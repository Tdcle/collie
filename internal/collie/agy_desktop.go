package collie

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// The Antigravity desktop app runs a language server on this computer. Its
// local API takes a message into a conversation the same way the app's own
// input box does (SendUserCascadeMessage), guarded by a CSRF token the app
// passes on the server's command line. Collie finds the server, its token
// and the port that speaks plain HTTP, and sends through it.
type agyServer struct {
	addr, csrf string
}

var agyServerCache struct {
	sync.Mutex
	at time.Time
	ls *agyServer
}

const agyService = "/exa.language_server_pb.LanguageServerService/"

// agyDesktopServer: the running app's language server, or nil.
func agyDesktopServer() *agyServer {
	agyServerCache.Lock()
	defer agyServerCache.Unlock()
	if time.Since(agyServerCache.at) < 20*time.Second {
		return agyServerCache.ls
	}
	agyServerCache.at, agyServerCache.ls = time.Now(), findAgyServer()
	return agyServerCache.ls
}

func forgetAgyServer() {
	agyServerCache.Lock()
	agyServerCache.at = time.Time{}
	agyServerCache.Unlock()
}

// probe: this port answers the API in plain HTTP with this token.
func (ls *agyServer) probe() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := ls.call(ctx, "GetCascadeTrajectorySteps", map[string]any{"cascadeId": "00000000-0000-0000-0000-000000000000"})
	var api *agyError
	return err == nil || errors.As(err, &api)
}

type agyError struct{ Code, Message string }

func (e *agyError) Error() string { return e.Message }

func (ls *agyServer) call(ctx context.Context, method string, body any) (json.RawMessage, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", "http://"+ls.addr+agyService+method, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("x-codeium-csrf-token", ls.csrf)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if !strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
		return nil, fmt.Errorf("Antigravity: HTTP %d", res.StatusCode)
	}
	if res.StatusCode != 200 {
		var e agyError
		json.Unmarshal(out, &e)
		if e.Message == "" {
			e.Message = fmt.Sprintf("HTTP %d", res.StatusCode)
		}
		return nil, &e
	}
	return out, nil
}

// agyAppSend puts a message into an Antigravity desktop conversation, as if
// typed in the app.
func (s *Server) agyAppSend(ctx context.Context, conversation, text string) error {
	ls := agyDesktopServer()
	if ls == nil {
		return errors.New("Antigravity 没有打开：打开它之后就能从这里发消息")
	}
	_, err := ls.call(ctx, "SendUserCascadeMessage", map[string]any{
		"cascadeId": conversation,
		"items":     []map[string]string{{"text": text}},
	})
	if err != nil {
		var api *agyError
		if !errors.As(err, &api) {
			forgetAgyServer() // the app restarted: look again next time
		}
		return fmt.Errorf("Antigravity 没收下这条消息：%w", err)
	}
	forgetDesktopRows()
	return nil
}
