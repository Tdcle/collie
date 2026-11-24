package collie

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// readFile lets the web app preview or download a file an agent mentions or
// produces (reports, PDFs, spreadsheets, archives, charts, markdown, HTML),
// read-only. Bytes go out as an opaque download unless ?as=html or ?as=pdf is
// requested; ?as=html renders inside a strict opaque-origin CSP sandbox.
const (
	fileTextMax     = 1 << 20
	fileHTMLMax     = 5 << 20
	fileArtifactMax = 100 << 20
	htmlSandboxCSP  = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads"
)

func isHTMLPath(p string) bool {
	s := strings.ReplaceAll(strings.TrimSpace(p), "\\", "/")
	ext := strings.ToLower(path.Ext(s))
	return ext == ".html" || ext == ".htm"
}

func setHTMLSandboxHeaders(h http.Header) {
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Del("Content-Disposition")
	h.Set("Content-Security-Policy", htmlSandboxCSP)
	h.Set("Cache-Control", "no-store")
}

func attachmentDisposition(p string) string {
	name := baseOfPath(p)
	if name == "" || name == "." || name == "/" {
		name = "download"
	}
	var ascii strings.Builder
	for i := 0; i < len(name); i++ {
		c := name[i]
		if c >= 0x20 && c <= 0x7e && c != '"' && c != '\\' && c != ';' {
			ascii.WriteByte(c)
		} else {
			ascii.WriteByte('_')
		}
	}
	fallback := strings.TrimSpace(ascii.String())
	if fallback == "" {
		fallback = "download"
	}
	return `attachment; filename="` + fallback + `"; filename*=UTF-8''` + url.PathEscape(name)
}

func classifyArtifactExt(p string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(strings.ReplaceAll(p, "\\", "/")), "."))
	switch ext {
	case "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico":
		return "image"
	case "pdf":
		return "pdf"
	case "md", "markdown":
		return "markdown"
	case "csv", "tsv":
		return "csv"
	case "doc", "docx", "xls", "xlsx", "ppt", "pptx":
		return "office"
	case "zip", "tar", "gz", "tgz", "7z", "rar":
		return "archive"
	case "txt", "log", "json", "jsonl", "yaml", "yml", "toml", "xml", "tex", "bib", "py", "go", "js", "ts", "tsx", "jsx", "css", "html", "htm", "sh", "ps1", "sql", "c", "cpp", "h", "rs", "java", "ipynb":
		return "text"
	default:
		return ""
	}
}

func (s *Server) readFile(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	raw := q.Get("path")
	if len(raw) >= 3 && raw[0] == '/' && isAlpha(raw[1]) && raw[2] == ':' {
		raw = raw[1:] // "/C:/foo" from file:///C:/foo
	}
	as := q.Get("as")
	isDownload := q.Get("download") == "1"
	p := s.expand(raw)
	if !isDownload && as == "html" && (!isHTMLPath(raw) || !isHTMLPath(p)) {
		writeJSON(w, 400, map[string]any{"error": "仅支持直接打开 .html 或 .htm 文件"})
		return
	}
	fi, err := os.Stat(p)
	switch {
	case os.IsNotExist(err):
		if !s.node && s.herdr != nil && q.Get("machine") == "" {
			if isDownload && s.tryRemoteDownloadFile(w, r, raw) {
				return
			}
			if !isDownload && as == "html" && s.tryRemoteHTMLFile(w, r, raw) {
				return
			}
		}
		writeJSON(w, 404, map[string]any{"error": "找不到这个文件"})
		return
	case err != nil:
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	case fi.IsDir():
		writeJSON(w, 400, map[string]any{"error": "这是一个文件夹"})
		return
	}
	if isDownload && fi.Size() > fileArtifactMax {
		writeJSON(w, 413, map[string]any{"error": "文件超过 100 MB，无法通过网页直接下载"})
		return
	}
	f, err := os.Open(p)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	defer f.Close()

	extKind := classifyArtifactExt(p)

	if q.Get("meta") == "1" {
		kind := extKind
		if kind == "" {
			var probe [512]byte
			n, _ := f.Read(probe[:])
			if bytes.IndexByte(probe[:n], 0) >= 0 {
				kind = "binary"
			} else {
				kind = "text"
			}
		}
		writeJSON(w, 200, map[string]any{
			"ok":   true,
			"kind": kind,
			"size": fi.Size(),
			"name": baseOfPath(p),
			"path": s.tilde(p),
		})
		return
	}

	if isDownload {
		h := w.Header()
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Content-Disposition", attachmentDisposition(p))
		h.Set("Content-Security-Policy", "sandbox")
		h.Set("Cache-Control", "no-store")
		h.Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
		h.Set("X-File-Kind", "download")
		h.Set("X-File-Size", strconv.FormatInt(fi.Size(), 10))
		h.Set("X-File-Path", url.PathEscape(s.tilde(p)))
		io.Copy(w, io.LimitReader(f, fileArtifactMax))
		return
	}

	if as == "html" {
		b, _ := io.ReadAll(io.LimitReader(f, fileHTMLMax))
		if bytes.IndexByte(b[:min(len(b), 8000)], 0) >= 0 {
			writeJSON(w, 400, map[string]any{"error": "这个文件不是有效的 HTML 文本"})
			return
		}
		h := w.Header()
		setHTMLSandboxHeaders(h)
		h.Set("X-File-Kind", "html")
		h.Set("X-File-Size", strconv.FormatInt(fi.Size(), 10))
		h.Set("X-File-Path", url.PathEscape(s.tilde(p)))
		w.Write(b)
		return
	}

	limit := int64(fileTextMax)
	if as == "image" || as == "pdf" {
		limit = fileArtifactMax
	}
	b, _ := io.ReadAll(io.LimitReader(f, limit))

	kind := "text"
	switch {
	case as == "image":
		kind = "image"
	case as == "pdf" || extKind == "pdf":
		kind = "pdf"
	case bytes.IndexByte(b[:min(len(b), 8000)], 0) >= 0:
		if extKind != "" && extKind != "text" && extKind != "markdown" && extKind != "csv" {
			kind = extKind
		} else {
			kind = "binary"
		}
		b = nil
	case extKind == "csv" || extKind == "markdown":
		kind = extKind
	}

	if (kind == "image" || kind == "pdf") && fi.Size() > limit {
		kind, b = "binary", nil
	}

	fname := strings.ReplaceAll(baseOfPath(p), `"`, "")
	if fname == "" {
		fname = "download"
	}
	h := w.Header()
	if as == "pdf" && kind == "pdf" && len(b) > 0 {
		h.Set("Content-Type", "application/pdf")
		h.Set("Content-Disposition", `inline; filename="`+url.PathEscape(fname)+`"`)
	} else {
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Content-Disposition", attachmentDisposition(p))
		h.Set("Content-Security-Policy", "sandbox")
	}
	h.Set("Cache-Control", "no-store")
	h.Set("X-File-Kind", kind)
	h.Set("X-File-Size", strconv.FormatInt(fi.Size(), 10))
	h.Set("X-File-Path", url.PathEscape(s.tilde(p)))
	w.Write(b)
}

// tryRemoteDownloadFile looks across connected online nodes when a direct
// ?download=1 link hits the hub without a machine parameter and is not on hub.
func (s *Server) tryRemoteDownloadFile(w http.ResponseWriter, r *http.Request, rawPath string) bool {
	for _, m := range s.herdr.Machines() {
		if m.Local || !m.Online {
			continue
		}
		client, err := s.herdr.Client(m.ID)
		if err != nil {
			continue
		}
		u := "http://node/api/file?download=1&path=" + url.QueryEscape(rawPath)
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u, nil)
		if err != nil {
			continue
		}
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		if resp.StatusCode == http.StatusNotFound {
			resp.Body.Close()
			continue
		}
		defer resp.Body.Close()
		h := w.Header()
		for _, k := range []string{"Content-Type", "Content-Disposition", "Content-Length", "X-File-Kind", "X-File-Size", "X-File-Path"} {
			if v := resp.Header.Get(k); v != "" {
				h.Set(k, v)
			}
		}
		if resp.StatusCode == http.StatusOK {
			h.Set("Content-Type", "application/octet-stream")
			if h.Get("Content-Disposition") == "" {
				h.Set("Content-Disposition", attachmentDisposition(rawPath))
			}
			h.Set("Content-Security-Policy", "sandbox")
			h.Set("Cache-Control", "no-store")
		}
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, io.LimitReader(resp.Body, fileArtifactMax+4096))
		return true
	}
	return false
}

// tryRemoteHTMLFile looks across connected online nodes when a direct ?as=html
// link hits the hub without a machine parameter and the file is not on the hub.
func (s *Server) tryRemoteHTMLFile(w http.ResponseWriter, r *http.Request, rawPath string) bool {
	for _, m := range s.herdr.Machines() {
		if m.Local || !m.Online {
			continue
		}
		client, err := s.herdr.Client(m.ID)
		if err != nil {
			continue
		}
		u := "http://node/api/file?as=html&path=" + url.QueryEscape(rawPath)
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u, nil)
		if err != nil {
			continue
		}
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		if resp.StatusCode == http.StatusNotFound {
			resp.Body.Close()
			continue
		}
		defer resp.Body.Close()
		h := w.Header()
		for _, k := range []string{"Content-Type", "Content-Security-Policy", "Cache-Control", "X-File-Kind", "X-File-Size", "X-File-Path"} {
			if v := resp.Header.Get(k); v != "" {
				h.Set(k, v)
			}
		}
		if resp.StatusCode == http.StatusOK {
			setHTMLSandboxHeaders(h)
		}
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, io.LimitReader(resp.Body, fileHTMLMax+4096))
		return true
	}
	return false
}
