//go:build !machcli

package main

func openAppender(root string, config database, flushMaxRows int) (appenderStream, error) {
	return openGoAppender(root, config, flushMaxRows)
}
