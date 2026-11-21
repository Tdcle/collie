//go:build windows

package collie

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

func TestWindowsLiveRuntime(t *testing.T) {
	// 1. Named pipe roundtrip matching herdr's GenericNamespaced pipe naming (`\\.\pipe\<socket_path>`).
	sockFile := filepath.Join(t.TempDir(), "herdr.sock")
	ln, err := winio.ListenPipe(herdrPipePath(sockFile), nil)
	if err != nil {
		t.Fatalf("ListenPipe: %v", err)
	}
	defer ln.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		line, err := bufio.NewReader(c).ReadBytes('\n')
		if err == nil {
			_, _ = c.Write(line)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := dialHerdrRaw(ctx, sockFile)
	if err != nil {
		t.Fatalf("dialHerdrRaw: %v", err)
	}
	if _, err := c.Write([]byte("{\"id\":\"1\",\"result\":{}}\n")); err != nil {
		t.Fatalf("pipe write: %v", err)
	}
	got, err := bufio.NewReader(c).ReadString('\n')
	c.Close()
	<-done
	if err != nil || got != "{\"id\":\"1\",\"result\":{}}\n" {
		t.Fatalf("pipe echo = %q, err = %v", got, err)
	}

	// 2. Process snapshot, alive() and PEB working-directory lookup on our own process.
	pid := os.Getpid()
	if !alive(pid) {
		t.Fatalf("alive(self=%d) = false", pid)
	}
	ps, err := listProcs()
	if err != nil {
		t.Fatalf("listProcs: %v", err)
	}
	if ps[pid] == nil {
		t.Fatalf("self pid %d missing from listProcs()", pid)
	}
	wantCwd, _ := os.Getwd()
	cwds := cwdOf([]int{pid})
	if !samePath(cwds[pid], wantCwd) {
		t.Fatalf("cwdOf(self) = %q, want %q", cwds[pid], wantCwd)
	}

	// 3. Drive enumeration and birthTime.
	if drives := windowsDrives(); len(drives) == 0 {
		t.Fatalf("windowsDrives returned empty")
	}
	tmpFile := filepath.Join(t.TempDir(), "born.txt")
	if err := os.WriteFile(tmpFile, []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(tmpFile); err != nil || birthTime(fi).IsZero() {
		t.Fatalf("birthTime = %v, err = %v", birthTime(fi), err)
	}
}
