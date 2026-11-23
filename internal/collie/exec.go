package collie

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

type execReq struct {
	Machine string `json:"machine,omitempty"`
	Cwd     string `json:"cwd,omitempty"`
	Command string `json:"command"`
	Timeout int    `json:"timeout_sec,omitempty"`
}

type execResp struct {
	ExitCode int    `json:"exit_code"`
	Output   string `json:"output"`
	TimedOut bool   `json:"timed_out,omitempty"`
}

func runLocalShellCommand(parent context.Context, home, rawCwd, command string, timeoutSec int) (execResp, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return execResp{}, errors.New("command is required")
	}
	if timeoutSec <= 0 || timeoutSec > 180 {
		timeoutSec = 60
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(timeoutSec)*time.Second)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		// Force UTF-8 output so non-ASCII paths/messages round-trip cleanly.
		ps := "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " + command
		cmd = exec.CommandContext(ctx, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-lc", command)
	}
	hideCmd(cmd)
	applySystemProxyEnv(cmd)
	dir := expandIn(home, rawCwd)
	if isDir(dir) {
		cmd.Dir = dir
	} else if isDir(home) {
		cmd.Dir = home
	}

	var buf limitedBuffer
	buf.max = 48 << 10
	cmd.Stdout = &buf
	cmd.Stderr = &buf

	err := cmd.Run()
	resp := execResp{Output: buf.String()}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		resp.ExitCode = 124
		resp.TimedOut = true
		return resp, nil
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			resp.ExitCode = ee.ExitCode()
			return resp, nil
		}
		return resp, err
	}
	return resp, nil
}

type limitedBuffer struct {
	b       bytes.Buffer
	max     int
	dropped bool
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	orig := len(p)
	rem := l.max - l.b.Len()
	if rem <= 0 {
		l.dropped = true
		return orig, nil
	}
	if len(p) > rem {
		p = p[:rem]
		l.dropped = true
	}
	l.b.Write(p)
	return orig, nil
}

func (l *limitedBuffer) String() string {
	s := l.b.String()
	if l.dropped {
		s += "\n…[output truncated]"
	}
	return s
}

// nodeExec handles POST /api/exec on a node (over the authenticated yamux tunnel).
func (s *Server) nodeExec(w http.ResponseWriter, r *http.Request) {
	var req execReq
	if !decode(w, r, &req) {
		return
	}
	res, err := runLocalShellCommand(r.Context(), s.home, req.Cwd, req.Command, req.Timeout)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, res)
}

func (sp *Super) activeRouterMachine(ctx context.Context) string {
	if live, ok := sp.liveAgents(ctx); ok {
		if a, alive := live[routerName]; alive {
			_, m := split(a.Pane)
			return m
		}
	}
	sp.mu.Lock()
	st := sp.st.Settings
	sp.mu.Unlock()
	if m, _, err := sp.resolveRouterTarget(st); err == nil && m != nil {
		return m.ID
	}
	return st.RouterMachine
}

// superExec handles POST /api/super/exec for Collie Router (or master/browser)
// to run bounded maintenance commands when an agent CLI on a target machine
// cannot start itself.
func (s *Server) superExec(w http.ResponseWriter, r *http.Request) {
	master, d := s.identity(r)
	if !master && (d == nil || (d.Kind != "browser" && d.ID != s.sup.activeRouterMachine(r.Context()))) {
		writeJSON(w, 403, map[string]any{"error": "only Collie Router or an admin session can run super/exec"})
		return
	}
	var req execReq
	if !decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Command) == "" {
		writeJSON(w, 400, map[string]any{"error": "command is required"})
		return
	}
	machine := s.sup.settings().WorkerMachine
	if req.Machine != "" {
		if req.Machine == "hub" || req.Machine == "local" {
			machine = ""
		} else {
			machine = s.machineByName(req.Machine)
			if machine == "" {
				writeJSON(w, 404, map[string]any{"error": fmt.Sprintf("unknown machine %q", req.Machine)})
				return
			}
		}
	} else if lm := s.herdr.Machines()[0]; !lm.Online && len(lm.Agents) == 0 {
		for _, rm := range s.herdr.Machines()[1:] {
			if rm.Online {
				machine = rm.ID
				break
			}
		}
	}

	if machine == "" {
		res, err := runLocalShellCommand(r.Context(), s.home, req.Cwd, req.Command, req.Timeout)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, res)
		return
	}

	client, err := s.herdr.Client(machine)
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	b, _ := json.Marshal(execReq{Cwd: req.Cwd, Command: req.Command, Timeout: req.Timeout})
	timeout := req.Timeout
	if timeout <= 0 || timeout > 180 {
		timeout = 60
	}
	cctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeout+10)*time.Second)
	defer cancel()
	nreq, _ := http.NewRequestWithContext(cctx, "POST", "http://node/api/exec", bytes.NewReader(b))
	nreq.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(nreq)
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 128<<10))
	if resp.StatusCode != 200 {
		var e struct{ Error string }
		if json.Unmarshal(raw, &e) == nil && e.Error != "" {
			writeJSON(w, resp.StatusCode, map[string]any{"error": e.Error})
			return
		}
		writeJSON(w, 502, map[string]any{"error": fmt.Sprintf("node /api/exec (%d) — upgrade collie on %s first: %s", resp.StatusCode, machine, strings.TrimSpace(string(raw)))})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	w.Write(raw)
}
