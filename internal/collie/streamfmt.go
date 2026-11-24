package collie

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var (
	ansiCSIRe       = regexp.MustCompile(`\x1b\[([0-9;]*)([A-Za-z])`)
	ansiOSCRe       = regexp.MustCompile(`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)
	ansiOtherEscRe  = regexp.MustCompile(`\x1b[@-_]`)
	tuiTableHeadRe  = regexp.MustCompile(`^\s*━{2,}(?:\s{2,}━{2,})+\s*$`)
	tuiTableRuleRe  = regexp.MustCompile(`^\s*[─━]{2,}(?:\s{2,}[─━]{2,})+\s*$`)
	linkMarkerJoin  = regexp.MustCompile("\x01L:([^\x02]+)\x02\\s*\n\\s*\x01L:([^\x02]+)\x02")
	linkMarkerPair  = regexp.MustCompile("\x01L:([^\x02]+)\x02\\s*\\(\\s*(?:\x01L:)?(https?://[^)\\s\x02]+)(?:\x02)?\\s*\\)")
	linkMarkerBare  = regexp.MustCompile("\x01L:([^\x02]+)\x02")
	plainParenLink  = regexp.MustCompile(`([\p{Han}A-Za-z0-9][^\n。！？；：()（）]{1,36}?)\s*\(\s*(https?://[^\s()<>"]+)\s*\)`)
	listOrBlockLead = regexp.MustCompile("(?m)^\\s*(?:[-*•+]\\s+|\\d+[.)]\\s+|#{1,6}\\s+|>\\s+|\\|.*\\||```|\\\\\\[|\\$\\$)")
	shellCmdLeadRe  = regexp.MustCompile(`^(?:\$\s+|#\s+)?(?:curl|wget|sudo|ssh|scp|rsync|git|cd|ls|pwd|cat|head|tail|less|echo|printf|export|env|source|chmod|chown|mkdir|rmdir|cp|mv|rm|ln|find|grep|rg|sed|awk|xargs|tar|unzip|zip|ps|top|kill|pkill|lsof|nohup|systemctl|journalctl|service|apt|apt-get|yum|dnf|pacman|apk|brew|winget|choco|scoop|pip|pip3|uv|conda|poetry|python|python3|pytest|node|npm|npx|pnpm|yarn|bun|deno|go|gofmt|cargo|rustc|javac|java|mvn|gradle|dotnet|docker|docker-compose|kubectl|helm|terraform|make|cmake|ninja|tailscale|whoami|ip|ifconfig|ping|netstat|ss|ufw|tmux|screen|launchctl|powershell|pwsh|cmd|herdr|collie)\b`)
	codeStmtLeadRe  = regexp.MustCompile(`^(?:import\s+\S|from\s+\S+\s+import\s+|package\s+\w+|func\s+\w+|def\s+\w+|async\s+def\s+|class\s+\w+|const\s+\w+|let\s+\w+|var\s+\w+|export\s+(?:default|const|function|class)\b|return\b|if\s*\(|for\s*\(|while\s*\(|#include\b)`)
	mdStripFenceRe  = regexp.MustCompile("(?m)^```[A-Za-z0-9_+-]*\\s*$")
	mdStripLinkRe   = regexp.MustCompile(`\[([^\]\n]+)\]\((?:<[^>\n]+>|[^)\s]+)\)`)
)

// stripANSICodes removes CSI/OSC escape sequences and HTML comments (`<!-- -->`)
// injected by ratatui/herdr while preserving line breaks.
func stripANSICodes(s string) string {
	if !strings.Contains(s, "\x1b") && !strings.Contains(s, "<!--") {
		return s
	}
	s = ansiOSCRe.ReplaceAllString(s, "")
	s = ansiCSIRe.ReplaceAllString(s, "")
	s = ansiOtherEscRe.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "<!-- -->", "")
	return strings.ReplaceAll(s, "\r", "")
}

// compactComparable normalizes both reconstructed terminal streaming Markdown
// and committed `.jsonl` Markdown into a canonical plain-character fingerprint
// so deduplication never double-renders at turn completion.
func compactComparable(s string) string {
	s = mdStripFenceRe.ReplaceAllString(s, "")
	s = mdStripLinkRe.ReplaceAllString(s, "$1")
	var b strings.Builder
	for _, r := range s {
		switch r {
		case ' ', '\n', '\r', '\t', '…', '*', '`', '|', '｜', '━', '─', '_', '[', ']', '<', '>':
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

type ansiSpan struct {
	text       string
	bold       bool
	dim        bool
	underline  bool
	inlineCode bool
	syntaxCol  bool
}

func parseANSISpans(line string) []ansiSpan {
	line = strings.ReplaceAll(strings.ReplaceAll(line, "\r", ""), "<!-- -->", "")
	var spans []ansiSpan
	var bold, dim, underline, inlineCode, syntaxCol bool
	pos := 0
	for _, m := range ansiCSIRe.FindAllStringSubmatchIndex(line, -1) {
		if m[0] > pos {
			spans = append(spans, ansiSpan{
				text: line[pos:m[0]], bold: bold, dim: dim,
				underline: underline, inlineCode: inlineCode, syntaxCol: syntaxCol,
			})
		}
		cmd := line[m[4]:m[5]]
		if cmd == "m" {
			rawParams := line[m[2]:m[3]]
			if rawParams == "" {
				bold, dim, underline, inlineCode, syntaxCol = false, false, false, false, false
			} else {
				parts := strings.Split(rawParams, ";")
				for i := 0; i < len(parts); i++ {
					n, err := strconv.Atoi(parts[i])
					if err != nil {
						continue
					}
					switch n {
					case 0:
						bold, dim, underline, inlineCode, syntaxCol = false, false, false, false, false
					case 1:
						bold = true
					case 2:
						dim = true
					case 4:
						underline = true
					case 22:
						bold, dim = false, false
					case 24:
						underline = false
					case 32, 36, 92, 96:
						inlineCode = true
					case 39:
						inlineCode, syntaxCol = false, false
					case 38:
						if i+4 < len(parts) && parts[i+1] == "2" {
							r, _ := strconv.Atoi(parts[i+2])
							g, _ := strconv.Atoi(parts[i+3])
							bl, _ := strconv.Atoi(parts[i+4])
							i += 4
							// Codex TUI Catppuccin Mocha inline-code green: 166;227;161
							if r == 166 && g == 227 && bl == 161 {
								inlineCode = true
								syntaxCol = false
							} else {
								inlineCode = false
								// Non-default syntax token colors (exclude prose white 238, bold pink 243;139;168, link blue 137;180;250)
								isDefault := (r == 238 && g == 238 && bl == 238) ||
									(r == 243 && g == 139 && bl == 168) ||
									(r == 137 && g == 180 && bl == 250)
								syntaxCol = !isDefault
							}
						} else if i+2 < len(parts) && parts[i+1] == "5" {
							i += 2
						}
					case 48:
						if i+4 < len(parts) && parts[i+1] == "2" {
							i += 4
						} else if i+2 < len(parts) && parts[i+1] == "5" {
							i += 2
						}
					}
				}
			}
		}
		pos = m[1]
	}
	if pos < len(line) {
		spans = append(spans, ansiSpan{
			text: line[pos:], bold: bold, dim: dim,
			underline: underline, inlineCode: inlineCode, syntaxCol: syntaxCol,
		})
	}
	return spans
}

func ansiReplyLineToMD(ansiLine string, isFirst bool) (mdLine string, hasSyntax bool) {
	spans := parseANSISpans(ansiLine)
	if len(spans) == 0 {
		return "", false
	}
	// Strip leading `• ` / `● ` / `⏺ ` on first line, or 2-space cell indent on continuation lines.
	strippedPrefix := false
	trimBulletSpace := false
	var merged []ansiSpan
	for _, sp := range spans {
		txt := sp.text
		if trimBulletSpace {
			txt = strings.TrimLeft(txt, " ")
			trimBulletSpace = false
		}
		if !strippedPrefix {
			if isFirst {
				if loc := liveReplyLead.FindStringIndex(txt); loc != nil && loc[0] == 0 {
					txt = txt[loc[1]:]
					strippedPrefix = true
				} else if strings.TrimSpace(txt) == "•" || strings.TrimSpace(txt) == "●" || strings.TrimSpace(txt) == "⏺" {
					txt = ""
					strippedPrefix = true
					trimBulletSpace = true
				}
			} else if strings.HasPrefix(txt, "  ") {
				txt = txt[2:]
				strippedPrefix = true
			} else if txt == " " {
				continue
			} else {
				strippedPrefix = true
			}
		}
		if txt == "" {
			continue
		}
		if sp.syntaxCol && strings.TrimSpace(txt) != "" {
			hasSyntax = true
		}
		// Coalesce adjacent spans with identical semantic styling
		styleEq := func(a, b ansiSpan) bool {
			return (a.bold && !a.dim) == (b.bold && !b.dim) &&
				a.underline == b.underline &&
				(a.inlineCode && !a.bold && !a.underline) == (b.inlineCode && !b.bold && !b.underline)
		}
		sp.text = txt
		if len(merged) > 0 && styleEq(merged[len(merged)-1], sp) {
			merged[len(merged)-1].text += txt
		} else {
			merged = append(merged, sp)
		}
	}

	var b strings.Builder
	for _, sp := range merged {
		t := sp.text
		trimmed := strings.TrimSpace(t)
		if trimmed == "" {
			b.WriteString(t)
			continue
		}
		leadWS := t[:strings.Index(t, trimmed)]
		tailWS := t[strings.Index(t, trimmed)+len(trimmed):]
		switch {
		case sp.underline:
			b.WriteString(leadWS + "\x01L:" + trimmed + "\x02" + tailWS)
		case sp.bold && !sp.dim:
			b.WriteString(leadWS + "**" + trimmed + "**" + tailWS)
		case sp.inlineCode && !sp.bold && !sp.dim:
			if !strings.Contains(trimmed, "`") {
				b.WriteString(leadWS + "`" + trimmed + "`" + tailWS)
			} else {
				b.WriteString(t)
			}
		default:
			b.WriteString(t)
		}
	}
	return strings.TrimRight(b.String(), " \t"), hasSyntax
}

func isCJK(r rune) bool {
	return unicode.Is(unicode.Han, r) ||
		(r >= 0x3000 && r <= 0x303F) ||
		(r >= 0xFF00 && r <= 0xFFEF)
}

func joinSoftWrapped(prev, next string) string {
	p := strings.TrimRight(prev, " \t")
	n := strings.TrimLeft(next, " \t")
	if p == "" {
		return n
	}
	if n == "" {
		return p
	}
	pr := []rune(p)
	nr := []rune(n)
	lastR := pr[len(pr)-1]
	firstR := nr[0]
	// Adjacent CJK characters (e.g. `选` + `择` + `同一个网络`) join WITHOUT spaces!
	if isCJK(lastR) || isCJK(firstR) {
		return p + n
	}
	// URLs wrapped mid-path join without spaces
	if strings.Contains(p, "http://") || strings.Contains(p, "https://") {
		lastTok := p
		if idx := strings.LastIndexAny(p, " \t("); idx >= 0 {
			lastTok = p[idx+1:]
		}
		if strings.HasPrefix(lastTok, "http://") || strings.HasPrefix(lastTok, "https://") {
			return p + n
		}
	}
	return p + " " + n
}

func stripInlineMDMarks(s string) string {
	s = linkMarkerBare.ReplaceAllString(s, "$1")
	s = strings.ReplaceAll(s, "**", "")
	s = strings.ReplaceAll(s, "`", "")
	return s
}

func isStreamCodeLine(plain string, hasSyntax bool) bool {
	t := strings.TrimSpace(plain)
	if t == "" {
		return false
	}
	if listOrBlockLead.MatchString(t) {
		return false
	}
	if shellCmdLeadRe.MatchString(t) || codeStmtLeadRe.MatchString(t) {
		return true
	}
	// Continuation of a shell pipeline / flags (`--flag ...`, `| sh`, `\`)
	if strings.HasPrefix(t, "--") || strings.HasPrefix(t, "| ") || strings.HasSuffix(t, " \\") {
		return true
	}
	// Syntax-colored non-CJK code line (`x = foo(bar)`, `{ "a": 1 }`, etc.)
	if hasSyntax {
		hasHan := false
		for _, r := range t {
			if unicode.Is(unicode.Han, r) {
				hasHan = true
				break
			}
		}
		if !hasHan && !strings.HasSuffix(t, ".") {
			return true
		}
	}
	return false
}

func guessFenceLang(lines []string) string {
	joined := strings.Join(lines, "\n")
	low := strings.ToLower(joined)
	switch {
	case strings.Contains(low, "powershell") || strings.Contains(low, "get-childitem") || strings.Contains(low, "invoke-webrequest"):
		return "powershell"
	case codeStmtLeadRe.MatchString(strings.TrimSpace(lines[0])):
		first := strings.TrimSpace(lines[0])
		switch {
		case strings.HasPrefix(first, "def ") || strings.HasPrefix(first, "import ") || strings.HasPrefix(first, "from "):
			return "python"
		case strings.HasPrefix(first, "func ") || strings.HasPrefix(first, "package "):
			return "go"
		case strings.HasPrefix(first, "const ") || strings.HasPrefix(first, "let ") || strings.HasPrefix(first, "export "):
			return "js"
		}
		return ""
	default:
		return "bash"
	}
}

// runeDisplayWidth approximates terminal column width (CJK = 2, ASCII = 1)
// so Codex TUI box-drawing tables (`━━━  ━━━━━`) slice cleanly into GFM columns.
func runeDisplayWidth(r rune) int {
	if isCJK(r) {
		return 2
	}
	return 1
}

func stringDisplayWidth(s string) int {
	w := 0
	for _, r := range s {
		w += runeDisplayWidth(r)
	}
	return w
}

func sliceByDisplayCols(s string, startCol, endCol int) string {
	col := 0
	var b strings.Builder
	for _, r := range s {
		w := runeDisplayWidth(r)
		if col+w > startCol && (endCol < 0 || col < endCol) {
			b.WriteRune(r)
		}
		col += w
	}
	return strings.TrimSpace(b.String())
}

func parseTUITableCols(sepLine string) [][2]int {
	var cols [][2]int
	col := 0
	inBar := false
	barStart := 0
	for _, r := range sepLine {
		w := runeDisplayWidth(r)
		if r == '━' || r == '─' {
			if !inBar {
				inBar = true
				barStart = col
			}
		} else if inBar {
			cols = append(cols, [2]int{barStart, col})
			inBar = false
		}
		col += w
	}
	if inBar {
		cols = append(cols, [2]int{barStart, -1})
	} else if len(cols) > 0 {
		cols[len(cols)-1][1] = -1
	}
	return cols
}

type streamLineInfo struct {
	md        string
	plain     string
	hasSyntax bool
}

func reconstructStreamMarkdown(lines []streamLineInfo) string {
	var blocks []string
	n := len(lines)
	i := 0
	for i < n {
		if strings.TrimSpace(lines[i].plain) == "" {
			i++
			continue
		}

		// 1. Codex TUI Box-Drawing Table (`Header` + `━━━  ━━━` + rows / `───  ───`)
		if i+1 < n && tuiTableHeadRe.MatchString(lines[i+1].plain) {
			cols := parseTUITableCols(lines[i+1].plain)
			if len(cols) >= 2 {
				formatRow := func(raw string) string {
					cells := make([]string, len(cols))
					for ci, rng := range cols {
						c := sliceByDisplayCols(raw, rng[0], rng[1])
						c = strings.ReplaceAll(c, "|", "\\|")
						cells[ci] = c
					}
					return "| " + strings.Join(cells, " | ") + " |"
				}
				var tbl []string
				tbl = append(tbl, formatRow(stripInlineMDMarks(lines[i].plain)))
				sepCells := make([]string, len(cols))
				for ci := range cols {
					sepCells[ci] = "---"
				}
				tbl = append(tbl, "| "+strings.Join(sepCells, " | ")+" |")
				i += 2
				var pendingCells []string
				flushPending := func() {
					if len(pendingCells) > 0 {
						for ci := range pendingCells {
							pendingCells[ci] = strings.TrimSpace(pendingCells[ci])
						}
						tbl = append(tbl, "| "+strings.Join(pendingCells, " | ")+" |")
						pendingCells = nil
					}
				}
				for i < n {
					pl := lines[i].plain
					if strings.TrimSpace(pl) == "" {
						flushPending()
						i++
						break
					}
					if tuiTableRuleRe.MatchString(pl) {
						flushPending()
						i++
						continue
					}
					rowSlices := make([]string, len(cols))
					nonEmpty := 0
					for ci, rng := range cols {
						c := sliceByDisplayCols(pl, rng[0], rng[1])
						rowSlices[ci] = strings.ReplaceAll(c, "|", "\\|")
						if rowSlices[ci] != "" {
							nonEmpty++
						}
					}
					if nonEmpty == 0 {
						break
					}
					if pendingCells == nil {
						pendingCells = rowSlices
					} else {
						// Wrapped continuation row inside a TUI table cell before `───`
						for ci, part := range rowSlices {
							if part != "" {
								pendingCells[ci] = joinSoftWrapped(pendingCells[ci], part)
							}
						}
					}
					i++
				}
				flushPending()
				blocks = append(blocks, strings.Join(tbl, "\n"))
				continue
			}
		}

		// 2. Stand-alone Code / Shell Command Block
		if isStreamCodeLine(lines[i].plain, lines[i].hasSyntax) {
			var codeLines []string
			for i < n && strings.TrimSpace(lines[i].plain) != "" && isStreamCodeLine(lines[i].plain, lines[i].hasSyntax) {
				codeLines = append(codeLines, stripInlineMDMarks(lines[i].plain))
				i++
			}
			lang := guessFenceLang(codeLines)
			blocks = append(blocks, "```"+lang+"\n"+strings.Join(codeLines, "\n")+"\n```")
			continue
		}

		// 3. Prose / List / Heading Paragraph (with terminal soft-wrap reflow + `[Label](URL)` restoration)
		var paraLines []string
		prevRawWidth := 0
		for i < n {
			pl := strings.TrimSpace(lines[i].plain)
			if pl == "" {
				i++
				break
			}
			if (i+1 < n && tuiTableHeadRe.MatchString(lines[i+1].plain)) || isStreamCodeLine(lines[i].plain, lines[i].hasSyntax) {
				break
			}
			curWidth := stringDisplayWidth(pl)
			mdL := lines[i].md
			if len(paraLines) == 0 {
				paraLines = append(paraLines, mdL)
			} else {
				prevPlain := strings.TrimSpace(stripInlineMDMarks(paraLines[len(paraLines)-1]))
				isParenURL := strings.HasPrefix(pl, "(") && strings.Contains(pl, "://")
				endedSentence := strings.HasSuffix(prevPlain, "。") || strings.HasSuffix(prevPlain, "！") ||
					strings.HasSuffix(prevPlain, "？") || strings.HasSuffix(prevPlain, "：") ||
					strings.HasSuffix(prevPlain, ":") || strings.HasSuffix(prevPlain, ".")
				if !isParenURL && (prevRawWidth < 48 || endedSentence || listOrBlockLead.MatchString(pl) || listOrBlockLead.MatchString(prevPlain)) {
					paraLines = append(paraLines, mdL)
				} else {
					paraLines[len(paraLines)-1] = joinSoftWrapped(paraLines[len(paraLines)-1], mdL)
				}
			}
			prevRawWidth = curWidth
			i++
		}
		para := strings.Join(paraLines, "\n")
		// Merge wrapped underlined link spans (`\x01L:Part1\x02\n\x01L:Part2\x02`) and restore `[Label](URL)`
		for linkMarkerJoin.MatchString(para) {
			para = linkMarkerJoin.ReplaceAllStringFunc(para, func(m string) string {
				sub := linkMarkerJoin.FindStringSubmatch(m)
				return "\x01L:" + joinSoftWrapped(sub[1], sub[2]) + "\x02"
			})
		}
		para = linkMarkerPair.ReplaceAllString(para, "[$1]($2)")
		para = linkMarkerBare.ReplaceAllString(para, "$1")
		// Also convert plain `Tailscale 官方 Linux 安装说明 (https://...)` after sentence punctuation into `[Label](URL)`
		para = plainParenLink.ReplaceAllStringFunc(para, func(m string) string {
			sub := plainParenLink.FindStringSubmatch(m)
			lbl := strings.TrimSpace(sub[1])
			if lbl == "" || strings.ContainsAny(lbl, "[]`*") {
				return m
			}
			return "[" + lbl + "](" + sub[2] + ")"
		})
		blocks = append(blocks, para)
	}
	return strings.TrimSpace(strings.Join(blocks, "\n\n"))
}

// extractStreamingBubbleANSI extracts an actively streaming assistant reply from
// an ANSI-formatted terminal snapshot and reconstructs rich Markdown (`**bold**`,
// `` `code` ``, fenced codeblocks, `[label](url)` links, GFM tables, and unwrapped prose).
func extractStreamingBubbleANSI(ansiScreen string) (text, screenPhase string) {
	plainScreen := stripANSICodes(ansiScreen)
	if !strings.Contains(ansiScreen, "\x1b") {
		// Plain-text caller (`activityLine` tests or non-ANSI screen): still apply
		// codeblock, link, table, and soft-wrap reconstruction!
		rawPlain, phase := extractRawStreamingSlice(plainScreen, nil)
		if len(rawPlain) == 0 {
			return "", ""
		}
		return reconstructStreamMarkdown(rawPlain), phase
	}
	ansiLines := strings.Split(strings.ReplaceAll(ansiScreen, "\r", ""), "\n")
	rawItems, phase := extractRawStreamingSlice(plainScreen, ansiLines)
	if len(rawItems) == 0 {
		return "", ""
	}
	return reconstructStreamMarkdown(rawItems), phase
}

func extractRawStreamingSlice(plainScreen string, ansiLines []string) ([]streamLineInfo, string) {
	rawLines := strings.Split(plainScreen, "\n")
	bottomCut := len(rawLines)
	for i := len(rawLines) - 1; i >= max(0, len(rawLines)-8); i-- {
		t := strings.TrimSpace(rawLines[i])
		if livePromptTop.MatchString(t) && (strings.Contains(t, "Ask Codex") || strings.Contains(t, "Try ") || i >= len(rawLines)-5) {
			bottomCut = i
			break
		}
	}
	rawLines = rawLines[:bottomCut]

	for i := len(rawLines) - 1; i >= max(0, len(rawLines)-6); i-- {
		t := strings.TrimSpace(rawLines[i])
		if t == "" {
			continue
		}
		if liveHint.MatchString(t) || liveSpinner.MatchString(t) {
			rawLines = rawLines[:i]
			break
		}
		if strings.HasPrefix(t, "└") || strings.HasPrefix(t, "⎿") || strings.HasPrefix(t, "↳") {
			continue
		}
		break
	}

	userIdx := -1
	for i := len(rawLines) - 1; i >= 0; i-- {
		if livePromptTop.MatchString(rawLines[i]) {
			userIdx = i
			break
		}
	}

	replyIdx := -1
	for i := len(rawLines) - 1; i > userIdx; i-- {
		if liveReplyLead.MatchString(rawLines[i]) {
			replyIdx = i
			break
		}
	}
	if replyIdx < 0 {
		return nil, ""
	}
	headTrim := strings.TrimSpace(rawLines[replyIdx])
	rest := strings.TrimSpace(liveReplyLead.ReplaceAllString(headTrim, ""))
	if liveHint.MatchString(headTrim) || liveKey.MatchString(headTrim) || liveToolLead.MatchString(rest) || liveFnCallLead.MatchString(rest) {
		return nil, ""
	}

	screenPhase := ""
	for i := replyIdx - 1; i > userIdx; i-- {
		t := strings.TrimSpace(strings.Trim(rawLines[i], "─━═ "))
		if liveWorkedEnd.MatchString(t) {
			screenPhase = "final_answer"
			break
		}
	}

	var out []streamLineInfo
	for i := replyIdx; i < len(rawLines); i++ {
		raw := strings.TrimRight(rawLines[i], " \t\r")
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			if len(out) > 0 && out[len(out)-1].plain != "" {
				out = append(out, streamLineInfo{})
			}
			continue
		}
		if liveTreeOrDiff.MatchString(raw) || liveKey.MatchString(trimmed) {
			return nil, ""
		}
		isTableRule := tuiTableRuleRe.MatchString(raw)
		if !isTableRule && (liveHint.MatchString(trimmed) || liveSpinner.MatchString(trimmed) || liveChrome.MatchString(trimmed) || liveWorkedEnd.MatchString(trimmed) || strings.Trim(trimmed, "─━═╭╮╰╯ ") == "") {
			break
		}
		plainLine := trimmed
		if i == replyIdx {
			plainLine = strings.TrimSpace(liveReplyLead.ReplaceAllString(raw, ""))
		} else if strings.HasPrefix(raw, "  ") {
			plainLine = raw[2:]
		}
		mdLine := plainLine
		hasSyntax := false
		if i < len(ansiLines) {
			mdLine, hasSyntax = ansiReplyLineToMD(ansiLines[i], i == replyIdx)
		}
		out = append(out, streamLineInfo{md: mdLine, plain: plainLine, hasSyntax: hasSyntax})
	}
	for len(out) > 0 && out[len(out)-1].plain == "" {
		out = out[:len(out)-1]
	}
	return out, screenPhase
}
