#!/bin/sh
# Build Collie for macOS, Linux and Windows and publish a GitHub release.
#
#   scripts/release.sh v0.1.0          build, then create the release
#   scripts/release.sh v0.1.0 --dry    build only (into dist/)
#
# install.sh / install.ps1 download releases/latest/download/collie-<os>-<arch>[.exe],
# so the asset names below are part of the contract.
set -eu

version=${1:?usage: scripts/release.sh vX.Y.Z [--dry]}
dry=${2:-}
cd "$(dirname "$0")/.."

case "$version" in v[0-9]*) ;; *) echo "version must look like v0.1.0" >&2; exit 2 ;; esac
if [ -z "$dry" ] && [ -n "$(git status --porcelain)" ]; then
  echo "commit your changes first: a release is built from what is committed" >&2
  exit 1
fi

rm -rf dist && mkdir -p dist
for target in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64 windows/arm64; do
  os=${target%/*} arch=${target#*/}
  ext=""
  [ "$os" = windows ] && ext=.exe
  out=dist/collie-$os-$arch$ext
  echo "building $out"
  GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$out" .
done
(cd dist && shasum -a 256 collie-* > checksums.txt)
cat dist/checksums.txt

[ "$dry" = "--dry" ] && exit 0

git tag -a "$version" -m "Collie $version" 2>/dev/null || true
git push origin "$version"
gh release create "$version" dist/collie-* dist/checksums.txt \
  --title "Collie $version" \
  --notes "macOS / Linux 安装：\`curl -fsSL https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.sh | sh\`；Windows（PowerShell）安装：\`powershell -ExecutionPolicy Bypass -Command \"& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.ps1)))\"\`（做 hub 加 \`hub\`，加入电脑见 README）。也可以直接下载下面对应平台的二进制。"
