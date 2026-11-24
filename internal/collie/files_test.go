package collie

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadFileHTMLSandboxAndAttachmentDisposition(t *testing.T) {
	dir := t.TempDir()
	srv := &Server{home: dir}

	htmlFile := filepath.Join(dir, "实验报告.html")
	if err := os.WriteFile(htmlFile, []byte("<!doctype html><h1>SFD-Net 实验报告</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	txtFile := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(txtFile, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 1. ?as=html on .html serves text/html inside strict CSP sandbox:
	req := httptest.NewRequest(http.MethodGet, "/api/file?as=html&path="+htmlFile, nil)
	rec := httptest.NewRecorder()
	srv.readFile(rec, req)
	if rec.Code != 200 {
		t.Fatalf("expected 200 for .html?as=html, got %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("expected text/html content-type, got %q", ct)
	}
	if csp := rec.Header().Get("Content-Security-Policy"); csp != htmlSandboxCSP {
		t.Fatalf("expected strict sandbox CSP %q, got %q", htmlSandboxCSP, csp)
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != "" {
		t.Fatalf("expected no Content-Disposition for ?as=html, got %q", cd)
	}

	// 2. ?as=html on non-html file is rejected with 400:
	req2 := httptest.NewRequest(http.MethodGet, "/api/file?as=html&path="+txtFile, nil)
	rec2 := httptest.NewRecorder()
	srv.readFile(rec2, req2)
	if rec2.Code != 400 {
		t.Fatalf("expected 400 for non-html ?as=html, got %d", rec2.Code)
	}

	// 3. ?download=1 sets RFC 5987 UTF-8 filename* disposition and Content-Length:
	req3 := httptest.NewRequest(http.MethodGet, "/api/file?download=1&path="+htmlFile, nil)
	rec3 := httptest.NewRecorder()
	srv.readFile(rec3, req3)
	if rec3.Code != 200 {
		t.Fatalf("expected 200 for ?download=1, got %d", rec3.Code)
	}
	cd := rec3.Header().Get("Content-Disposition")
	if !strings.Contains(cd, "filename*=UTF-8''") || !strings.Contains(cd, ".html") {
		t.Fatalf("expected RFC 5987 Content-Disposition, got %q", cd)
	}

	// 4. Windows path handling in isHTMLPath & attachmentDisposition:
	if !isHTMLPath(`C:\Users\26422\SFD-Net 2\report.htm`) {
		t.Fatal("expected Windows .htm path to match isHTMLPath")
	}
	winDisp := attachmentDisposition(`C:\Users\26422\SFD-Net 2\对比结果.csv`)
	if !strings.Contains(winDisp, `filename*=UTF-8''%E5%AF%B9%E6%AF%94%E7%BB%93%E6%9E%9C.csv`) || strings.Contains(winDisp, "SFD-Net") {
		t.Fatalf("expected Windows path basename extraction in attachmentDisposition, got %q", winDisp)
	}
}
