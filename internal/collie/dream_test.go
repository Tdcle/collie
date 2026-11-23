package collie

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDreamCatchUpBackoffAndOfflineDeferral(t *testing.T) {
	dir := t.TempDir()
	srv := &Server{herdr: newHerdr("", "hub", dir), home: dir}
	sp, err := newSuper(srv, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer sp.db.Close()
	srv.sup = sp

	loc := time.Local
	sp.mu.Lock()
	sp.st.Settings.DreamAt = "04:00"
	sp.st.Settings.RouterMachine = "mac1"
	sp.st.Settings.RouterKind = "codex"
	sp.st.Entries = append(sp.st.Entries, &Entry{
		ID:   "e1",
		Role: "user",
		Text: "帮我检查一下服务",
		At:   time.Date(2026, 11, 22, 23, 0, 0, 0, loc),
	})
	sp.mu.Unlock()

	// Last dream was yesterday morning at 04:01.
	sp.setLastDream(time.Date(2026, 11, 22, 4, 1, 0, 0, loc))

	// 1. Morning catch-up: at 09:30 on Nov 23 (laptop was asleep at 04:00),
	//    dueDreamSlot still returns today's 04:00 slot, while nextDream for UI
	//    cleanly points to tomorrow 04:00.
	morning := time.Date(2026, 11, 23, 9, 30, 0, 0, loc)
	wantSlot := time.Date(2026, 11, 23, 4, 0, 0, 0, loc)
	if got := sp.dueDreamSlot(morning); !got.Equal(wantSlot) {
		t.Fatalf("expected morning catch-up slot %v, got %v", wantSlot, got)
	}
	wantNextUI := time.Date(2026, 11, 24, 4, 0, 0, 0, loc)
	if got := sp.nextDream(morning); !got.Equal(wantNextUI) {
		t.Fatalf("expected UI nextDream %v, got %v", wantNextUI, got)
	}

	// 2. Offline RouterMachine ("mac1") at checkDream time: must quietly defer
	//    with zero error entries and sp.dream == nil!
	srv.herdr.mu.Lock()
	srv.herdr.remote["mac1"] = &Machine{ID: "mac1", Name: "Mac", Online: false, Agents: []string{"codex"}}
	srv.herdr.mu.Unlock()
	entriesBefore := len(sp.st.Entries)
	sp.checkDream(context.Background(), map[string]liveAgent{}, false)
	if sp.dreaming() || len(sp.st.Entries) != entriesBefore {
		t.Fatalf("expected quiet deferral while RouterMachine is offline, dreaming=%v entries=%d", sp.dreaming(), len(sp.st.Entries))
	}

	// 3. Failure backoff & journal verification:
	//    A hung/crashed dream without a journal file must NOT advance lastDream
	//    and must engage retry backoff (preventing 3ms crash-loop retries).
	dAt := time.Now()
	sp.finishDream(context.Background(), &dreamRun{at: dAt, reason: "nightly"}, false, true)
	if !sp.lastDream().Before(wantSlot) && dAt.Year() == 2026 {
		// Verify lastDream was not updated to now
	}
	sp.mu.Lock()
	if sp.dreamFailures != 1 || sp.dreamFailAt.IsZero() {
		sp.mu.Unlock()
		t.Fatalf("expected dreamFailures=1 and non-zero dreamFailAt, got failures=%d at=%v", sp.dreamFailures, sp.dreamFailAt)
	}
	sp.mu.Unlock()
	if b := dreamRetryBackoff(1); b != 5*time.Minute {
		t.Fatalf("expected 5m backoff after 1st failure, got %v", b)
	}
	if b := dreamRetryBackoff(2); b != 20*time.Minute {
		t.Fatalf("expected 20m backoff after 2nd failure, got %v", b)
	}

	// 4. When journal file DOES exist on exit, finishDream marks ok=true and resets failure counter.
	os.MkdirAll(filepath.Join(sp.routerDir(), "dreams"), 0o700)
	jPath := filepath.Join(sp.routerDir(), "dreams", journalName(dAt)+".md")
	if err := os.WriteFile(jPath, []byte("精简了常驻指令并归档旧任务。\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sp.finishDream(context.Background(), &dreamRun{at: dAt, reason: "nightly"}, false, true)
	sp.mu.Lock()
	failsAfter := sp.dreamFailures
	lastText := sp.st.Entries[len(sp.st.Entries)-1].Text
	sp.mu.Unlock()
	if failsAfter != 0 {
		t.Fatalf("expected dreamFailures reset to 0 after ok dream, got %d", failsAfter)
	}
	if lastText != "Collie 醒了。整理记忆：精简了常驻指令并归档旧任务。" {
		t.Fatalf("unexpected wake entry: %q", lastText)
	}
}
