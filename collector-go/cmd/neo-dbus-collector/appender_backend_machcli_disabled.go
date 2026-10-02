//go:build machcli && !cgo

package main

import "errors"

func openAppender(string, database, int) (appenderStream, error) {
	return nil, errors.New("machcli backend requires CGO_ENABLED=1")
}
