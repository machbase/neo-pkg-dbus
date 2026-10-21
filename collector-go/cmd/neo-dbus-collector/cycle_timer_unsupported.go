//go:build !linux || !amd64

package main

import (
	"context"
	"errors"
	"time"
)

func newAbsoluteCycleTimer(context.Context, time.Duration) (cycleTimer, error) {
	return nil, errors.New("absolute timer requires Linux/amd64")
}
