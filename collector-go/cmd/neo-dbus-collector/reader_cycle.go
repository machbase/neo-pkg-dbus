package main

import (
	"fmt"
	"sync"
	"time"
)

type readResult struct {
	ok, attempt bool
	timing      readTiming
	err         error
}

// One Job owns at most one active reader. Only this fixed-size record is kept;
// there is no per-skip history, sample array, or extra completion goroutine.
type readerCycle struct {
	mu                             sync.Mutex
	active                         bool
	scheduledAt, wakeAt, startedAt time.Time
	detail                         overrunDetail
}

type overrunDetail struct {
	SkippedAt                                               time.Time
	IntervalUS                                              int64
	SkippedCycles                                           uint64
	TimerWakeLagUS, ReaderStartLagUS, SkippedTimerWakeLagUS int64
	ReaderTotalUS, DBusUS, ParseUS                          int64
	DBusMeasured, ParseMeasured                             bool
}

func (c *readerCycle) begin(scheduled, wake time.Time, interval time.Duration) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active {
		c.detail.SkippedCycles++
		c.detail.SkippedAt = scheduled
		c.detail.SkippedTimerWakeLagUS = nonNegativeMicroseconds(wake.Sub(scheduled))
		return false
	}
	c.active = true
	c.scheduledAt, c.wakeAt, c.startedAt = scheduled, wake, time.Time{}
	c.detail = overrunDetail{IntervalUS: interval.Microseconds(), TimerWakeLagUS: nonNegativeMicroseconds(wake.Sub(scheduled))}
	return true
}

func (c *readerCycle) started(start time.Time) {
	c.mu.Lock()
	c.startedAt = start
	c.detail.ReaderStartLagUS = nonNegativeMicroseconds(start.Sub(c.scheduledAt))
	c.mu.Unlock()
}

func (c *readerCycle) finish(timing readTiming) *overrunDetail {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.active = false
	if c.detail.SkippedCycles == 0 {
		return nil
	}
	detail := c.detail
	detail.ReaderTotalUS = timing.ReaderTotal.Microseconds()
	detail.DBusUS, detail.DBusMeasured = timing.DBus.Microseconds(), timing.DBusMeasured
	detail.ParseUS, detail.ParseMeasured = timing.Parse.Microseconds(), timing.ParseMeasured
	return &detail
}

func (d *daemon) recordReadResult(name string, result readResult, detail ...*overrunDetail) {
	if result.attempt {
		d.recordJobPerformance(name, result.timing, result.err, detail...)
	}
}

func formatOverrunDetail(detail *overrunDetail) string {
	if detail == nil {
		return ""
	}
	parse := "n/a"
	if detail.ParseMeasured {
		parse = fmt.Sprint(detail.ParseUS)
	}
	return fmt.Sprintf(" lastOverrun[skippedAt=%s skippedCycles=%d intervalUs=%d timerWakeLagUs=%d readerStartLagUs=%d skippedTimerWakeLagUs=%d readerTotalUs=%d dbusUs=%s parseUs=%s]",
		detail.SkippedAt.UTC().Format(time.RFC3339Nano), detail.SkippedCycles, detail.IntervalUS,
		detail.TimerWakeLagUS, detail.ReaderStartLagUS, detail.SkippedTimerWakeLagUS, detail.ReaderTotalUS,
		formatReaderDBusUS(readerTotalExtremum{DBusUS: detail.DBusUS, DBusMeasured: detail.DBusMeasured}), parse)
}
