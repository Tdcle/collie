//go:build windows

package collie

import (
	"os"
	"syscall"
	"time"
)

func birthTime(fi os.FileInfo) time.Time {
	if st, ok := fi.Sys().(*syscall.Win32FileAttributeData); ok {
		if ns := st.CreationTime.Nanoseconds(); ns > 0 {
			return time.Unix(0, ns)
		}
	}
	return time.Time{}
}
