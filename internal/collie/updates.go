package collie

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The hub looks up the latest release now and then, so the devices page can
// say which computers run an older Collie. The release page's redirect
// (…/releases/latest → …/tag/vX.Y.Z) needs no API token or rate limit.

var repo = "Tdcle/collie"

func releaseRepo() string { return envOr("COLLIE_REPO", repo) }

var latestRel struct {
	sync.Mutex
	once    sync.Once
	tag     string
	checked time.Time
	busy    bool
}

// latestVersion returns the newest release tag seen so far ("" until known).
// It checks every hour; soon asks for another check in the background when the
// last one is more than a few minutes old (the devices page, where updates are
// looked at).
func latestVersion(soon bool) string {
	latestRel.once.Do(func() {
		go func() {
			for {
				refreshLatest()
				time.Sleep(time.Hour)
			}
		}()
	})
	latestRel.Lock()
	defer latestRel.Unlock()
	if soon && !latestRel.busy && !latestRel.checked.IsZero() && time.Since(latestRel.checked) > 10*time.Minute {
		go refreshLatest()
	}
	return latestRel.tag
}

func refreshLatest() {
	latestRel.Lock()
	if latestRel.busy {
		latestRel.Unlock()
		return
	}
	latestRel.busy = true
	latestRel.Unlock()
	t := fetchLatestTag()
	latestRel.Lock()
	defer latestRel.Unlock()
	latestRel.busy, latestRel.checked = false, time.Now()
	if t != "" {
		latestRel.tag = t
	}
}

func fetchLatestTag() string {
	c := &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := c.Head("https://github.com/" + releaseRepo() + "/releases/latest")
	if err != nil {
		return ""
	}
	resp.Body.Close()
	loc := resp.Header.Get("Location")
	i := strings.LastIndex(loc, "/tag/")
	if i < 0 {
		return ""
	}
	if t := loc[i+5:]; parseVersion(t) != nil {
		return t
	}
	return ""
}

// parseVersion reads "v1.2.3" (nil for "dev" and anything else).
func parseVersion(v string) []int {
	v, ok := strings.CutPrefix(v, "v")
	if !ok {
		return nil
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return nil
	}
	out := make([]int, 3)
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil
		}
		out[i] = n
	}
	return out
}

// outdated: have is a release older than latest. Builds from source ("dev")
// and unknown versions (nodes from before v0.2.5 don't say) aren't judged.
func outdated(have, latest string) bool {
	a, b := parseVersion(have), parseVersion(latest)
	if a == nil || b == nil {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

func (s *Server) getVersion(w http.ResponseWriter, r *http.Request) {
	latest := latestVersion(false)
	var old []string
	for _, m := range s.herdr.Machines() {
		v := m.Version
		if m.Local {
			v = version
		}
		if (m.Local || m.Online) && outdated(v, latest) {
			old = append(old, m.Name)
		}
	}
	writeJSON(w, 200, map[string]any{"version": version, "latest": latest, "outdated": old})
}

// selfUpdate replaces this computer's collie with the latest release and
// restarts it in place (same process id, so launchd, systemd or nohup keep
// tracking it). herdr and the agents in it keep running meanwhile.
func (s *Server) selfUpdate(w http.ResponseWriter, r *http.Request) {
	if parseVersion(version) == nil {
		writeJSON(w, 400, map[string]any{"error": "这台的 collie 是从源码编译的（" + version + "），在源码里 git pull 后重新编译来更新"})
		return
	}
	latest := fetchLatestTag()
	if latest == "" {
		writeJSON(w, 502, map[string]any{"error": "查不到最新版本：这台电脑连不上 github.com？"})
		return
	}
	if !outdated(version, latest) {
		writeJSON(w, 200, map[string]any{"ok": true, "version": version, "latest": true})
		return
	}
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": "找不到自己的程序文件：" + err.Error()})
		return
	}
	if err := downloadRelease(r.Context(), latest, exe); err != nil {
		writeJSON(w, 502, map[string]any{"error": "更新失败：" + err.Error()})
		return
	}
	log.Printf("updated %s → %s; restarting", version, latest)
	writeJSON(w, 200, map[string]any{"ok": true, "from": version, "version": latest})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go func() {
		time.Sleep(800 * time.Millisecond)
		restartSelf(exe)
	}()
}

// downloadRelease puts release tag's binary for this platform at exe,
// checked against the release's checksums and by running it once.
func downloadRelease(ctx context.Context, tag, exe string) error {
	asset := releaseAssetFor(runtime.GOOS, runtime.GOARCH)
	base := "https://github.com/" + releaseRepo() + "/releases/download/" + tag + "/"
	c := &http.Client{Timeout: 5 * time.Minute}
	get := func(name string) (*http.Response, error) {
		req, _ := http.NewRequestWithContext(ctx, "GET", base+name, nil)
		resp, err := c.Do(req)
		if err == nil && resp.StatusCode != 200 {
			resp.Body.Close()
			return nil, fmt.Errorf("下载 %s：%s", name, resp.Status)
		}
		return resp, err
	}
	resp, err := get("checksums.txt")
	if err != nil {
		return err
	}
	want := ""
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		if f := strings.Fields(sc.Text()); len(f) == 2 && f[1] == asset {
			want = f[0]
		}
	}
	resp.Body.Close()
	if want == "" {
		return fmt.Errorf("%s 没有 %s 的版本", tag, asset)
	}
	resp, err = get(asset)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	tmp := exe + ".new"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), resp.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && hex.EncodeToString(h.Sum(nil)) != want {
		err = fmt.Errorf("下载的文件校验不对，再试一次")
	}
	if err == nil {
		cmd := exec.CommandContext(ctx, tmp, "version")
		hideCmd(cmd)
		out, rerr := cmd.Output()
		if rerr != nil || !strings.Contains(string(out), tag) {
			err = fmt.Errorf("新版本在这台电脑上跑不起来：%v %s", rerr, strings.TrimSpace(string(out)))
		}
	}
	if err == nil {
		err = replaceBinary(tmp, exe)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}
