//go:build !darwin && !windows

package collie

import (
	"os"
	"time"
)

func birthTime(fi os.FileInfo) time.Time { return time.Time{} }
