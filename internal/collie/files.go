package collie

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// readFile lets the web app preview or download a file an agent mentions or
// produces (reports, PDFs, spreadsheets, archives, charts, markdown), read-only.
const (
	fileTextMax     = 1 << 20
	fileArtifactMax = 50 << 20
)

func classifyArtifactExt(p string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(p), "."))
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
	case "txt", "log", "json", "jsonl", "yaml", "yml", "toml", "xml", "tex", "bib", "py", "go", "js", "ts", "tsx", "jsx", "css", "html", "sh", "ps1", "sql", "c", "cpp", "h", "rs", "java", "ipynb":
		return "text"
	default:
		return ""
	}
}

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

	as := r.URL.Query().Get("as")
	isDownload := r.URL.Query().Get("download") == "1"
	extKind := classifyArtifactExt(p)

	if r.URL.Query().Get("meta") == "1" {
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

	limit := int64(fileTextMax)
	if as == "image" || as == "pdf" || isDownload {
		limit = fileArtifactMax
	}
	b, _ := io.ReadAll(io.LimitReader(f, limit))

	kind := "text"
	switch {
	case as == "image":
		kind = "image"
	case as == "pdf" || extKind == "pdf":
		kind = "pdf"
	case isDownload:
		kind = "download"
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

	if (kind == "image" || kind == "pdf" || kind == "download") && fi.Size() > limit {
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
		h.Set("Content-Disposition", `attachment; filename="`+url.PathEscape(fname)+`"`)
		h.Set("Content-Security-Policy", "sandbox")
	}
	h.Set("Cache-Control", "no-store")
	h.Set("X-File-Kind", kind)
	h.Set("X-File-Size", strconv.FormatInt(fi.Size(), 10))
	h.Set("X-File-Path", url.PathEscape(s.tilde(p)))
	w.Write(b)
}
