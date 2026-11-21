#!/bin/sh
# Builds the browser-only demo into docs/demo/: the real web app plus
# scripts/demo/demo.js, which answers its API with made-up data.
#
#   sh scripts/demo.sh
set -eu
cd "$(dirname "$0")/.."
out=docs/demo
rm -rf "$out" && mkdir -p "$out"
cp web/app.css web/icon.svg web/icon-512.png "$out/"
cp scripts/demo/demo.js scripts/demo/demo-qr.png "$out/"
# Absolute paths assume the hub serves the app at /; Pages serves it at /collie/demo/.
sed -e 's#src="/icon.svg"#src="icon.svg"#g' -e 's#"/api/qr?text=#"demo-qr.png?text=#g' web/app.js > "$out/app.js"
sed -e 's#href="/#href="#g' -e 's#src="/#src="#g' \
    -e 's#<script src="app.js"></script>#<script src="demo.js"></script>\n<script src="app.js"></script>#' \
    -e 's#<title>Collie</title>#<title>Collie 演示</title>#' \
    -e '/rel="manifest"/d' web/index.html > "$out/index.html"
cat >> "$out/app.css" <<'CSS'

/* demo only */
.demo-badge { position: fixed; right: 14px; bottom: calc(14px + env(safe-area-inset-bottom)); z-index: 999; font: 500 12px/1 var(--sans); padding: 7px 10px; border-radius: 999px; background: var(--fg); color: var(--bg); text-decoration: none; opacity: .85; }
.demo-badge:hover { opacity: 1; }
CSS
echo "built $out"
