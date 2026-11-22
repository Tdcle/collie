//go:build windows

package collie

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

const (
	stillActive                     = 259
	processCommandLineInformation   = 60
	statusInfoLengthMismatch        = 0xC0000004
	statusBufferOverflow            = 0x80000005
	statusBufferTooSmall            = 0xC0000023
)

func herdrPipePath(socket string) string {
	if strings.HasPrefix(socket, `\\.\pipe\`) {
		return socket
	}
	return `\\.\pipe\` + socket
}

func dialHerdrRaw(ctx context.Context, socket string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, herdrPipePath(socket))
}

func dialLocalSocket(ctx context.Context, sock string) (net.Conn, error) {
	if strings.HasPrefix(sock, `\\.\pipe\`) {
		return winio.DialPipeContext(ctx, sock)
	}
	var d net.Dialer
	if c, err := d.DialContext(ctx, "unix", sock); err == nil {
		return c, nil
	}
	return winio.DialPipeContext(ctx, `\\.\pipe\`+sock)
}

func detachCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP,
		HideWindow:    true,
	}
}

func hideCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NO_WINDOW,
		HideWindow:    true,
	}
}

func alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == stillActive
}

func stopProcess(pid int) bool {
	if pid <= 0 || !alive(pid) {
		return true
	}
	runKill := func(force bool) {
		args := []string{"/T", "/PID", strconv.Itoa(pid)}
		if force {
			args = append([]string{"/F"}, args...)
		}
		cmd := exec.Command("taskkill", args...)
		hideCmd(cmd)
		_ = cmd.Run()
	}
	runKill(false)
	for i := 0; i < 30 && alive(pid); i++ {
		if i == 10 {
			runKill(true)
		}
		time.Sleep(200 * time.Millisecond)
	}
	return !alive(pid)
}

// isFileLockedByOtherProcess checks whether a lock file on Windows is held
// exclusively (or without write sharing) by another running process.
func isFileLockedByOtherProcess(path string) bool {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return err == windows.ERROR_SHARING_VIOLATION || err == windows.ERROR_LOCK_VIOLATION
	}
	windows.CloseHandle(h)
	return false
}

// snapshotWinProcs lists every process via Toolhelp32 (<1 ms, no subprocess).
func snapshotWinProcs() ([]windows.ProcessEntry32, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snap)
	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	if err := windows.Process32First(snap, &pe); err != nil {
		return nil, err
	}
	var out []windows.ProcessEntry32
	for {
		out = append(out, pe)
		pe.Size = uint32(unsafe.Sizeof(pe))
		if err := windows.Process32Next(snap, &pe); err != nil {
			break
		}
	}
	return out, nil
}

func procCreationAge(h windows.Handle, now time.Time) time.Duration {
	var ct, et, kt, ut windows.Filetime
	if err := windows.GetProcessTimes(h, &ct, &et, &kt, &ut); err != nil {
		return 0
	}
	started := time.Unix(0, ct.Nanoseconds())
	if d := now.Sub(started); d > 0 {
		return d
	}
	return 0
}

func procCommandLine(h windows.Handle) string {
	size := uint32(512)
	for i := 0; i < 4; i++ {
		buf := make([]byte, size)
		var ret uint32
		err := windows.NtQueryInformationProcess(h, processCommandLineInformation, unsafe.Pointer(&buf[0]), size, &ret)
		if err == nil {
			us := (*windows.NTUnicodeString)(unsafe.Pointer(&buf[0]))
			if us.Length == 0 || us.Buffer == nil {
				return ""
			}
			n := int(us.Length / 2)
			slice := unsafe.Slice(us.Buffer, n)
			return windows.UTF16ToString(slice)
		}
		if errno, ok := err.(syscall.Errno); ok {
			code := uint32(errno)
			if (code == statusInfoLengthMismatch || code == statusBufferOverflow || code == statusBufferTooSmall) && ret > size && ret <= 1<<20 {
				size = ret + 64
				continue
			}
		}
		return ""
	}
	return ""
}

func isInspectTarget(exe string) bool {
	n := cleanProgBase(exe)
	if externalKinds[n] != "" {
		return true
	}
	switch n {
	case "node", "bun", "deno":
		return true
	}
	return false
}

func procFullImageWin(h windows.Handle) (string, error) {
	buf := make([]uint16, 1024)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		return "", err
	}
	return windows.UTF16ToString(buf[:n]), nil
}

func listProcs() (map[int]*proc, error) {
	entries, err := snapshotWinProcs()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	ps := make(map[int]*proc, len(entries))
	for _, e := range entries {
		pid := int(e.ProcessID)
		if pid == 0 {
			continue
		}
		exe := windows.UTF16ToString(e.ExeFile[:])
		p := &proc{
			pid:  pid,
			ppid: int(e.ParentProcessID),
			args: []string{exe},
			name: cleanProgBase(exe),
		}
		if isInspectTarget(exe) {
			if h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, e.ProcessID); err == nil {
				p.age = procCreationAge(h, now)
				if fullExe, err := procFullImageWin(h); err == nil && fullExe != "" {
					p.args[0] = fullExe
				}
				if cmdline := strings.TrimSpace(procCommandLine(h)); cmdline != "" && !strings.ContainsRune(cmdline, 0) {
					if argv, err := windows.DecomposeCommandLine(cmdline); err == nil && len(argv) > 0 {
						if fullExe := p.args[0]; strings.ContainsAny(fullExe, `\/`) && !strings.ContainsAny(argv[0], `\/`) {
							argv[0] = fullExe
						}
						p.args = argv
						p.name = progName(argv)
					}
				}
				windows.CloseHandle(h)
			}
			if kind := externalKinds[p.name]; kind != "" && !isDesktopOrHelperProc(kind, p.args) {
				p.tty = "console"
			}
		}
		ps[pid] = p
	}
	return ps, nil
}

func readRemoteMem(h windows.Handle, addr uintptr, dst []byte) bool {
	if addr == 0 || len(dst) == 0 {
		return false
	}
	var read uintptr
	err := windows.ReadProcessMemory(h, addr, &dst[0], uintptr(len(dst)), &read)
	return err == nil && read == uintptr(len(dst))
}

func procCwdWin(pid int) string {
	if pid <= 0 {
		return ""
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_VM_READ, false, uint32(pid))
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)

	var pbi windows.PROCESS_BASIC_INFORMATION
	var ret uint32
	if err := windows.NtQueryInformationProcess(h, windows.ProcessBasicInformation, unsafe.Pointer(&pbi), uint32(unsafe.Sizeof(pbi)), &ret); err != nil || pbi.PebBaseAddress == nil {
		return ""
	}
	var peb windows.PEB
	if !readRemoteMem(h, uintptr(unsafe.Pointer(pbi.PebBaseAddress)), unsafe.Slice((*byte)(unsafe.Pointer(&peb)), unsafe.Sizeof(peb))) || peb.ProcessParameters == nil {
		return ""
	}
	var params windows.RTL_USER_PROCESS_PARAMETERS
	if !readRemoteMem(h, uintptr(unsafe.Pointer(peb.ProcessParameters)), unsafe.Slice((*byte)(unsafe.Pointer(&params)), unsafe.Sizeof(params))) {
		return ""
	}
	us := params.CurrentDirectory.DosPath
	if us.Length == 0 || us.Length > 32768 || us.Buffer == nil {
		return ""
	}
	raw := make([]byte, us.Length)
	if !readRemoteMem(h, uintptr(unsafe.Pointer(us.Buffer)), raw) {
		return ""
	}
	u16 := unsafe.Slice((*uint16)(unsafe.Pointer(&raw[0])), len(raw)/2)
	cwd := windows.UTF16ToString(u16)
	if cwd == "" {
		return ""
	}
	return filepath.Clean(cwd)
}

func cwdOf(pids []int) map[int]string {
	m := map[int]string{}
	for _, pid := range pids {
		if c := procCwdWin(pid); c != "" {
			m[pid] = c
		}
	}
	return m
}

func findAgyServer() *agyServer {
	if ls := findAgyHub(); ls != nil {
		return ls
	}
	entries, err := snapshotWinProcs()
	if err != nil {
		return nil
	}
	for _, e := range entries {
		exe := strings.ToLower(windows.UTF16ToString(e.ExeFile[:]))
		if !strings.Contains(exe, "language_server") {
			continue
		}
		h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, e.ProcessID)
		if err != nil {
			continue
		}
		cmdline := procCommandLine(h)
		windows.CloseHandle(h)
		if cmdline == "" || strings.ContainsRune(cmdline, 0) {
			continue
		}
		argv, err := windows.DecomposeCommandLine(cmdline)
		if err != nil {
			continue
		}
		args := map[string]string{}
		for i := 1; i+1 < len(argv); i++ {
			if strings.HasPrefix(argv[i], "--") {
				args[argv[i]] = argv[i+1]
			}
		}
		if args["--app_data_dir"] != "antigravity" || args["--csrf_token"] == "" {
			continue
		}
		for _, port := range listenPorts(int(e.ProcessID)) {
			ls := &agyServer{addr: "127.0.0.1:" + port, csrf: args["--csrf_token"]}
			if ls.probe() {
				return ls
			}
		}
	}
	return nil
}

func listenPorts(pid int) []string {
	cmd := exec.Command("netstat", "-ano", "-p", "tcp")
	hideCmd(cmd)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	want := strconv.Itoa(pid)
	var ports []string
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		// TCP 127.0.0.1:54321 0.0.0.0:0 LISTENING 12345
		if len(f) < 5 || !strings.EqualFold(f[0], "TCP") || f[len(f)-1] != want {
			continue
		}
		if !strings.EqualFold(f[3], "LISTENING") {
			continue
		}
		if i := strings.LastIndexByte(f[1], ':'); i > 0 {
			ports = append(ports, f[1][i+1:])
		}
	}
	return ports
}

func openURL(ctx context.Context, link string) error {
	cmd := exec.CommandContext(ctx, "rundll32", "url.dll,FileProtocolHandler", link)
	hideCmd(cmd)
	return cmd.Run()
}

// replaceBinary swaps a new binary into exe on Windows, where a running .exe
// cannot be overwritten or deleted directly, only renamed aside. Using a
// unique backup suffix avoids "Access is denied" if a previous .old file is
// still locked across consecutive updates.
func replaceBinary(tmp, exe string) error {
	old := exe + ".old"
	if err := os.Remove(old); err != nil && !os.IsNotExist(err) {
		old = fmt.Sprintf("%s.old.%d", exe, os.Getpid())
		_ = os.Remove(old)
	}
	hadOld := false
	if _, err := os.Stat(exe); err == nil {
		if err := os.Rename(exe, old); err != nil {
			old = fmt.Sprintf("%s.old.%d", exe, time.Now().UnixNano())
			if rerr := os.Rename(exe, old); rerr != nil {
				return rerr
			}
		}
		hadOld = true
	}
	if err := os.Rename(tmp, exe); err != nil {
		if hadOld {
			_ = os.Rename(old, exe)
		}
		return err
	}
	_ = os.Remove(old) // succeeds if exe wasn't running; otherwise cleaned up on next start
	return nil
}

func cleanupOldBinary() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	_ = os.Remove(exe + ".old")
	if matches, err := filepath.Glob(exe + ".old.*"); err == nil {
		for _, m := range matches {
			_ = os.Remove(m)
		}
	}
}

func restartSelf(exe string) {
	if os.Getenv("COLLIE_SUPERVISED") == "1" {
		os.Exit(0)
	}
	// Spawn a short helper that waits for this process to release its listening
	// port before starting the updated executable.
	var quoted []string
	for _, a := range os.Args[1:] {
		quoted = append(quoted, `'`+strings.ReplaceAll(a, `'`, `''`)+`'`)
	}
	argList := ""
	if len(quoted) > 0 {
		argList = " -ArgumentList @(" + strings.Join(quoted, ",") + ")"
	}
	ps := "Start-Sleep -Milliseconds 800; Start-Process -WindowStyle Hidden -FilePath '" +
		strings.ReplaceAll(exe, `'`, `''`) + "'" + argList
	cmd := exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps)
	detachCmd(cmd)
	if err := cmd.Start(); err != nil {
		log.Printf("restart after update: %v", err)
		os.Exit(1)
	}
	os.Exit(0)
}

func windowsDrives() []string {
	var out []string
	for d := byte('A'); d <= 'Z'; d++ {
		root := string(d) + `:\`
		if fi, err := os.Stat(root); err == nil && fi.IsDir() {
			out = append(out, root)
		}
	}
	return out
}

// codexDesktopProcRunning detects the Windows Store / desktop Codex app
// (OpenAI.Codex_* running ChatGPT.exe / bundled codex.exe), which runs its own
// stdio app-server rather than exposing ~/.codex/ipc/ipc.sock.
func codexDesktopProcRunning() bool {
	entries, err := snapshotWinProcs()
	if err != nil {
		return false
	}
	for _, e := range entries {
		exe := strings.ToLower(windows.UTF16ToString(e.ExeFile[:]))
		if exe != "chatgpt.exe" && exe != "codex.exe" {
			continue
		}
		h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, e.ProcessID)
		if err != nil {
			continue
		}
		full, ferr := procFullImageWin(h)
		windows.CloseHandle(h)
		if ferr != nil || full == "" {
			continue
		}
		norm := strings.ToLower(strings.ReplaceAll(full, `\`, "/"))
		if strings.Contains(norm, "/windowsapps/openai.codex") || strings.Contains(norm, "/programs/codex/") {
			return true
		}
	}
	return false
}

func findBinPlatform(name, home string) string {
	exts := []string{".exe", ".cmd", ".bat", ""}
	if strings.ContainsRune(filepath.Base(name), '.') {
		exts = []string{""}
	}
	var dirs []string
	addDir := func(parts ...string) {
		if parts[0] != "" {
			dirs = append(dirs, filepath.Join(parts...))
		}
	}
	localApp := os.Getenv("LOCALAPPDATA")
	if localApp == "" && home != "" {
		localApp = filepath.Join(home, "AppData", "Local")
	}
	roamingApp := os.Getenv("APPDATA")
	if roamingApp == "" && home != "" {
		roamingApp = filepath.Join(home, "AppData", "Roaming")
	}
	addDir(home, ".local", "bin")
	addDir(roamingApp, "npm")
	addDir(localApp, "Programs", "Herdr", "bin")
	addDir(home, ".herdr", "packages", "standalone", "current")
	addDir(localApp, "pnpm")
	addDir(home, ".bun", "bin")
	addDir(home, ".claude", "local")
	addDir(localApp, "Programs", "claude-code")
	addDir(localApp, "Programs", "Antigravity", "bin")
	addDir(localApp, "Microsoft", "WinGet", "Links")
	addDir(home, "scoop", "shims")
	addDir(home, ".cargo", "bin")
	addDir(home, "bin")

	for _, d := range dirs {
		for _, ext := range exts {
			if p := filepath.Join(d, name+ext); isFile(p) {
				return p
			}
		}
	}
	// Refresh from User + Machine PATH in registry (catches tools installed
	// after the background daemon started).
	ps := `$p = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine'); ` +
		`$env:Path = $p; $c = Get-Command '` + strings.ReplaceAll(name, `'`, `''`) + `' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $c.Source }`
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps)
	hideCmd(cmd)
	out, _ := cmd.Output()
	for _, l := range strings.Split(string(out), "\n") {
		if l = strings.TrimSpace(l); filepath.IsAbs(l) && isFile(l) {
			return l
		}
	}
	return ""
}
