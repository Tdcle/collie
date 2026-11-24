package collie

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Collie-managed Skills:
//
// Canonical source of truth lives on the Hub inside routerDir() (/root/.collie/router):
//   - skills/<slug>/SKILL.md         -> Scope "shared" (stored on Hub, mirrored to Router,
//                                       AND distributed to ~/.agents/skills, ~/.codex/skills,
//                                       and ~/.claude/skills on every connected computer with
//                                       a .collie-managed marker so user skills are untouched).
//   - .agents/skills/<slug>/SKILL.md -> Scope "router" (stored on Hub, mirrored to
//                                       router/.claude/skills/<slug>, loaded only by Collie's
//                                       own Router & Dream sessions).

const (
	collieMirrorMarker  = ".collie-mirror"
	collieManagedMarker = ".collie-managed"
)

var skillSlugRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)

type collieSkill struct {
	Slug        string    `json:"slug"`
	Scope       string    `json:"scope"` // "shared" | "router"
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Text        string    `json:"text"`
	Body        string    `json:"body"`
	ExtraFiles  []string  `json:"extra_files,omitempty"`
	Size        int64     `json:"size"`
	Mod         time.Time `json:"mod"`
}

type sharedSkillBundle struct {
	Slug  string           `json:"slug"`
	Files []routerSyncItem `json:"files"`
}

func validSkillSlug(slug string) bool {
	return skillSlugRe.MatchString(slug) && !strings.HasPrefix(slug, ".") && slug != ".."
}

func routerSkillPullRel(rel string) bool {
	if strings.HasSuffix(rel, "/"+collieMirrorMarker) || strings.HasSuffix(rel, "/"+collieManagedMarker) {
		return false
	}
	return strings.HasPrefix(rel, "skills/") ||
		strings.HasPrefix(rel, ".agents/skills/") ||
		strings.HasPrefix(rel, ".claude/skills/")
}

// parseSkillMarkdown extracts YAML frontmatter (name, description) and the
// Markdown body below the closing `---` fence.
func parseSkillMarkdown(raw string) (name, description, body string) {
	norm := strings.ReplaceAll(raw, "\r\n", "\n")
	if !strings.HasPrefix(norm, "---\n") {
		return "", "", strings.TrimSpace(norm)
	}
	rest := norm[4:]
	idx := strings.Index(rest, "\n---\n")
	endFenceLen := 5
	if idx < 0 && strings.HasSuffix(rest, "\n---") {
		idx = len(rest) - 4
		endFenceLen = 4
	}
	if idx < 0 {
		return "", "", strings.TrimSpace(norm)
	}
	fm := rest[:idx]
	body = strings.TrimSpace(rest[idx+endFenceLen:])

	lines := strings.Split(fm, "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		colon := strings.IndexByte(line, ':')
		if colon <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		val := strings.TrimSpace(line[colon+1:])
		if val == ">" || val == "|" || val == ">-" || val == "|-" {
			var parts []string
			for i+1 < len(lines) && (strings.HasPrefix(lines[i+1], "  ") || strings.HasPrefix(lines[i+1], "\t") || strings.TrimSpace(lines[i+1]) == "") {
				i++
				parts = append(parts, strings.TrimSpace(lines[i]))
			}
			sep := " "
			if strings.HasPrefix(val, "|") {
				sep = "\n"
			}
			val = strings.TrimSpace(strings.Join(parts, sep))
		} else {
			val = strings.Trim(val, `"'`)
		}
		switch key {
		case "name":
			name = val
		case "description":
			description = val
		}
	}
	return name, description, body
}

func isMirroredSkillDir(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, collieMirrorMarker))
	return err == nil
}

func copySkillDirAsMirror(srcDir, dstDir string) {
	_ = os.RemoveAll(dstDir)
	_ = os.MkdirAll(dstDir, 0o700)
	filepath.WalkDir(srcDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == srcDir {
			return nil
		}
		rel, rerr := filepath.Rel(srcDir, p)
		if rerr != nil {
			return nil
		}
		if d.Name() == collieMirrorMarker || d.Name() == collieManagedMarker {
			return nil
		}
		target := filepath.Join(dstDir, rel)
		if d.IsDir() {
			_ = os.MkdirAll(target, 0o700)
			return nil
		}
		if b, err := os.ReadFile(p); err == nil {
			_ = os.MkdirAll(filepath.Dir(target), 0o700)
			_ = os.WriteFile(target, b, 0o600)
		}
		return nil
	})
	_ = os.WriteFile(filepath.Join(dstDir, collieMirrorMarker), []byte("mirrored from canonical skill store\n"), 0o600)
}

func copySkillDirClean(srcDir, dstDir string) {
	_ = os.MkdirAll(dstDir, 0o700)
	filepath.WalkDir(srcDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == srcDir {
			return nil
		}
		rel, rerr := filepath.Rel(srcDir, p)
		if rerr != nil {
			return nil
		}
		if d.Name() == collieMirrorMarker || d.Name() == collieManagedMarker {
			return nil
		}
		target := filepath.Join(dstDir, rel)
		if d.IsDir() {
			_ = os.MkdirAll(target, 0o700)
			return nil
		}
		if b, err := os.ReadFile(p); err == nil {
			_ = os.MkdirAll(filepath.Dir(target), 0o700)
			_ = os.WriteFile(target, b, 0o600)
		}
		return nil
	})
}

// normalizeRouterSkills ensures canonical skills in `skills/<slug>` (shared) and
// `.agents/skills/<slug>` (router-only) are cleanly deduplicated and mirrored into
// both `.agents/skills` and `.claude/skills` inside routerDir so Codex, Claude,
// Gemini, and Antigravity all discover them seamlessly.
func normalizeRouterSkills(routerDir string) {
	if routerDir == "" {
		return
	}
	sharedRoot := filepath.Join(routerDir, "skills")
	agentsRoot := filepath.Join(routerDir, ".agents", "skills")
	claudeRoot := filepath.Join(routerDir, ".claude", "skills")
	_ = os.MkdirAll(sharedRoot, 0o700)
	_ = os.MkdirAll(agentsRoot, 0o700)
	_ = os.MkdirAll(claudeRoot, 0o700)

	// 1. If Claude wrote a brand-new skill directly to .claude/skills/<slug> (not a mirror),
	//    promote it into .agents/skills/<slug> unless already present in skills/ or .agents/skills/.
	if entries, err := os.ReadDir(claudeRoot); err == nil {
		for _, e := range entries {
			if !e.IsDir() || !validSkillSlug(e.Name()) {
				continue
			}
			cdir := filepath.Join(claudeRoot, e.Name())
			if isMirroredSkillDir(cdir) || !isFile(filepath.Join(cdir, "SKILL.md")) {
				continue
			}
			sdir := filepath.Join(sharedRoot, e.Name())
			adir := filepath.Join(agentsRoot, e.Name())
			if !isFile(filepath.Join(sdir, "SKILL.md")) && !isFile(filepath.Join(adir, "SKILL.md")) {
				copySkillDirClean(cdir, adir)
			}
		}
	}

	sharedSlugs := map[string]bool{}
	if entries, err := os.ReadDir(sharedRoot); err == nil {
		for _, e := range entries {
			if !e.IsDir() || !validSkillSlug(e.Name()) {
				continue
			}
			sdir := filepath.Join(sharedRoot, e.Name())
			if !isFile(filepath.Join(sdir, "SKILL.md")) {
				continue
			}
			sharedSlugs[e.Name()] = true
			copySkillDirAsMirror(sdir, filepath.Join(agentsRoot, e.Name()))
			copySkillDirAsMirror(sdir, filepath.Join(claudeRoot, e.Name()))
		}
	}

	routerSlugs := map[string]bool{}
	if entries, err := os.ReadDir(agentsRoot); err == nil {
		for _, e := range entries {
			if !e.IsDir() || !validSkillSlug(e.Name()) || sharedSlugs[e.Name()] {
				continue
			}
			adir := filepath.Join(agentsRoot, e.Name())
			if isMirroredSkillDir(adir) {
				// Stale mirror of a removed/demoted shared skill.
				_ = os.RemoveAll(adir)
				continue
			}
			if !isFile(filepath.Join(adir, "SKILL.md")) {
				continue
			}
			routerSlugs[e.Name()] = true
			copySkillDirAsMirror(adir, filepath.Join(claudeRoot, e.Name()))
		}
	}

	// Clean stale mirrors in .claude/skills.
	if entries, err := os.ReadDir(claudeRoot); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			if !sharedSlugs[e.Name()] && !routerSlugs[e.Name()] && isMirroredSkillDir(filepath.Join(claudeRoot, e.Name())) {
				_ = os.RemoveAll(filepath.Join(claudeRoot, e.Name()))
			}
		}
	}
}

func readSkillEntry(dir, slug, scope string) *collieSkill {
	mdPath := filepath.Join(dir, "SKILL.md")
	fi, err := os.Stat(mdPath)
	if err != nil || fi.IsDir() {
		return nil
	}
	b, err := os.ReadFile(mdPath)
	if err != nil {
		return nil
	}
	raw := string(b)
	name, desc, body := parseSkillMarkdown(raw)
	if name == "" {
		name = slug
	}
	var extras []string
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || p == mdPath {
			return nil
		}
		if d.Name() == collieMirrorMarker || d.Name() == collieManagedMarker {
			return nil
		}
		if rel, rerr := filepath.Rel(dir, p); rerr == nil {
			extras = append(extras, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(extras)
	return &collieSkill{
		Slug:        slug,
		Scope:       scope,
		Name:        name,
		Description: desc,
		Text:        raw,
		Body:        body,
		ExtraFiles:  extras,
		Size:        fi.Size(),
		Mod:         fi.ModTime(),
	}
}

func (sp *Super) listSkills() []*collieSkill {
	rdir := sp.routerDir()
	normalizeRouterSkills(rdir)
	out := []*collieSkill{}
	seen := map[string]bool{}

	sharedRoot := filepath.Join(rdir, "skills")
	if entries, err := os.ReadDir(sharedRoot); err == nil {
		for _, e := range entries {
			if !e.IsDir() || !validSkillSlug(e.Name()) {
				continue
			}
			if sk := readSkillEntry(filepath.Join(sharedRoot, e.Name()), e.Name(), "shared"); sk != nil {
				out = append(out, sk)
				seen[e.Name()] = true
			}
		}
	}
	agentsRoot := filepath.Join(rdir, ".agents", "skills")
	if entries, err := os.ReadDir(agentsRoot); err == nil {
		for _, e := range entries {
			if !e.IsDir() || !validSkillSlug(e.Name()) || seen[e.Name()] {
				continue
			}
			adir := filepath.Join(agentsRoot, e.Name())
			if isMirroredSkillDir(adir) {
				continue
			}
			if sk := readSkillEntry(adir, e.Name(), "router"); sk != nil {
				out = append(out, sk)
				seen[e.Name()] = true
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Scope != out[j].Scope {
			return out[i].Scope == "shared" // shared skills first
		}
		return out[i].Slug < out[j].Slug
	})
	return out
}

func (sp *Super) collectSharedSkillBundles() []sharedSkillBundle {
	rdir := sp.routerDir()
	sharedRoot := filepath.Join(rdir, "skills")
	var bundles []sharedSkillBundle
	entries, err := os.ReadDir(sharedRoot)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		if !e.IsDir() || !validSkillSlug(e.Name()) {
			continue
		}
		sdir := filepath.Join(sharedRoot, e.Name())
		if !isFile(filepath.Join(sdir, "SKILL.md")) {
			continue
		}
		files := collectRouterTree(sdir, func(rel string) bool {
			base := filepath.Base(rel)
			return base != collieMirrorMarker && base != collieManagedMarker
		})
		if len(files) > 0 {
			bundles = append(bundles, sharedSkillBundle{Slug: e.Name(), Files: files})
		}
	}
	sort.Slice(bundles, func(i, j int) bool { return bundles[i].Slug < bundles[j].Slug })
	return bundles
}

// applySharedSkillsToHome writes Collie-managed shared skills into the user's
// ~/.agents/skills, ~/.codex/skills, and ~/.claude/skills directories on a host.
// Pre-existing user or system skills without `.collie-managed` are NEVER touched.
func applySharedSkillsToHome(home string, bundles []sharedSkillBundle) error {
	if strings.TrimSpace(home) == "" {
		return nil
	}
	roots := []string{
		filepath.Join(home, ".agents", "skills"),
		filepath.Join(home, ".codex", "skills"),
		filepath.Join(home, ".claude", "skills"),
	}
	want := map[string]sharedSkillBundle{}
	for _, b := range bundles {
		if validSkillSlug(b.Slug) {
			want[b.Slug] = b
		}
	}
	for _, root := range roots {
		if err := os.MkdirAll(root, 0o700); err != nil {
			continue
		}
		// 1. Install or update wanted skills (skipping any non-Collie directory of the same name).
		for slug, bundle := range want {
			dst := filepath.Join(root, slug)
			if st, err := os.Stat(dst); err == nil && st.IsDir() {
				if _, mErr := os.Stat(filepath.Join(dst, collieManagedMarker)); mErr != nil {
					// Owned by user / external installer — never clobber!
					continue
				}
			}
			_ = applyRouterTree(dst, bundle.Files, []string{"."}, nil)
			_ = os.WriteFile(filepath.Join(dst, collieManagedMarker), []byte("managed by collie hub\n"), 0o600)
		}
		// 2. Remove stale Collie-managed skills no longer in `want`.
		if entries, err := os.ReadDir(root); err == nil {
			for _, e := range entries {
				if !e.IsDir() || want[e.Name()].Slug != "" {
					continue
				}
				dst := filepath.Join(root, e.Name())
				if _, mErr := os.Stat(filepath.Join(dst, collieManagedMarker)); mErr == nil {
					_ = os.RemoveAll(dst)
				}
			}
		}
	}
	return nil
}

func (s *Server) skillsSync(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Skills []sharedSkillBundle `json:"skills"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := applySharedSkillsToHome(s.home, body.Skills); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "count": len(body.Skills)})
}

func (sp *Super) syncSharedSkillsToNode(ctx context.Context, machineID string, bundles []sharedSkillBundle) {
	if machineID == "" || sp.s == nil || sp.s.herdr == nil {
		return
	}
	client, err := sp.s.herdr.Client(machineID)
	if err != nil {
		return
	}
	b, _ := json.Marshal(map[string]any{"skills": bundles})
	cctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, "POST", "http://node/api/skills-sync", bytes.NewReader(b))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if resp, err := client.Do(req); err == nil {
		resp.Body.Close()
	}
}

func (sp *Super) syncSharedSkillsAllNodes() {
	if sp == nil || sp.s == nil {
		return
	}
	bundles := sp.collectSharedSkillBundles()
	_ = applySharedSkillsToHome(sp.s.home, bundles)
	if sp.s.herdr == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for _, m := range sp.s.herdr.Machines() {
		if !m.Local && m.Online && m.ID != "" {
			sp.syncSharedSkillsToNode(ctx, m.ID, bundles)
		}
	}
}

// seedMissingSkillsFromNode runs once per connected node per Hub process lifetime
// before a clean push so any skill created earlier on a remote Router node (such
// as Mac's `.agents/skills/collie-resume-sidebar`) is imported onto the Hub
// instead of being wiped by the Hub's initial push.
func (sp *Super) seedMissingSkillsFromNode(ctx context.Context, machineID string) {
	if sp == nil || machineID == "" || sp.s == nil || sp.s.herdr == nil {
		return
	}
	sp.mu.Lock()
	if sp.seededSkillNodes == nil {
		sp.seededSkillNodes = map[string]bool{}
	}
	if sp.seededSkillNodes[machineID] {
		sp.mu.Unlock()
		return
	}
	sp.mu.Unlock()

	client, err := sp.s.herdr.Client(machineID)
	if err != nil {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(cctx, "GET", "http://node/api/router-sync", nil)
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return
	}
	var out struct {
		Files []routerSyncItem `json:"files"`
	}
	if json.NewDecoder(resp.Body).Decode(&out) != nil {
		return
	}

	rdir := sp.routerDir()
	imported := false
	for _, it := range out.Files {
		if !isSafeRouterRel(it.Path) || !routerSkillPullRel(it.Path) {
			continue
		}
		// Extract slug to check if Hub already has this skill in either scope.
		var slug string
		switch {
		case strings.HasPrefix(it.Path, "skills/"):
			slug = strings.SplitN(strings.TrimPrefix(it.Path, "skills/"), "/", 2)[0]
		case strings.HasPrefix(it.Path, ".agents/skills/"):
			slug = strings.SplitN(strings.TrimPrefix(it.Path, ".agents/skills/"), "/", 2)[0]
		case strings.HasPrefix(it.Path, ".claude/skills/"):
			slug = strings.SplitN(strings.TrimPrefix(it.Path, ".claude/skills/"), "/", 2)[0]
		}
		if !validSkillSlug(slug) {
			continue
		}
		if isFile(filepath.Join(rdir, "skills", slug, "SKILL.md")) || isFile(filepath.Join(rdir, ".agents", "skills", slug, "SKILL.md")) {
			// If we're still importing sibling files of the same newly imported slug, allow missing files.
			dst := filepath.Join(rdir, filepath.FromSlash(it.Path))
			if isFile(dst) {
				continue
			}
		}
		dst := filepath.Join(rdir, filepath.FromSlash(it.Path))
		if _, err := os.Stat(dst); os.IsNotExist(err) {
			_ = os.MkdirAll(filepath.Dir(dst), 0o700)
			if os.WriteFile(dst, []byte(it.Text), 0o600) == nil {
				imported = true
			}
		}
	}
	if imported {
		normalizeRouterSkills(rdir)
	}
	sp.mu.Lock()
	sp.seededSkillNodes[machineID] = true
	sp.mu.Unlock()
}

func (sp *Super) onNodeConnected(machineID string) {
	if sp == nil || machineID == "" {
		return
	}
	time.Sleep(800 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	sp.seedMissingSkillsFromNode(ctx, machineID)
	bundles := sp.collectSharedSkillBundles()
	sp.syncSharedSkillsToNode(ctx, machineID, bundles)
}

func (sp *Super) syncActiveRouterNodeAsync() {
	if sp == nil || sp.s == nil || sp.s.herdr == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		sp.mu.Lock()
		m := sp.routerActiveMachine
		if m == "" {
			m = sp.st.Settings.RouterMachine
		}
		sp.mu.Unlock()
		if m != "" && m != "hub" {
			_, _ = sp.pushRouterToNode(ctx, m)
		}
	}()
}

func (s *Server) superSaveSkill(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Slug      string `json:"slug"`
		PrevSlug  string `json:"prev_slug"`
		Scope     string `json:"scope"`      // "shared" | "router"
		PrevScope string `json:"prev_scope"` // optional when moving scope
		Text      string `json:"text"`
	}
	if !decode(w, r, &body) {
		return
	}
	slug := strings.TrimSpace(body.Slug)
	if !validSkillSlug(slug) {
		writeJSON(w, 400, map[string]any{"error": "Skill 标识仅支持字母、数字、连字符与下划线（如 sfd-router-eval）"})
		return
	}
	scope := strings.TrimSpace(body.Scope)
	if scope != "router" {
		scope = "shared"
	}
	if len(body.Text) == 0 || len(body.Text) > 256<<10 {
		writeJSON(w, 400, map[string]any{"error": "SKILL.md 内容不能为空且不超过 256 KB"})
		return
	}

	sp := s.sup
	rdir := sp.routerDir()
	targetDir := filepath.Join(rdir, "skills", slug)
	if scope == "router" {
		targetDir = filepath.Join(rdir, ".agents", "skills", slug)
	}

	prevSlug := strings.TrimSpace(body.PrevSlug)
	if prevSlug == "" {
		prevSlug = slug
	}
	prevScope := strings.TrimSpace(body.PrevScope)
	if validSkillSlug(prevSlug) && (prevSlug != slug || (prevScope != "" && prevScope != scope)) {
		oldDir := filepath.Join(rdir, "skills", prevSlug)
		if prevScope == "router" {
			oldDir = filepath.Join(rdir, ".agents", "skills", prevSlug)
		}
		if oldDir != targetDir && isFile(filepath.Join(oldDir, "SKILL.md")) {
			copySkillDirClean(oldDir, targetDir)
			_ = os.RemoveAll(oldDir)
		}
		_ = os.RemoveAll(filepath.Join(rdir, ".claude", "skills", prevSlug))
		if prevScope == "shared" && scope == "router" {
			_ = os.RemoveAll(filepath.Join(rdir, "skills", prevSlug))
		} else if prevScope == "router" && scope == "shared" {
			_ = os.RemoveAll(filepath.Join(rdir, ".agents", "skills", prevSlug))
		}
	} else if scope == "router" {
		// Ensure it doesn't remain duplicated in shared skills/
		_ = os.RemoveAll(filepath.Join(rdir, "skills", slug))
	} else if scope == "shared" {
		// Remove non-mirror copy in .agents/skills before normalizeRouterSkills mirrors it cleanly
		_ = os.RemoveAll(filepath.Join(rdir, ".agents", "skills", slug))
	}

	if err := os.MkdirAll(targetDir, 0o700); err != nil {
		fail(w, err)
		return
	}
	_ = os.Remove(filepath.Join(targetDir, collieMirrorMarker))
	text := strings.TrimRight(strings.ReplaceAll(body.Text, "\r\n", "\n"), "\n") + "\n"
	if _, _, _ = parseSkillMarkdown(text); !strings.HasPrefix(text, "---\n") {
		text = fmt.Sprintf("---\nname: %s\ndescription: 自定义技能\n---\n\n%s", slug, text)
	}
	if err := os.WriteFile(filepath.Join(targetDir, "SKILL.md"), []byte(text), 0o600); err != nil {
		fail(w, err)
		return
	}
	normalizeRouterSkills(rdir)
	sp.syncActiveRouterNodeAsync()
	go sp.syncSharedSkillsAllNodes()
	writeJSON(w, 200, map[string]any{"ok": true, "slug": slug, "scope": scope})
}

func (s *Server) superDeleteSkill(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Slug string `json:"slug"`
	}
	if !decode(w, r, &body) {
		return
	}
	slug := strings.TrimSpace(body.Slug)
	if !validSkillSlug(slug) {
		writeJSON(w, 400, map[string]any{"error": "无效的 Skill 标识"})
		return
	}
	sp := s.sup
	rdir := sp.routerDir()
	_ = os.RemoveAll(filepath.Join(rdir, "skills", slug))
	_ = os.RemoveAll(filepath.Join(rdir, ".agents", "skills", slug))
	_ = os.RemoveAll(filepath.Join(rdir, ".claude", "skills", slug))
	normalizeRouterSkills(rdir)
	sp.syncActiveRouterNodeAsync()
	go sp.syncSharedSkillsAllNodes()
	writeJSON(w, 200, map[string]any{"ok": true})
}
