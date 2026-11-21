#!/bin/sh
# Collie installer — https://github.com/Tdcle/collie
#
#   安装 collie 命令：
#     curl -fsSL https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.sh | sh
#
#   把这台电脑加入 hub，并作为后台服务常驻（macOS: launchd，Linux: systemd --user，Windows Git Bash: daemon）：
#     curl -fsSL https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.sh | sh -s -- node --hub http://<hub>:7788 --code <配对码>
#
#   让这台电脑做 hub，并作为后台服务常驻：
#     curl -fsSL https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.sh | sh -s -- hub [--url http://<本机内网 IP>:7788]
#
#   从源码安装（需要 Go 1.25+）：在仓库里运行这个脚本，会用本地源码编译，不下载：
#     git clone https://github.com/Tdcle/collie.git ~/collie && cd ~/collie
#     sh docs/install.sh [hub | node …]
#
# 环境变量：COLLIE_REPO（默认 Tdcle/collie）、COLLIE_BIN_DIR（默认 ~/.local/bin）、
# COLLIE_BINARY（直接安装这个现成的文件）、COLLIE_VERSION（下载时的版本，默认 latest）。
set -eu

REPO=${COLLIE_REPO:-Tdcle/collie}
VERSION=${COLLIE_VERSION:-latest}
BIN_DIR=${COLLIE_BIN_DIR:-$HOME/.local/bin}

say() { printf '%s\n' "$*"; }
step() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mcollie:\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ platform
ext=""
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) os=windows; ext=.exe ;;
  *) die "不支持的系统：$(uname -s)（Windows 上也可用 PowerShell 运行 docs/install.ps1）" ;;
esac
BIN=$BIN_DIR/collie$ext
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "暂时只支持 amd64 和 arm64（这台是 $(uname -m)）" ;;
esac

fetch() { # fetch <url> <file>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "需要 curl 或 wget"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# ------------------------------------------------------------------ binary
# checkout: the repository this script was run from (sh docs/install.sh),
# if any. Piped from curl, $0 is the shell, so this never matches.
checkout() {
  case "$0" in *install.sh) ;; *) return 1 ;; esac
  d=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd) || return 1
  grep -Eq '^module github\.com/.+/collie$' "$d/go.mod" 2>/dev/null || return 1
  printf '%s\n' "$d"
}

install_binary() {
  asset=collie-$os-$arch$ext
  if [ "$VERSION" = latest ]; then
    base=https://github.com/$REPO/releases/latest/download
  else
    base=https://github.com/$REPO/releases/download/$VERSION
  fi
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  if [ -n "${COLLIE_BINARY:-}" ]; then # a file built elsewhere
    cp "$COLLIE_BINARY" "$tmp/$asset"
  elif src=$(checkout); then
    command -v go >/dev/null 2>&1 || die "从源码安装需要 Go 1.25+：https://go.dev/dl/"
    v=$(git -C "$src" describe --tags --always --dirty 2>/dev/null || echo dev)
    step "从源码编译（$src，$v）"
    (cd "$src" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$v" -o "$tmp/$asset" .) || die "编译失败"
  else
    step "下载 $asset（$VERSION）"
    if fetch "$base/$asset" "$tmp/$asset"; then
      if fetch "$base/checksums.txt" "$tmp/checksums.txt" 2>/dev/null; then
        want=$(grep " $asset\$" "$tmp/checksums.txt" | cut -d' ' -f1)
        [ -n "$want" ] && [ "$want" = "$(sha256 "$tmp/$asset")" ] || die "校验和对不上，没有安装"
      fi
    elif command -v git >/dev/null 2>&1 && command -v go >/dev/null 2>&1; then
      step "没有现成的预编译版本，用本机 Go 从 https://github.com/$REPO 编译…"
      git clone --depth 1 "https://github.com/$REPO.git" "$tmp/src" || die "git clone 失败"
      v=$(git -C "$tmp/src" describe --tags --always --dirty 2>/dev/null || echo dev)
      (cd "$tmp/src" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$v" -o "$tmp/$asset" .) || die "编译失败"
    else
      die "下载失败：$base/$asset（也可以装好 git + Go 1.25+ 后重跑自动编译）"
    fi
  fi

  mkdir -p "$BIN_DIR"
  chmod 755 "$tmp/$asset"
  if [ "$os" = windows ] && [ -f "$BIN" ]; then
    rm -f "$BIN.old" 2>/dev/null || true
    mv -f "$BIN" "$BIN.old" 2>/dev/null || true
  fi
  # Replace atomically: a running node or hub keeps its old file until restart.
  mv -f "$tmp/$asset" "$BIN.new" && mv -f "$BIN.new" "$BIN"
  [ "$os" = windows ] && rm -f "$BIN.old" 2>/dev/null || true
  step "已安装 $("$BIN" version 2>/dev/null || echo collie) → $BIN"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) say "    提示：$BIN_DIR 不在 PATH 里。把这行加到 ~/.zshrc 或 ~/.bashrc：
      export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
}

# ------------------------------------------------------------------ services
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# service <name> <args…>: run `collie <args…>` in the background, now and
# after every login (macOS) or boot (Linux, with linger).
service() {
  name=$1; shift
  path="$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  if [ "$os" = windows ]; then
    # In Git Bash / MSYS on Windows, `collie daemon` manages the detached background supervisor.
    sub=$1; shift
    if [ -n "${COLLIE_DRY_SERVICE:-}" ]; then say "$BIN daemon restart $name -- $*"; return; fi
    "$BIN" daemon restart "$name" -- "$@"
    step "已作为后台服务运行（collie daemon: $name）"
    say "    日志：tail -f ~/.collie/$name.log"
    return
  fi
  if [ "$os" = darwin ]; then
    label=com.collie.$name
    plist=$HOME/Library/LaunchAgents/$label.plist
    log=$HOME/Library/Logs/collie-$name.log
    args="    <string>$(xml "$BIN")</string>"
    for a in "$@"; do args="$args
    <string>$(xml "$a")</string>"; done
    unit="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$args
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(xml "$path")</string></dict>
  <key>WorkingDirectory</key><string>$(xml "$HOME")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$(xml "$log")</string>
  <key>StandardErrorPath</key><string>$(xml "$log")</string>
</dict>
</plist>"
    if [ -n "${COLLIE_DRY_SERVICE:-}" ]; then say "$unit"; return; fi
    mkdir -p "$(dirname "$plist")"
    printf '%s\n' "$unit" > "$plist"
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    step "已作为后台服务运行（launchd: $label）"
    say "    日志：tail -f $log"
  else
    unitdir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
    file=$unitdir/collie-$name.service
    quoted=""
    for a in "$@"; do quoted="$quoted \"$a\""; done
    unit="[Unit]
Description=Collie $name
After=network-online.target

[Service]
ExecStart=\"$BIN\"$quoted
WorkingDirectory=%h
Environment=PATH=$path
Restart=always
RestartSec=5

[Install]
WantedBy=default.target"
    if [ -n "${COLLIE_DRY_SERVICE:-}" ]; then say "$unit"; return; fi
    # Containers (cloud dev machines, sandboxes) often have systemctl but no
    # user bus; fall back to a plain background process there.
    if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
      log=$HOME/.collie/$name.log
      pidf=$HOME/.collie/$name.pid
      mkdir -p "$HOME/.collie"
      if [ -f "$pidf" ] && kill "$(cat "$pidf")" 2>/dev/null; then sleep 1; fi
      PATH=$path nohup "$BIN" "$@" >>"$log" 2>&1 </dev/null &
      echo $! > "$pidf"
      sleep 2
      kill -0 "$(cat "$pidf")" 2>/dev/null || die "没能启动，看日志：tail -n 30 $log"
      step "已在后台运行（这台机器没有 systemd 用户服务，用的 nohup；pid $(cat "$pidf")）"
      say "    日志：tail -f $log"
      say "    机器重启后不会自动起来，重跑这条安装命令即可"
      return
    fi
    mkdir -p "$unitdir"
    printf '%s\n' "$unit" > "$file"
    # The README's earlier one-off unit (systemd-run) has the same name.
    systemctl --user stop "collie-$name" 2>/dev/null || true
    systemctl --user reset-failed "collie-$name" 2>/dev/null || true
    systemctl --user daemon-reload
    systemctl --user enable --now "collie-$name" >/dev/null
    systemctl --user restart "collie-$name"
    step "已作为后台服务运行（systemd --user: collie-$name）"
    say "    日志：journalctl --user -u collie-$name -f"
    if command -v loginctl >/dev/null 2>&1 && ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q yes; then
      say "    提示：退出登录后也要继续跑的话，运行一次：loginctl enable-linger"
    fi
  fi
}

# ------------------------------------------------------------------ herdr
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }

# check_herdr: Collie drives agents through herdr, which is installed and
# set up on its own. Say what is missing on this computer; change nothing.
check_herdr() {
  if [ "$os" = windows ]; then
    hb=$(command -v herdr 2>/dev/null || command -v herdr.exe 2>/dev/null || true)
    [ -z "$hb" ] && [ -f "$HOME/.local/bin/herdr.exe" ] && hb=$HOME/.local/bin/herdr.exe
    if [ -z "$hb" ]; then
      warn "没找到 herdr：在 PowerShell 运行 irm https://herdr.dev/install.ps1 | iex 安装。"
      return 0
    fi
    if ! "$hb" status 2>/dev/null | grep -q "status: running"; then
      powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "Start-Process -FilePath '$hb' -ArgumentList 'server' -WindowStyle Hidden" >/dev/null 2>&1 || true
      sleep 2
    fi
    return 0
  fi
  hb=$(command -v herdr 2>/dev/null || true)
  [ -z "$hb" ] && [ -x "$HOME/.local/bin/herdr" ] && hb=$HOME/.local/bin/herdr
  # Collie talks to herdr (the CLI at herdr.dev/install.sh), not to the Herdr
  # app or herdr-core that releases.herdr.dev/app/install.sh puts in.
  if [ -z "$hb" ] && [ -z "${COLLIE_NO_HERDR:-}" ]; then
    step "安装 herdr（Collie 通过它看到和管理 agent；不想装就设 COLLIE_NO_HERDR=1）"
    if curl -fsSL https://herdr.dev/install.sh | HERDR_INSTALL_DIR="$HOME/.local/bin" sh >/dev/null; then
      hb=$HOME/.local/bin/herdr
    else
      warn "herdr 没装上，可以稍后自己装：curl -fsSL https://herdr.dev/install.sh | sh"
    fi
  fi
  if [ -z "$hb" ]; then
    warn "没找到 herdr：没有它，这台电脑上的 agent 不会出现在 Collie 里${1:+（$1）}。"
    say "    安装：curl -fsSL https://herdr.dev/install.sh | sh"
    return 0
  fi
  if ! "$hb" status 2>/dev/null | grep -q "status: running"; then
    # Collie needs herdr's server (its socket), not a terminal UI.
    nohup "$hb" server >/dev/null 2>&1 </dev/null &
    sleep 2
    if "$hb" status 2>/dev/null | grep -q "status: running"; then
      step "已在后台启动 herdr 服务端（herdr server）；之后运行 herdr 会直接接上它"
    else
      warn "herdr 服务端没起来：运行一次 herdr 或 herdr server（Collie 连的是它的 socket）。"
    fi
  fi
  st=$("$hb" integration status 2>/dev/null) || return 0
  missing=""
  for pair in claude:claude codex:codex agy:antigravity-cli; do
    command -v "${pair%%:*}" >/dev/null 2>&1 || continue # this agent isn't installed here
    target=${pair#*:}
    line=$(printf '%s\n' "$st" | grep "^$target:" || true)
    case "$line" in
      "" | *": current"*) ;; # unknown to this herdr version, or fine
      *) missing="$missing $target" ;;
    esac
  done
  if [ -n "$missing" ]; then
    warn "这些 agent 还没装 herdr 集成：herdr 认不出它们在干什么，Collie 也就没法给它们发消息。运行："
    for t in $missing; do say "      herdr integration install $t"; done
  fi
}

# ------------------------------------------------------------------ main
mode=${1:-}
[ $# -gt 0 ] && shift

case "$mode" in
  "")
    install_binary
    say ""
    say "下一步："
    say "  让这台电脑做 hub：   collie -url http://<本机内网 IP>:7788"
    say "  把电脑加入 hub：     collie node --hub http://<hub>:7788 --code <配对码>"
    say "  （加 node / hub 参数重跑这个脚本，会顺便装成后台服务）"
    check_herdr
    ;;
  node)
    install_binary
    case " $* " in
      *" --code "* | *" --code="*)
        step "加入 hub"
        "$BIN" node --pair-only "$@"
        ;;
      *)
        [ -f "$HOME/.collie/node.json" ] || die "第一次要带上 hub 地址和配对码：sh -s -- node --hub http://<hub>:7788 --code <配对码>
    配对码在 hub 的「设备 → 连接一台电脑」里拿。"
        ;;
    esac
    # The service runs `collie node` with the saved address and token;
    # --name stays only if given (otherwise the name chosen when joining).
    n=$#
    i=0
    while [ "$i" -lt "$n" ]; do
      a=$1; shift; i=$((i + 1))
      case "$a" in
        --name | --socket) set -- "$@" "$a" "$1"; shift; i=$((i + 1)) ;;
        --name=* | --socket=*) set -- "$@" "$a" ;;
        --hub | --code) shift; i=$((i + 1)) ;;
        *) ;;
      esac
    done
    service node node "$@"
    say "    在 hub 的侧栏里能看到这台电脑了。"
    say "    本机界面：http://127.0.0.1:17788（用 Chrome 打开可以安装成 app）"
    check_herdr
    ;;
  hub)
    install_binary
    service hub serve "$@"
    say "    打开 hub 的地址；手机配对：collie pair（或在「设备」页扫码）。"
    say "    首次登录的令牌在 ~/.collie/token。"
    check_herdr "hub 本身照常能用"
    ;;
  *)
    die "不认识的参数：$mode（可以是 node、hub，或者不带参数）"
    ;;
esac
