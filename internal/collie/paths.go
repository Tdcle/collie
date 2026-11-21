package collie

import (
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

// defaultHerdrSocket returns the default herdr API socket/pipe path on this OS,
// matching herdr's own resolution rules (HERDR_SOCKET_PATH, XDG_CONFIG_HOME,
// %APPDATA%\herdr on Windows, ~/.config/herdr on Unix, plus HERDR_SESSION).
func defaultHerdrSocket(home string) string {
	return defaultHerdrSocketFor(runtime.GOOS, home, os.Getenv)
}

func defaultHerdrSocketFor(goos, home string, getenv func(string) string) string {
	if s := getenv("HERDR_SOCKET_PATH"); s != "" {
		return s
	}
	join := filepath.Join
	if goos == "windows" {
		join = winJoin
	} else {
		join = path.Join
	}
	var cfgDir string
	switch {
	case getenv("XDG_CONFIG_HOME") != "":
		cfgDir = join(getenv("XDG_CONFIG_HOME"), "herdr")
	case goos == "windows" && getenv("APPDATA") != "":
		cfgDir = join(getenv("APPDATA"), "herdr")
	case goos == "windows" && getenv("USERPROFILE") != "":
		cfgDir = join(getenv("USERPROFILE"), "AppData", "Roaming", "herdr")
	case goos == "windows":
		cfgDir = join(home, "AppData", "Roaming", "herdr")
	default:
		cfgDir = join(home, ".config", "herdr")
	}
	if sess := strings.TrimSpace(getenv("HERDR_SESSION")); sess != "" && sess != "default" && !strings.ContainsAny(sess, `/\:`) {
		return join(cfgDir, "sessions", sess, "herdr.sock")
	}
	return join(cfgDir, "herdr.sock")
}

func isAlpha(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// stripExtendedPrefix removes Win32 extended-length path prefixes (`\\?\C:\…`,
// `\??\C:\…`, `\\?\UNC\server\share`) so paths from Rust/Win32 canonicalize()
// match ordinary drive and UNC paths everywhere.
func stripExtendedPrefix(p string) string {
	p = strings.TrimSpace(p)
	if len(p) < 4 {
		return p
	}
	s := strings.ReplaceAll(p[:4], "/", `\`)
	if s != `\\?\` && s != `\??\` && s != `\\.\` {
		return p
	}
	if s == `\\.\` && strings.HasPrefix(strings.ToLower(strings.ReplaceAll(p[4:], "/", `\`)), `pipe\`) {
		return p // preserve Named Pipe paths (`\\.\pipe\…`)
	}
	rest := p[4:]
	if len(rest) >= 4 && strings.EqualFold(rest[:3], "unc") && (rest[3] == '\\' || rest[3] == '/') {
		return `\\` + strings.TrimLeft(rest[4:], `\/`)
	}
	if len(rest) >= 2 && isAlpha(rest[0]) && rest[1] == ':' {
		return rest
	}
	return p
}

// isWindowsPath reports whether p looks like a Windows drive or UNC path
// ("C:\…", "C:/…", "C:", "\\server\share…"), regardless of the host OS.
func isWindowsPath(p string) bool {
	p = stripExtendedPrefix(p)
	if len(p) >= 2 && isAlpha(p[0]) && p[1] == ':' && (len(p) == 2 || p[2] == '\\' || p[2] == '/') {
		return true
	}
	return strings.HasPrefix(p, `\\`)
}

func winJoin(parts ...string) string {
	var clean []string
	for _, p := range parts {
		if p != "" {
			clean = append(clean, p)
		}
	}
	if len(clean) == 0 {
		return ""
	}
	return winClean(strings.Join(clean, `\`))
}

// winClean normalises a Windows path using "\" separators, preserving drive
// roots ("C:\") and UNC prefixes ("\\server\share") even when run on Unix.
func winClean(p string) string {
	p = strings.ReplaceAll(stripExtendedPrefix(p), "/", `\`)
	if strings.HasPrefix(p, `\\`) {
		rest := strings.TrimLeft(p[2:], `\`)
		parts := strings.Split(rest, `\`)
		var out []string
		for _, seg := range parts {
			switch seg {
			case "", ".":
			case "..":
				if len(out) > 2 {
					out = out[:len(out)-1]
				}
			default:
				out = append(out, seg)
			}
		}
		return `\\` + strings.Join(out, `\`)
	}
	drive := ""
	if len(p) >= 2 && isAlpha(p[0]) && p[1] == ':' {
		drive = strings.ToUpper(p[:1]) + ":"
		p = p[2:]
	}
	rooted := strings.HasPrefix(p, `\`)
	var out []string
	for _, seg := range strings.Split(p, `\`) {
		switch seg {
		case "", ".":
		case "..":
			if len(out) > 0 && out[len(out)-1] != ".." {
				out = out[:len(out)-1]
			} else if !rooted {
				out = append(out, "..")
			}
		default:
			out = append(out, seg)
		}
	}
	if drive != "" {
		if len(out) == 0 {
			return drive + `\`
		}
		return drive + `\` + strings.Join(out, `\`)
	}
	if rooted {
		return `\` + strings.Join(out, `\`)
	}
	if len(out) == 0 {
		return "."
	}
	return strings.Join(out, `\`)
}

// expandIn resolves "~", "~/x", "~\x" and relative paths against home.
// It inspects home (not runtime.GOOS) so a Unix hub expanding a path for a
// Windows node — or vice versa — produces a native path for that machine.
func expandIn(home, p string) string {
	p = strings.TrimSpace(p)
	win := isWindowsPath(home)
	if p == "" || p == "~" {
		if win {
			return winClean(home)
		}
		return home
	}
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if win {
			return winJoin(home, p[2:])
		}
		return path.Join(home, strings.ReplaceAll(p[2:], `\`, "/"))
	}
	if win {
		if isWindowsPath(p) {
			return winClean(p)
		}
		if strings.HasPrefix(p, "/") {
			// "/c/Users/..." (Git Bash style) -> "C:\Users\..."
			if len(p) >= 3 && isAlpha(p[1]) && (len(p) == 2 || p[2] == '/') {
				return winClean(string(p[1]) + ":" + p[2:])
			}
			return winClean(home[:2] + p)
		}
		return winJoin(home, p)
	}
	if isWindowsPath(p) {
		return winClean(p)
	}
	if !strings.HasPrefix(p, "/") {
		return path.Join(home, p)
	}
	return path.Clean(p)
}

// tildeIn shortens a path inside home to "~" or "~/…" ("~\…" on Windows).
func tildeIn(home, p string) string {
	if home == "" || p == "" {
		return p
	}
	if isWindowsPath(home) || isWindowsPath(p) {
		hc, pc := winClean(home), winClean(p)
		if strings.EqualFold(hc, pc) {
			return "~"
		}
		prefix := hc
		if !strings.HasSuffix(prefix, `\`) {
			prefix += `\`
		}
		if len(pc) > len(prefix) && strings.EqualFold(pc[:len(prefix)], prefix) {
			return `~\` + pc[len(prefix):]
		}
		return pc
	}
	if p == home {
		return "~"
	}
	if strings.HasPrefix(p, home+"/") {
		return "~" + p[len(home):]
	}
	return p
}

// baseOfPath returns the final path element for either "/" or "\" paths.
func baseOfPath(p string) string {
	p = strings.TrimRight(stripExtendedPrefix(p), `/\`)
	if p == "" {
		return ""
	}
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		return p[i+1:]
	}
	return p
}

// isDriveRoot reports whether p is a Windows drive root such as "C:\" or "C:".
func isDriveRoot(p string) bool {
	p = strings.TrimRight(stripExtendedPrefix(p), `/\`)
	return len(p) == 2 && isAlpha(p[0]) && p[1] == ':'
}

// samePath compares two paths, accounting for slash direction and Windows case-insensitivity.
func samePath(a, b string) bool {
	if a == "" || b == "" {
		return a == b
	}
	if isWindowsPath(a) || isWindowsPath(b) {
		return strings.EqualFold(winClean(a), winClean(b))
	}
	return path.Clean(strings.TrimSuffix(a, "/")) == path.Clean(strings.TrimSuffix(b, "/"))
}

// claudeProjectSlug converts a working directory to Claude Code's ~/.claude/projects/<slug> name.
func claudeProjectSlug(cwd string) string {
	if isWindowsPath(cwd) {
		cwd = winClean(cwd)
	}
	return strings.NewReplacer("/", "-", `\`, "-", ":", "-", ".", "-", "_", "-").Replace(cwd)
}

// uriToPath turns a file:// URI (Unix "file:///a/b" or Windows "file:///c:/a/b") into a local path.
func uriToPath(u string) string {
	p := strings.TrimPrefix(u, "file://")
	if unescaped, err := url.PathUnescape(p); err == nil {
		p = unescaped
	}
	if len(p) >= 3 && p[0] == '/' && isAlpha(p[1]) && p[2] == ':' {
		return winClean(p[1:])
	}
	if isWindowsPath(p) {
		return winClean(p)
	}
	return strings.TrimSuffix(p, "/")
}

// sqliteURI builds a SQLite "file:" URI safe on both Unix and Windows.
func sqliteURI(p, query string) string {
	s := stripExtendedPrefix(p)
	if isWindowsPath(s) {
		s = strings.ReplaceAll(winClean(s), `\`, "/")
	} else {
		s = filepath.ToSlash(s)
	}
	s = strings.NewReplacer("%", "%25", "?", "%3f", "#", "%23").Replace(s)
	uri := "file:" + s
	if len(s) >= 2 && isAlpha(s[0]) && s[1] == ':' {
		uri = "file:///" + s
	}
	if query != "" {
		uri += "?" + query
	}
	return uri
}

// shellBin formats a binary path so it can be invoked cleanly across sh/bash,
// PowerShell and cmd.exe (forward slashes avoid bash eating backslashes).
func shellBin(bin string) string {
	if bin == "" {
		return "collie"
	}
	s := strings.ReplaceAll(bin, `\`, "/")
	if strings.ContainsAny(s, " \t") {
		return `"` + s + `"`
	}
	return s
}

func exeName(name string) string {
	if runtime.GOOS == "windows" && !strings.HasSuffix(strings.ToLower(name), ".exe") {
		return name + ".exe"
	}
	return name
}

func releaseAssetFor(goos, goarch string) string {
	name := "collie-" + goos + "-" + goarch
	if goos == "windows" {
		return name + ".exe"
	}
	return name
}
