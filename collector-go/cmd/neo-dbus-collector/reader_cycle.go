package main

import (
	"fmt"
	"time"
)

type readResult struct {
	ok, attempt bool
	timing      readTiming
	err         error
}

type overrunDetail struct {
	SkippedAt                                               time.Time
	IntervalUS                                              int64
	SkippedCycles                                           uint64
	TimerWakeLagUS, ReaderStartLagUS, SkippedTimerWakeLagUS int64
	ReaderTotalUS, DBusUS, ParseUS                          int64
	DBusMeasured, ParseMeasured                             bool
	MissingSkippedWake                                      bool
	DetectedLagUS                                           int64
}

// One fixed record connects future boundaries skipped by the serial timer to
// the reader that just completed. No skipped tick handler actually ran, so its
// wake latency must be n/a rather than a fabricated scheduler measurement.
type serialCycleDetail struct {
	scheduled, wake, started time.Time
	interval                 time.Duration
	result                   readResult
	normal                   bool
	skipped                  uint64
}

func (d *daemon) recordInlineSkipped(name string, skipped timerSkipped, detected time.Time, cycle *serialCycleDetail) {
	if skipped.Count > 0 {
		d.recordOverrunCount(name, false, skipped.Count)
	}
	if !d.performancePolicy.Enabled {
		return
	}
	d.performanceMu.Lock()
	defer d.performanceMu.Unlock()
	stats := d.jobPerformance[name]
	if stats == nil {
		stats = newJobPerformance(d.performancePolicy.JobSampleCount, "dbus")
		d.jobPerformance[name] = stats
	}
	if skipped.ClockReset {
		stats.ClockAnomalyCount++
	}
	if skipped.Count == 0 || cycle == nil || !cycle.result.attempt {
		return
	}
	cycle.skipped += skipped.Count
	if d.performancePolicy.OverrunDetailEnabled != nil && !*d.performancePolicy.OverrunDetailEnabled {
		return
	}
	timing := cycle.result.timing
	stats.LastOverrun = &overrunDetail{SkippedAt: skipped.Last, IntervalUS: cycle.interval.Microseconds(), SkippedCycles: cycle.skipped,
		TimerWakeLagUS: nonNegativeMicroseconds(cycle.wake.Sub(cycle.scheduled)), ReaderStartLagUS: nonNegativeMicroseconds(cycle.started.Sub(cycle.scheduled)),
		ReaderTotalUS: timing.ReaderTotal.Microseconds(), DBusUS: timing.DBus.Microseconds(), DBusMeasured: timing.DBusMeasured, ParseUS: timing.Parse.Microseconds(), ParseMeasured: timing.ParseMeasured,
		MissingSkippedWake: true, DetectedLagUS: nonNegativeMicroseconds(detected.Sub(skipped.Last))}
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
	skippedWake := fmt.Sprint(detail.SkippedTimerWakeLagUS)
	detected := ""
	if detail.MissingSkippedWake {
		skippedWake = "n/a"
		detected = fmt.Sprintf(" detectedLagUs=%d", detail.DetectedLagUS)
	}
	return fmt.Sprintf(" lastOverrun[skippedAt=%s skippedCycles=%d intervalUs=%d timerWakeLagUs=%d readerStartLagUs=%d skippedTimerWakeLagUs=%s%s readerTotalUs=%d dbusUs=%s parseUs=%s]",
		detail.SkippedAt.UTC().Format(time.RFC3339Nano), detail.SkippedCycles, detail.IntervalUS,
		detail.TimerWakeLagUS, detail.ReaderStartLagUS, skippedWake, detected, detail.ReaderTotalUS,
		formatReaderDBusUS(readerTotalExtremum{DBusUS: detail.DBusUS, DBusMeasured: detail.DBusMeasured}), parse)
}
