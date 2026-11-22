package collie

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// `collie daemon` runs hub (`serve`) or `node` in the background with log
// rotation and automatic restart on crash or self-update. On Windows this plays
// the role launchd / systemd --user play on macOS and Linux, without needing
// Administrator rights or opening a console window.

func daemonFiles(name string) (pidFile, childFile, stopFile, logFile string) {
	dir := collieDir()
	return filepath.Join(dir, name+".pid"),
		filepath.Join(dir, name+".child.pid"),
		filepath.Join(dir, name+".stop"),
		filepath.Join(dir, name+".log")
}

func readPID(path string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return n
}

func runDaemon(args []string) {
	usage := func() {
		fmt.Fprintf(os.Stderr, "usage: collie daemon <start|stop|restart|status|run> <hub|node> [-- args…]\n")
		os.Exit(2)
	}
	if len(args) < 2 {
		usage()
	}
	action, name := args[0], args[1]
	if name != "hub" && name != "node" {
		usage()
	}
	rest := args[2:]
	if len(rest) > 0 && rest[0] == "--" {
		rest = rest[1:]
	}
	switch action {
	case "start", "restart":
		if err := daemonStart(name, rest); err != nil {
			fmt.Fprintln(os.Stderr, "collie daemon:", err)
			os.Exit(1)
		}
	case "stop":
		daemonStop(name)
	case "status":
		pidFile, _, _, logFile := daemonFiles(name)
		if pid := readPID(pidFile); alive(pid) {
			fmt.Printf("collie-%s running (pid %d), log: %s\n", name, pid, logFile)
			return
		}
		fmt.Printf("collie-%s stopped (log: %s)\n", name, logFile)
		os.Exit(1)
	case "run":
		daemonSupervisor(name, rest)
	default:
		usage()
	}
}

func daemonStop(name string) {
	pidFile, childFile, stopFile, _ := daemonFiles(name)
	supPID := readPID(pidFile)
	childPID := readPID(childFile)
	if !alive(supPID) && !alive(childPID) {
		_ = os.Remove(pidFile)
		_ = os.Remove(childFile)
		_ = os.Remove(stopFile)
		return
	}
	_ = os.MkdirAll(collieDir(), 0o700)
	_ = os.WriteFile(stopFile, []byte("1\n"), 0o600)
	for i := 0; i < 20 && (alive(supPID) || alive(childPID)); i++ {
		time.Sleep(150 * time.Millisecond)
	}
	if alive(childPID) {
		stopProcess(childPID)
	}
	if alive(supPID) {
		stopProcess(supPID)
	}
	_ = os.Remove(pidFile)
	_ = os.Remove(childFile)
	_ = os.Remove(stopFile)
}

func daemonStart(name string, subArgs []string) error {
	daemonStop(name)
	if err := os.MkdirAll(collieDir(), 0o700); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	pidFile, _, stopFile, logFile := daemonFiles(name)
	_ = os.Remove(stopFile)

	cmdArgs := append([]string{"daemon", "run", name, "--"}, subArgs...)
	cmd := exec.Command(exe, cmdArgs...)
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	detachCmd(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()

	// Wait briefly to confirm the supervisor and child stay up.
	time.Sleep(1500 * time.Millisecond)
	if !alive(pid) && !alive(readPID(pidFile)) {
		tail := ""
		if b, err := os.ReadFile(logFile); err == nil {
			lines := strings.Split(strings.TrimSpace(string(b)), "\n")
			if len(lines) > 20 {
				lines = lines[len(lines)-20:]
			}
			tail = "\n" + strings.Join(lines, "\n")
		}
		return fmt.Errorf("failed to stay running (see %s)%s", logFile, tail)
	}
	fmt.Printf("collie-%s started (pid %d), log: %s\n", name, pid, logFile)
	return nil
}

func openRotatedLog(path string) *os.File {
	if fi, err := os.Stat(path); err == nil && fi.Size() > 10<<20 {
		_ = os.Remove(path + ".1")
		_ = os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return os.Stderr
	}
	return f
}

func daemonSupervisor(name string, subArgs []string) {
	_ = os.MkdirAll(collieDir(), 0o700)
	pidFile, childFile, stopFile, logFile := daemonFiles(name)
	myPID := os.Getpid()
	_ = os.WriteFile(pidFile, []byte(strconv.Itoa(myPID)+"\n"), 0o600)
	defer func() {
		if readPID(pidFile) == myPID {
			_ = os.Remove(pidFile)
		}
		_ = os.Remove(childFile)
	}()

	exe, err := os.Executable()
	if err != nil {
		return
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	home, _ := os.UserHomeDir()
	subcmd := "serve"
	if name == "node" {
		subcmd = "node"
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	stopping := func() bool {
		if ctx.Err() != nil {
			return true
		}
		if _, err := os.Stat(stopFile); err == nil {
			return true
		}
		if p := readPID(pidFile); p != 0 && p != myPID {
			return true
		}
		return false
	}

	stripOld := func(p string) string {
		low := strings.ToLower(p)
		if i := strings.Index(low, ".exe.old"); i > 0 {
			return p[:i+4]
		}
		if i := strings.Index(low, ".old.exe"); i > 0 {
			return p[:i] + ".exe"
		}
		return strings.TrimSuffix(p, ".old")
	}
	exe = stripOld(exe)

	backoff := 2 * time.Second
	for !stopping() {
		// Re-resolve exe on every iteration so selfUpdate's replaced binary is picked up.
		runExe := exe
		if !isFile(runExe) {
			for _, bak := range []string{runExe + ".old", strings.TrimSuffix(runExe, ".exe") + ".old.exe"} {
				if b, err := os.ReadFile(bak); err == nil && len(b) > 0 {
					_ = os.WriteFile(runExe, b, 0o755)
					break
				}
			}
		}
		lf := openRotatedLog(logFile)
		start := time.Now()
		cmd := exec.Command(runExe, append([]string{subcmd}, subArgs...)...)
		cmd.Dir = home
		cmd.Env = append(os.Environ(), "COLLIE_SUPERVISED=1")
		cmd.Stdout = lf
		cmd.Stderr = lf
		hideCmd(cmd)

		if err := cmd.Start(); err != nil {
			fmt.Fprintf(lf, "[supervisor] start %s: %v\n", runExe, err)
			if lf != os.Stderr {
				lf.Close()
			}
			time.Sleep(backoff)
			continue
		}
		_ = os.WriteFile(childFile, []byte(strconv.Itoa(cmd.Process.Pid)+"\n"), 0o600)

		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()

		for {
			select {
			case err := <-done:
				_ = os.Remove(childFile)
				if lf != os.Stderr {
					lf.Close()
				}
				if stopping() {
					_ = os.Remove(stopFile)
					return
				}
				// Clean exit (e.g. selfUpdate): if this supervisor itself was renamed
				// to .old, hand off supervision to the fresh binary so .old unlocks.
				if err == nil {
					if curExe, e := os.Executable(); e == nil && strings.Contains(strings.ToLower(curExe), ".old") && isFile(runExe) {
						nextCmd := exec.Command(runExe, append([]string{"daemon", "run", name, "--"}, subArgs...)...)
						nextCmd.Dir = home
						detachCmd(nextCmd)
						if nextCmd.Start() == nil {
							_ = nextCmd.Process.Release()
							return
						}
					}
					backoff = 2 * time.Second
					time.Sleep(500 * time.Millisecond)
					goto nextRun
				}
				if time.Since(start) > time.Minute {
					backoff = 2 * time.Second
				}
				time.Sleep(backoff)
				if backoff < 30*time.Second {
					backoff *= 2
				}
				goto nextRun
			case <-time.After(300 * time.Millisecond):
				if stopping() {
					stopProcess(cmd.Process.Pid)
					<-done
					_ = os.Remove(childFile)
					_ = os.Remove(stopFile)
					if lf != os.Stderr {
						lf.Close()
					}
					return
				}
			}
		}
	nextRun:
	}
}
