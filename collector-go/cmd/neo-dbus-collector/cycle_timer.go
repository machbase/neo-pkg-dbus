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
	next     time.Time
	skipped  timerSkipped
}

type timerSkipped struct {
	Count      uint64
	Last       time.Time
	ClockReset bool
}

// Serial readers explicitly advance their next boundary. These counts are
// decisions not to run elapsed slots, not an estimate from a throughput rate.
type skippingCycleTimer interface {
	SkipPast(time.Time) timerSkipped
	TakeSkipped() timerSkipped
}

func mergeTimerSkipped(a, b timerSkipped) timerSkipped {
	a.Count += b.Count
	if b.Count > 0 {
		a.Last = b.Last
	}
	a.ClockReset = a.ClockReset || b.ClockReset
	return a
}
func takeTimerSkipped(t cycleTimer) timerSkipped {
	if s, ok := t.(skippingCycleTimer); ok {
		return s.TakeSkipped()
	}
	return timerSkipped{}
}
func skipTimerPast(t cycleTimer, now time.Time) timerSkipped {
	if s, ok := t.(skippingCycleTimer); ok {
		return s.SkipPast(now)
	}
	return timerSkipped{}
}

func (t *standardCycleTimer) SkipPast(now time.Time) timerSkipped {
	if t.next.IsZero() {
		return timerSkipped{}
	}
	wallDelta := now.UnixNano() - t.next.UnixNano()
	monoDelta := now.Sub(t.next).Nanoseconds()
	// Standard mode follows changed wall-clock phase without turning a clock
	// adjustment into thousands of fabricated scheduled skips.
	if difference := wallDelta - monoDelta; difference > int64(time.Millisecond) || difference < -int64(time.Millisecond) {
		t.next = now.Add(nextAligned(now, t.interval))
		return timerSkipped{ClockReset: true}
	}
	if now.Before(t.next) {
		return timerSkipped{}
	}
	count := now.Sub(t.next)/t.interval + 1
	result := timerSkipped{Count: uint64(count), Last: t.next.Add((count - 1) * t.interval)}
	t.next = t.next.Add(count * t.interval)
	return result
}
func (t *standardCycleTimer) TakeSkipped() timerSkipped {
	s := t.skipped
	t.skipped = timerSkipped{}
	return s
}

func (t *standardCycleTimer) Wait(ctx context.Context) (time.Time, time.Time, error) {
	now := time.Now()
	if err := ctx.Err(); err != nil {
		return time.Time{}, time.Time{}, err
	}
	if t.next.IsZero() {
		t.next = now.Add(nextAligned(now, t.interval))
	}
	t.skipped = mergeTimerSkipped(t.skipped, t.SkipPast(now))
	scheduled := t.next
	delay := scheduled.Sub(now)
	t.timer.Reset(delay)
	select {
	case <-ctx.Done():
		return time.Time{}, time.Time{}, ctx.Err()
	case <-t.timer.C:
		t.next = scheduled.Add(t.interval)
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
