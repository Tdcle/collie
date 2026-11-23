//go:build !windows

package collie

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func dialHerdrRaw(ctx context.Context, socket string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", socket)
}

func dialLocalSocket(ctx context.Context, sock string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", sock)
}

func detachCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func hideCmd(_ *exec.Cmd) {}

func alive(pid int) bool {
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

func stopProcess(pid int) bool {
	if pid <= 0 || !alive(pid) {
		return true
	}
	syscall.Kill(pid, syscall.SIGINT)
	for i := 0; i < 30 && alive(pid); i++ {
		if i == 10 {
			syscall.Kill(pid, syscall.SIGTERM)
		}
		time.Sleep(200 * time.Millisecond)
	}
	return !alive(pid)
}

func interruptProcess(pid int) error {
	if pid <= 0 || !alive(pid) {
		return nil
	}
	return syscall.Kill(pid, syscall.SIGINT)
}

// isFileLockedByOtherProcess checks whether an flock-style writer lock file is
// currently held by another process (e.g. Codex Desktop's thread-writer-locks).
func isFileLockedByOtherProcess(path string) bool {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return false
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return true
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return false
}

func listProcs() (map[int]*proc, error) {
	out, err := exec.Command("ps", "-axww", "-o", "pid=,ppid=,tty=,etime=,command=").Output()
	if err != nil {
		return nil, err
	}
	ps := map[int]*proc{}
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 5 {
			continue
		}
		pid, _ := strconv.Atoi(f[0])
		ppid, _ := strconv.Atoi(f[1])
		p := &proc{pid: pid, ppid: ppid, tty: f[2], age: parseEtime(f[3]), args: f[4:]}
		p.name = progName(p.args)
		ps[pid] = p
	}
	return ps, nil
}

func cwdOf(pids []int) map[int]string {
	m := map[int]string{}
	if runtime.GOOS == "linux" {
		for _, pid := range pids {
			if c, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid)); err == nil {
				m[pid] = c
			}
		}
		return m
	}
	if len(pids) == 0 {
		return m
	}
	ids := make([]string, len(pids))
	for i, p := range pids {
		ids[i] = strconv.Itoa(p)
	}
	out, _ := exec.Command("lsof", "-a", "-d", "cwd", "-p", strings.Join(ids, ","), "-Fpn").Output()
	pid := 0
	for _, l := range strings.Split(string(out), "\n") {
		switch {
		case strings.HasPrefix(l, "p"):
			pid, _ = strconv.Atoi(l[1:])
		case strings.HasPrefix(l, "n") && pid != 0:
			m[pid] = l[1:]
		}
	}
	return m
}

func findAgyServer() *agyServer {
	if ls := findAgyHub(); ls != nil {
		return ls
	}
	// Before 2.34 the token was on the server's command line.
	out, err := exec.Command("ps", "-axww", "-o", "pid=,command=").Output()
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || !strings.HasSuffix(f[1], "/language_server") {
			continue
		}
		args := map[string]string{}
		for i := 2; i+1 < len(f); i++ {
			if strings.HasPrefix(f[i], "--") {
				args[f[i]] = f[i+1]
			}
		}
		if args["--app_data_dir"] != "antigravity" || args["--csrf_token"] == "" {
			continue
		}
		pid, err := strconv.Atoi(f[0])
		if err != nil {
			continue
		}
		for _, port := range listenPorts(pid) {
			ls := &agyServer{addr: "127.0.0.1:" + port, csrf: args["--csrf_token"]}
			if ls.probe() {
				return ls
			}
		}
	}
	return nil
}

// listenPorts: the loopback TCP ports a process listens on.
func listenPorts(pid int) []string {
	out, err := exec.Command("lsof", "-nP", "-a", "-p", strconv.Itoa(pid), "-iTCP", "-sTCP:LISTEN", "-Fn").Output()
	if err != nil {
		return nil
	}
	var ports []string
	for _, l := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(l, "n") {
			if i := strings.LastIndex(l, ":"); i > 0 {
				ports = append(ports, l[i+1:])
			}
		}
	}
	return ports
}

func openURL(ctx context.Context, link string) error {
	if runtime.GOOS == "darwin" {
		return exec.CommandContext(ctx, "open", link).Run()
	}
	return exec.CommandContext(ctx, "xdg-open", link).Run()
}

func replaceBinary(tmp, exe string) error {
	if runtime.GOOS == "darwin" {
		// Ad-hoc sign the fresh binary before renaming over an active executable
		// so Apple Silicon kernel signature caching never SIGKILLs on restart.
		_ = exec.Command("codesign", "-s", "-", "-f", tmp).Run()
	}
	return os.Rename(tmp, exe)
}

func cleanupOldBinary() {}

func restartSelf(exe string) {
	if os.Getenv("COLLIE_SUPERVISED") == "1" {
		os.Exit(0)
	}
	err := syscall.Exec(exe, os.Args, os.Environ())
	log.Printf("restart after update: %v", err)
	os.Exit(1)
}

func windowsDrives() []string { return nil }

func codexDesktopProcRunning() bool { return false }

func findBinPlatform(name, home string) string {
	for _, d := range []string{".local/bin", ".npm-global/bin", ".bun/bin", "bin"} {
		if p := filepath.Join(home, d, name); isFile(p) {
			return p
		}
	}
	for _, d := range []string{"/opt/homebrew/bin", "/usr/local/bin"} {
		if p := filepath.Join(d, name); isFile(p) {
			return p
		}
	}
	sh := os.Getenv("SHELL")
	if sh == "" {
		sh = "/bin/bash"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	out, _ := exec.CommandContext(ctx, sh, "-lic", "command -v "+name).Output()
	cancel()
	for _, l := range strings.Split(string(out), "\n") {
		if l = strings.TrimSpace(l); filepath.IsAbs(l) && isFile(l) {
			return l
		}
	}
	return ""
}

func registerDaemonAutoStart(_, _ string, _ []string) {}
func unregisterDaemonAutoStart(_ string)              {}
