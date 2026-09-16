package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/machbase/neo-client/v2/api"
)

func TestNextAlignedUsesEpochBoundaries(t *testing.T) {
	base := time.Date(2026, 8, 31, 9, 0, 3, 250_000_000, time.Local)
	if got, want := nextAligned(base, 10*time.Second), 6*time.Second+750*time.Millisecond; got != want {
		t.Fatalf("delay=%s want %s", got, want)
	}
	if got, want := nextAligned(base, time.Millisecond), time.Millisecond; got != want {
		t.Fatalf("1ms delay=%s want %s", got, want)
	}
}

func TestJobLogUsesExistingCGILogLocationAndLevel(t *testing.T) {
	root := t.TempDir()
	d := &daemon{root: filepath.Join(root, "cgi-bin"), logConfigs: map[string]logConfig{
		"line-a": {Level: "warn", MaxFiles: 2},
	}}
	d.log("line-a", "INFO", "collector", "must not be written")
	d.log("line-a", "WARN", "scheduler", "scheduled cycle skipped")
	data, err := os.ReadFile(filepath.Join(root, "logs", "line-a.log"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, "must not be written") || !strings.Contains(text, "[WARN]") || !strings.Contains(text, "scheduled cycle skipped") {
		t.Fatalf("unexpected log content: %q", text)
	}
}

func TestRefreshLogReplacesOnlyTheLiveLogPolicy(t *testing.T) {
	root := t.TempDir()
	cgiRoot := filepath.Join(root, "cgi-bin")
	conf := filepath.Join(cgiRoot, "conf.d")
	if err := os.MkdirAll(conf, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(conf, configFileName), []byte(`{"schemaVersion":2,"logging":{}}`), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(conf, secretFileName), []byte(`{"schemaVersion":1,"servers":{"local":{"host":"127.0.0.1","port":5656,"user":"sys","password":"manager","defaultTable":"TAG","valueColumn":"VALUE","stringValueColumn":""}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(conf, "jobs"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(conf, "job-index"), 0755); err != nil {
		t.Fatal(err)
	}
	job := `{"schemaVersion":1,"name":"line-a","revision":1,"schedule":{"intervalMs":10},"database":{"server":"local","table":"TAG","valueColumn":"VALUE","stringValueColumn":""},"methodCalls":[{"id":"read","inputs":{"DataCount":1,"DeviceString":"%MW0"},"outputSelections":[{"tags":[{"name":"tag-1","bias":0,"multiplier":1,"signed":false}]}]}],"log":{"level":"error","maxFiles":3}}`
	if err := os.WriteFile(filepath.Join(conf, "jobs", "line-a.json"), []byte(job), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(conf, "job-index", "line-a.json"), []byte(`{"schemaVersion":1,"name":"line-a","revision":1}`), 0644); err != nil {
		t.Fatal(err)
	}
	d := &daemon{root: cgiRoot, logConfigs: map[string]logConfig{"line-a": {Level: "info", MaxFiles: 10}}}
	if err := d.refreshLog("line-a"); err != nil {
		t.Fatal(err)
	}
	if got := d.logConfigs["line-a"]; got.Level != "error" || got.MaxFiles != 3 {
		t.Fatalf("unexpected refreshed log policy: %#v", got)
	}
	data, err := os.ReadFile(filepath.Join(root, "logs", "line-a.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "[INFO]") || !strings.Contains(string(data), "log level changed: INFO -> ERROR") {
		t.Fatalf("log level transition must be retained as an audit record: %q", data)
	}
}

func TestLogPolicyNormalizesPLCBounds(t *testing.T) {
	if got := (logPolicy{}).normalized(); got != (logPolicy{MaxFileBytes: 1024 * 1024, MaxFiles: 3, SummaryIntervalMS: time.Hour.Milliseconds()}) {
		t.Fatalf("unexpected default log policy: %#v", got)
	}
	if got := (logPolicy{MaxFileBytes: 63 * 1024, MaxFiles: 11, SummaryIntervalMS: 59 * 1000}).normalized(); got != (logPolicy{MaxFileBytes: 1024 * 1024, MaxFiles: 3, SummaryIntervalMS: time.Hour.Milliseconds()}) {
		t.Fatalf("invalid log policy must normalize: %#v", got)
	}
}

func TestWriterPolicyNormalizesSharedQueueAndFlushBounds(t *testing.T) {
	want := writerPolicy{QueueCapacity: queueCapacity, FlushMaxRows: defaultFlushMaxRows, FlushIntervalMS: defaultFlushInterval.Milliseconds()}
	if got := (writerPolicy{}).normalized(); got != want {
		t.Fatalf("unexpected default writer policy: %#v", got)
	}
	if got := (writerPolicy{QueueCapacity: 1025, FlushMaxRows: 65536, FlushIntervalMS: time.Hour.Milliseconds() + 1}).normalized(); got != want {
		t.Fatalf("invalid writer policy must normalize: %#v", got)
	}
	configured := writerPolicy{QueueCapacity: 8, FlushMaxRows: 512, FlushIntervalMS: 250}
	if got := configured.normalized(); got != configured {
		t.Fatalf("valid writer policy changed: %#v", got)
	}
}

func TestPerformancePolicyClampsDiagnosticFloors(t *testing.T) {
	applied, corrections := (performancePolicy{Enabled: true, JobSampleCount: 10, WriterSummaryIntervalMS: 100}).normalized()
	if applied.JobSampleCount != 500 || applied.WriterSummaryIntervalMS != 10000 {
		t.Fatalf("unexpected applied performance policy: %#v", applied)
	}
	if got := strings.Join(corrections, ","); !strings.Contains(got, "jobSampleCount=10->500") || !strings.Contains(got, "writerSummaryIntervalMs=100->10000") {
		t.Fatalf("missing correction audit: %q", got)
	}
}

func TestDurationSummaryUsesNearestRankPercentiles(t *testing.T) {
	values := make([]int64, 100)
	for index := range values {
		values[index] = int64(index + 1)
	}
	minimum, p50, average, p99, maximum := durationSummaryUS(values)
	if minimum != 1 || p50 != 50 || average != 50 || p99 != 99 || maximum != 100 {
		t.Fatalf("unexpected duration summary: %d %d %d %d %d", minimum, p50, average, p99, maximum)
	}
}

func TestPerformanceLogsStayBoundedAndSummarized(t *testing.T) {
	root := t.TempDir()
	d := &daemon{
		root:              filepath.Join(root, "cgi-bin"),
		performancePolicy: performancePolicy{Enabled: true, JobSampleCount: 1000, WriterSummaryIntervalMS: 30000},
		logConfigs:        map[string]logConfig{"line-a": {Level: "info"}},
		logPolicy:         (logPolicy{}).normalized(),
		jobPerformance:    map[string]*jobPerformance{"line-a": {DBusUS: make([]int64, 0, 1000)}},
		writerPerformance: writerPerformance{StartedAt: time.Now().Add(-30 * time.Second), DurableUS: make([]int64, 0, maxDurableSamples)},
		jobs:              map[string]*activeJob{"line-a": {}},
	}
	for index := 0; index < 1000; index++ {
		d.recordJobPerformance("line-a", 10*time.Millisecond, readTiming{
			DBus: time.Duration(index+1) * time.Microsecond, Parse: 10 * time.Microsecond,
			DBusMeasured: true, ParseMeasured: true,
		}, nil)
	}
	for index := 0; index < maxDurableSamples+100; index++ {
		d.recordDurable(&batch{EnqueuedAt: time.Now().Add(-time.Duration(index+1) * time.Microsecond)}, time.Now())
	}
	if got := len(d.writerPerformance.DurableUS); got != maxDurableSamples {
		t.Fatalf("durable samples=%d", got)
	}
	d.recordQueueDepth(7)
	d.recordWriterBusy(3 * time.Second)
	d.flushWriterPerformance(true)
	data, err := os.ReadFile(filepath.Join(root, "logs", "line-a.log"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if len(data) > 1024 {
		t.Fatalf("two performance summaries are unexpectedly large: %d bytes", len(data))
	}
	if strings.Count(text, "job summary;") != 1 || strings.Count(text, "writer summary;") != 1 {
		t.Fatalf("performance must be summarized, got %q", text)
	}
	for _, field := range []string{"dbusUs[min=", "p50=", "p99=", "parseAvgUs=", "overIntervalCount=", "errorCount=", "maxQueueDepth=7", "busyRatio=", "queueToDurableP99Us="} {
		if !strings.Contains(text, field) {
			t.Fatalf("missing %s in %q", field, text)
		}
	}
	if !strings.Contains(text, "job=line-a job summary;") || !strings.Contains(text, "scope=shared writer summary;") {
		t.Fatalf("performance log scope is ambiguous: %q", text)
	}
}

func TestPerformanceExcludesUnmeasuredLatencyFromDistribution(t *testing.T) {
	d := &daemon{
		performancePolicy: performancePolicy{Enabled: true, JobSampleCount: 1000, WriterSummaryIntervalMS: 30000},
		jobPerformance:    map[string]*jobPerformance{"line-a": {DBusUS: make([]int64, 0, 1000)}},
	}
	d.recordJobPerformance("line-a", 10*time.Millisecond, readTiming{}, errors.New("connect failed"))
	d.recordJobPerformance("line-a", 10*time.Millisecond, readTiming{
		DBus: 20 * time.Millisecond, DBusMeasured: true,
	}, errors.New("DBus failed"))

	stats := d.jobPerformance["line-a"]
	if stats.Attempts != 2 || stats.ErrorCount != 2 {
		t.Fatalf("attempt/error count = %d/%d", stats.Attempts, stats.ErrorCount)
	}
	if len(stats.DBusUS) != 1 || stats.DBusUS[0] != 20000 {
		t.Fatalf("DBus samples = %#v", stats.DBusUS)
	}
	if stats.ParseSamples != 0 || stats.ParseTotalUS != 0 {
		t.Fatalf("unmeasured parsing was included: %#v", stats)
	}
	if stats.OverIntervalCount != 1 {
		t.Fatalf("over interval count = %d", stats.OverIntervalCount)
	}
}

func TestLogSummaryOnlyWarnsForRepeatedEvents(t *testing.T) {
	root := t.TempDir()
	d := &daemon{
		root:       filepath.Join(root, "cgi-bin"),
		logConfigs: map[string]logConfig{"line-a": {Level: "debug"}},
		logPolicy:  (logPolicy{}).normalized(),
		logSummaries: map[string]logSummary{
			"line-a": {StartedAt: time.Now().Add(-time.Minute), Cycles: 2, Failed: 2, Skipped: 2, LastError: "DBus read failed"},
		},
	}
	d.flushLogSummary("line-a", true)
	data, err := os.ReadFile(filepath.Join(root, "logs", "line-a.log"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if got := strings.Count(text, "cycle summary"); got != 3 {
		t.Fatalf("repeated events must produce warn/error/debug summaries, got %d: %q", got, text)
	}

	d.logSummaries["line-a"] = logSummary{StartedAt: time.Now().Add(-time.Minute), Cycles: 1, Failed: 1, Skipped: 1, LastError: "one failure"}
	d.flushLogSummary("line-a", true)
	data, err = os.ReadFile(filepath.Join(root, "logs", "line-a.log"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(data), "cycle summary"); got != 4 {
		t.Fatalf("single event must add only the debug summary, got %d", got)
	}
}

func TestLoadActiveJobsRejectsInvalidStateAndSortsUniqueNames(t *testing.T) {
	root := t.TempDir()
	conf := filepath.Join(root, "conf.d")
	if err := os.MkdirAll(conf, 0755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(conf, activeFileName)
	if err := os.WriteFile(file, []byte(`{"schemaVersion":1,"names":["line-b","line-a","line-b"]}`), 0644); err != nil {
		t.Fatal(err)
	}
	names, err := loadActiveJobs(root)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(names, ","), "line-a,line-b"; got != want {
		t.Fatalf("names=%s want=%s", got, want)
	}
	if err := os.WriteFile(file, []byte(`{"schemaVersion":1,"names":["../bad"]}`), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadActiveJobs(root); err == nil {
		t.Fatal("invalid active Job name must fail")
	}
}

func writeRegisteredJobFixture(t *testing.T, root string, withIndex bool) {
	t.Helper()
	conf := filepath.Join(root, "conf.d")
	for _, directory := range []string{conf, filepath.Join(conf, "jobs"), filepath.Join(conf, "job-index")} {
		if err := os.MkdirAll(directory, 0755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		configFileName:                       `{"schemaVersion":2,"logging":{},"writer":{},"performance":{"enabled":false}}`,
		secretFileName:                       `{"schemaVersion":1,"servers":{"local":{"host":"127.0.0.1","port":5656,"user":"sys","password":"manager","defaultTable":"TAG","valueColumn":"VALUE","stringValueColumn":""}}}`,
		filepath.Join("jobs", "line-a.json"): `{"schemaVersion":1,"name":"line-a","revision":1,"schedule":{"intervalMs":3600000},"database":{"server":"local","table":"TAG","valueColumn":"VALUE","stringValueColumn":""},"methodCalls":[{"id":"read","inputs":{"DataCount":1,"DeviceString":"%MW0"},"outputSelections":[{"tags":[{"name":"tag-1","bias":0,"multiplier":1,"signed":false}]}]}],"log":{"level":"info","maxFiles":3}}`,
	}
	if withIndex {
		files[filepath.Join("job-index", "line-a.json")] = `{"schemaVersion":1,"name":"line-a","revision":1}`
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(conf, name), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestGoOwnsRegisteredJobLoadAndActiveCheckpoint(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cgi-bin")
	writeRegisteredJobFixture(t, root, true)
	d := &daemon{
		root: root, queue: make(chan *batch, 1), flushNow: make(chan struct{}, 1),
		jobs: map[string]*activeJob{}, runtime: runtimeState{Jobs: map[string]jobRuntime{}},
		logConfigs: map[string]logConfig{}, logSummaries: map[string]logSummary{},
		jobPerformance: map[string]*jobPerformance{}, controls: map[string]*sync.Mutex{},
	}
	stopWriter := startTestWriter(d, func(_ string, got database, _ int) (appenderStream, error) {
		return &fakeAppenderStream{database: got}, nil
	})
	defer stopWriter()
	if err := d.start("line-a"); err != nil {
		t.Fatal(err)
	}
	if names, err := loadActiveJobs(root); err != nil || len(names) != 1 || names[0] != "line-a" {
		t.Fatalf("active checkpoint after start = %v, %v", names, err)
	}
	if err := d.stop("line-a"); err != nil {
		t.Fatal(err)
	}
	if names, err := loadActiveJobs(root); err != nil || len(names) != 0 {
		t.Fatalf("active checkpoint after stop = %v, %v", names, err)
	}
}

func waitForRuntimeState(t *testing.T, d *daemon, name, state string) jobRuntime {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		d.mu.Lock()
		value, exists := d.runtime.Jobs[name]
		d.mu.Unlock()
		if exists && value.State == state {
			return value
		}
		time.Sleep(time.Millisecond)
	}
	d.mu.Lock()
	value := d.runtime.Jobs[name]
	d.mu.Unlock()
	t.Fatalf("Job %s state=%q, want %q", name, value.State, state)
	return jobRuntime{}
}

func TestStartReturnsWhileAppenderPreparationContinues(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cgi-bin")
	writeRegisteredJobFixture(t, root, true)
	prepareStarted := make(chan struct{})
	prepareRelease := make(chan struct{})
	stream := &fakeAppenderStream{registerStarted: make(chan struct{}), registerRelease: make(chan struct{})}
	d := &daemon{
		root: root, queue: make(chan *batch, 1), flushNow: make(chan struct{}, 1),
		jobs: map[string]*activeJob{}, runtime: runtimeState{Jobs: map[string]jobRuntime{
			"line-a": {Name: "line-a", State: "stopped", LastReadAt: "2026-09-15T00:00:00Z", LastStoredAt: "2026-09-15T00:00:00.001Z", OverrunCount: 7},
		}},
		logConfigs: map[string]logConfig{}, logSummaries: map[string]logSummary{},
		jobPerformance: map[string]*jobPerformance{}, controls: map[string]*sync.Mutex{},
	}
	stopWriter := startTestWriter(d, func(_ string, got database, _ int) (appenderStream, error) {
		if got.Server != "local" || got.Table != "TAG" {
			return nil, fmt.Errorf("unexpected database prepared: %#v", got)
		}
		close(prepareStarted)
		<-prepareRelease
		stream.database = got
		return stream, nil
	})
	defer stopWriter()
	startedAt := time.Now()
	if err := d.start("line-a"); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(startedAt); elapsed > 250*time.Millisecond {
		t.Fatalf("asynchronous Start blocked for %s", elapsed)
	}
	starting := waitForRuntimeState(t, d, "line-a", "starting")
	if starting.StateDetail != "Preparing tags…" {
		t.Fatalf("starting detail=%q", starting.StateDetail)
	}
	if starting.LastReadAt != "2026-09-15T00:00:00Z" || starting.LastStoredAt != "2026-09-15T00:00:00.001Z" || starting.OverrunCount != 0 {
		t.Fatalf("STARTING must retain completed timestamps and reset skip monitoring: %#v", starting)
	}
	if names, err := loadActiveJobs(root); err != nil || len(names) != 1 || names[0] != "line-a" {
		t.Fatalf("STARTING Job was not checkpointed as desired-active: %v, %v", names, err)
	}
	select {
	case <-prepareStarted:
	case <-time.After(time.Second):
		t.Fatal("Appender preparation was not requested")
	}
	close(prepareRelease)
	select {
	case <-stream.registerStarted:
	case <-time.After(time.Second):
		t.Fatal("TAG registration was not requested")
	}
	if got := waitForRuntimeState(t, d, "line-a", "starting"); got.State != "starting" {
		t.Fatalf("Job became running before TAG registration: %#v", got)
	}
	close(stream.registerRelease)
	waitForRuntimeState(t, d, "line-a", "running")
	if err := d.stop("line-a"); err != nil {
		t.Fatal(err)
	}
}

func TestAsyncStartPublishesFailedWhenAppenderPreparationFails(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cgi-bin")
	writeRegisteredJobFixture(t, root, true)
	d := &daemon{
		root: root, queue: make(chan *batch, 1), flushNow: make(chan struct{}, 1),
		jobs: map[string]*activeJob{}, runtime: runtimeState{Jobs: map[string]jobRuntime{}},
		logConfigs: map[string]logConfig{}, logSummaries: map[string]logSummary{},
		jobPerformance: map[string]*jobPerformance{}, controls: map[string]*sync.Mutex{},
	}
	stopWriter := startTestWriter(d, func(string, database, int) (appenderStream, error) {
		return nil, errors.New("Appender unavailable")
	})
	defer stopWriter()
	if err := d.start("line-a"); err != nil {
		t.Fatalf("Start acceptance failed: %v", err)
	}
	failed := waitForRuntimeState(t, d, "line-a", "failed")
	if !strings.Contains(failed.StateDetail, "Appender unavailable") {
		t.Fatalf("failed detail=%q", failed.StateDetail)
	}
	d.mu.Lock()
	_, running := d.jobs["line-a"]
	d.mu.Unlock()
	if running {
		t.Fatal("failed start retained an active Job")
	}
	if names, err := loadActiveJobs(root); err != nil || len(names) != 0 {
		t.Fatalf("failed start changed active checkpoint: %v, %v", names, err)
	}
}

func TestAsyncStartPublishesFailedWhenTagRegistrationFails(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cgi-bin")
	writeRegisteredJobFixture(t, root, true)
	d := &daemon{
		root: root, queue: make(chan *batch, 1), flushNow: make(chan struct{}, 1),
		jobs: map[string]*activeJob{}, runtime: runtimeState{Jobs: map[string]jobRuntime{}},
		logConfigs: map[string]logConfig{}, logSummaries: map[string]logSummary{},
		jobPerformance: map[string]*jobPerformance{}, controls: map[string]*sync.Mutex{},
	}
	stopWriter := startTestWriter(d, func(_ string, got database, _ int) (appenderStream, error) {
		return &fakeAppenderStream{database: got, registerErr: errors.New("metadata unavailable")}, nil
	})
	defer stopWriter()
	if err := d.start("line-a"); err != nil {
		t.Fatalf("Start acceptance failed: %v", err)
	}
	failed := waitForRuntimeState(t, d, "line-a", "failed")
	if !strings.Contains(failed.StateDetail, "metadata unavailable") {
		t.Fatalf("failed detail=%q", failed.StateDetail)
	}
	d.mu.Lock()
	_, running := d.jobs["line-a"]
	d.mu.Unlock()
	if running {
		t.Fatal("failed metadata registration published a running Job")
	}
	if names, err := loadActiveJobs(root); err != nil || len(names) != 0 {
		t.Fatalf("failed metadata registration changed active checkpoint: %v, %v", names, err)
	}
}

type fakeAppenderStream struct {
	database        database
	closed          int
	appended        int
	flushed         int
	registered      []string
	registerErr     error
	registerStarted chan struct{}
	registerRelease chan struct{}
}

func (a *fakeAppenderStream) same(database database) bool { return a.database == database }
func (a *fakeAppenderStream) close() error                { a.closed++; return nil }
func (a *fakeAppenderStream) flush() error                { a.flushed++; return nil }
func (a *fakeAppenderStream) append([]row) error          { a.appended++; return nil }
func (a *fakeAppenderStream) registerTags(ctx context.Context, tags []string) error {
	a.registered = append(a.registered, tags...)
	if a.registerStarted != nil {
		close(a.registerStarted)
	}
	if a.registerRelease != nil {
		select {
		case <-a.registerRelease:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return a.registerErr
}

func startTestWriter(d *daemon, opener func(string, database, int) (appenderStream, error)) func() {
	if d.queue == nil {
		d.queue = make(chan *batch, 1)
	}
	if d.flushNow == nil {
		d.flushNow = make(chan struct{}, 1)
	}
	d.appenderPrepare = make(chan appenderPrepareRequest)
	d.appenderOpener = opener
	d.performancePolicy.WriterSummaryIntervalMS = 30000
	done := make(chan struct{})
	go func() { defer close(done); d.writer() }()
	return func() {
		close(d.queue)
		<-done
	}
}

func TestWriterPreparesOnceAndReusesMatchingAppender(t *testing.T) {
	first := &fakeAppenderStream{}
	opens := 0
	d := &daemon{
		queue:           make(chan *batch, 1),
		flushNow:        make(chan struct{}, 1),
		appenderPrepare: make(chan appenderPrepareRequest),
		writerPolicy:    writerPolicy{QueueCapacity: 1, FlushMaxRows: 1024, FlushIntervalMS: 1000},
		performancePolicy: performancePolicy{
			WriterSummaryIntervalMS: 30000,
		},
		appenderOpener: func(_ string, got database, _ int) (appenderStream, error) {
			opens++
			first.database = got
			return first, nil
		},
	}
	done := make(chan struct{})
	go func() { defer close(done); d.writer() }()
	for index := 0; index < 2; index++ {
		result := make(chan error, 1)
		d.appenderPrepare <- appenderPrepareRequest{Database: database{Server: "local", Table: "TAG"}, Result: result}
		if err := <-result; err != nil {
			t.Fatal(err)
		}
	}
	if opens != 1 {
		t.Fatalf("matching Appender opened %d times", opens)
	}
	close(d.queue)
	<-done
	if first.closed != 1 {
		t.Fatalf("Appender close count=%d", first.closed)
	}
}

func TestSlowTagRegistrationDoesNotBlockExistingWriter(t *testing.T) {
	registerStarted := make(chan struct{})
	registerRelease := make(chan struct{})
	stream := &fakeAppenderStream{
		database:        database{Server: "local", Table: "TAG"},
		registerStarted: registerStarted, registerRelease: registerRelease,
	}
	d := &daemon{
		queue:             make(chan *batch, 1),
		flushNow:          make(chan struct{}, 1),
		appenderPrepare:   make(chan appenderPrepareRequest),
		writerPolicy:      writerPolicy{QueueCapacity: 1, FlushMaxRows: 1024, FlushIntervalMS: 60000},
		performancePolicy: performancePolicy{WriterSummaryIntervalMS: 30000},
		appenderOpener:    func(_ string, _ database, _ int) (appenderStream, error) { return stream, nil },
	}
	done := make(chan struct{})
	go func() { defer close(done); d.writer() }()
	prepareResult := make(chan error, 1)
	d.appenderPrepare <- appenderPrepareRequest{
		Context: context.Background(), Database: stream.database, Tags: []string{"NEW-TAG"}, Result: prepareResult,
	}
	select {
	case <-registerStarted:
	case <-time.After(time.Second):
		t.Fatal("TAG registration did not start")
	}
	existing := &batch{
		Database: stream.database, Rows: []row{{Name: "EXISTING", Time: time.Now(), Value: 1}},
		Finished: make(chan error, 1), EnqueuedAt: time.Now(), FlushAfterAppend: true,
	}
	d.queue <- existing
	select {
	case err := <-existing.Finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("slow TAG registration blocked append for an existing Job")
	}
	close(registerRelease)
	if err := <-prepareResult; err != nil {
		t.Fatal(err)
	}
	close(d.queue)
	<-done
}

func TestStopCancelsStartingJob(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cgi-bin")
	writeRegisteredJobFixture(t, root, true)
	registerStarted := make(chan struct{})
	d := &daemon{
		root: root, queue: make(chan *batch, 1), flushNow: make(chan struct{}, 1),
		jobs: map[string]*activeJob{}, runtime: runtimeState{Jobs: map[string]jobRuntime{}},
		logConfigs: map[string]logConfig{}, logSummaries: map[string]logSummary{},
		jobPerformance: map[string]*jobPerformance{}, controls: map[string]*sync.Mutex{},
	}
	stopWriter := startTestWriter(d, func(_ string, got database, _ int) (appenderStream, error) {
		return &fakeAppenderStream{database: got, registerStarted: registerStarted, registerRelease: make(chan struct{})}, nil
	})
	defer stopWriter()
	if err := d.start("line-a"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-registerStarted:
	case <-time.After(time.Second):
		t.Fatal("TAG registration did not start")
	}
	if err := d.stop("line-a"); err != nil {
		t.Fatal(err)
	}
	stopped := waitForRuntimeState(t, d, "line-a", "stopped")
	if stopped.StateDetail != "" {
		t.Fatalf("stopped detail=%q", stopped.StateDetail)
	}
	if names, err := loadActiveJobs(root); err != nil || len(names) != 0 {
		t.Fatalf("stopped STARTING Job remained desired-active: %v, %v", names, err)
	}
}

func TestConfiguredTagNamesAreUniqueAndOrdered(t *testing.T) {
	config := jobConfig{MethodCalls: []method{
		{OutputSelections: []selection{{Tags: []tag{{Name: "TAG-A"}, {Name: "TAG-B"}}}}},
		{OutputSelections: []selection{{Tags: []tag{{Name: "TAG-B"}, {Name: "TAG-C"}}}}},
	}}
	if got := strings.Join(configuredTagNames(config), ","); got != "TAG-A,TAG-B,TAG-C" {
		t.Fatalf("configured Tag names=%q", got)
	}
}

func TestWriterMakesPrimingBatchDurableImmediately(t *testing.T) {
	stream := &fakeAppenderStream{database: database{Server: "local", Table: "TAG"}}
	d := &daemon{
		queue:           make(chan *batch, 1),
		flushNow:        make(chan struct{}, 1),
		appenderPrepare: make(chan appenderPrepareRequest),
		writerPolicy:    writerPolicy{QueueCapacity: 1, FlushMaxRows: 1024, FlushIntervalMS: 60000},
		performancePolicy: performancePolicy{
			WriterSummaryIntervalMS: 30000,
		},
		appenderOpener: func(_ string, _ database, _ int) (appenderStream, error) {
			return stream, nil
		},
	}
	done := make(chan struct{})
	go func() { defer close(done); d.writer() }()

	priming := &batch{
		Database:         stream.database,
		Rows:             []row{{Name: "TAG-1", Time: time.Now(), Value: 1}},
		Finished:         make(chan error, 1),
		EnqueuedAt:       time.Now(),
		FlushAfterAppend: true,
	}
	d.queue <- priming
	select {
	case err := <-priming.Finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("priming batch waited for the periodic flush")
	}
	if stream.appended != 1 || stream.flushed != 1 {
		t.Fatalf("priming append/flush count=%d/%d", stream.appended, stream.flushed)
	}
	close(d.queue)
	<-done
}

func TestGoRejectsCanonicalJobWithoutRegistrationIndex(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cgi-bin")
	writeRegisteredJobFixture(t, root, false)
	if _, err := loadJob(root, "line-a"); err == nil || !strings.Contains(err.Error(), "not registered") {
		t.Fatalf("missing index error = %v", err)
	}
}

func TestRuntimeMutationOnlyMarksCheckpointDirty(t *testing.T) {
	d := &daemon{
		queue: make(chan *batch, 1), runtime: runtimeState{Jobs: map[string]jobRuntime{}},
		runtimeDirty: make(chan struct{}, 1),
	}
	d.mu.Lock()
	d.updateLocked("line-a", func(value *jobRuntime) { value.Name = "line-a" })
	d.mu.Unlock()
	select {
	case <-d.runtimeDirty:
	default:
		t.Fatal("runtime mutation did not schedule a checkpoint")
	}
}

func TestPerJobControlsSerializeOnlyTheSameJob(t *testing.T) {
	d := &daemon{controls: map[string]*sync.Mutex{}}
	if d.controlFor("line-a") != d.controlFor("line-a") {
		t.Fatal("same Job must share one control mutex")
	}
	if d.controlFor("line-a") == d.controlFor("line-b") {
		t.Fatal("different Jobs must not share the control mutex")
	}
}

func TestTransformRespectsConfiguredOrder(t *testing.T) {
	if got, _ := transform(int64(3), tag{Bias: 2, Multiplier: 4, TransformOrder: []string{"bias", "multiplier"}}); got != float64(20) {
		t.Fatalf("bias first: %v", got)
	}
	if got, _ := transform(int64(3), tag{Bias: 2, Multiplier: 4, TransformOrder: []string{"multiplier", "bias"}}); got != float64(14) {
		t.Fatalf("multiplier first: %v", got)
	}
	if got, _ := transform(int64(3), tag{Bias: 2, Multiplier: 0, TransformOrder: []string{"bias", "multiplier"}}); got != float64(0) {
		t.Fatalf("zero multiplier must be preserved: %v", got)
	}
}

func TestDecodeLSDeviceRowsUsesPLCTimestamp(t *testing.T) {
	rows, err := decodeLSDeviceRows(`{"rtn":1,"data-count":2,"data":[11,12],"time-stamp-us":1788333667837979}`, 2, []tag{
		{Name: "MB0", Multiplier: 1}, {Name: "MB1", Bias: 1, Multiplier: 2},
	}, lsValueCodec{bits: 8})
	if err != nil {
		t.Fatal(err)
	}
	want := time.Unix(1788333667, 837979000).UTC()
	if len(rows) != 2 || !rows[0].Time.Equal(want) || !rows[1].Time.Equal(want) {
		t.Fatalf("rows must use the DBus timestamp: %#v want %s", rows, want)
	}
	if rows[0].Value != uint64(11) || rows[1].Value != float64(26) {
		t.Fatalf("unexpected transformed values: %#v", rows)
	}
}

func TestDecodeLSDeviceRowsRejectsMissingPLCTimestamp(t *testing.T) {
	if _, err := decodeLSDeviceRows(`{"rtn":1,"data-count":1,"data":[11]}`, 1, []tag{{Name: "MB0"}}, lsValueCodec{bits: 8}); err == nil {
		t.Fatal("missing DBus time-stamp-us must not fall back to collector time")
	}
}

func TestLSAddressDataTypeConvertsUnsignedBeforeTransform(t *testing.T) {
	codec, err := lsValueCodecForAddress("%MW0")
	if err != nil || codec != (lsValueCodec{bits: 16}) {
		t.Fatalf("word codec=%#v err=%v", codec, err)
	}
	rows, err := decodeLSDeviceRows(`{"rtn":1,"data-count":1,"data":[65535],"time-stamp-us":1788333667837979}`, 1,
		[]tag{{Name: "MW0", Signed: true, Bias: 3, Multiplier: 2, TransformOrder: []string{"bias", "multiplier"}}}, codec)
	if err != nil {
		t.Fatal(err)
	}
	// 0xffff is -1 as a signed W value; (-1 + 3) * 2 is 4.
	if len(rows) != 1 || rows[0].Value != float64(4) {
		t.Fatalf("unsigned-to-signed conversion must precede transform: %#v", rows)
	}
	for address, want := range map[string]lsValueCodec{
		"%MX0": {bits: 1}, "%MB0": {bits: 8}, "%MD0": {bits: 32}, "%ML0": {bits: 64},
	} {
		if got, codecError := lsValueCodecForAddress(address); codecError != nil || got != want {
			t.Fatalf("address %s codec=%#v err=%v", address, got, codecError)
		}
	}
}

func TestLSUnsignedAndBitValuesRemainUnsigned(t *testing.T) {
	codec, err := lsValueCodecForAddress("%MW0")
	if err != nil {
		t.Fatal(err)
	}
	rows, err := decodeLSDeviceRows(`{"rtn":1,"data-count":1,"data":[65535],"time-stamp-us":1788333667837979}`, 1,
		[]tag{{Name: "MW0", Multiplier: 1}}, codec)
	if err != nil || rows[0].Value != uint64(65535) {
		t.Fatalf("unsigned word=%#v err=%v", rows, err)
	}
	bitRows, err := decodeLSDeviceRows(`{"rtn":1,"data-count":1,"data":[1],"time-stamp-us":1788333667837979}`, 1,
		[]tag{{Name: "MX0", Signed: true, Multiplier: 1}}, lsValueCodec{bits: 1})
	if err != nil || bitRows[0].Value != uint64(1) {
		t.Fatalf("Bit signed must be ignored: %#v err=%v", bitRows, err)
	}
}

func TestValueForColumnPreservesIntegerAndRejectsFraction(t *testing.T) {
	value, err := valueForColumn(int64(-1), api.ColumnTypeLong)
	if err != nil || value != int64(-1) {
		t.Fatalf("LONG value=%#v err=%v", value, err)
	}
	value, err = valueForColumn(uint64(65535), api.ColumnTypeInteger)
	if err != nil || value != int32(65535) {
		t.Fatalf("INTEGER value=%#v err=%v", value, err)
	}
	if _, err := valueForColumn(1.5, api.ColumnTypeLong); err == nil {
		t.Fatal("fractional integer append must fail")
	}
	if _, err := valueForColumn(uint64(math.MaxInt64)+1, api.ColumnTypeLong); err == nil {
		t.Fatal("LONG overflow must fail")
	}
}

func TestNewJobRuntimeResetsSkipMonitoring(t *testing.T) {
	runtime := newJobRuntime("line-a", "starting", "Preparing tags…")
	if runtime.Name != "line-a" || runtime.State != "starting" || runtime.StateDetail != "Preparing tags…" {
		t.Fatalf("unexpected fresh runtime: %#v", runtime)
	}
	if runtime.OverrunCount != 0 || runtime.LastOverrunAt != "" || runtime.QueueSkipped != 0 || runtime.RowsStored != 0 {
		t.Fatalf("fresh Job runtime must reset monitoring values: %#v", runtime)
	}
}

func TestClearOverrunKeepsDataPlaneRuntime(t *testing.T) {
	root := t.TempDir()
	d := &daemon{root: root, runtime: runtimeState{Jobs: map[string]jobRuntime{
		"line-a": {Name: "line-a", State: "running", RowsStored: 42, OverrunCount: 3, LastOverrunAt: "2026-09-02T00:00:00.000Z", QueueSkipped: 2},
	}}}
	if err := d.clearOverrun("line-a"); err != nil {
		t.Fatal(err)
	}
	runtime := d.runtime.Jobs["line-a"]
	if runtime.OverrunCount != 0 || runtime.LastOverrunAt != "" || runtime.QueueSkipped != 0 {
		t.Fatalf("skip monitoring was not cleared: %#v", runtime)
	}
	if runtime.RowsStored != 42 || runtime.State != "running" {
		t.Fatalf("clear must not change data-plane runtime: %#v", runtime)
	}
	if err := d.clearOverrun("unknown"); err == nil {
		t.Fatal("missing runtime must return an error")
	}
}
