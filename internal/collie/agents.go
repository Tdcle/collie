package collie

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
)

// Which agents a computer has installed, by herdr kind. Each node detects its
// own and says so when it connects (X-Collie-Agents); the hub detects its own.
// Starting an agent checks again where it runs, so a stale list only greys
// out the wrong choices in the UI, it never starts a pane for nothing.

var agentKinds = []string{"claude", "codex", "agy", "gemini"}

var agentNames = map[string]string{"claude": "Claude Code", "codex": "Codex", "agy": "Antigravity", "gemini": "Gemini CLI"}

func detectAgents(home string) []string {
	out := []string{}
	for _, k := range agentKinds {
		if findBin(k, home) != "" {
			out = append(out, k)
		}
	}
	return out
}

// agentsHeader / parseAgentsHeader: "claude,codex", "-" for none; an older
// node sends nothing, and nil means "not known".
func agentsHeader(list []string) string {
	if len(list) == 0 {
		return "-"
	}
	return strings.Join(list, ",")
}

func parseAgentsHeader(v string) []string {
	if v == "" {
		return nil
	}
	out := []string{}
	for _, k := range strings.Split(v, ",") {
		if k = strings.TrimSpace(k); slices.Contains(agentKinds, k) {
			out = append(out, k)
		}
	}
	return out
}

// A miss looks through the login shell, which can take seconds, so this
// computer's list is kept for a minute and refreshed in the background.
var localAgentList struct {
	sync.Mutex
	list []string
	at   time.Time
	busy bool
}

// localAgents is this computer's list: nil until the first look ends, unless
// wait, which looks now if there is nothing fresh.
func localAgents(home string, wait bool) []string {
	c := &localAgentList
	c.Lock()
	stale := time.Since(c.at) > time.Minute
	if stale && wait {
		c.Unlock()
		l := detectAgents(home)
		c.Lock()
		c.list, c.at = l, time.Now()
		defer c.Unlock()
		return c.list
	}
	defer c.Unlock()
	if stale && !c.busy {
		c.busy = true
		go func() {
			l := detectAgents(home)
			c.Lock()
			c.list, c.at, c.busy = l, time.Now(), false
			c.Unlock()
		}()
	}
	return c.list
}

// agentMissing says why kind (herdr's: claude, codex, agy) can't start on
// machine, or nil. A list that isn't known yet lets it try.
func (s *Server) agentMissing(machine, kind string) error {
	name := agentNames[kind]
	if name == "" {
		return nil
	}
	if machine == "" {
		if findBin(kind, s.home) != "" {
			return nil
		}
		return fmt.Errorf("这台电脑上没装 %s（找不到 %s 命令）", name, kind)
	}
	m, err := s.herdr.machine(machine)
	if err != nil || m.Agents == nil || slices.Contains(m.Agents, kind) {
		return nil
	}
	return fmt.Errorf("%s 上没装 %s（找不到 %s 命令）", m.Name, name, kind)
}
