// Package collie is the hub, node and CLI behind the collie command.
package collie

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/lihuanyu0w0/collie/web"
)

// version is what `collie version` prints; the main package passes it in.
var version = "dev"

// Main runs the collie command with os.Args.
func Main(v string) {
	version = v
	cleanupOldBinary()
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "--version", "-v":
			fmt.Println("collie", version)
			return
		}
		if os.Args[1] == "node" {
			runNode(os.Args[2:])
			return
		}
		if os.Args[1] == "daemon" {
			runDaemon(os.Args[2:])
			return
		}
		if _, ok := cliCommands[os.Args[1]]; ok {
			runCLI(os.Args[1], os.Args[2:])
			return
		}
		if os.Args[1] == "serve" {
			os.Args = append(os.Args[:1], os.Args[2:]...)
		}
	}
	serve()
}

func serve() {
	home, _ := os.UserHomeDir()
	dir := collieDir()
	addr := flag.String("addr", envOr("COLLIE_ADDR", "0.0.0.0:7788"), "listen address")
	sock := flag.String("socket", defaultHerdrSocket(home), "herdr API socket")
	token := flag.String("token", os.Getenv("COLLIE_TOKEN"), "access token (default: generated and stored in ~/.collie/token)")
	publicURL := flag.String("url", os.Getenv("COLLIE_URL"), "address phones and computers should use, e.g. http://10.0.0.5:7788 (default: detected LAN addresses)")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: collie [serve] [flags]          run the hub\n       collie node --hub <addr> --code <c>   join this computer to a hub\n       collie pair [--computer]              new pairing code\n       collie reply|say|spawn|send|report|subscribe|stop|show|list|timer|hook …\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Fatal(err)
	}
	if *token == "" {
		*token = loadOrCreateToken(filepath.Join(dir, "token"), filepath.Join(home, ".config/collie/token"))
	} else {
		os.WriteFile(filepath.Join(dir, "token"), []byte(*token+"\n"), 0o600)
	}

	host, _ := os.Hostname()
	host = strings.TrimSuffix(host, ".local")
	srv := &Server{herdr: newHerdr(*sock, host, home), token: *token, home: home, web: web.FS}
	if *publicURL != "" {
		srv.publicURLs = strings.Split(*publicURL, ",")
	}
	sup, err := newSuper(srv, dir)
	if err != nil {
		log.Fatalf("open %s: %v", dir, err)
	}
	srv.sup = sup
	srv.auths = newAuth(sup.db, *token)
	if hn := srv.auths.HubName(); hn != "" {
		srv.herdr.RenameMachine("hub", hn)
	}
	srv.herdr.onChange = sup.changed
	loadAgentNames(sup.db, srv.herdr)
	loadAgentRuns(sup.db, srv.herdr)

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	tcp := ln.Addr().(*net.TCPAddr)
	srv.port = tcp.Port
	// The CLI (used by router and worker sessions) finds the server here.
	os.WriteFile(filepath.Join(dir, "addr"), []byte(fmt.Sprintf("127.0.0.1:%d\n", tcp.Port)), 0o600)
	printBanner(srv, tcp, *token)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go sup.Run(ctx)
	go srv.watchEndings(ctx)

	hs := &http.Server{Handler: srv.Routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		srv.auths.save()
		sc, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		hs.Shutdown(sc)
	}()
	if err := hs.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	sup.flush()
	os.Remove(filepath.Join(dir, "addr"))
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func loadOrCreateToken(path, legacy string) string {
	for _, p := range []string{path, legacy} {
		if b, err := os.ReadFile(p); err == nil {
			if t := strings.TrimSpace(string(b)); t != "" {
				if p != path {
					os.WriteFile(path, []byte(t+"\n"), 0o600)
				}
				return t
			}
		}
	}
	buf := make([]byte, 16)
	rand.Read(buf)
	t := hex.EncodeToString(buf)
	if err := os.WriteFile(path, []byte(t+"\n"), 0o600); err != nil {
		log.Printf("warning: could not persist token: %v", err)
	}
	return t
}

func printBanner(s *Server, a *net.TCPAddr, token string) {
	fmt.Println()
	fmt.Println("  collie · herding your agents")
	fmt.Println()
	addrs := []string{fmt.Sprintf("http://127.0.0.1:%d", a.Port)}
	if a.IP.IsUnspecified() {
		addrs = s.addresses(nil)
	} else if !a.IP.IsLoopback() {
		addrs = []string{fmt.Sprintf("http://%s:%d", a.IP, a.Port)}
	}
	for _, h := range addrs {
		fmt.Printf("  %s/?t=%s\n", h, token)
	}
	if a.IP.IsLoopback() {
		fmt.Println("\n  只监听本机。要让手机和其他电脑连进来，用 -addr 0.0.0.0:7788")
		fmt.Println()
		return
	}
	code, _ := s.auths.newCode("browser")
	u := pairURL(addrs[0], code)
	fmt.Println("\n  手机扫码连接（10 分钟内有效；之后用 `collie pair` 再生成）：")
	fmt.Println()
	printQR(os.Stdout, u)
	fmt.Printf("\n  %s\n\n", u)
}
