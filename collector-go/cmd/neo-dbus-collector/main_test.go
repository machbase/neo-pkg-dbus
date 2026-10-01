package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	client "github.com/machbase/neo-client/v2"
	"github.com/machbase/neo-client/v2/api"
)

func BenchmarkReaderValueConversion4096(b *testing.B) {
	encoded := make([]json.Number, 4096)
	for index := range encoded {
		encoded[index] = json.Number(fmt.Sprintf("%d", index%256))
	}
	codec := lsValueCodec{bits: 8}
	transformConfig := tag{Bias: 1, Multiplier: 2, TransformOrder: []string{"bias", "multiplier"}, Signed: true}
	b.ReportAllocs()
	b.SetBytes(int64(len(encoded)))
	b.ResetTimer()
	for iteration := 0; iteration < b.N; iteration++ {
		for _, source := range encoded {
			value, err := decodeLSValue(source, codec, "BYTE2INT", transformConfig.Signed)
			if err != nil {
				b.Fatal(err)
			}
			if _, err := transform(value, transformConfig); err != nil {
				b.Fatal(err)
			}
		}
	}
}

func BenchmarkWriterValueConversion4096(b *testing.B) {
	values := make([]any, 4096)
	for index := range values {
		values[index] = float64(index)
	}
	b.ReportAllocs()
	b.SetBytes(int64(len(values)))
	b.ResetTimer()
	for iteration := 0; iteration < b.N; iteration++ {
		for _, source := range values {
			if _, err := valueForColumn(source, api.ColumnTypeDouble); err != nil {
				b.Fatal(err)
			}
		}
	}
}

func BenchmarkSyntheticCycle4096(b *testing.B) {
	tags := make([]tag, 4096)
	for index := range tags {
		tags[index] = tag{Name: fmt.Sprintf("MB%d", index), Conversion: "BYTE2INT", Multiplier: 1, registryIndex: uint32(index)}
	}
	config := jobConfig{MethodCalls: []method{{
		Inputs:           json.RawMessage(`{"DataCount":4096,"DeviceString":"%MB0"}`),
		OutputSelections: []selection{{Tags: tags}},
	}}}
	plan, err := buildReadPlan(config)
	if err != nil {
		b.Fatal(err)
	}

	b.Run("allocate", func(b *testing.B) {
		b.ReportAllocs()
		for iteration := 0; iteration < b.N; iteration++ {
			rows := make([]row, plan.rowCount)
			if _, err := generateTestRowsInto(plan, rows); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("pool", func(b *testing.B) {
		pool := newRowBufferPool(plan)
		b.ReportAllocs()
		b.ResetTimer()
		for iteration := 0; iteration < b.N; iteration++ {
			lease := pool.acquire()
			if _, err := generateTestRowsInto(plan, lease.rows); err != nil {
				b.Fatal(err)
			}
			lease.release()
		}
	})
}

// BenchmarkNativeAppender4096 is opt-in because it writes to a real Machbase
// server. It intentionally exercises nativeAppender.append so results taken
// before and after writer changes remain directly comparable.
func BenchmarkNativeAppender4096(b *testing.B) {
	dsn := strings.TrimSpace(os.Getenv("NEO_DBUS_BENCH_DSN"))
	if dsn == "" {
		b.Skip("set NEO_DBUS_BENCH_DSN to run the native writer benchmark")
	}
	table := fmt.Sprintf("DBUS_WB_%d", os.Getpid())
	db, err := sql.Open("machbase", dsn)
	if err != nil {
		b.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, fmt.Sprintf("CREATE TAG TABLE %s (NAME VARCHAR(100) PRIMARY KEY, TIME DATETIME BASE TIME, VALUE DOUBLE)", table)); err != nil {
		b.Fatal(err)
	}
	defer func() {
		_, _ = db.ExecContext(ctx, fmt.Sprintf("DROP TABLE %s CASCADE", table))
	}()

	ap := &client.Appender{}
	if err := ap.Connect(ctx, dsn, table); err != nil {
		b.Fatal(err)
	}
	flushMaxRows := defaultFlushMaxRows
	if source := strings.TrimSpace(os.Getenv("NEO_DBUS_BENCH_FLUSH_MAX_ROWS")); source != "" {
		parsed, err := strconv.Atoi(source)
		if err != nil || parsed < 1 || parsed > 65535 {
			b.Fatalf("invalid NEO_DBUS_BENCH_FLUSH_MAX_ROWS=%q", source)
		}
		flushMaxRows = parsed
	}
	ap.WithBatchMaxRows(flushMaxRows).WithBatchMaxDelay(0)
	stream := &nativeAppender{
		appender: ap, dsn: dsn, database: database{Table: table}, primary: "NAME", valueType: api.ColumnTypeDouble,
		columnValues: make([]any, len(ap.Columns())), primaryIndex: 0,
		basetimeIndex: 1, valueIndex: 2,
	}
	defer stream.close()

	rows := make([]row, 4096)
	registry := newTagRegistry()
	testConfig := jobConfig{MethodCalls: []method{{OutputSelections: []selection{{Tags: make([]tag, len(rows))}}}}}
	baseTime := time.Now()
	for index := range rows {
		testConfig.MethodCalls[0].OutputSelections[0].Tags[index].Name = fmt.Sprintf("WB_%04d", index)
	}
	if err := registry.bindJob(&testConfig); err != nil {
		b.Fatal(err)
	}
	for index, configured := range testConfig.MethodCalls[0].OutputSelections[0].Tags {
		rows[index] = row{TagIndex: configured.registryIndex, Time: baseTime, Value: float64(index)}
	}
	if err := stream.prepareRegistry(ctx, registry, registry.count()); err != nil {
		b.Fatal(err)
	}
	if err := stream.append(rows, registry); err != nil {
		b.Fatal(err)
	}
	if err := stream.flush(); err != nil {
		b.Fatal(err)
	}

	b.ReportAllocs()
	b.SetBytes(int64(len(rows)))
	b.ResetTimer()
	for iteration := 0; iteration < b.N; iteration++ {
		for index := range rows {
			rows[index].Time = baseTime.Add(time.Duration(iteration+1) * time.Microsecond)
		}
		if err := stream.append(rows, registry); err != nil {
			b.Fatal(err)
		}
	}
	b.StopTimer()
	if err := stream.flush(); err != nil {
		b.Fatal(err)
	}
	b.ReportMetric(float64(flushMaxRows), "flushRows")
	b.ReportMetric(float64(b.N*len(rows))/b.Elapsed().Seconds(), "rows/s")
}

func TestNextAlignedUsesEpochBoundaries(t *testing.T) {
	base := time.Date(2026, 8, 31, 9, 0, 3, 250_000_000, time.Local)
	if got, want := nextAligned(base, 10*time.Second), 6*time.Second+750*time.Millisecond; got != want {
		t.Fatalf("delay=%s want %s", got, want)
	}
	if got, want := nextAligned(base, time.Millisecond), time.Millisecond; got != want {
		t.Fatalf("1ms delay=%s want %s", got, want)
	}
}

func TestRunDaemonStopsWhenLauncherProcessExits(t *testing.T) {
	root := t.TempDir()
	conf := filepath.Join(root, "conf.d")
	if err := os.MkdirAll(conf, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(conf, configFileName), []byte(`{"schemaVersion":2,"logging":{},"writer":{},"performance":{}}`), 0644); err != nil {
		t.Fatal(err)
	}

	launcher := exec.Command(os.Args[0], "-test.run=^TestLauncherHelperProcess$")
	launcher.Env = append(os.Environ(), "DBUS_LAUNCHER_HELPER=1")
	if err := launcher.Start(); err != nil {
		t.Fatalf("start launcher helper: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- runDaemon(root, launcher.Process.Pid) }()
	socket := filepath.Join(root, "data", socketFileName)
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(socket); err == nil {
			break
		}
		if time.Now().After(deadline) {
			_ = launcher.Process.Kill()
			_ = launcher.Wait()
			t.Fatal("collector control socket was not created")
		}
		time.Sleep(10 * time.Millisecond)
	}

	if err := launcher.Process.Kill(); err != nil {
		t.Fatalf("kill launcher helper: %v", err)
	}
	if err := launcher.Wait(); err == nil {
		t.Fatal("launcher helper exited successfully after Kill, want signal error")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runDaemon: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("collector did not stop after launcher exited")
	}
}

func TestLauncherHelperProcess(t *testing.T) {
	if os.Getenv("DBUS_LAUNCHER_HELPER") != "1" {
		return
	}
	select {}
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
		jobPerformance:    map[string]*jobPerformance{"line-a": newJobPerformance(1000, "dbus")},
		writerPerformance: newWriterPerformance(time.Now().Add(-30 * time.Second)),
		jobs:              map[string]*activeJob{"line-a": {}},
	}
	d.recordPerformanceSkip("line-a", false)
	d.recordPerformanceSkip("line-a", false)
	d.recordPerformanceSkip("line-a", true)
	d.recordPerformanceSkip("line-a", true)
	d.recordPerformanceSkip("line-a", true)
	for index := 0; index < 1000; index++ {
		d.recordJobPerformance("line-a", readTiming{
			DBus: time.Duration(index+1) * time.Microsecond, Parse: 10 * time.Microsecond,
			ReaderTotal:  time.Duration(index+21) * time.Microsecond,
			DBusMeasured: true, ParseMeasured: true, ReaderTotalMeasured: true,
		}, nil)
	}
	for index := 0; index < maxDurableSamples+100; index++ {
		d.recordDurable(&batch{EnqueuedAt: time.Now().Add(-time.Duration(index+1) * time.Microsecond)}, time.Now())
	}
	if got := len(d.writerPerformance.DurableUS); got != maxDurableSamples {
		t.Fatalf("durable samples=%d", got)
	}
	d.recordQueueDepth(7)
	d.recordWriterAppend(2*time.Millisecond, 4096)
	d.recordWriterFlush(3*time.Second, nil)
	d.flushWriterPerformance(true)
	data, err := os.ReadFile(filepath.Join(root, "logs", "line-a.log"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if len(data) > 1024 {
		t.Fatalf("two performance summaries are unexpectedly large: %d bytes", len(data))
	}
	t.Logf("two performance summary records=%d bytes", len(data))
	if strings.Count(text, "job summary;") != 1 || strings.Count(text, "writer summary;") != 1 {
		t.Fatalf("performance must be summarized, got %q", text)
	}
	for _, field := range []string{"dbusUs[avg=500 p99=990 max=1000]", "parseUs[avg=10 max=10]", "readerTotalUs[p99=1010 max=1020]", "skipCount=5", "overIntervalCount=2", "queueFullSkipCount=3", "errorCount=", "maxQueueDepth=7", "queueCapacity=512", "busyRatio=", "appendBatches=1", "appendRows=4096", "appendRowsPerSec=2048000", "appendUs[avg=2000 p99=2000 max=2000]", "flushIntervalMs=1000", "flushCount=1", "flushErrorCount=0", "flushMaxUs=3000000", "queueToDurableUs[p99="} {
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
		jobPerformance:    map[string]*jobPerformance{"line-a": newJobPerformance(1000, "dbus")},
	}
	d.recordJobPerformance("line-a", readTiming{}, errors.New("connect failed"))
	d.recordJobPerformance("line-a", readTiming{
		DBus: 20 * time.Millisecond, DBusMeasured: true,
	}, errors.New("DBus failed"))
	d.recordPerformanceSkip("line-a", false)

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
	if stats.QueueFullSkipCount != 0 {
		t.Fatalf("queue full skip count = %d", stats.QueueFullSkipCount)
	}
}

func TestPerformanceOverrunCountsOnlyActualSchedulerSkips(t *testing.T) {
	root := t.TempDir()
	d := &daemon{
		root:              filepath.Join(root, "cgi-bin"),
		performancePolicy: performancePolicy{Enabled: true, JobSampleCount: 1000, WriterSummaryIntervalMS: 30000},
		jobPerformance:    map[string]*jobPerformance{"line-a": newJobPerformance(1000, "dbus")},
		runtime:           runtimeState{Jobs: map[string]jobRuntime{"line-a": newJobRuntime("line-a", "running", "")}},
		logConfigs:        map[string]logConfig{"line-a": {Level: "info"}},
		logPolicy:         (logPolicy{}).normalized(),
		logSummaries:      map[string]logSummary{"line-a": {StartedAt: time.Now()}},
	}
	d.recordOverrun("line-a", false)
	d.recordOverrun("line-a", true)

	if got := d.jobPerformance["line-a"].OverIntervalCount; got != 1 {
		t.Fatalf("performance over interval count = %d, want scheduler-only 1", got)
	}
	if got := d.jobPerformance["line-a"].QueueFullSkipCount; got != 1 {
		t.Fatalf("performance queue full count = %d, want 1", got)
	}
	if got := d.runtime.Jobs["line-a"]; got.OverrunCount != 2 || got.QueueSkipped != 1 {
		t.Fatalf("runtime skip counts = %#v", got)
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
	d.mu.Lock()
	active := d.jobs["line-a"]
	d.mu.Unlock()
	if err := d.stop("line-a"); err != nil {
		t.Fatal(err)
	}
	if names, err := loadActiveJobs(root); err != nil || len(names) != 0 {
		t.Fatalf("active checkpoint after stop = %v, %v", names, err)
	}
	if active == nil || active.buffers == nil || !active.buffers.closed.Load() || active.buffers.leased.Load() != 0 || len(active.buffers.idle) != 0 {
		t.Fatalf("Job stop did not dispose its row pool: %#v", active)
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
	logData, err := os.ReadFile(filepath.Join(filepath.Dir(root), "logs", "line-a.log"))
	if err != nil {
		t.Fatal(err)
	}
	logText := string(logData)
	for _, want := range []string{
		"TAG preparation started; table=TAG requiredTags=1",
		"TAG preparation completed; table=TAG requiredTags=1",
		"metadataUs=0",
		"registrationUs=0",
		"totalUs=",
	} {
		if !strings.Contains(logText, want) {
			t.Fatalf("Job log does not contain %q: %s", want, logText)
		}
	}
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
	registerOnce    sync.Once
	registerRelease chan struct{}
	prepareSerial   sync.Mutex
	preparedMu      sync.RWMutex
	prepared        map[*tagRegistry]int
}

func (a *fakeAppenderStream) same(database database) bool      { return a.database == database }
func (a *fakeAppenderStream) close() error                     { a.closed++; return nil }
func (a *fakeAppenderStream) flush() error                     { a.flushed++; return nil }
func (a *fakeAppenderStream) append([]row, *tagRegistry) error { a.appended++; return nil }
func (a *fakeAppenderStream) prepareRegistry(ctx context.Context, registry *tagRegistry, required int) error {
	a.preparedMu.RLock()
	ready := a.prepared[registry] >= required
	a.preparedMu.RUnlock()
	if ready {
		return nil
	}
	a.prepareSerial.Lock()
	defer a.prepareSerial.Unlock()
	a.preparedMu.RLock()
	ready = a.prepared[registry] >= required
	a.preparedMu.RUnlock()
	if ready {
		return nil
	}
	if a.prepared == nil {
		a.preparedMu.Lock()
		a.prepared = make(map[*tagRegistry]int)
		a.preparedMu.Unlock()
	}
	a.registered = append(a.registered, registry.snapshot()[:required]...)
	if a.registerStarted != nil {
		a.registerOnce.Do(func() { close(a.registerStarted) })
	}
	if a.registerRelease != nil {
		select {
		case <-a.registerRelease:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if a.registerErr == nil {
		a.preparedMu.Lock()
		a.prepared[registry] = required
		a.preparedMu.Unlock()
	}
	return a.registerErr
}

type periodicOnlyFakeAppender struct {
	*fakeAppenderStream
}

func (a *periodicOnlyFakeAppender) periodicFlushOnly() {}

type blockingAppenderStream struct {
	*fakeAppenderStream
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

type failingAppenderStream struct {
	*fakeAppenderStream
	err error
}

func (a *failingAppenderStream) append(_ []row, _ *tagRegistry) error { return a.err }

type appendSignalStream struct {
	*fakeAppenderStream
	appended chan struct{}
	once     sync.Once
}

func (a *appendSignalStream) append(_ []row, _ *tagRegistry) error {
	a.once.Do(func() { close(a.appended) })
	return nil
}

func (a *appendSignalStream) periodicFlushOnly() {}

func (a *blockingAppenderStream) append(_ []row, _ *tagRegistry) error {
	a.once.Do(func() { close(a.started) })
	<-a.release
	return nil
}

func startTestWriter(d *daemon, opener func(string, database, int) (appenderStream, error)) func() {
	if d.queue == nil {
		d.queue = make(chan *batch, 1)
	}
	if d.flushNow == nil {
		d.flushNow = make(chan struct{}, 1)
	}
	d.appenderPrepare = make(chan appenderPrepareRequest)
	if d.tagRegistry == nil {
		d.tagRegistry = newTagRegistry()
	}
	d.appenderOpener = opener
	d.performancePolicy.WriterSummaryIntervalMS = 30000
	done := make(chan struct{})
	go func() { defer close(done); d.writer() }()
	return func() {
		close(d.queue)
		<-done
	}
}

func testTagRegistry(t *testing.T, names ...string) (*tagRegistry, []row) {
	t.Helper()
	registry := newTagRegistry()
	config := jobConfig{MethodCalls: []method{{OutputSelections: []selection{{Tags: make([]tag, len(names))}}}}}
	for index, name := range names {
		config.MethodCalls[0].OutputSelections[0].Tags[index].Name = name
	}
	if err := registry.bindJob(&config); err != nil {
		t.Fatal(err)
	}
	rows := make([]row, len(names))
	for index, configured := range config.MethodCalls[0].OutputSelections[0].Tags {
		rows[index] = row{TagIndex: configured.registryIndex, Time: time.Now(), Value: float64(index + 1)}
	}
	return registry, rows
}

func TestTagRegistryIndexesStayStableAcrossJobEdits(t *testing.T) {
	registry := newTagRegistry()
	first := jobConfig{MethodCalls: []method{{OutputSelections: []selection{{Tags: []tag{{Name: "A"}, {Name: "B"}}}}}}}
	if err := registry.bindJob(&first); err != nil {
		t.Fatal(err)
	}
	if first.MethodCalls[0].OutputSelections[0].Tags[0].registryIndex != 0 ||
		first.MethodCalls[0].OutputSelections[0].Tags[1].registryIndex != 1 {
		t.Fatalf("initial indexes=%#v", first.MethodCalls[0].OutputSelections[0].Tags)
	}
	updated := jobConfig{MethodCalls: []method{{OutputSelections: []selection{{Tags: []tag{{Name: "B"}, {Name: "C"}, {Name: "A"}}}}}}}
	if err := registry.bindJob(&updated); err != nil {
		t.Fatal(err)
	}
	got := updated.MethodCalls[0].OutputSelections[0].Tags
	if got[0].registryIndex != 1 || got[1].registryIndex != 2 || got[2].registryIndex != 0 {
		t.Fatalf("updated indexes=%#v", got)
	}
	if registry.count() != 3 {
		t.Fatalf("registry count=%d", registry.count())
	}
}

func TestQueueCapacityAllocatesOnlyBatchPointerSlots(t *testing.T) {
	queue := make(chan *batch, queueCapacity)
	if cap(queue) != 512 || len(queue) != 0 {
		t.Fatalf("queue len/cap=%d/%d", len(queue), cap(queue))
	}
}

func TestRowBufferPoolStartsSmallGrowsToCapAndDiscardsOverflow(t *testing.T) {
	plan := &readPlan{rowCount: 2, tagIDs: []uint32{3, 7}}
	pool := newRowBufferPool(plan)
	if got := len(pool.idle); got != initialJobRowBuffers {
		t.Fatalf("initial retained buffers=%d, want %d", got, initialJobRowBuffers)
	}

	leases := make([]*rowBufferLease, maximumJobRowBuffers+8)
	for index := range leases {
		leases[index] = pool.acquire()
		leases[index].rows[0].Time = time.Now()
		leases[index].rows[0].Value = index
	}
	if got := pool.leased.Load(); got != int64(len(leases)) {
		t.Fatalf("leased buffers=%d, want %d", got, len(leases))
	}
	for _, lease := range leases {
		lease.release()
		lease.release() // idempotent ownership release
	}
	if got := pool.leased.Load(); got != 0 {
		t.Fatalf("leased buffers after release=%d", got)
	}
	if got := len(pool.idle); got != maximumJobRowBuffers {
		t.Fatalf("retained buffers=%d, want cap %d", got, maximumJobRowBuffers)
	}
	buffer := <-pool.idle
	if buffer[0].TagIndex != 3 || !buffer[0].Time.IsZero() || buffer[0].Value != nil {
		t.Fatalf("returned buffer was not cleared while retaining layout: %#v", buffer[0])
	}
	pool.idle <- buffer
	if outstanding := pool.dispose(); outstanding != 0 || len(pool.idle) != 0 {
		t.Fatalf("disposed pool outstanding/retained=%d/%d", outstanding, len(pool.idle))
	}
}

func TestDisposedRowBufferPoolDropsLateReturn(t *testing.T) {
	pool := newRowBufferPool(&readPlan{rowCount: 1, tagIDs: []uint32{9}})
	lease := pool.acquire()
	if outstanding := pool.dispose(); outstanding != 1 {
		t.Fatalf("outstanding at dispose=%d, want 1", outstanding)
	}
	lease.release()
	if got := pool.leased.Load(); got != 0 {
		t.Fatalf("late release left %d outstanding buffers", got)
	}
	if got := len(pool.idle); got != 0 {
		t.Fatalf("late return repopulated a disposed pool: %d", got)
	}
}

func TestQueueFullIsRejectedBeforeReadPlanOrBufferAllocation(t *testing.T) {
	d := &daemon{
		queue:          make(chan *batch, 1),
		runtime:        runtimeState{Jobs: map[string]jobRuntime{"line-a": newJobRuntime("line-a", "running", "")}},
		logConfigs:     map[string]logConfig{"line-a": {Level: "error"}},
		logSummaries:   map[string]logSummary{"line-a": {StartedAt: time.Now()}},
		jobPerformance: map[string]*jobPerformance{},
		runtimeDirty:   make(chan struct{}, 1),
	}
	occupied := d.reserveQueue()
	if occupied == nil {
		t.Fatal("failed to occupy the only queue slot")
	}
	active := &activeJob{}
	invalid := jobConfig{Execution: execution{Test: true}}
	if d.readOnce(context.Background(), invalid, "line-a", nil, active, false) {
		t.Fatal("queue-full cycle unexpectedly ran")
	}
	if active.plan != nil || active.buffers != nil {
		t.Fatal("queue-full cycle prepared a plan or allocated a row pool")
	}
	got := d.runtime.Jobs["line-a"]
	if got.OverrunCount != 1 || got.QueueSkipped != 1 || got.LastError != "" {
		t.Fatalf("queue-full runtime=%#v", got)
	}
	occupied.release()
	if next := d.reserveQueue(); next == nil {
		t.Fatal("released queue slot could not be reserved again")
	} else {
		next.release()
	}
}

func TestReadFailureReturnsBufferAndQueueReservation(t *testing.T) {
	config := jobConfig{
		Execution: execution{Test: true},
		MethodCalls: []method{{
			Inputs:           json.RawMessage(`{"DataCount":1,"DeviceString":"%MW0"}`),
			OutputSelections: []selection{{Tags: []tag{{Name: "W0", Conversion: "INVALID", Multiplier: 1}}}},
		}},
	}
	registry := newTagRegistry()
	if err := registry.bindJob(&config); err != nil {
		t.Fatal(err)
	}
	plan, err := buildReadPlan(config)
	if err != nil {
		t.Fatal(err)
	}
	active := &activeJob{registry: registry, plan: plan, buffers: newRowBufferPool(plan)}
	d := &daemon{
		root:           filepath.Join(t.TempDir(), "cgi-bin"),
		queue:          make(chan *batch, 1),
		runtime:        runtimeState{Jobs: map[string]jobRuntime{"line-a": newJobRuntime("line-a", "running", "")}},
		logConfigs:     map[string]logConfig{"line-a": {Level: "error"}},
		logPolicy:      (logPolicy{}).normalized(),
		logSummaries:   map[string]logSummary{"line-a": {StartedAt: time.Now()}},
		jobPerformance: map[string]*jobPerformance{},
		runtimeDirty:   make(chan struct{}, 1),
	}
	if d.readOnce(context.Background(), config, "line-a", nil, active, false) {
		t.Fatal("invalid conversion unexpectedly succeeded")
	}
	if got := active.buffers.leased.Load(); got != 0 {
		t.Fatalf("read failure leaked %d buffers", got)
	}
	if next := d.reserveQueue(); next == nil {
		t.Fatal("read failure leaked the queue reservation")
	} else {
		next.release()
	}
}

func TestAppendFailureReturnsBufferAndQueueReservation(t *testing.T) {
	base := &fakeAppenderStream{database: database{Server: "local", Table: "TAG"}}
	stream := &failingAppenderStream{fakeAppenderStream: base, err: errors.New("append failed")}
	d := &daemon{
		root:           filepath.Join(t.TempDir(), "cgi-bin"),
		queue:          make(chan *batch, 1),
		flushNow:       make(chan struct{}, 1),
		runtime:        runtimeState{Jobs: map[string]jobRuntime{"line-a": newJobRuntime("line-a", "running", "")}},
		logConfigs:     map[string]logConfig{"line-a": {Level: "error"}},
		logPolicy:      (logPolicy{}).normalized(),
		logSummaries:   map[string]logSummary{"line-a": {StartedAt: time.Now()}},
		jobPerformance: map[string]*jobPerformance{},
		runtimeDirty:   make(chan struct{}, 1),
	}
	stopWriter := startTestWriter(d, func(_ string, _ database, _ int) (appenderStream, error) { return stream, nil })
	defer stopWriter()
	registry, _ := testTagRegistry(t, "TAG-1")
	pool := newRowBufferPool(&readPlan{rowCount: 1, tagIDs: []uint32{0}})
	lease := pool.acquire()
	lease.rows[0].Time = time.Now()
	lease.rows[0].Value = float64(1)
	reservation := d.reserveQueue()
	if reservation == nil {
		t.Fatal("failed to reserve queue")
	}
	owner := &activeJob{}
	owner.work.Add(1)
	b := &batch{Job: "line-a", Database: base.database, Registry: registry, Rows: lease.rows, RowCount: 1, rowLease: lease, queueReservation: reservation, Owner: owner, EnqueuedAt: time.Now()}
	d.queue <- b
	done := make(chan struct{})
	go func() { owner.work.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("append failure did not finish batch ownership")
	}
	if got := pool.leased.Load(); got != 0 {
		t.Fatalf("append failure leaked %d buffers", got)
	}
	if next := d.reserveQueue(); next == nil {
		t.Fatal("writer dequeue did not release queue reservation")
	} else {
		next.release()
	}
}

func TestAppenderPrepareFailureReturnsBufferAndQueueReservation(t *testing.T) {
	d := &daemon{
		root:           filepath.Join(t.TempDir(), "cgi-bin"),
		queue:          make(chan *batch, 1),
		flushNow:       make(chan struct{}, 1),
		runtime:        runtimeState{Jobs: map[string]jobRuntime{"line-a": newJobRuntime("line-a", "running", "")}},
		logConfigs:     map[string]logConfig{"line-a": {Level: "error"}},
		logPolicy:      (logPolicy{}).normalized(),
		logSummaries:   map[string]logSummary{"line-a": {StartedAt: time.Now()}},
		jobPerformance: map[string]*jobPerformance{},
		runtimeDirty:   make(chan struct{}, 1),
	}
	stopWriter := startTestWriter(d, func(_ string, _ database, _ int) (appenderStream, error) {
		return nil, errors.New("prepare failed")
	})
	defer stopWriter()
	registry, _ := testTagRegistry(t, "TAG-1")
	pool := newRowBufferPool(&readPlan{rowCount: 1, tagIDs: []uint32{0}})
	lease := pool.acquire()
	reservation := d.reserveQueue()
	if reservation == nil {
		t.Fatal("failed to reserve queue")
	}
	owner := &activeJob{}
	owner.work.Add(1)
	d.queue <- &batch{
		Job: "line-a", Database: database{Server: "local", Table: "TAG"}, Registry: registry,
		Rows: lease.rows, RowCount: 1, rowLease: lease, queueReservation: reservation, Owner: owner,
	}
	done := make(chan struct{})
	go func() { owner.work.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Appender prepare failure did not finish batch ownership")
	}
	if got := pool.leased.Load(); got != 0 {
		t.Fatalf("Appender prepare failure leaked %d buffers", got)
	}
	if next := d.reserveQueue(); next == nil {
		t.Fatal("Appender prepare failure leaked the queue reservation")
	} else {
		next.release()
	}
}

func TestSuccessfulAppendReturnsBufferBeforePeriodicFlush(t *testing.T) {
	base := &fakeAppenderStream{database: database{Server: "local", Table: "TAG"}}
	stream := &appendSignalStream{fakeAppenderStream: base, appended: make(chan struct{})}
	d := &daemon{
		queue:        make(chan *batch, 1),
		flushNow:     make(chan struct{}, 1),
		writerPolicy: writerPolicy{QueueCapacity: 1, FlushMaxRows: 8192, FlushIntervalMS: 60000},
	}
	stopWriter := startTestWriter(d, func(_ string, _ database, _ int) (appenderStream, error) { return stream, nil })
	registry, _ := testTagRegistry(t, "TAG-1")
	pool := newRowBufferPool(&readPlan{rowCount: 1, tagIDs: []uint32{0}})
	lease := pool.acquire()
	lease.rows[0].Time = time.Now()
	lease.rows[0].Value = float64(1)
	reservation := d.reserveQueue()
	if reservation == nil {
		t.Fatal("failed to reserve queue")
	}
	d.queue <- &batch{
		Database: base.database, Registry: registry, Rows: lease.rows, RowCount: 1,
		rowLease: lease, queueReservation: reservation, EnqueuedAt: time.Now(),
	}
	select {
	case <-stream.appended:
	case <-time.After(time.Second):
		t.Fatal("writer did not append")
	}
	deadline := time.Now().Add(time.Second)
	for pool.leased.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := pool.leased.Load(); got != 0 {
		t.Fatalf("successful append retained %d buffers until Flush", got)
	}
	if next := d.reserveQueue(); next == nil {
		t.Fatal("writer dequeue retained the queue reservation")
	} else {
		next.release()
	}
	stopWriter()
}

func TestDefaultQueueAbsorbsFourSecondsOfTenMillisecondBatches(t *testing.T) {
	base := &fakeAppenderStream{database: database{Server: "local", Table: "TAG"}}
	stream := &blockingAppenderStream{fakeAppenderStream: base, started: make(chan struct{}), release: make(chan struct{})}
	d := &daemon{
		queue: make(chan *batch, queueCapacity), flushNow: make(chan struct{}, 1),
		writerPolicy: writerPolicy{QueueCapacity: queueCapacity, FlushMaxRows: 8192, FlushIntervalMS: 1000},
	}
	stopWriter := startTestWriter(d, func(_ string, _ database, _ int) (appenderStream, error) { return stream, nil })
	registry, rows := testTagRegistry(t, "TAG-1")
	first := &batch{Database: base.database, Registry: registry, Rows: rows}
	d.queue <- first
	select {
	case <-stream.started:
	case <-time.After(time.Second):
		t.Fatal("writer did not enter the simulated stall")
	}
	for index := 0; index < 400; index++ {
		select {
		case d.queue <- &batch{Database: base.database, Registry: registry, Rows: rows}:
		default:
			t.Fatalf("default queue filled after %d additional 10ms batches", index)
		}
	}
	if got := len(d.queue); got != 400 {
		t.Fatalf("queued batches=%d, want 400", got)
	}
	close(stream.release)
	stopWriter()
}

func TestWriterPreparesOnceAndReusesMatchingAppender(t *testing.T) {
	first := &fakeAppenderStream{}
	registry, _ := testTagRegistry(t, "TAG-1")
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
		d.appenderPrepare <- appenderPrepareRequest{Database: database{Server: "local", Table: "TAG"}, Registry: registry, TagCount: registry.count(), Result: result}
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
		database: database{Server: "local", Table: "TAG"},
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
	registry, existingRows := testTagRegistry(t, "EXISTING")
	if err := stream.prepareRegistry(context.Background(), registry, registry.count()); err != nil {
		t.Fatal(err)
	}
	stream.registerStarted = registerStarted
	stream.registerRelease = registerRelease
	newConfig := jobConfig{MethodCalls: []method{{OutputSelections: []selection{{Tags: []tag{{Name: "NEW-TAG"}}}}}}}
	if err := registry.bindJob(&newConfig); err != nil {
		t.Fatal(err)
	}
	prepareResult := make(chan error, 1)
	d.appenderPrepare <- appenderPrepareRequest{
		Context: context.Background(), Database: stream.database, Registry: registry, TagCount: registry.count(), Result: prepareResult,
	}
	select {
	case <-registerStarted:
	case <-time.After(time.Second):
		t.Fatal("TAG registration did not start")
	}
	existing := &batch{
		Database: stream.database, Registry: registry, Rows: existingRows,
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

func TestFormatTagPreparationLogIncludesCountsAndStageDurations(t *testing.T) {
	message := formatTagPreparationLog("TAG preparation completed", "TAG_DATA", 4*time.Second, tagPreparationStats{
		Required:             4096,
		Candidates:           4096,
		ExistingCandidates:   96,
		Missing:              4000,
		Registered:           4000,
		MetadataDuration:     1200 * time.Microsecond,
		RegistrationDuration: 3500 * time.Millisecond,
	})
	for _, want := range []string{
		"table=TAG_DATA", "requiredTags=4096", "candidates=4096", "existing=96",
		"missing=4000", "registered=4000", "metadataUs=1200",
		"registrationUs=3500000", "totalUs=4000000",
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("TAG preparation log %q does not contain %q", message, want)
		}
	}
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
	registry, rows := testTagRegistry(t, "TAG-1")
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
		Registry:         registry,
		Rows:             rows,
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

func TestWriterIgnoresForcedFlushForPeriodicOnlyAppender(t *testing.T) {
	base := &fakeAppenderStream{database: database{Server: "local", Table: "TAG"}}
	registry, rows := testTagRegistry(t, "TAG-1")
	stream := &periodicOnlyFakeAppender{fakeAppenderStream: base}
	d := &daemon{
		queue:           make(chan *batch, 1),
		flushNow:        make(chan struct{}, 1),
		appenderPrepare: make(chan appenderPrepareRequest),
		writerPolicy:    writerPolicy{QueueCapacity: 1, FlushMaxRows: 1024, FlushIntervalMS: 250},
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
		Database:         base.database,
		Registry:         registry,
		Rows:             rows,
		Finished:         make(chan error, 1),
		EnqueuedAt:       time.Now(),
		FlushAfterAppend: true,
	}
	d.queue <- priming
	d.requestFlush()
	select {
	case err := <-priming.Finished:
		t.Fatalf("periodic-only batch completed on a forced Flush: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	select {
	case err := <-priming.Finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("periodic Flush did not complete the batch")
	}
	close(d.queue)
	<-done
	if base.appended != 1 || base.flushed != 1 || base.closed != 1 {
		t.Fatalf("append/periodic flush/close count=%d/%d/%d", base.appended, base.flushed, base.closed)
	}
}

func TestWriterCompletesOrdinaryBatchWithoutPerBatchWaiter(t *testing.T) {
	stream := &fakeAppenderStream{database: database{Server: "local", Table: "TAG"}}
	registry, rows := testTagRegistry(t, "TAG-1")
	owner := &activeJob{}
	owner.work.Add(1)
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
		runtime:      runtimeState{Jobs: map[string]jobRuntime{"line-a": newJobRuntime("line-a", "running", "")}},
		logConfigs:   map[string]logConfig{"line-a": {Level: "error", MaxFiles: 1}},
		logSummaries: map[string]logSummary{"line-a": {StartedAt: time.Now()}},
		runtimeDirty: make(chan struct{}, 1),
	}
	done := make(chan struct{})
	go func() { defer close(done); d.writer() }()

	d.queue <- &batch{
		Job: "line-a", Database: stream.database, Owner: owner,
		Registry:   registry,
		Rows:       rows,
		EnqueuedAt: time.Now(), FlushAfterAppend: true,
	}
	completed := make(chan struct{})
	go func() { owner.work.Wait(); close(completed) }()
	select {
	case <-completed:
	case <-time.After(time.Second):
		t.Fatal("writer did not complete an ordinary batch directly")
	}
	if stored := d.snapshotRuntime().Jobs["line-a"].RowsStored; stored != 1 {
		t.Fatalf("stored rows=%d", stored)
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

func TestLSIntegerConversionsHonorSignedBeforeTransform(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		codec      lsValueCodec
		conversion string
		signed     bool
		want       any
	}{
		{name: "byte unsigned", body: "250", codec: lsValueCodec{bits: 8}, conversion: "BYTE2INT", want: uint64(250)},
		{name: "byte signed", body: "250", codec: lsValueCodec{bits: 8}, conversion: "BYTE2INT", signed: true, want: int64(-6)},
		{name: "word signed", body: "65535", codec: lsValueCodec{bits: 16}, conversion: "WORD2INT", signed: true, want: int64(-1)},
		{name: "dword signed", body: "4294967295", codec: lsValueCodec{bits: 32}, conversion: "DWORD2INT", signed: true, want: int64(-1)},
		{name: "lword signed", body: "18446744073709551615", codec: lsValueCodec{bits: 64}, conversion: "LWORD2INT", signed: true, want: int64(-1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value, err := decodeLSValue(json.Number(test.body), test.codec, test.conversion, test.signed)
			if err != nil || value != test.want {
				t.Fatalf("value=%#v err=%v want=%#v", value, err, test.want)
			}
		})
	}

	rows, err := decodeLSDeviceRows(`{"rtn":1,"data-count":1,"data":[250],"time-stamp-us":1788333667837979}`, 1,
		[]tag{{Name: "MB0", Conversion: "BYTE2INT", Signed: true, Bias: 3, Multiplier: 2, TransformOrder: []string{"bias", "multiplier"}}}, lsValueCodec{bits: 8})
	if err != nil || rows[0].Value != float64(-6) {
		// Signed -6 is decoded first; (-6 + 3) * 2 is -6.
		t.Fatalf("signed conversion must precede transform: rows=%#v err=%v", rows, err)
	}
}

func TestLSRealConversionsReinterpretIEEE754Bits(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		codec      lsValueCodec
		conversion string
		want       float64
	}{
		{name: "DWORD positive REAL", body: "1065353216", codec: lsValueCodec{bits: 32}, conversion: "DWORD2REAL", want: 1},
		{name: "DWORD negative REAL", body: "3212836864", codec: lsValueCodec{bits: 32}, conversion: "DWORD2REAL", want: -1},
		{name: "LWORD positive LREAL", body: "4607182418800017408", codec: lsValueCodec{bits: 64}, conversion: "LWORD2LREAL", want: 1},
		{name: "LWORD negative LREAL", body: "13830554455654793216", codec: lsValueCodec{bits: 64}, conversion: "LWORD2LREAL", want: -1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value, err := decodeLSValue(json.Number(test.body), test.codec, test.conversion, true)
			if err != nil || value != test.want {
				t.Fatalf("value=%#v err=%v want=%v", value, err, test.want)
			}
		})
	}
	if _, err := decodeLSValue(json.Number("1"), lsValueCodec{bits: 16}, "DWORD2REAL", false); err == nil {
		t.Fatal("conversion/address mismatch must fail")
	}
}

func TestGenerateTestRowsSkipsDBusDecodeAndUsesNormalTransforms(t *testing.T) {
	config := jobConfig{
		Execution: execution{Test: true},
		MethodCalls: []method{
			{
				Inputs: json.RawMessage(`{"DataCount":2,"DeviceString":"%MB0"}`),
				OutputSelections: []selection{{Tags: []tag{
					{Name: "B0", Conversion: "BYTE2INT", Multiplier: 1},
					{Name: "B1", Conversion: "BYTE2INT", Bias: 2, Multiplier: 3, TransformOrder: []string{"bias", "multiplier"}},
				}}},
			},
			{
				Inputs: json.RawMessage(`{"DataCount":2,"DeviceString":"%MD0"}`),
				OutputSelections: []selection{{Tags: []tag{
					{Name: "D0", Conversion: "DWORD2REAL", Multiplier: 1},
					{Name: "D1", Conversion: "DWORD2REAL", Multiplier: 1},
				}}},
			},
		},
	}
	rows, timing, err := generateTestRows(config)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 4 || !timing.GenerateMeasured || timing.DBusMeasured || timing.ParseMeasured {
		t.Fatalf("rows/timing=%d %#v", len(rows), timing)
	}
	if rows[0].Value != uint64(0) || rows[1].Value != float64(9) || rows[2].Value != float64(0) || rows[3].Value != float64(1) {
		t.Fatalf("synthetic conversion/transform values=%#v", rows)
	}
	for _, current := range rows[1:] {
		if !current.Time.Equal(rows[0].Time) {
			t.Fatal("one synthetic cycle must use one timestamp")
		}
	}
}

func TestReadOnceTestModeNeedsNoDBusConnection(t *testing.T) {
	config := jobConfig{
		Execution: execution{Test: true},
		Database:  database{Server: "local", Table: testTableName, ValueColumn: "VALUE"},
		MethodCalls: []method{{
			Inputs: json.RawMessage(`{"DataCount":1,"DeviceString":"%MW0"}`),
			OutputSelections: []selection{{Tags: []tag{{
				Name: "W0", Conversion: "WORD2INT", Multiplier: 1,
			}}}},
		}},
	}
	d := &daemon{
		queue:        make(chan *batch, 1),
		tagRegistry:  newTagRegistry(),
		runtime:      runtimeState{Jobs: map[string]jobRuntime{"line-a": newJobRuntime("line-a", "running", "")}},
		logConfigs:   map[string]logConfig{"line-a": {Level: "error"}},
		logSummaries: map[string]logSummary{"line-a": {StartedAt: time.Now()}},
		runtimeDirty: make(chan struct{}, 1),
	}
	if err := d.tagRegistry.bindJob(&config); err != nil {
		t.Fatal(err)
	}
	active := &activeJob{registry: d.tagRegistry}
	if !d.readOnce(context.Background(), config, "line-a", nil, active, false) {
		t.Fatal("TEST read must succeed with a nil DBus connection")
	}
	queued := <-d.queue
	name, ok := queued.Registry.name(queued.Rows[0].TagIndex)
	if queued.Job != "line-a" || len(queued.Rows) != 1 || !ok || name != "W0" {
		t.Fatalf("queued TEST batch=%#v", queued)
	}
	queued.queueReservation.release()
	queued.releaseRows()
	active.work.Done()
	if got := active.buffers.leased.Load(); got != 0 {
		t.Fatalf("dequeued TEST batch leaked %d buffers", got)
	}
}

func TestLoadJobFailsTestModeClosedAgainstEffectiveProfileTable(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cgi-bin")
	writeRegisteredJobFixture(t, root, true)
	jobPath := filepath.Join(root, "conf.d", "jobs", "line-a.json")
	data, err := os.ReadFile(jobPath)
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Replace(string(data), `"schedule":`, `"execution":{"test":true},"schedule":`, 1)
	text = strings.Replace(text, `"table":"TAG"`, `"table":"T4_DBUS_TEST_"`, 1)
	if err := os.WriteFile(jobPath, []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
	job, err := loadJob(root, "line-a")
	if err != nil {
		t.Fatal(err)
	}
	if job.Execution.Test {
		t.Fatal("effective non-test profile table must force TEST false")
	}

	secretPath := filepath.Join(root, "conf.d", secretFileName)
	secret, err := os.ReadFile(secretPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secretPath, []byte(strings.Replace(string(secret), `"defaultTable":"TAG"`, `"defaultTable":"T4_DBUS_TEST_"`, 1)), 0644); err != nil {
		t.Fatal(err)
	}
	job, err = loadJob(root, "line-a")
	if err != nil || !job.Execution.Test {
		t.Fatalf("matching effective table TEST=%v err=%v", job.Execution.Test, err)
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
