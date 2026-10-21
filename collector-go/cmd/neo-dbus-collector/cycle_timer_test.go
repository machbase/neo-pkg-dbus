//go:build linux && amd64

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

// Opt-in finite diagnostic using the production timer implementation. This
// does no DB I/O and is not run by normal unit tests or included in the package.
func TestCycleTimerDiagnostic(t *testing.T) {
	seconds, err := strconv.Atoi(os.Getenv("NEO_DBUS_TIMER_PROBE_SECONDS"))
	if err != nil || seconds < 1 || seconds > 300 {
		t.Skip("set NEO_DBUS_TIMER_PROBE_SECONDS=1..300")
	}
	for _, absolute := range []bool{false, true} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(seconds)*time.Second)
		timer, err := newCycleTimer(ctx, 20*time.Millisecond, absolute)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		lags := make([]int64, 0, seconds*50)
		var early, late1, late3, late5 int
		for {
			scheduled, wake, err := timer.Wait(ctx)
			if err != nil {
				if ctx.Err() == nil {
					t.Fatal(err)
				}
				break
			}
			lag := wake.Sub(scheduled)
			if lag < 0 {
				early++
			}
			us := nonNegativeMicroseconds(lag)
			lags = append(lags, us)
			if us >= 1000 {
				late1++
			}
			if us >= 3000 {
				late3++
			}
			if us >= 5000 {
				late5++
			}
		}
		timer.Close()
		cancel()
		minimum, p50, average, p99, maximum := durationSummaryUS(lags)
		t.Logf("timerMode=%s durationSeconds=%d intervalMs=20 samples=%d wakeUs[min=%d p50=%d avg=%d p99=%d max=%d] lateCount[1ms=%d 3ms=%d 5ms=%d] early=%d", timerMode(absolute), seconds, len(lags), minimum, p50, average, p99, maximum, late1, late3, late5, early)
	}
}

type controlledCycleTick struct{ scheduled, wake time.Time }
type controlledCycleTimer struct{ ticks chan controlledCycleTick }

func (t *controlledCycleTimer) Wait(ctx context.Context) (time.Time, time.Time, error) {
	select {
	case <-ctx.Done():
		return time.Time{}, time.Time{}, ctx.Err()
	case tick := <-t.ticks:
		return tick.scheduled, tick.wake, nil
	}
}
func (*controlledCycleTimer) Close() {}

func TestReaderSchedulerAssociatesSkippedTicksWithBlockedBufferPreparation(t *testing.T) {
	config := jobConfig{Execution: execution{Test: true}, Schedule: schedule{IntervalMS: 20}, MethodCalls: []method{{Inputs: json.RawMessage(`{"DataCount":1,"DeviceString":"%MB0"}`), OutputSelections: []selection{{Tags: []tag{{Name: "B0", Multiplier: 1}}}}}}}
	plan, err := buildReadPlan(config)
	if err != nil {
		t.Fatal(err)
	}
	active := &activeJob{plan: plan, buffers: newRowBufferPool(plan)}
	d := readerPerformanceFixture(2, "test")
	d.root = filepath.Join(t.TempDir(), "cgi-bin")
	d.queue = make(chan *batch, 2)
	d.runtime = runtimeState{Jobs: map[string]jobRuntime{}}
	d.logConfigs = map[string]logConfig{"line-a": {Level: "error"}}
	d.logPolicy = (logPolicy{}).normalized()
	d.logSummaries = map[string]logSummary{}
	d.runtimeDirty = make(chan struct{}, 1)
	timer := &controlledCycleTimer{ticks: make(chan controlledCycleTick, 8)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); d.readerWithTimer(ctx, config, "line-a", active, timer) }()
	start := time.Now()
	timer.ticks <- controlledCycleTick{start, start.Add(time.Millisecond)}
	first := <-d.queue
	first.queueReservation.release()
	first.releaseRows()
	first.Finished <- nil
	active.buffers.mu.Lock()
	second := start.Add(20 * time.Millisecond)
	timer.ticks <- controlledCycleTick{second, second.Add(2 * time.Millisecond)}
	limit := time.Now().Add(time.Second)
	for len(d.queueSlots) == 0 && time.Now().Before(limit) {
		time.Sleep(time.Millisecond)
	}
	if len(d.queueSlots) == 0 {
		active.buffers.mu.Unlock()
		t.Fatal("reader did not reserve queue")
	}
	for n := 2; n <= 3; n++ {
		s := start.Add(time.Duration(n) * 20 * time.Millisecond)
		timer.ticks <- controlledCycleTick{s, s.Add(3 * time.Millisecond)}
	}
	for time.Now().Before(limit) {
		d.mu.Lock()
		count := d.runtime.Jobs["line-a"].OverrunCount
		d.mu.Unlock()
		if count == 2 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	active.buffers.mu.Unlock()
	secondBatch := <-d.queue
	secondBatch.queueReservation.release()
	secondBatch.releaseRows()
	active.work.Done()
	var record performanceLogRecord
	select {
	case record = <-d.performanceLogs:
	case <-time.After(time.Second):
		t.Fatal("missing reader summary")
	}
	if record.Summary.OverIntervalCount != 2 || record.Summary.LastOverrun == nil {
		t.Fatalf("summary=%+v", record.Summary)
	}
	detail := record.Summary.LastOverrun
	if detail.SkippedCycles != 2 || detail.TimerWakeLagUS != 2000 || detail.SkippedTimerWakeLagUS != 3000 || detail.DBusMeasured {
		t.Fatalf("detail=%+v", detail)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("reader did not stop")
	}
	if active.buffers.dispose() != 0 {
		t.Fatal("buffer leaked")
	}
}

func TestPerformanceLogBackpressureDoesNotKeepCompletedReaderBusy(t *testing.T) {
	config := jobConfig{Execution: execution{Test: true}, Schedule: schedule{IntervalMS: 20}, MethodCalls: []method{{Inputs: json.RawMessage(`{"DataCount":1,"DeviceString":"%MB0"}`), OutputSelections: []selection{{Tags: []tag{{Name: "B0", Multiplier: 1}}}}}}}
	plan, err := buildReadPlan(config)
	if err != nil {
		t.Fatal(err)
	}
	active := &activeJob{plan: plan, buffers: newRowBufferPool(plan)}
	d := readerPerformanceFixture(1, "test")
	d.performanceLogs = make(chan performanceLogRecord, 1)
	d.root = filepath.Join(t.TempDir(), "cgi-bin")
	d.queue = make(chan *batch, 2)
	d.runtime = runtimeState{Jobs: map[string]jobRuntime{}}
	d.logConfigs = map[string]logConfig{"line-a": {Level: "error"}}
	d.logSummaries = map[string]logSummary{}
	d.runtimeDirty = make(chan struct{}, 1)
	timer := &controlledCycleTimer{ticks: make(chan controlledCycleTick, 8)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); d.readerWithTimer(ctx, config, "line-a", active, timer) }()
	for n := 0; n < 3; n++ {
		d.performanceMu.Lock()
		previous := d.jobPerformance["line-a"]
		d.performanceMu.Unlock()
		now := time.Now()
		timer.ticks <- controlledCycleTick{now, now}
		var queued *batch
		select {
		case queued = <-d.queue:
		case <-time.After(time.Second):
			t.Fatal("logger kept completed reader busy")
		}
		queued.queueReservation.release()
		queued.releaseRows()
		if queued.Finished != nil {
			queued.Finished <- nil
		} else {
			active.work.Done()
		}
		limit := time.Now().Add(time.Second)
		advanced := false
		for time.Now().Before(limit) {
			d.performanceMu.Lock()
			advanced = d.jobPerformance["line-a"] != previous
			d.performanceMu.Unlock()
			if advanced {
				break
			}
			time.Sleep(time.Millisecond)
		}
		if !advanced {
			t.Fatal("reader did not detach its summary")
		}
	}
	// One summary filled the channel; the other two workers are waiting to
	// submit. Their readers have already released busy, allowing all 3 reads.
	for n := 0; n < 3; n++ {
		select {
		case <-d.performanceLogs:
		case <-time.After(time.Second):
			t.Fatal("summary lost")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("reader did not drain")
	}
	if d.runtime.Jobs["line-a"].OverrunCount != 0 {
		t.Fatal("logging caused an overrun")
	}
	if active.buffers.dispose() != 0 {
		t.Fatal("buffer leaked")
	}
}

func TestCycleTimersKeepEpochBoundariesAndSkipPastDeadlines(t *testing.T) {
	for _, absolute := range []bool{false, true} {
		t.Run(timerMode(absolute), func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			interval := 4 * time.Millisecond
			timer, err := newCycleTimer(ctx, interval, absolute)
			if err != nil {
				t.Fatal(err)
			}
			defer timer.Close()
			var previous time.Time
			for n := 0; n < 8; n++ {
				scheduled, wake, err := timer.Wait(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if scheduled.UnixNano()%int64(interval) != 0 {
					t.Fatalf("not epoch aligned: %v", scheduled)
				}
				if wake.Before(scheduled) {
					t.Fatalf("early wake: %s", wake.Sub(scheduled))
				}
				if !previous.IsZero() && !scheduled.After(previous) {
					t.Fatal("deadline went backwards")
				}
				previous = scheduled
			}
			time.Sleep(19 * time.Millisecond)
			now := time.Now()
			scheduled, _, err := timer.Wait(ctx)
			if err != nil || !scheduled.After(now) {
				t.Fatalf("replayed stale boundary: %v %v", scheduled, err)
			}
		})
	}
}

func TestCycleTimersCancelLongWaitWithoutFDOrWorkerLeak(t *testing.T) {
	fds, _ := os.ReadDir("/proc/self/fd")
	workers := runtime.NumGoroutine()
	for _, absolute := range []bool{false, true} {
		for n := 0; n < 40; n++ {
			ctx, cancel := context.WithCancel(context.Background())
			timer, err := newCycleTimer(ctx, time.Hour, absolute)
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { _, _, err := timer.Wait(ctx); done <- err }()
			cancel()
			select {
			case err := <-done:
				if err != context.Canceled {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("long timer did not cancel")
			}
			timer.Close()
			timer.Close()
		}
	}
	after, _ := os.ReadDir("/proc/self/fd")
	if len(after) > len(fds) {
		t.Fatalf("FDs %d -> %d", len(fds), len(after))
	}
	if runtime.NumGoroutine() > workers+1 {
		t.Fatalf("worker leak: %d -> %d", workers, runtime.NumGoroutine())
	}
}

func TestOverrunDetailRetainsOnlyTheBlockedReaderAndLatestSkip(t *testing.T) {
	var cycle readerCycle
	scheduled := time.Unix(0, 0)
	if !cycle.begin(scheduled, scheduled.Add(time.Millisecond), 20*time.Millisecond) {
		t.Fatal("first reader refused")
	}
	cycle.started(scheduled.Add(1500 * time.Microsecond))
	for n := 1; n <= 3; n++ {
		s := scheduled.Add(time.Duration(n) * 20 * time.Millisecond)
		if cycle.begin(s, s.Add(time.Duration(n)*time.Millisecond), 20*time.Millisecond) {
			t.Fatal("overlap admitted")
		}
	}
	timing := readTiming{ReaderTotal: 65 * time.Millisecond, DBus: 60 * time.Millisecond, Parse: time.Millisecond, DBusMeasured: true, ParseMeasured: true, ReaderTotalMeasured: true}
	detail := cycle.finish(timing)
	if detail.SkippedCycles != 3 || detail.SkippedTimerWakeLagUS != 3000 || detail.ReaderStartLagUS != 1500 || detail.DBusUS != 60000 {
		t.Fatalf("detail=%+v", detail)
	}
	d := readerPerformanceFixture(1, "dbus")
	for n := 0; n < 3; n++ {
		d.recordPerformanceSkip("line-a", false)
	}
	d.recordReadResult("line-a", readResult{attempt: true, timing: timing}, detail)
	record := readerPerformanceRecord(t, d)
	for _, part := range []string{"overIntervalCount=3", "lastOverrun[", "skippedCycles=3", "readerTotalUs=65000", "timerWakeLagUs=1000", "skippedTimerWakeLagUs=3000", "dbusUs=60000"} {
		if !strings.Contains(formatJobPerformance(record.Name, record.Summary), part) {
			t.Fatal(part)
		}
	}
	if !cycle.begin(scheduled.Add(time.Second), scheduled.Add(time.Second), 20*time.Millisecond) {
		t.Fatal("busy not released")
	}
	cycle.started(scheduled.Add(time.Second))
	if cycle.finish(timing) != nil {
		t.Fatal("old skip leaked into clean reader")
	}
	d.recordReadResult("line-a", readResult{attempt: true, timing: timing})
	if readerPerformanceRecord(t, d).Summary.LastOverrun != nil {
		t.Fatal("old detail leaked into next window")
	}
}

func TestOverrunDetailCanBeDisabledWithoutChangingSkipCounts(t *testing.T) {
	d := readerPerformanceFixture(1, "dbus")
	disabled := false
	d.performancePolicy.OverrunDetailEnabled = &disabled
	d.recordPerformanceSkip("line-a", false)
	d.recordPerformanceSkip("line-a", true)
	d.recordReadResult("line-a", readResult{attempt: true}, &overrunDetail{SkippedCycles: 1})
	record := readerPerformanceRecord(t, d)
	if record.Summary.LastOverrun != nil || record.Summary.OverIntervalCount != 1 || record.Summary.QueueFullSkipCount != 1 {
		t.Fatal("detail switch altered counters")
	}
}

func TestReaderTotalIncludesPreparationButNotDurableWait(t *testing.T) {
	for _, prime := range []bool{false, true} {
		t.Run(fmt.Sprint(prime), func(t *testing.T) {
			config := jobConfig{Execution: execution{Test: true}, MethodCalls: []method{{Inputs: json.RawMessage(`{"DataCount":1,"DeviceString":"%MB0"}`), OutputSelections: []selection{{Tags: []tag{{Name: "B0", Multiplier: 1}}}}}}}
			plan, err := buildReadPlan(config)
			if err != nil {
				t.Fatal(err)
			}
			active := &activeJob{plan: plan, buffers: newRowBufferPool(plan)}
			d := &daemon{queue: make(chan *batch, 1), runtime: runtimeState{Jobs: map[string]jobRuntime{}}, logConfigs: map[string]logConfig{}, logSummaries: map[string]logSummary{}, runtimeDirty: make(chan struct{}, 1)}
			active.buffers.mu.Lock()
			done := make(chan readResult, 1)
			go func() {
				var connection *dbus.Conn
				done <- d.readCycle(context.Background(), config, "line-a", &connection, active, prime, time.Now())
			}()
			time.Sleep(25 * time.Millisecond)
			active.buffers.mu.Unlock()
			queued := <-d.queue
			if prime {
				time.Sleep(40 * time.Millisecond)
				queued.Finished <- nil
			} else {
				active.work.Done()
			}
			result := <-done
			if !result.ok || result.timing.ReaderTotal < 25*time.Millisecond {
				t.Fatalf("preparation omitted: %+v", result)
			}
			if prime && result.timing.ReaderTotal >= 60*time.Millisecond {
				t.Fatalf("durable wait included: %+v", result)
			}
			queued.queueReservation.release()
			queued.releaseRows()
			if active.buffers.dispose() != 0 {
				t.Fatal("buffer leaked")
			}
		})
	}
}
