package collie

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Collie's memory is a directory, split by kind so that each session loads
// only what it needs: standing instructions, an index of notes, open tasks and
// what it recently said. Everything else is read on demand.

const memoryLayout = `memory/
  instructions.md   the human's standing instructions and preferences. Read every session.
  notes/index.md    one line per note file saying what it holds. Read every session.
  notes/<topic>.md  what you learned about people, projects, machines, recurring how-tos,
                    and what finished work taught: where data lives, the command or query
                    that worked, pitfalls, where results are. One file per project or
                    data set (book-df.md, shop-api.md) by default; machines.md for
                    computers; agents.md for which agent and model works where, what
                    each is good at, how they fail; a how-to that spans projects gets
                    its own. Facts that change (quotas, outages, how far a job has got)
                    carry a date: "（截至 11-19）". Read when relevant; add a line to
                    index.md for each new file.
  tasks/<slug>.md   one file per piece of open work: goal, thread id, agents on it,
                    what's done, what's left, next step. Read every session.
  tasks/done/       finished or abandoned tasks, moved here with a last line on how they ended.
  messages.md       what you recently told the human, kept up to date by the hub. Read
                    every session, to build on what you already said.
Store only what can't be looked up again: pointers (paths, thread ids, URLs), not copies.`

func (sp *Super) memDir() string { return filepath.Join(sp.routerDir(), "memory") }

// ensureMemory creates the skeleton (keeping whatever is there) and refreshes messages.md.
func (sp *Super) ensureMemory() {
	dir := sp.memDir()
	os.MkdirAll(filepath.Join(dir, "notes"), 0o700)
	os.MkdirAll(filepath.Join(dir, "tasks", "done"), 0o700)
	seed := map[string]string{
		"instructions.md":  "# Instructions from the human\n",
		"notes/index.md":   "# Notes\n\nOne line per file in this folder.\n",
		"tasks/.keep":      "",
		"tasks/done/.keep": "",
	}
	for name, body := range seed {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); os.IsNotExist(err) {
			os.WriteFile(p, []byte(body), 0o600)
		}
	}
	sp.writeMessages()
}

// recentMessages is how many of Collie's replies messages.md keeps: enough
// not to repeat itself after a restart; older ones are in the chat history.
const recentMessages = 10

// writeMessages records Collie's recent replies to the human.
func (sp *Super) writeMessages() {
	sp.mu.Lock()
	var lines []string
	for i := len(sp.st.Entries) - 1; i >= 0 && len(lines) < recentMessages; i-- {
		e := sp.st.Entries[i]
		if e.Role == "collie" {
			lines = append(lines, fmt.Sprintf("- %s [%s] %s", e.At.Format("01-02 15:04"), e.Thread, clip(oneLine(e.Text), 240)))
		}
	}
	sp.mu.Unlock()
	for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
		lines[i], lines[j] = lines[j], lines[i]
	}
	body := "# What Collie recently told the human (written by the hub, oldest first)\n\n" + strings.Join(lines, "\n") + "\n"
	os.WriteFile(filepath.Join(sp.memDir(), "messages.md"), []byte(body), 0o600)
}

// openTasks lists memory/tasks/*.md (not done/).
func (sp *Super) openTasks() []string {
	m, _ := filepath.Glob(filepath.Join(sp.memDir(), "tasks", "*.md"))
	out := []string{}
	for _, p := range m {
		out = append(out, filepath.Base(p))
	}
	sort.Strings(out)
	return out
}

// loadedSize is what a session reads up front, in bytes.
func (sp *Super) loadedSize() int64 {
	var n int64
	add := func(p string) {
		if fi, err := os.Stat(p); err == nil {
			n += fi.Size()
		}
	}
	dir := sp.memDir()
	add(filepath.Join(dir, "instructions.md"))
	add(filepath.Join(dir, "notes", "index.md"))
	add(filepath.Join(dir, "messages.md"))
	for _, t := range sp.openTasks() {
		add(filepath.Join(dir, "tasks", t))
	}
	add(filepath.Join(sp.routerDir(), "memory.md")) // the old single file, until migrated
	return n
}

// upFrontSize is the part of loadedSize that Collie writes: all of it but messages.md.
func (sp *Super) upFrontSize() int64 {
	n := sp.loadedSize()
	if fi, err := os.Stat(filepath.Join(sp.memDir(), "messages.md")); err == nil {
		n -= fi.Size()
	}
	return n
}

func (sp *Super) legacyMemory() bool {
	return isFile(filepath.Join(sp.routerDir(), "memory.md"))
}

const migrateNote = "memory.md (and memory-archive.md, if present) are the old single-file memory. Move their contents into memory/ as laid out in ROUTER.md (instructions, notes with an index, one file per open task, finished work to tasks/done/), then delete those two files."

// sessionStart is the preamble of a fresh session's first prompt.
func (sp *Super) sessionStart() string {
	var b strings.Builder
	b.WriteString("[collie] Session start. Read ROUTER.md, then memory/instructions.md, memory/notes/index.md, memory/messages.md")
	if t := sp.openTasks(); len(t) > 0 {
		fmt.Fprintf(&b, " and the open tasks in memory/tasks/ (%s)", strings.Join(t, ", "))
	} else {
		b.WriteString(" (memory/tasks/ is empty: no open work)")
	}
	b.WriteString(". Then handle the events below.\n")
	if sp.legacyMemory() {
		b.WriteString("Also read memory.md. " + migrateNote + " Do that once these events are handled.\n")
	} else if n := sp.upFrontSize(); n > upFrontBudget*2 {
		fmt.Fprintf(&b, "The up-front files (instructions, notes/index.md, open tasks) are %d KB, a lot for every session: once these events are handled, bring them to ~%d KB (detail into notes/, finished work into tasks/done/).\n", n/1024, upFrontBudget/1024)
	}
	return b.String()
}

// memFiles lists the memory directory for the web UI (relative paths).
func (sp *Super) memFiles() []*memFile {
	var out []*memFile
	root := sp.memDir()
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".md") {
			return nil
		}
		if f := readMemFile(p); f != nil {
			rel, _ := filepath.Rel(root, p)
			f.Name = filepath.ToSlash(rel)
			out = append(out, f)
		}
		return nil
	})
	for _, name := range []string{"memory.md", "memory-archive.md"} {
		if f := readMemFile(filepath.Join(sp.routerDir(), name)); f != nil {
			f.Name, f.Legacy = name, true
			out = append(out, f)
		}
	}
	return out
}

// memoryRules lets Collie (and its dream session, which nobody watches) keep
// memory/ without asking: by relative and absolute path, plus read-only looks.
func memoryRules(dir string) []string {
	slashed := filepath.ToSlash(dir)
	if isWindowsPath(dir) {
		slashed = strings.ReplaceAll(dir, `\`, "/")
	}
	abs := "/" + strings.TrimPrefix(slashed, "/") // Claude Code writes absolute paths as //path
	var r []string
	for _, p := range []string{"memory/**", "dreams/**", "memory.md", "memory-archive.md"} {
		r = append(r, "Read("+p+")", "Edit("+p+")", "Write("+p+")", "Read(/"+abs+"/"+p+")", "Edit(/"+abs+"/"+p+")", "Write(/"+abs+"/"+p+")")
	}
	r = append(r, "Read(dream/**)", "Read(/"+abs+"/dream/**)")
	for _, base := range []string{"", slashed + "/"} {
		r = append(r, "Bash(mkdir -p "+base+"memory:*)", "Bash(mv "+base+"memory:*)", "Bash(rm "+base+"memory.md:*)", "Bash(rm "+base+"memory-archive.md:*)")
	}
	for _, c := range []string{"ls", "find", "du", "wc", "cat", "head", "tail", "sort", "grep", "stat", "echo", "date", "dir", "type"} {
		r = append(r, "Bash("+c+":*)")
	}
	return r
}
