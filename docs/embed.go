// Package docs embeds installer scripts so every Collie Hub can serve
// /install.sh and /install.ps1 directly without relying on raw.githubusercontent.com.
package docs

import _ "embed"

//go:embed install.sh
var InstallSH []byte

//go:embed install.ps1
var InstallPS1 []byte
