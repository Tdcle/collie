package collie

import (
	"bufio"
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// How full an agent's context window is, read from the tail of its transcript.
// Claude Code logs usage on every assistant turn; Codex logs token_count events
// that also carry the model's window.

type ctxUsage struct {
	Used   int `json:"used"`
	Window int `json:"window"`
}

func (u ctxUsage) Pct() int {
	if u.Window <= 0 || u.Used <= 0 {
		return 0
	}
	return u.Used * 100 / u.Window
}

var usageCache = struct {
	sync.Mutex
	m map[string]usageMark
}{m: map[string]usageMark{}}

type usageMark struct {
	mod  time.Time
	size int64
	u    ctxUsage
}

// contextUsage returns the latest usage in a transcript; claudeWindow is the
// window to assume for Claude (its logs don't say).
func contextUsage(path, format string, claudeWindow int) ctxUsage {
	fi, err := os.Stat(path)
	if err != nil {
		return ctxUsage{}
	}
	usageCache.Lock()
	m, ok := usageCache.m[path]
	usageCache.Unlock()
	if !ok || !m.mod.Equal(fi.ModTime()) || m.size != fi.Size() {
		m = usageMark{mod: fi.ModTime(), size: fi.Size(), u: readUsage(path, format, fi.Size())}
		usageCache.Lock()
		usageCache.m[path] = m
		usageCache.Unlock()
	}
	u := m.u
	if format == "claude" {
		if claudeWindow <= 0 {
			claudeWindow = 200000
		}
		u.Window = claudeWindow
	}
	return u
}

func readUsage(path, format string, size int64) ctxUsage {
	if format == "agy" {
		return agyUsage(path)
	}
	f, err := os.Open(path)
	if err != nil {
		return ctxUsage{}
	}
	defer f.Close()
	const tail = 1 << 20
	if size > tail {
		f.Seek(size-tail, io.SeekStart)
	}
	var last ctxUsage
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 16<<20)
	for sc.Scan() {
		line := sc.Bytes()
		switch format {
		case "claude":
			if !bytes.Contains(line, []byte(`"usage"`)) {
				continue
			}
			var e struct {
				Type      string `json:"type"`
				Sidechain bool   `json:"isSidechain"`
				Message   struct {
					Usage *struct {
						In     int `json:"input_tokens"`
						Read   int `json:"cache_read_input_tokens"`
						Create int `json:"cache_creation_input_tokens"`
						Out    int `json:"output_tokens"`
					} `json:"usage"`
				} `json:"message"`
			}
			if json.Unmarshal(line, &e) != nil || e.Type != "assistant" || e.Sidechain || e.Message.Usage == nil {
				continue
			}
			u := e.Message.Usage
			if n := u.In + u.Read + u.Create + u.Out; n > 0 {
				last.Used = n
			}
		case "codex":
			if !bytes.Contains(line, []byte(`"token_count"`)) {
				continue
			}
			var e struct {
				Payload struct {
					Type string `json:"type"`
					Info *struct {
						Last struct {
							Total int `json:"total_tokens"`
						} `json:"last_token_usage"`
						Window int `json:"model_context_window"`
					} `json:"info"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &e) != nil || e.Payload.Type != "token_count" || e.Payload.Info == nil {
				continue
			}
			if e.Payload.Info.Last.Total > 0 {
				last = ctxUsage{Used: e.Payload.Info.Last.Total, Window: e.Payload.Info.Window}
			}
		}
	}
	return last
}

// agyUsage: Antigravity keeps no usage in its transcript; its conversation
// database does. Each model call's metadata (protobuf) carries a context
// meter at field 1.9.10: 1 = tokens in the window now, 4 = the window.
// path is <home>/brain/<id>/.system_generated/logs/transcript.jsonl.
func agyUsage(path string) ctxUsage {
	logs := filepath.Dir(path)
	id := filepath.Base(filepath.Dir(filepath.Dir(logs)))
	home := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(logs))))
	db := filepath.Join(home, "conversations", id+".db")
	if !isFile(db) {
		return ctxUsage{}
	}
	conn, err := sql.Open("sqlite", sqliteURI(db, "mode=ro&_pragma=busy_timeout(2000)"))
	if err != nil {
		return ctxUsage{}
	}
	defer conn.Close()
	rows, err := conn.Query(`SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 8`)
	if err != nil {
		return ctxUsage{}
	}
	defer rows.Close()
	for rows.Next() {
		var b []byte
		if rows.Scan(&b) != nil {
			continue
		}
		if u, ok := agyMeter(b); ok {
			return u
		}
	}
	return ctxUsage{}
}

func agyMeter(b []byte) (ctxUsage, bool) {
	for _, f1 := range pbBytes(b, 1) {
		for _, f9 := range pbBytes(f1, 9) {
			for _, m := range pbBytes(f9, 10) {
				used, window := pbVarint(m, 1), pbVarint(m, 4)
				if used > 0 && window > 0 {
					return ctxUsage{Used: used, Window: window}, true
				}
			}
		}
	}
	return ctxUsage{}, false
}

// pbFields walks one protobuf message, calling fn for each field; it stops
// at anything malformed.
func pbFields(b []byte, fn func(num, wire int, v uint64, sub []byte)) {
	uv := func() (uint64, bool) {
		var v uint64
		for s := 0; s < 64; s += 7 {
			if len(b) == 0 {
				return 0, false
			}
			x := b[0]
			b = b[1:]
			v |= uint64(x&0x7f) << s
			if x < 0x80 {
				return v, true
			}
		}
		return 0, false
	}
	for len(b) > 0 {
		key, ok := uv()
		if !ok {
			return
		}
		num, wire := int(key>>3), int(key&7)
		switch wire {
		case 0:
			v, ok := uv()
			if !ok {
				return
			}
			fn(num, wire, v, nil)
		case 1, 5:
			n := 8
			if wire == 5 {
				n = 4
			}
			if len(b) < n {
				return
			}
			b = b[n:]
		case 2:
			l, ok := uv()
			if !ok || uint64(len(b)) < l {
				return
			}
			fn(num, wire, 0, b[:l])
			b = b[l:]
		default:
			return
		}
	}
}

func pbBytes(b []byte, num int) (out [][]byte) {
	pbFields(b, func(n, w int, _ uint64, sub []byte) {
		if n == num && w == 2 {
			out = append(out, sub)
		}
	})
	return
}

func pbVarint(b []byte, num int) (v int) {
	pbFields(b, func(n, w int, x uint64, _ []byte) {
		if n == num && w == 0 {
			v = int(x)
		}
	})
	return
}
