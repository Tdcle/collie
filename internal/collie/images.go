package collie

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
)

// Images in a transcript are base64 inside the log. Each one is written once
// to ~/.collie/images/, named by its content, and the message carries
// "[image:~/.collie/images/<hash>.png]" for the web app to show by path.

type imageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

var imageExt = map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}

func imageToken(src imageSource) string {
	ext, ok := imageExt[src.MediaType]
	if src.Type != "base64" || !ok || src.Data == "" {
		return "[image]"
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "[image]"
	}
	sum := sha1.Sum([]byte(src.Data))
	name := hex.EncodeToString(sum[:10]) + ext
	p := filepath.Join(home, ".collie", "images", name)
	if _, err := os.Stat(p); err != nil {
		b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(src.Data))
		if err != nil {
			return "[image]"
		}
		os.MkdirAll(filepath.Dir(p), 0o700)
		tmp := p + ".tmp"
		if os.WriteFile(tmp, b, 0o600) != nil || os.Rename(tmp, p) != nil {
			os.Remove(tmp)
			return "[image]"
		}
	}
	return "[image:~/.collie/images/" + name + "]"
}

// imageDataURLToken parses a base64 data URL (e.g. "data:image/png;base64,iVBOR...")
// from Codex/OpenAI image content items and saves it to ~/.collie/images/<hash>.<ext>.
func imageDataURLToken(u string) string {
	u = strings.TrimSpace(u)
	if !strings.HasPrefix(u, "data:") {
		if u != "" && (filepath.IsAbs(u) || strings.HasPrefix(u, "~/") || strings.HasPrefix(u, `~\`) || isWindowsPath(u) || strings.HasPrefix(u, "file://")) {
			p := uriToPath(u)
			return "[image:" + p + "]"
		}
		return ""
	}
	semi := strings.IndexByte(u, ';')
	comma := strings.IndexByte(u, ',')
	if semi <= 5 || comma <= semi {
		return ""
	}
	mediaType := strings.ToLower(strings.TrimSpace(u[5:semi]))
	enc := strings.ToLower(strings.TrimSpace(u[semi+1 : comma]))
	if enc != "base64" {
		return ""
	}
	return imageToken(imageSource{
		Type:      "base64",
		MediaType: mediaType,
		Data:      u[comma+1:],
	})
}
