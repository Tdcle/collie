package collie

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseSkillMarkdown(t *testing.T) {
	raw := "---\nname: collie-resume-sidebar\ndescription: >\n  当用户明确指定已有侧栏会话继续工作，\n  或要求核验任务是否接单时使用。\n---\n\n# 续派到原侧栏会话\n\n1. 认准原会话。\n"
	name, desc, body := parseSkillMarkdown(raw)
	if name != "collie-resume-sidebar" {
		t.Fatalf("name = %q, want collie-resume-sidebar", name)
	}
	if !strings.Contains(desc, "当用户明确指定已有侧栏会话继续工作") || !strings.Contains(desc, "核验任务") {
		t.Fatalf("description = %q", desc)
	}
	if !strings.HasPrefix(body, "# 续派到原侧栏会话") {
		t.Fatalf("body = %q", body)
	}
}

func TestNormalizeRouterSkillsAndMirrors(t *testing.T) {
	rdir := t.TempDir()

	// 1. Router-only skill in .agents/skills
	rSkillDir := filepath.Join(rdir, ".agents", "skills", "collie-resume-sidebar")
	if err := os.MkdirAll(rSkillDir, 0o700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(rSkillDir, "SKILL.md"), []byte("---\nname: collie-resume-sidebar\ndescription: router only\n---\n# Body\n"), 0o600)

	// 2. Shared skill in skills/
	sSkillDir := filepath.Join(rdir, "skills", "sfd-router-eval")
	if err := os.MkdirAll(sSkillDir, 0o700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(sSkillDir, "SKILL.md"), []byte("---\nname: sfd-router-eval\ndescription: shared across machines\n---\n# Eval\n"), 0o600)
	os.MkdirAll(filepath.Join(sSkillDir, "scripts"), 0o700)
	os.WriteFile(filepath.Join(sSkillDir, "scripts", "run.py"), []byte("print('ok')\n"), 0o600)

	// 3. Brand-new skill written by Claude Code into .claude/skills
	cSkillDir := filepath.Join(rdir, ".claude", "skills", "claude-authored")
	os.MkdirAll(cSkillDir, 0o700)
	os.WriteFile(filepath.Join(cSkillDir, "SKILL.md"), []byte("---\nname: claude-authored\ndescription: written by claude\n---\n# Hi\n"), 0o600)

	sp := &Super{dir: filepath.Dir(rdir)}
	// Point routerDir to a sub-tempdir named "router"
	base := t.TempDir()
	realRouter := filepath.Join(base, "router")
	copySkillDirClean(rdir, realRouter)
	sp.dir = base

	skills := sp.listSkills()
	if len(skills) != 3 {
		t.Fatalf("listSkills count = %d, want 3: %+v", len(skills), skills)
	}
	if skills[0].Slug != "sfd-router-eval" || skills[0].Scope != "shared" {
		t.Fatalf("first skill = %+v, want shared sfd-router-eval", skills[0])
	}
	if len(skills[0].ExtraFiles) != 1 || skills[0].ExtraFiles[0] != "scripts/run.py" {
		t.Fatalf("extra files = %+v, want [scripts/run.py]", skills[0].ExtraFiles)
	}

	// Both skills must be mirrored to .claude/skills for Claude Router compatibility,
	// and shared skill must also be mirrored to .agents/skills without duplicating listSkills!
	if !isFile(filepath.Join(realRouter, ".claude", "skills", "collie-resume-sidebar", "SKILL.md")) {
		t.Fatal("expected collie-resume-sidebar mirrored to .claude/skills")
	}
	if !isFile(filepath.Join(realRouter, ".agents", "skills", "sfd-router-eval", "SKILL.md")) {
		t.Fatal("expected shared sfd-router-eval mirrored to .agents/skills")
	}
	if skillsAgain := sp.listSkills(); len(skillsAgain) != 3 {
		t.Fatalf("idempotent listSkills count = %d, want 3", len(skillsAgain))
	}
}

func TestApplySharedSkillsPreservesUserSkills(t *testing.T) {
	home := t.TempDir()

	// Pre-existing user skill (NO .collie-managed marker) must never be overwritten or deleted!
	userSkill := filepath.Join(home, ".codex", "skills", "lark-doc")
	os.MkdirAll(userSkill, 0o700)
	os.WriteFile(filepath.Join(userSkill, "SKILL.md"), []byte("user owned lark-doc"), 0o600)

	// Pre-existing stale Collie-managed skill should be cleaned up when removed from bundles.
	staleCollie := filepath.Join(home, ".agents", "skills", "old-collie-skill")
	os.MkdirAll(staleCollie, 0o700)
	os.WriteFile(filepath.Join(staleCollie, "SKILL.md"), []byte("old"), 0o600)
	os.WriteFile(filepath.Join(staleCollie, collieManagedMarker), []byte("managed\n"), 0o600)

	bundles := []sharedSkillBundle{
		{
			Slug: "sfd-eval",
			Files: []routerSyncItem{
				{Path: "SKILL.md", Text: "---\nname: sfd-eval\ndescription: eval\n---\n"},
			},
		},
		{
			// Even if a bundle collides with user-owned "lark-doc", user's directory wins!
			Slug: "lark-doc",
			Files: []routerSyncItem{
				{Path: "SKILL.md", Text: "should not overwrite user lark-doc"},
			},
		},
	}

	if err := applySharedSkillsToHome(home, bundles); err != nil {
		t.Fatalf("applySharedSkillsToHome: %v", err)
	}

	for _, root := range []string{".agents/skills", ".codex/skills", ".claude/skills"} {
		p := filepath.Join(home, filepath.FromSlash(root), "sfd-eval", "SKILL.md")
		if !isFile(p) {
			t.Fatalf("expected sfd-eval installed in %s", root)
		}
	}
	gotUser, _ := os.ReadFile(filepath.Join(userSkill, "SKILL.md"))
	if string(gotUser) != "user owned lark-doc" {
		t.Fatalf("user skill was overwritten: %q", string(gotUser))
	}
	if _, err := os.Stat(staleCollie); !os.IsNotExist(err) {
		t.Fatalf("expected stale .collie-managed skill to be removed")
	}
}
