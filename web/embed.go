// Package web is Collie's browser UI: plain HTML, CSS and JS with no build
// step, embedded into the binary.
package web

import "embed"

// FS holds the files served at /.
//
//go:embed *.html *.css *.js *.svg *.png *.webmanifest
var FS embed.FS
