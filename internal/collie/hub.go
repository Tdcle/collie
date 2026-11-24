package collie

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/yamux"
	qrcode "github.com/skip2/go-qrcode"
)

// ---------------------------------------------------------------- forwarding to nodes

// routed sends a request about a pane, workspace or agent on another machine
// to that machine's node; everything about this machine is handled here.
func (s *Server) routed(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		machine, path := "", r.URL.Path
		for _, key := range []string{"id", "target"} {
			if v := r.PathValue(key); v != "" {
				local, m := split(v)
				machine = m
				path = strings.Replace(path, "/"+v+"/", "/"+local+"/", 1)
			}
		}
		var body []byte
		var agentProjectID string
		var extSentID string
		if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/external/") && (strings.HasSuffix(r.URL.Path, "/send") || strings.HasSuffix(r.URL.Path, "/interrupt")) {
			if strings.HasSuffix(r.URL.Path, "/send") {
				extSentID = r.PathValue("id")
			}
			if machine != "" {
				remoteExternal.Lock()
				if c := remoteExternal.m[machine]; c != nil {
					c.at = time.Time{}
				}
				remoteExternal.Unlock()
			}
		}
		switch {
		case r.URL.Path == "/api/dirs", r.URL.Path == "/api/file", r.URL.Path == "/api/uploads", r.URL.Path == "/api/transcript", r.URL.Path == "/api/models", r.URL.Path == "/api/quota", r.URL.Path == "/api/trust", r.URL.Path == "/api/update", r.URL.Path == "/api/router-sync", r.URL.Path == "/api/exec", r.URL.Path == "/api/codex/lock":
			machine = r.URL.Query().Get("machine")
		case (r.URL.Path == "/api/agents" || r.URL.Path == "/api/codex/send" || r.URL.Path == "/api/codex/interrupt" || r.URL.Path == "/api/codex/read") && r.Method == "POST":
			body, _ = io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
			var b struct {
				Machine   string `json:"machine"`
				ProjectID string `json:"project_id"`
				Thread    string `json:"thread"`
			}
			json.Unmarshal(body, &b)
			machine = b.Machine
			agentProjectID = b.ProjectID
			if r.URL.Path == "/api/codex/send" && strings.TrimSpace(b.Thread) != "" {
				extSentID = join("cx-"+strings.TrimSpace(b.Thread), machine)
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
		case r.URL.Path == "/api/state":
			machine = ""
		}
		if machine == "" {
			if extSentID != "" && s.sup != nil {
				s.sup.noteExternalSent(extSentID)
			}
			h(w, r)
			return
		}
		if extSentID != "" && s.sup != nil {
			s.sup.noteExternalSent(extSentID)
			remoteExternal.Lock()
			if c := remoteExternal.m[machine]; c != nil {
				c.at = time.Time{}
			}
			remoteExternal.Unlock()
		}
		s.forwardWithProject(w, r, machine, path, body, agentProjectID)
	}
}

func (s *Server) forward(w http.ResponseWriter, r *http.Request, machine, path string, body []byte) {
	s.forwardWithProject(w, r, machine, path, body, "")
}

func (s *Server) forwardWithProject(w http.ResponseWriter, r *http.Request, machine, path string, body []byte, agentProjectID string) {
	client, err := s.herdr.Client(machine)
	if err != nil {
		writeJSON(w, 503, map[string]any{"error": "这台电脑现在不在线（" + machine + "）"})
		return
	}
	rp := &httputil.ReverseProxy{
		Transport:     client.Transport,
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme, pr.Out.URL.Host = "http", "node"
			pr.Out.URL.Path, pr.Out.URL.RawPath = path, ""
			q := pr.In.URL.Query()
			q.Del("machine")
			pr.Out.URL.RawQuery = q.Encode()
			pr.Out.Header.Del("Authorization")
			pr.Out.Header.Del("Cookie")
			if body != nil {
				pr.Out.Body = io.NopCloser(bytes.NewReader(body))
				pr.Out.ContentLength = int64(len(body))
			}
		},
		ModifyResponse: func(resp *http.Response) error {
			if !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
				return nil
			}
			b, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil {
				return err
			}
			b = suffixIDs(b, machine)
			if agentProjectID != "" && (resp.StatusCode == 200 || resp.StatusCode == 202) {
				var launched struct {
					PaneID string `json:"pane_id"`
				}
				if json.Unmarshal(b, &launched) == nil && launched.PaneID != "" {
					s.bindPaneProject(launched.PaneID, agentProjectID)
				}
			}
			resp.Body = io.NopCloser(bytes.NewReader(b))
			resp.ContentLength = int64(len(b))
			resp.Header.Set("Content-Length", strconv.Itoa(len(b)))
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			writeJSON(w, 502, map[string]any{"error": "转发到 " + machine + " 失败：" + err.Error()})
		},
	}
	rp.ServeHTTP(w, r)
}

// ---------------------------------------------------------------- devices and pairing

// A Device is something allowed in: a phone or browser (cookie) or a computer
// running `collie node` (bearer token, may also use the CLI).
type Device struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"` // "browser" | "machine"
	Name      string    `json:"name"`
	Renamed   bool      `json:"renamed,omitempty"`
	Hostname  string    `json:"hostname,omitempty"`
	OS        string    `json:"os,omitempty"`
	Home      string    `json:"home,omitempty"`
	Hash      string    `json:"hash"`
	CreatedAt time.Time `json:"created_at"`
	LastSeen  time.Time `json:"last_seen"`
}

type pairCode struct {
	kind    string
	expires time.Time
}

type Auth struct {
	db     *sql.DB
	master string

	mu      sync.Mutex
	devices map[string]*Device // by hash
	codes   map[string]pairCode
	hubName string
	dirty   bool
}

func newAuth(db *sql.DB, master string) *Auth {
	a := &Auth{db: db, master: master, devices: map[string]*Device{}, codes: map[string]pairCode{}}
	var raw string
	if db.QueryRow(`SELECT v FROM kv WHERE k='devices'`).Scan(&raw) == nil {
		var list []*Device
		json.Unmarshal([]byte(raw), &list)
		for _, d := range list {
			a.devices[d.Hash] = d
		}
	}
	_ = db.QueryRow(`SELECT v FROM kv WHERE k='hub_name'`).Scan(&a.hubName)
	return a
}

func (a *Auth) HubName() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.hubName
}

func (a *Auth) setHubName(name string) {
	a.mu.Lock()
	a.hubName = name
	a.mu.Unlock()
	if _, err := a.db.Exec(`INSERT INTO kv(k,v) VALUES('hub_name',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, name); err != nil {
		log.Printf("save hub_name: %v", err)
	}
}

func (a *Auth) rename(id, name string) *Device {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, d := range a.devices {
		if d.ID == id {
			d.Name = name
			d.Renamed = true
			a.dirty = true
			cp := *d
			return &cp
		}
	}
	return nil
}

func hashToken(t string) string { h := sha256.Sum256([]byte(t)); return hex.EncodeToString(h[:]) }

func randomToken() string {
	b := make([]byte, 24)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// who identifies a token: the master token, a device, or nothing.
func (a *Auth) who(token string) (master bool, d *Device) {
	if token == "" {
		return false, nil
	}
	x, y := sha256.Sum256([]byte(token)), sha256.Sum256([]byte(a.master))
	if subtle.ConstantTimeCompare(x[:], y[:]) == 1 {
		return true, nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	d = a.devices[hashToken(token)]
	if d != nil && time.Since(d.LastSeen) > time.Minute {
		d.LastSeen = time.Now()
		a.dirty = true
	}
	return false, d
}

func (a *Auth) newCode(kind string) (string, time.Time) {
	b := make([]byte, 5)
	rand.Read(b)
	code := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b) // 8 chars
	exp := time.Now().Add(10 * time.Minute)
	a.mu.Lock()
	defer a.mu.Unlock()
	for c, p := range a.codes {
		if time.Now().After(p.expires) {
			delete(a.codes, c)
		}
	}
	a.codes[code] = pairCode{kind, exp}
	return code, exp
}

func deviceSlug(kind, s string) string {
	base := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-"), "-")
	if len(base) > 20 {
		base = base[:20]
	}
	if base == "" {
		base = kind
	}
	return base
}

func sameMachineIdentity(d *Device, name, osName, hostname, home string) bool {
	if d == nil || d.Kind != "machine" {
		return false
	}
	if d.OS != "" && osName != "" && !strings.EqualFold(d.OS, osName) {
		return false
	}
	if hostname != "" && d.Hostname != "" && strings.EqualFold(hostname, d.Hostname) {
		if home == "" || d.Home == "" || strings.EqualFold(home, d.Home) {
			return true
		}
	}
	if home != "" && d.Home != "" && strings.EqualFold(home, d.Home) {
		cand := hostname
		if cand == "" {
			cand = name
		}
		if d.ID == deviceSlug("machine", cand) || strings.EqualFold(d.Name, cand) {
			return true
		}
	}
	candSlug := deviceSlug("machine", hostname)
	if hostname == "" {
		candSlug = deviceSlug("machine", name)
	}
	if candSlug != "" && candSlug != "machine" && candSlug != "电脑" && d.ID == candSlug {
		if home == "" || d.Home == "" || strings.EqualFold(home, d.Home) {
			return true
		}
	}
	return false
}

// redeem turns a one-time code into a device with its own token.
// Re-pairing an already-registered physical machine rotates its token in-place
// and preserves its ID, custom display name, and projects instead of creating a duplicate.
func (a *Auth) redeem(code, kind, name, osName, hostname, home string) (*Device, string, bool, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	a.mu.Lock()
	defer a.mu.Unlock()
	p, ok := a.codes[code]
	if !ok || time.Now().After(p.expires) {
		return nil, "", false, fmt.Errorf("配对码无效或已过期")
	}
	if p.kind != kind {
		return nil, "", false, fmt.Errorf("这个配对码不是给%s用的", map[string]string{"browser": "手机或浏览器", "machine": "电脑"}[kind])
	}
	delete(a.codes, code)
	token := randomToken()
	newHash := hashToken(token)
	now := time.Now()

	if kind == "machine" {
		for oldHash, existing := range a.devices {
			if sameMachineIdentity(existing, name, osName, hostname, home) {
				delete(a.devices, oldHash)
				existing.Hash = newHash
				existing.LastSeen = now
				if osName != "" {
					existing.OS = osName
				}
				if hostname != "" {
					existing.Hostname = hostname
				}
				if home != "" {
					existing.Home = home
				}
				if !existing.Renamed && name != "" {
					existing.Name = name
				}
				a.devices[newHash] = existing
				a.dirty = true
				cp := *existing
				return &cp, token, true, nil
			}
		}
	}

	idSeed := name
	if kind == "machine" && hostname != "" && name == "" {
		idSeed = hostname
	}
	d := &Device{
		ID:        a.uniqueID(kind, idSeed),
		Kind:      kind,
		Name:      name,
		Hostname:  hostname,
		OS:        osName,
		Home:      home,
		Hash:      newHash,
		CreatedAt: now,
		LastSeen:  now,
	}
	a.devices[d.Hash] = d
	a.dirty = true
	cp := *d
	return &cp, token, false, nil
}

var slugRe = regexp.MustCompile(`[^a-z0-9-]+`)

func (a *Auth) uniqueID(kind, name string) string {
	base := deviceSlug(kind, name)
	taken := map[string]bool{}
	for _, d := range a.devices {
		taken[d.ID] = true
	}
	id := base
	for i := 2; taken[id]; i++ {
		id = fmt.Sprintf("%s-%d", base, i)
	}
	return id
}

func (a *Auth) list() []Device {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := []Device{}
	for _, d := range a.devices {
		out = append(out, *d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (a *Auth) remove(id string) *Device {
	a.mu.Lock()
	defer a.mu.Unlock()
	for h, d := range a.devices {
		if d.ID == id {
			delete(a.devices, h)
			a.dirty = true
			return d
		}
	}
	return nil
}

func (a *Auth) save() {
	a.mu.Lock()
	if !a.dirty {
		a.mu.Unlock()
		return
	}
	list := make([]*Device, 0, len(a.devices))
	for _, d := range a.devices {
		list = append(list, d)
	}
	a.dirty = false
	a.mu.Unlock()
	b, _ := json.Marshal(list)
	if _, err := a.db.Exec(`INSERT INTO kv(k,v) VALUES('devices',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, string(b)); err != nil {
		log.Printf("save devices: %v", err)
	}
}

// ---------------------------------------------------------------- addresses

func (a *Auth) noteMachineMeta(id, osName, home, hostname string) {
	a.mu.Lock()
	changed := false
	for _, d := range a.devices {
		if d.ID == id && d.Kind == "machine" {
			if osName != "" && d.OS != osName {
				d.OS, changed = osName, true
			}
			if home != "" && d.Home != home {
				d.Home, changed = home, true
			}
			if hostname != "" && d.Hostname != hostname {
				d.Hostname, changed = hostname, true
			}
		}
	}
	if changed {
		a.dirty = true
	}
	a.mu.Unlock()
	if changed {
		a.save()
	}
}

// lanAddresses lists the URLs other devices can try, best first: addresses
// given with -url, then private ranges (10/8, 192.168/16, 172.16/12), then
// CGNAT/VPN (100.64/10), then anything else that is not loopback.
func lanAddresses(port int, extra []string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(u string) {
		if !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	for _, e := range extra {
		if e = strings.TrimRight(strings.TrimSpace(e), "/"); e != "" {
			add(e)
		}
	}
	type cand struct {
		ip   net.IP
		rank int
	}
	var cs []cand
	ifs, _ := net.Interfaces()
	for _, ifc := range ifs {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 || virtualIf(ifc.Name) {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			n, ok := a.(*net.IPNet)
			if !ok || n.IP.To4() == nil {
				continue
			}
			ip := n.IP.To4()
			// Company networks are usually 10/8; home Wi-Fi 192.168/16;
			// 172.16/12 is often a local or container network.
			rank := 5
			switch {
			case ip[0] == 10:
				rank = 0
			case ip[0] == 192 && ip[1] == 168:
				rank = 1
			case ip[0] == 172 && ip[1]&0xf0 == 16:
				rank = 2
			case ip[0] == 100 && ip[1]&0xc0 == 64:
				rank = 3
			case ip[0] == 169 && ip[1] == 254:
				continue
			}
			cs = append(cs, cand{ip, rank})
		}
	}
	sort.SliceStable(cs, func(i, j int) bool { return cs[i].rank < cs[j].rank })
	for _, c := range cs {
		add(fmt.Sprintf("http://%s:%d", c.ip, port))
	}
	add(fmt.Sprintf("http://127.0.0.1:%d", port))
	return out
}

// ---------------------------------------------------------------- hub endpoints

func (s *Server) hubRoutes(mux *http.ServeMux) {
	api := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, s.auth(h)) }
	mux.HandleFunc("POST /api/pair", s.pair)
	mux.HandleFunc("GET /api/node/connect", s.nodeConnect)
	api("POST /api/pair/new", s.pairNew)
	api("GET /api/local-app", s.localApp)
	api("GET /api/qr", s.qr)
	api("GET /api/devices", s.listDevices)
	api("GET /api/quotas", s.listQuotas)
	api("GET /api/search", s.searchAll)
	api("GET /api/version", s.getVersion)
	api("GET /api/history", s.listHistory)
	api("POST /api/history/{id}/delete", s.deleteHistory)
	api("POST /api/sessions/pin", s.pinSession)
	api("POST /api/sessions/rename", s.renameSession)
	api("POST /api/sessions/archive", s.archiveSession)
	api("POST /api/sessions/delete", s.deleteSession)
	api("POST /api/sessions/project", s.assignSessionProject)
	api("POST /api/sessions/model", s.switchSessionModel)
	api("GET /api/projects", s.listProjects)
	api("POST /api/projects", s.createProject)
	api("POST /api/projects/sync", s.syncProjectsHandler)
	api("POST /api/projects/{id}/update", s.updateProject)
	api("POST /api/projects/{id}/delete", s.deleteProject)
	api("POST /api/devices/{id}/rename", s.renameDevice)
	api("POST /api/devices/{id}/delete", s.deleteDevice)
	api("GET /api/hubs", s.getHubs)
	api("POST /api/hubs", s.setHubs)
}

func isHTTPSReq(r *http.Request) bool {
	if r == nil {
		return false
	}
	if r.TLS != nil {
		return true
	}
	xfp := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	return strings.EqualFold(xfp, "https")
}

func (s *Server) addresses(r *http.Request) []string {
	list := lanAddresses(s.port, s.publicURLs)
	// The address this browser already uses works for it; keep it visible.
	if r != nil && r.Host != "" {
		cur := "http://" + r.Host
		if isHTTPSReq(r) {
			cur = "https://" + r.Host
		}
		found := false
		for _, a := range list {
			if a == cur || (cur == "http://"+r.Host && a == "https://"+r.Host) {
				found = true
			}
		}
		if !found && !strings.HasPrefix(r.Host, "localhost") && !strings.HasPrefix(r.Host, "127.") {
			list = append([]string{cur}, list...)
		}
	}
	return list
}

func (s *Server) pairNew(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Kind string `json:"kind"`
	}
	decode(w, r, &body)
	if body.Kind != "machine" {
		body.Kind = "browser"
	}
	code, exp := s.auths.newCode(body.Kind)
	writeJSON(w, 200, map[string]any{"code": code, "expires": exp, "kind": body.Kind, "addresses": s.addresses(r)})
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code     string `json:"code"`
		Kind     string `json:"kind"`
		Name     string `json:"name"`
		OS       string `json:"os"`
		Hostname string `json:"hostname"`
		Home     string `json:"home"`
		// Another hub's page keeps the token itself: it can't use our cookie.
		WantToken bool `json:"want_token"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Kind != "machine" {
		body.Kind = "browser"
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = map[string]string{"browser": "浏览器", "machine": "电脑"}[body.Kind]
	}
	if len([]rune(name)) > 40 {
		name = string([]rune(name)[:40])
	}
	d, token, rebound, err := s.auths.redeem(body.Code, body.Kind, name, strings.TrimSpace(body.OS), strings.TrimSpace(body.Hostname), strings.TrimSpace(body.Home))
	if err != nil {
		time.Sleep(500 * time.Millisecond)
		writeJSON(w, 401, map[string]any{"error": err.Error()})
		return
	}
	if rebound && d.Kind == "machine" && s.herdr != nil {
		s.herdr.detach(d.ID, nil)
	}
	go s.auths.save()
	if d.Kind == "browser" && !body.WantToken {
		setTokenCookie(w, r, token)
		writeJSON(w, 200, map[string]any{"ok": true, "id": d.ID, "name": d.Name})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "id": d.ID, "name": d.Name, "rebound": rebound, "token": token})
}

func setTokenCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: token, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: 365 * 24 * 3600, Secure: isHTTPSReq(r),
	})
}

func (s *Server) qr(w http.ResponseWriter, r *http.Request) {
	text := r.URL.Query().Get("text")
	if text == "" || len(text) > 512 {
		http.Error(w, "bad text", 400)
		return
	}
	png, err := qrcode.Encode(text, qrcode.Medium, 512)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "private, max-age=600")
	w.Write(png)
}

func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	machines := map[string]Machine{}
	for _, m := range s.herdr.Machines() {
		machines[m.ID] = m
	}
	type view struct {
		Device
		Online  bool     `json:"online"`
		Current bool     `json:"current"`
		Version string   `json:"version,omitempty"`
		Agents  []string `json:"agents"`
	}
	_, me := s.identity(r)
	out := []view{}
	for _, d := range s.auths.list() {
		v := view{Device: d}
		v.Hash = ""
		if m, ok := machines[d.ID]; ok && d.Kind == "machine" {
			v.Online, v.Version, v.Agents = m.Online, m.Version, m.Agents
			if m.Home != "" {
				v.Home = m.Home
			}
		}
		v.Current = me != nil && me.ID == d.ID
		out = append(out, v)
	}
	local := s.herdr.Machines()[0]
	_, herdrErr := s.herdr.local.conn.call(r.Context(), "workspace.list", nil)
	writeJSON(w, 200, map[string]any{
		"devices":   out,
		"hub":       map[string]any{"name": local.Name, "os": runtime.GOOS + "/" + runtime.GOARCH, "home": local.Home, "herdr": herdrErr == nil, "version": version, "agents": localAgents(local.Home, true)},
		"addresses": s.addresses(r),
		"latest":    latestVersion(true),
	})
}

func (s *Server) renameDevice(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeJSON(w, 400, map[string]any{"error": "名称不能为空"})
		return
	}
	if len([]rune(name)) > 40 {
		name = string([]rune(name)[:40])
	}
	id := r.PathValue("id")
	if id == "hub" {
		s.auths.setHubName(name)
		s.herdr.RenameMachine("hub", name)
		writeJSON(w, 200, map[string]any{"ok": true, "name": name})
		return
	}
	d := s.auths.rename(id, name)
	if d == nil {
		writeJSON(w, 404, map[string]any{"error": "找不到这台设备"})
		return
	}
	if d.Kind == "machine" {
		s.herdr.RenameMachine(d.ID, name)
	}
	go s.auths.save()
	writeJSON(w, 200, map[string]any{"ok": true, "name": name})
}

func (s *Server) deleteDevice(w http.ResponseWriter, r *http.Request) {
	d := s.auths.remove(r.PathValue("id"))
	if d == nil {
		writeJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	if d.Kind == "machine" {
		s.purgeMachineData(d.ID)
	}
	go s.auths.save()
	writeJSON(w, 200, map[string]any{"ok": true})
}

// nodeConnect upgrades a computer's connection into a multiplexed tunnel.
// The hub opens streams on it: "herdr" reaches that computer's herdr socket,
// "http" its node API (chat, screens, directories, launching).
func (s *Server) nodeConnect(w http.ResponseWriter, r *http.Request) {
	_, d := s.identity(r)
	if d == nil || d.Kind != "machine" {
		writeJSON(w, 401, map[string]any{"error": "unauthorized"})
		return
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "collie-node") {
		writeJSON(w, 400, map[string]any{"error": "upgrade required"})
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		writeJSON(w, 500, map[string]any{"error": "no hijack"})
		return
	}
	conn, buf, err := hj.Hijack()
	if err != nil {
		return
	}
	buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: collie-node\r\nConnection: Upgrade\r\n\r\n")
	if err := buf.Flush(); err != nil {
		conn.Close()
		return
	}
	cfg := yamux.DefaultConfig()
	cfg.LogOutput = io.Discard
	cfg.KeepAliveInterval = 15 * time.Second
	sess, err := yamux.Client(&bufConn{Conn: conn, r: buf.Reader}, cfg)
	if err != nil {
		conn.Close()
		return
	}
	open := func() (net.Conn, error) { return sess.Open() }
	httpDial := streamDialer(open, "http")
	m := &Machine{
		ID: d.ID, Name: d.Name, OS: r.Header.Get("X-Collie-OS"), Home: r.Header.Get("X-Collie-Home"),
		Bin: r.Header.Get("X-Collie-Bin"), Version: r.Header.Get("X-Collie-Version"), Agents: parseAgentsHeader(r.Header.Get("X-Collie-Agents")), Online: true, Since: time.Now(),
		sendReceipts: r.Header.Get("X-Collie-Send-Receipts") == "1",
		conn:         &herdrConn{dial: streamDialer(open, "herdr")},
		client: &http.Client{Transport: &http.Transport{
			DialContext:         func(ctx context.Context, _, _ string) (net.Conn, error) { return httpDial(ctx) },
			MaxIdleConnsPerHost: 8, IdleConnTimeout: 60 * time.Second, ResponseHeaderTimeout: 0,
		}},
		close: func() { sess.Close() },
	}
	if n := strings.TrimSpace(r.Header.Get("X-Collie-Name")); n != "" && !d.Renamed {
		m.Name = n
	}
	m.ip, _, _ = net.SplitHostPort(r.RemoteAddr)
	if u := r.Header.Get("X-Collie-UI"); strings.HasPrefix(u, "http://127.0.0.1:") || strings.HasPrefix(u, "http://localhost:") {
		m.ui = u
	}
	if s.auths != nil {
		s.auths.noteMachineMeta(d.ID, m.OS, m.Home, strings.TrimSpace(r.Header.Get("X-Collie-Hostname")))
	}
	s.herdr.attach(m)
	log.Printf("node %s (%s) connected from %s", m.ID, m.Name, r.RemoteAddr)
	<-sess.CloseChan()
	s.herdr.detach(m.ID, m)
	log.Printf("node %s disconnected", m.ID)
}

// bufConn reads through the bufio.Reader that may already hold tunnel bytes.
type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufConn) Read(p []byte) (int, error) { return c.r.Read(p) }

// identity reports who made a request: the master token or a paired device.
func (s *Server) identity(r *http.Request) (master bool, d *Device) {
	var got string
	if c, err := r.Cookie(cookieName); err == nil {
		got = c.Value
	} else if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		got = strings.TrimPrefix(h, "Bearer ")
	} else if t := r.URL.Query().Get("access_token"); t != "" && r.Method == http.MethodGet &&
		strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
		// An EventSource can't set headers; another hub's page passes the
		// token in the URL, for event streams only.
		got = t
	}
	if s.auths == nil {
		x, y := sha256.Sum256([]byte(got)), sha256.Sum256([]byte(s.token))
		return got != "" && subtle.ConstantTimeCompare(x[:], y[:]) == 1, nil
	}
	return s.auths.who(got)
}

// pairURL is what a phone opens after scanning.
func pairURL(base, code string) string {
	return strings.TrimRight(base, "/") + "/?pair=" + url.QueryEscape(code)
}

// printQR renders a QR code with half-block characters for a terminal.
func printQR(w io.Writer, text string) {
	q, err := qrcode.New(text, qrcode.Low)
	if err != nil {
		return
	}
	q.DisableBorder = false
	bm := q.Bitmap()
	for y := 0; y < len(bm); y += 2 {
		var b strings.Builder
		b.WriteString("  ")
		for x := 0; x < len(bm[y]); x++ {
			top := bm[y][x]
			bot := y+1 < len(bm) && bm[y+1][x]
			switch {
			case top && bot:
				b.WriteString(" ")
			case top:
				b.WriteString("▄")
			case bot:
				b.WriteString("▀")
			default:
				b.WriteString("█")
			}
		}
		fmt.Fprintln(w, b.String())
	}
}

// virtualIf reports container and VM bridges, whose addresses only make sense
// inside this machine.
func virtualIf(name string) bool {
	low := strings.ToLower(name)
	for _, p := range []string{"docker", "br-", "veth", "virbr", "cni", "flannel", "vmnet", "bridge", "lxc", "podman", "vethernet", "loopback"} {
		if strings.HasPrefix(low, p) {
			return true
		}
	}
	for _, sub := range []string{"wsl", "vmware", "virtualbox", "hyper-v"} {
		if strings.Contains(low, sub) {
			return true
		}
	}
	return false
}
