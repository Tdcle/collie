package collie

import (
	"context"
	"encoding/json"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

type linkMetaInfo struct {
	URL      string    `json:"url"`
	Host     string    `json:"host"`
	Title    string    `json:"title,omitempty"`
	SiteName string    `json:"site_name,omitempty"`
	at       time.Time `json:"-"`
}

var (
	linkMetaCacheMu sync.Mutex
	linkMetaCache   = map[string]linkMetaInfo{}

	htmlTitleRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	htmlMetaRe  = regexp.MustCompile(`(?is)<meta\b[^>]*>`)
	htmlAttrRe  = regexp.MustCompile(`(?is)\b(property|name|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))`)
	htmlTagRe   = regexp.MustCompile(`<[^>]+>`)
)

func isDisallowedFetchIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}
	// Block CGNAT & cloud metadata range 100.64.0.0/10 (includes Aliyun ECS metadata 100.100.100.200).
	if ip4 := ip.To4(); ip4 != nil {
		if ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
			return true
		}
		if ip4[0] == 0 || ip4[0] >= 224 {
			return true
		}
	}
	return false
}

func safeLinkHTTPClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 2500 * time.Millisecond}
	tr := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		TLSHandshakeTimeout: 2500 * time.Millisecond,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil || len(ips) == 0 {
				return nil, net.InvalidAddrError("unable to resolve host")
			}
			for _, ia := range ips {
				if isDisallowedFetchIP(ia.IP) {
					return nil, net.InvalidAddrError("disallowed address")
				}
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		},
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 4 {
				return http.ErrUseLastResponse
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
}

func parseHTMLTitleAndSite(rawHTML string) (title, site string) {
	var ogTitle, twTitle string
	for _, tag := range htmlMetaRe.FindAllString(rawHTML, 60) {
		var key, content string
		for _, m := range htmlAttrRe.FindAllStringSubmatch(tag, -1) {
			attr := strings.ToLower(m[1])
			val := firstNonEmpty(firstNonEmpty(m[2], m[3]), m[4])
			switch attr {
			case "property", "name":
				key = strings.ToLower(strings.TrimSpace(val))
			case "content":
				content = val
			}
		}
		if content == "" {
			continue
		}
		switch key {
		case "og:title":
			if ogTitle == "" {
				ogTitle = content
			}
		case "twitter:title":
			if twTitle == "" {
				twTitle = content
			}
		case "og:site_name":
			if site == "" {
				site = content
			}
		}
	}
	title = firstNonEmpty(ogTitle, twTitle)
	if title == "" {
		if m := htmlTitleRe.FindStringSubmatch(rawHTML); len(m) > 1 {
			title = htmlTagRe.ReplaceAllString(m[1], "")
		}
	}
	clean := func(s string, maxRunes int) string {
		s = html.UnescapeString(s)
		s = strings.Join(strings.Fields(s), " ")
		if s == "" {
			return ""
		}
		return clip(s, maxRunes)
	}
	title = clean(title, 120)
	site = clean(site, 40)
	// Filter generic unhelpful bot-gate titles.
	low := strings.ToLower(title)
	if low == "just a moment..." || low == "attention required! | cloudflare" || low == "access denied" || low == "403 forbidden" || low == "404 not found" {
		title = ""
	}
	return title, site
}

func fetchLinkMeta(ctx context.Context, rawURL string) linkMetaInfo {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return linkMetaInfo{URL: rawURL}
	}
	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	info := linkMetaInfo{URL: u.String(), Host: host}

	// Skip network dial immediately if literal IP is private/loopback or localhost.
	if host == "localhost" || strings.HasSuffix(host, ".local") {
		return info
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && isDisallowedFetchIP(ip) {
		return info
	}

	linkMetaCacheMu.Lock()
	if cached, ok := linkMetaCache[info.URL]; ok && time.Since(cached.at) < 30*time.Minute {
		linkMetaCacheMu.Unlock()
		return cached
	}
	linkMetaCacheMu.Unlock()

	fctx, cancel := context.WithTimeout(ctx, 3500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(fctx, "GET", info.URL, nil)
	if err != nil {
		return info
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; CollieLinkPreview/1.0)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1")
	req.Header.Set("Range", "bytes=0-65535")

	resp, err := safeLinkHTTPClient(3500 * time.Millisecond).Do(req)
	if err == nil && resp != nil {
		defer resp.Body.Close()
		ct := strings.ToLower(resp.Header.Get("Content-Type"))
		if resp.StatusCode < 400 && (ct == "" || strings.Contains(ct, "html") || strings.Contains(ct, "xml")) {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 65536))
			info.Title, info.SiteName = parseHTMLTitleAndSite(string(b))
		}
	}

	if info.Title != "" {
		info.at = time.Now()
		linkMetaCacheMu.Lock()
		if len(linkMetaCache) > 512 {
			for k, v := range linkMetaCache {
				if time.Since(v.at) > 30*time.Minute {
					delete(linkMetaCache, k)
				}
			}
		}
		linkMetaCache[info.URL] = info
		linkMetaCacheMu.Unlock()
	}
	return info
}

func (s *Server) linkMeta(w http.ResponseWriter, r *http.Request) {
	rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if rawURL == "" {
		writeJSON(w, 200, linkMetaInfo{})
		return
	}
	info := fetchLinkMeta(r.Context(), rawURL)
	// When running on Hub (e.g. domestic cloud server) and direct fetch could not
	// reach an overseas site like github.com/arxiv.org, transparently try one online
	// connected desktop node (`?via=hub` prevents recursion).
	if info.Title == "" && r.URL.Query().Get("via") == "" && s.herdr != nil {
		for _, m := range s.herdr.Machines() {
			if m.Local || m.ID == "" || !m.Online {
				continue
			}
			client, err := s.herdr.Client(m.ID)
			if err != nil {
				continue
			}
			fctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
			req, err := http.NewRequestWithContext(fctx, "GET", "http://node/api/link-meta?via=hub&url="+url.QueryEscape(rawURL), nil)
			if err != nil {
				cancel()
				continue
			}
			res, err := client.Do(req)
			if err == nil && res != nil {
				var remote linkMetaInfo
				_ = json.NewDecoder(res.Body).Decode(&remote)
				res.Body.Close()
				cancel()
				if remote.Title != "" {
					info = remote
					info.at = time.Now()
					linkMetaCacheMu.Lock()
					linkMetaCache[info.URL] = info
					linkMetaCacheMu.Unlock()
					break
				}
			} else {
				cancel()
			}
		}
	}
	writeJSON(w, 200, info)
}
