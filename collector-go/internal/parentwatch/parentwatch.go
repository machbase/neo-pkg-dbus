// Package parentwatch monitors the JSH launcher that owns the LS collector.
package parentwatch

import (
	"context"
	"errors"
	"fmt"
	"syscall"
	"time"
)

const checkInterval = time.Second

// Monitor waits until the process identified at construction exits.
type Monitor interface {
	Wait(context.Context) error
	Close() error
}

type monitor struct {
	pid      int
	interval time.Duration
	dead     bool
}

// New creates a Linux parent-process monitor. LS collector releases target
// linux/amd64 only, so syscall.Kill(pid, 0) is the deployment-native probe.
func New(pid int) (Monitor, error) {
	if pid <= 0 {
		return nil, fmt.Errorf("parent PID must be positive: %d", pid)
	}
	alive, err := processAlive(pid)
	if err != nil {
		return nil, err
	}
	return &monitor{pid: pid, interval: checkInterval, dead: !alive}, nil
}

func (m *monitor) Wait(ctx context.Context) error {
	if m.dead {
		return nil
	}
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			alive, err := processAlive(m.pid)
			if err != nil {
				return err
			}
			if !alive {
				return nil
			}
		}
	}
}

func (m *monitor) Close() error { return nil }

func processAlive(pid int) (bool, error) {
	err := syscall.Kill(pid, 0)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, syscall.EPERM):
		return true, nil
	case errors.Is(err, syscall.ESRCH):
		return false, nil
	default:
		return false, fmt.Errorf("check parent process %d: %w", pid, err)
	}
}
