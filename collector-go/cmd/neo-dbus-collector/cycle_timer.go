package main

import (
	"context"
	"errors"
	"time"
)

// Both timers return the intended boundary and the actual wake time. Missed
// boundaries are not replayed in a burst, matching the existing timer policy.
type cycleTimer interface {
	Wait(context.Context) (scheduledAt, wakeAt time.Time, err error)
	Close()
}

type standardCycleTimer struct {
	interval time.Duration
	timer    *time.Timer
}

func (t *standardCycleTimer) Wait(ctx context.Context) (time.Time, time.Time, error) {
	now := time.Now()
	delay := nextAligned(now, t.interval)
	scheduled := now.Add(delay)
	if err := ctx.Err(); err != nil {
		return time.Time{}, time.Time{}, err
	}
	t.timer.Reset(delay)
	select {
	case <-ctx.Done():
		return time.Time{}, time.Time{}, ctx.Err()
	case <-t.timer.C:
		return scheduled, time.Now(), nil
	}
}

func (t *standardCycleTimer) Close() { t.timer.Stop() }

func newCycleTimer(ctx context.Context, interval time.Duration, absolute bool) (cycleTimer, error) {
	if interval <= 0 {
		return nil, errors.New("timer interval must be positive")
	}
	if absolute {
		return newAbsoluteCycleTimer(ctx, interval)
	}
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	return &standardCycleTimer{interval: interval, timer: timer}, nil
}

func timerMode(absolute bool) string {
	if absolute {
		return "absolute"
	}
	return "standard"
}
