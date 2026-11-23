package collie

import (
	"database/sql"
	"encoding/json"
	"log"
	"sort"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"
)

// SQLite (WAL) is the source of truth for the super-agent: the trigger inbox,
// threads, workers, conversation, timers and settings (in ~/.collie/herd.db). The process keeps a
// recent working set in memory and upserts it back; history stays in the DB.

const schema = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS kv       (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS triggers (id TEXT PRIMARY KEY, n INTEGER NOT NULL, at INTEGER NOT NULL,
                                     status TEXT NOT NULL, source TEXT NOT NULL, thread TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS triggers_status ON triggers(status);
CREATE INDEX IF NOT EXISTS triggers_thread ON triggers(thread, n);
CREATE TABLE IF NOT EXISTS threads  (id TEXT PRIMARY KEY, last_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workers  (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries  (id TEXT PRIMARY KEY, n INTEGER NOT NULL, at INTEGER NOT NULL, thread TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS timers   (id TEXT PRIMARY KEY, data TEXT NOT NULL);
`

func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", sqliteURI(path, "_pragma=busy_timeout(5000)"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		return nil, err
	}
	return db, nil
}

func idNum(id string) int64 {
	n, _ := strconv.ParseInt(strings.TrimLeft(id, "abcdefghijklmnopqrstuvwxyz"), 10, 64)
	return n
}

func loadRows[T any](db *sql.DB, q string, into func(*T), args ...any) error {
	rows, err := db.Query(q, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			return err
		}
		v := new(T)
		if json.Unmarshal([]byte(data), v) == nil {
			into(v)
		}
	}
	return rows.Err()
}

func loadState(db *sql.DB, home string) (*State, error) {
	st := defaultState(home)
	kv := map[string]string{}
	rows, err := db.Query(`SELECT k, v FROM kv`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var k, v string
		rows.Scan(&k, &v)
		kv[k] = v
	}
	rows.Close()
	if v, ok := kv["seq"]; ok {
		st.Seq, _ = strconv.Atoi(v)
	}
	if v, ok := kv["settings"]; ok {
		json.Unmarshal([]byte(v), &st.Settings)
		st.Settings.migrateReply()
	}
	if v, ok := kv["policies"]; ok {
		json.Unmarshal([]byte(v), &st.Policies)
	}
	if v, ok := kv["dismissed"]; ok {
		var ids []string
		if json.Unmarshal([]byte(v), &ids) == nil {
			for _, id := range ids {
				if id != "" {
					st.Dismissed[id] = true
				}
			}
		}
	}

	var trig []*Trigger
	err = loadRows(db, `SELECT data FROM (SELECT data, n FROM triggers ORDER BY n DESC LIMIT 600) ORDER BY n`, func(t *Trigger) { trig = append(trig, t) })
	if err != nil {
		return nil, err
	}
	// Anything still queued but older than the working set is pulled in too.
	seen := map[string]bool{}
	for _, t := range trig {
		seen[t.ID] = true
	}
	loadRows(db, `SELECT data FROM triggers WHERE status='queued' ORDER BY n`, func(t *Trigger) {
		if !seen[t.ID] {
			trig = append([]*Trigger{t}, trig...)
		}
	})
	st.Triggers = trig
	loadRows(db, `SELECT data FROM (SELECT data, n FROM entries ORDER BY n DESC LIMIT 600) ORDER BY n`, func(e *Entry) { st.Entries = append(st.Entries, e) })
	loadRows(db, `SELECT data FROM threads ORDER BY last_at DESC LIMIT 500`, func(t *Thread) { st.Threads[t.ID] = t })
	loadRows(db, `SELECT data FROM workers`, func(w *Worker) { st.Workers[w.Name] = w })
	loadRows(db, `SELECT data FROM timers`, func(t *Timer) { st.Timers = append(st.Timers, t) })
	return st, nil
}

// saveState upserts the in-memory working set in one transaction.
func saveState(db *sql.DB, st *State, deletedTimers []string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	put := func(q string, args ...any) {
		if err == nil {
			_, err = tx.Exec(q, args...)
		}
	}
	js := func(v any) string { b, _ := json.Marshal(v); return string(b) }

	put(`INSERT INTO kv(k,v) VALUES('seq',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, strconv.Itoa(st.Seq))
	put(`INSERT INTO kv(k,v) VALUES('settings',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, js(st.Settings))
	put(`INSERT INTO kv(k,v) VALUES('policies',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, js(st.Policies))
	dismissed := make([]string, 0, len(st.Dismissed))
	for id, on := range st.Dismissed {
		if on && id != "" {
			dismissed = append(dismissed, id)
		}
	}
	sort.Slice(dismissed, func(i, j int) bool {
		ni, nj := idNum(dismissed[i]), idNum(dismissed[j])
		if ni != nj {
			return ni < nj
		}
		return dismissed[i] < dismissed[j]
	})
	put(`INSERT INTO kv(k,v) VALUES('dismissed',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, js(dismissed))
	for _, t := range st.Triggers {
		put(`INSERT INTO triggers(id,n,at,status,source,thread,data) VALUES(?,?,?,?,?,?,?)
		     ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data`,
			t.ID, idNum(t.ID), t.At.Unix(), t.Status, t.Source, t.Thread, js(t))
	}
	for _, th := range st.Threads {
		put(`INSERT INTO threads(id,last_at,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET last_at=excluded.last_at, data=excluded.data`,
			th.ID, th.LastAt.Unix(), js(th))
	}
	for _, w := range st.Workers {
		put(`INSERT INTO workers(name,created_at,data) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data`,
			w.Name, w.CreatedAt.Unix(), js(w))
	}
	for _, e := range st.Entries {
		put(`INSERT INTO entries(id,n,at,thread,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
			e.ID, idNum(e.ID), e.At.Unix(), e.Thread, js(e))
	}
	for _, t := range st.Timers {
		put(`INSERT INTO timers(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, t.ID, js(t))
	}
	for _, id := range deletedTimers {
		put(`DELETE FROM timers WHERE id=?`, id)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

// threadHistory reads older triggers of a thread straight from the DB, for
// recall beyond the in-memory working set.
func threadHistory(db *sql.DB, thread string, before int64, limit int) []*Trigger {
	var out []*Trigger
	loadRows(db, `SELECT data FROM triggers WHERE thread = ? AND n < ? ORDER BY n DESC LIMIT ?`,
		func(t *Trigger) { out = append(out, t) }, thread, before, limit)
	return out
}

// entryHistory reads a thread's chat from before entry number `before`,
// newest first, straight from the DB (memory keeps only the recent ones).
func entryHistory(db *sql.DB, thread string, before int64, limit int) []*Entry {
	var out []*Entry
	loadRows(db, `SELECT data FROM entries WHERE thread = ? AND n < ? ORDER BY n DESC LIMIT ?`,
		func(e *Entry) { out = append(out, e) }, thread, before, limit)
	return out
}

// loadAgentRuns restores the models agents were started with (Herdr.runs).
func loadAgentRuns(db *sql.DB, h *Herdr) {
	m := map[string][2]string{}
	var raw string
	if db.QueryRow(`SELECT v FROM kv WHERE k='agent_runs'`).Scan(&raw) == nil {
		json.Unmarshal([]byte(raw), &m)
	}
	h.LoadRuns(m, func(m map[string][2]string) {
		b, _ := json.Marshal(m)
		if _, err := db.Exec(`INSERT INTO kv(k,v) VALUES('agent_runs',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, string(b)); err != nil {
			log.Printf("save agent runs: %v", err)
		}
	})
}

// loadAgentNames restores the names Collie gave its agents (see Herdr.named)
// and keeps them saved in the kv table.
func loadAgentNames(db *sql.DB, h *Herdr) {
	m := map[string]string{}
	var raw string
	if db.QueryRow(`SELECT v FROM kv WHERE k='agent_names'`).Scan(&raw) == nil {
		json.Unmarshal([]byte(raw), &m)
	}
	h.LoadNames(m, func(m map[string]string) {
		b, _ := json.Marshal(m)
		if _, err := db.Exec(`INSERT INTO kv(k,v) VALUES('agent_names',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, string(b)); err != nil {
			log.Printf("save agent names: %v", err)
		}
	})
}
