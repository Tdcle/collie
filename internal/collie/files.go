package collie

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
)

// readFile lets the web app show a file an agent mentions (a report it
// wrote, a chart it drew), read-only. Bytes go out as an opaque download so
// a browser never runs them; the app decides how to show them by name.
const (
	fileTextMax  = 1 << 20
	fileImageMax = 20 << 20
)

func (s *Server) readFile(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("path")
	if len(raw) >= 3 && raw[0] == '/' && isAlpha(raw[1]) && raw[2] == ':' {
		raw = raw[1:] // "/C:/foo" from file:///C:/foo
	}
	p := s.expand(raw)
	fi, err := os.Stat(p)
	switch {
	case os.IsNotExist(err):
		writeJSON(w, 404, map[string]any{"error": "找不到这个文件"})
		return
	case err != nil:
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	case fi.IsDir():
		writeJSON(w, 400, map[string]any{"error": "这是一个文件夹"})
		return
	}
	f, err := os.Open(p)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	defer f.Close()
	limit := int64(fileTextMax)
	if r.URL.Query().Get("as") == "image" || r.URL.Query().Get("download") == "1" {
		limit = fileImageMax
	}
	b, _ := io.ReadAll(io.LimitReader(f, limit))
	kind := "text"
	if r.URL.Query().Get("as") == "image" {
		kind = "image"
	} else if r.URL.Query().Get("download") == "1" {
		kind = "download"
	} else if bytes.IndexByte(b[:min(len(b), 8000)], 0) >= 0 {
		kind, b = "binary", nil
	}
	if (kind == "image" || kind == "download") && fi.Size() > limit {
		kind, b = "binary", nil
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", "attachment")
	h.Set("Content-Security-Policy", "sandbox")
	h.Set("Cache-Control", "no-store")
	h.Set("X-File-Kind", kind)
	h.Set("X-File-Size", strconv.FormatInt(fi.Size(), 10))
	h.Set("X-File-Path", url.PathEscape(s.tilde(p)))
	w.Write(b)
}
