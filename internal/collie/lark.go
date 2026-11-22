package collie

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Notifications can also go out as a Feishu/Lark message from the hub's own
// lark-cli: its bot writes to whoever is logged in to it. No lark-cli on the
// hub, or no one logged in, and nothing is sent.

type larkTarget struct {
	mu      sync.Mutex
	bin     string
	openID  string
	who     string
	err     string
	checked time.Time
}

var lark larkTarget

// get says who lark-cli would write to, looking again every 10 minutes (or
// at once when asked), so installing or logging in later just works.
func (l *larkTarget) get(fresh bool) (bin, openID, who, problem string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if fresh || time.Since(l.checked) > 10*time.Minute {
		l.checked = time.Now()
		l.bin, l.openID, l.who, l.err = larkLookup()
	}
	return l.bin, l.openID, l.who, l.err
}

func larkLookup() (bin, openID, who, problem string) {
	home, _ := os.UserHomeDir()
	if bin = findBin("lark-cli", home); bin == "" {
		return "", "", "", "hub 上没有 lark-cli"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "auth", "status")
	hideCmd(cmd)
	out, err := cmd.Output()
	var st struct {
		Identities struct {
			Bot struct {
				Available bool `json:"available"`
			} `json:"bot"`
			User struct {
				OpenID   string `json:"openId"`
				UserName string `json:"userName"`
			} `json:"user"`
		} `json:"identities"`
	}
	if err != nil || json.Unmarshal(out, &st) != nil {
		return bin, "", "", "lark-cli 读不到登录状态"
	}
	if !st.Identities.Bot.Available {
		return bin, "", "", "lark-cli 的机器人身份不可用"
	}
	if st.Identities.User.OpenID == "" {
		return bin, "", "", "lark-cli 没有登录用户（lark-cli auth login）"
	}
	return bin, st.Identities.User.OpenID, st.Identities.User.UserName, ""
}

// larkSend writes to the logged-in user, as the bot (a message from yourself
// would not ring): a card, or plain text if the card is turned down.
func larkSend(ns []notice, base string) error {
	bin, openID, _, problem := lark.get(false)
	if problem != "" {
		return errors.New(problem)
	}
	send := func(args ...string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		args = append([]string{"im", "+messages-send", "--as", "bot", "--user-id", openID}, args...)
		cmd := exec.CommandContext(ctx, bin, args...)
		hideCmd(cmd)
		if out, err := cmd.CombinedOutput(); err != nil {
			return errors.New(clip(string(out), 300))
		}
		return nil
	}
	err := send("--msg-type", "interactive", "--content", larkCard(ns, base))
	if err == nil {
		return nil
	}
	text := noticesText(ns)
	if link := noticeLink(ns, base); link != "" {
		text += "\n\n打开 Collie：" + link
	}
	if err2 := send("--text", text); err2 != nil {
		lark.get(true) // logged out, or moved: look again next time
		return err2
	}
	log.Printf("notify lark: card refused, sent as text: %v", err)
	return nil
}

func isFeishuWebhook(u string) bool {
	low := strings.ToLower(strings.TrimSpace(u))
	return strings.Contains(low, "feishu.cn/") || strings.Contains(low, "larksuite.com/") || strings.Contains(low, "larkoffice.com/")
}

func noticeLink(ns []notice, base string) string {
	base = strings.TrimSpace(base)
	if base == "" {
		return ""
	}
	if strings.Contains(base, "/#/") {
		return base
	}
	hash := "/#/collie"
	for _, n := range ns {
		if n.hash != "" {
			hash = n.hash
		}
	}
	return strings.TrimRight(base, "/") + hash
}

// webhookSend delivers notices to a Feishu/Lark custom group bot webhook (as a
// rich interactive card with fallback to text) or to a Slack-compatible webhook.
func webhookSend(webhookURL string, ns []notice, base string) error {
	webhookURL = strings.TrimSpace(webhookURL)
	if !strings.HasPrefix(webhookURL, "http://") && !strings.HasPrefix(webhookURL, "https://") {
		return errors.New("Webhook 地址必须以 http:// 或 https:// 开头")
	}
	postJSON := func(payload any) error {
		body, _ := json.Marshal(payload)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, "POST", webhookURL, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if resp.StatusCode >= 300 {
			return fmt.Errorf("HTTP %d: %s", resp.StatusCode, clip(strings.TrimSpace(string(raw)), 200))
		}
		if isFeishuWebhook(webhookURL) && len(raw) > 0 {
			var r struct {
				Code          *int   `json:"code"`
				StatusCode    *int   `json:"StatusCode"`
				Msg           string `json:"msg"`
				StatusMessage string `json:"StatusMessage"`
			}
			if json.Unmarshal(raw, &r) == nil {
				code := 0
				if r.Code != nil {
					code = *r.Code
				} else if r.StatusCode != nil {
					code = *r.StatusCode
				}
				if code != 0 {
					msg := r.Msg
					if msg == "" {
						msg = r.StatusMessage
					}
					if code == 19024 {
						return fmt.Errorf("飞书机器人拒绝发送（关键词不匹配：%s，请在飞书机器人安全设置中取消自定义关键词限制）", msg)
					}
					if code == 19021 {
						return fmt.Errorf("飞书机器人拒绝发送（开启了签名校验：%s）", msg)
					}
					return fmt.Errorf("飞书机器人返回错误 (%d): %s", code, msg)
				}
			}
		}
		return nil
	}

	if isFeishuWebhook(webhookURL) {
		var cardObj map[string]any
		if json.Unmarshal([]byte(larkCard(ns, base)), &cardObj) == nil {
			err := postJSON(map[string]any{"msg_type": "interactive", "card": cardObj})
			if err == nil {
				return nil
			}
			// Security errors (keywords / signature / invalid URL) will fail for text too; surface them directly.
			if strings.Contains(err.Error(), "19024") || strings.Contains(err.Error(), "19021") || strings.Contains(err.Error(), "关键词") || strings.Contains(err.Error(), "签名") {
				return err
			}
			log.Printf("notify feishu webhook: card refused (%v), retrying as text", err)
		}
	}

	text := noticesText(ns)
	if link := noticeLink(ns, base); link != "" {
		text += "\n\n打开 Collie：" + link
	}
	return postJSON(map[string]any{
		"msg_type": "text", "content": map[string]string{"text": text},
		"text": text,
	})
}

// larkCard is a Feishu card (JSON 2.0): the header says how much it matters
// (orange when it needs you, as on the page), the body is Collie's own
// Markdown, and a button opens Collie.
func larkCard(ns []notice, base string) string {
	title, color := "Collie", "default" // plain white: colour only when it needs you
	if len(ns) == 1 && ns[0].title != "" {
		title = ns[0].title
		if ns[0].tone == "done" {
			color = "green"
		}
	}
	for _, n := range ns {
		switch {
		case n.tone == "blocked":
			title, color = n.label(), "orange"
		case n.tone == "error" && color != "orange":
			title, color = n.label(), "red"
		}
	}
	var els []any
	for i, n := range ns {
		if i > 0 {
			els = append(els, map[string]any{"tag": "hr"})
		}
		t := clip(n.text, 1500)
		if n.re != nil {
			t = "<font color='grey'>↩ " + larkEscape(n.re.line()) + "</font>\n" + t
		}
		if len(ns) > 1 && n.tone != "" && n.tone != "collie" {
			t = "**" + n.label() + "**\n" + t
		}
		els = append(els, map[string]any{"tag": "markdown", "content": t})
	}
	if link := noticeLink(ns, base); link != "" {
		btnText := "打开 Collie"
		if len(ns) == 1 && ns[0].btnLabel != "" {
			btnText = ns[0].btnLabel
		}
		els = append(els, map[string]any{
			"tag": "button", "type": "default", "width": "default",
			"text":      map[string]string{"tag": "plain_text", "content": btnText},
			"behaviors": []any{map[string]string{"type": "open_url", "default_url": link}},
		})
	}
	b, _ := json.Marshal(map[string]any{
		"schema": "2.0",
		"config": map[string]any{"summary": map[string]string{"content": clip(cardSummary(ns), 60)}},
		"header": map[string]any{"title": map[string]string{"tag": "plain_text", "content": title}, "template": color},
		"body":   map[string]any{"elements": els},
	})
	return string(b)
}

var (
	noticeImgTokenRe  = regexp.MustCompile(`(?i)\[image:[^\]]+\]\n?`)
	noticeMdImgRe     = regexp.MustCompile(`!\[([^\]\n]*)\]\((?:<[^>\r\n]+>|[^)\s]+)\)`)
	noticeLocalLinkRe = regexp.MustCompile(`\[([^\]\n]+)\]\((?:<(?:file:///?)?(?:~[\\/]|/|[A-Za-z]:[\\/])[^>\r\n]+>|(?:file:///?)?(?:~[\\/]|/|[A-Za-z]:[\\/])[^)\s]+)\)`)
)

// formatSessionNoticeText cleans local image tokens and local filesystem links
// so session replies render cleanly inside Feishu Markdown cards.
func formatSessionNoticeText(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "本轮任务已执行完成。"
	}
	hadImg := false
	if noticeImgTokenRe.MatchString(s) {
		hadImg = true
		s = noticeImgTokenRe.ReplaceAllString(s, "")
	}
	s = noticeMdImgRe.ReplaceAllStringFunc(s, func(m string) string {
		hadImg = true
		sub := noticeMdImgRe.FindStringSubmatch(m)
		if len(sub) > 1 && strings.TrimSpace(sub[1]) != "" {
			return "🖼 `" + strings.TrimSpace(sub[1]) + "`"
		}
		return "🖼 `已生成图片`"
	})
	s = noticeLocalLinkRe.ReplaceAllString(s, "`$1`")
	s = strings.TrimSpace(s)
	if s == "" && hadImg {
		return "🖼 已生成图片结果，点击下方按钮即可查看原图。"
	}
	s = clip(s, 700)
	if hadImg && !strings.Contains(s, "🖼") {
		s += "\n\n🖼 包含图片结果，打开会话即可查看原图。"
	}
	return s
}

// larkEscape keeps quoted text from being read as card Markdown.
var larkEscape = strings.NewReplacer("<", "&lt;", ">", "&gt;", "*", "\\*", "`", "'", "[", "\\[", "_", "\\_").Replace

// cardSummary is what the chat list shows for the card: the first line of
// what matters most (needs you, then an error, else the latest), without
// the Markdown marks the list would show as they are.
var mdMarks = strings.NewReplacer("**", "", "__", "", "`", "")

func cardSummary(ns []notice) string {
	pick := ns[len(ns)-1]
	for _, tone := range []string{"error", "blocked"} {
		for _, n := range ns {
			if n.tone == tone {
				pick = n
			}
		}
	}
	for _, l := range strings.Split(pick.text, "\n") {
		l = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(l), "#>-*• "))
		if l = strings.TrimSpace(mdMarks.Replace(l)); l != "" {
			return l
		}
	}
	return pick.label()
}
