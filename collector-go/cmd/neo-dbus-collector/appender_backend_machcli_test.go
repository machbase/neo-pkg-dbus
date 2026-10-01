//go:build machcli && cgo

package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"

	_ "github.com/machbase/neo-client/v2"
	"github.com/machbase/neo-client/v2/api"
)

func TestMachcliTagNameType(t *testing.T) {
	for _, test := range []struct {
		typ  api.ColumnType
		want bool
	}{
		{typ: api.ColumnTypeVarchar, want: true},
		{typ: api.ColumnTypeChar, want: true},
		{typ: api.ColumnTypeText, want: false},
		{typ: api.ColumnTypeDouble, want: false},
	} {
		if got := machcliTagNameType(test.typ); got != test.want {
			t.Fatalf("machcliTagNameType(%s)=%v, want %v", test.typ, got, test.want)
		}
	}
}

func TestMachcliNumericValueType(t *testing.T) {
	for _, typ := range []api.ColumnType{
		api.ColumnTypeShort, api.ColumnTypeUShort,
		api.ColumnTypeInteger, api.ColumnTypeUInteger,
		api.ColumnTypeLong, api.ColumnTypeULong,
		api.ColumnTypeFloat, api.ColumnTypeDouble,
	} {
		if !machcliNumericValueType(typ) {
			t.Fatalf("%s must use the machcli numeric path", typ)
		}
	}
	if machcliNumericValueType(api.ColumnTypeVarchar) {
		t.Fatal("VARCHAR must not use the machcli numeric path")
	}
}

func TestMachcliAppenderIntegration(t *testing.T) {
	if os.Getenv("NEO_DBUS_CGO_INTEGRATION") != "1" {
		t.Skip("set NEO_DBUS_CGO_INTEGRATION=1 to use a local Machbase server")
	}
	dsn := "server=tcp://sys:manager@127.0.0.1:5656"
	table := fmt.Sprintf("DBUS_CGO_%d", os.Getpid())
	db, err := sql.Open("machbase", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.ExecContext(context.Background(), fmt.Sprintf(
		"CREATE TAG TABLE %s (NAME VARCHAR(100) PRIMARY KEY, TIME DATETIME BASE TIME, VALUE DOUBLE, STR_VALUE VARCHAR(100))", table)); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = db.ExecContext(context.Background(), "DROP TABLE "+table+" CASCADE") }()

	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "conf.d"), 0o755); err != nil {
		t.Fatal(err)
	}
	secret := struct {
		SchemaVersion int             `json:"schemaVersion"`
		Servers       map[string]conn `json:"servers"`
	}{
		SchemaVersion: 1,
		Servers: map[string]conn{
			"localhost": {Host: "127.0.0.1", Port: 5656, User: "sys", Password: "manager"},
		},
	}
	encoded, err := json.Marshal(secret)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "conf.d", secretFileName), encoded, 0o600); err != nil {
		t.Fatal(err)
	}

	stream, err := openAppender(root, database{Server: "localhost", Table: table, ValueColumn: "VALUE"}, 8192)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.close()
	tagCount := positiveTestEnv(t, "NEO_DBUS_CGO_TAGS", 3)
	cycles := positiveTestEnv(t, "NEO_DBUS_CGO_CYCLES", 1)
	flushEvery := positiveTestEnv(t, "NEO_DBUS_CGO_FLUSH_EVERY", 1)
	intervalMS := nonNegativeTestEnv(t, "NEO_DBUS_CGO_INTERVAL_MS", 0)
	traceEnabled := os.Getenv("NEO_DBUS_CGO_TRACE") == "1"
	tags := make([]string, tagCount)
	for index := range tags {
		tags[index] = fmt.Sprintf("CGO_%05d", index)
	}
	registry, rows := testTagRegistry(t, tags...)
	if err := stream.prepareRegistry(context.Background(), registry, registry.count()); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for index := range rows {
		rows[index].Time = now
		rows[index].Value = float64(index) + 0.25
	}
	samples := make([]time.Duration, cycles)
	traces := make([]machcliAppendTrace, cycles)
	tracedStream, isMachcli := stream.(*machcliAppender)
	if traceEnabled && !isMachcli {
		t.Fatal("NEO_DBUS_CGO_TRACE requires the machcli backend")
	}
	next := time.Now()
	for cycle := 0; cycle < cycles; cycle++ {
		next = next.Add(time.Duration(intervalMS) * time.Millisecond)
		for index := range rows {
			rows[index].Time = now.Add(time.Duration(cycle) * time.Millisecond)
		}
		started := time.Now()
		var appendErr error
		if traceEnabled {
			traces[cycle], appendErr = tracedStream.appendTraced(rows, registry)
		} else {
			appendErr = stream.append(rows, registry)
		}
		if appendErr != nil {
			t.Fatalf("cycle %d append: %v", cycle+1, appendErr)
		}
		samples[cycle] = time.Since(started)
		if (cycle+1)%flushEvery == 0 {
			if err := stream.flush(); err != nil {
				t.Fatalf("cycle %d flush: %v", cycle+1, err)
			}
		}
		if wait := time.Until(next); wait > 0 {
			time.Sleep(wait)
		}
	}
	if err := stream.flush(); err != nil {
		t.Fatal(err)
	}
	if err := stream.close(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM "+table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	expected := len(rows) * cycles
	if count != expected {
		t.Fatalf("stored rows=%d, want %d", count, expected)
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	var total time.Duration
	for _, sample := range samples {
		total += sample
	}
	t.Logf("machcli tags=%d cycles=%d avg=%s p50=%s p99=%s max=%s",
		tagCount, cycles, total/time.Duration(cycles), samples[(cycles*50-1)/100],
		samples[(cycles*99-1)/100], samples[cycles-1])
	if traceEnabled {
		logMachcliTraceSummary(t, traces)
	}
}

func TestMachcliCollectorQueueIntegration(t *testing.T) {
	if os.Getenv("NEO_DBUS_QUEUE_INTEGRATION") != "1" {
		t.Skip("set NEO_DBUS_QUEUE_INTEGRATION=1 to exercise the production writer queue")
	}
	db := openIntegrationDB(t)
	defer db.Close()
	table := fmt.Sprintf("DBUS_CGO_QUEUE_%d", os.Getpid())
	createIntegrationTable(t, db, table, "DOUBLE")
	defer dropIntegrationTable(t, db, table)

	root := integrationConfigRoot(t)
	tagCount := positiveTestEnv(t, "NEO_DBUS_CGO_TAGS", 4096)
	cycles := positiveTestEnv(t, "NEO_DBUS_CGO_CYCLES", 6000)
	intervalMS := positiveTestEnv(t, "NEO_DBUS_CGO_INTERVAL_MS", 10)
	capacity := positiveTestEnv(t, "NEO_DBUS_CGO_QUEUE_CAPACITY", queueCapacity)
	names := make([]string, tagCount)
	for index := range names {
		names[index] = fmt.Sprintf("QUEUE_%05d", index)
	}
	registry, template := testTagRegistry(t, names...)
	tagIDs := make([]uint32, len(template))
	for index := range template {
		tagIDs[index] = template[index].TagIndex
	}
	pool := newRowBufferPool(&readPlan{rowCount: len(template), tagIDs: tagIDs})
	configDB := database{Server: "localhost", Table: table, ValueColumn: "MEASURE"}
	d := &daemon{
		root: root, queue: make(chan *batch, capacity), flushNow: make(chan struct{}, 1),
		writerPolicy: writerPolicy{QueueCapacity: capacity, FlushMaxRows: 8192, FlushIntervalMS: 1000},
	}
	stopWriter := startTestWriter(d, nil)
	if err := d.ensureAppenderReady(context.Background(), configDB, registry); err != nil {
		stopWriter()
		t.Fatal(err)
	}

	accepted, skipped, maxDepth := 0, 0, 0
	started := time.Now()
	next := started
	for cycle := 0; cycle < cycles; cycle++ {
		next = next.Add(time.Duration(intervalMS) * time.Millisecond)
		reservation := d.reserveQueue()
		if reservation == nil {
			skipped++
			if wait := time.Until(next); wait > 0 {
				time.Sleep(wait)
			}
			continue
		}
		lease := pool.acquire()
		rows := lease.rows
		stamp := time.Now().UTC()
		for index := range rows {
			rows[index].Time = stamp
			rows[index].Value = float64(index) + float64(cycle%1000)/1000
		}
		select {
		case d.queue <- &batch{Database: configDB, Registry: registry, Rows: rows, RowCount: len(rows), rowLease: lease, queueReservation: reservation, EnqueuedAt: time.Now()}:
			accepted++
			if depth := len(d.queue); depth > maxDepth {
				maxDepth = depth
			}
		default:
			lease.release()
			reservation.release()
			skipped++
		}
		if wait := time.Until(next); wait > 0 {
			time.Sleep(wait)
		}
	}
	stopWriter()
	if outstanding := pool.dispose(); outstanding != 0 {
		t.Fatalf("row buffer leases after writer stop=%d", outstanding)
	}
	elapsed := time.Since(started)
	var stored int64
	if err := db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM "+table).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	want := int64(accepted) * int64(tagCount)
	if stored != want {
		t.Fatalf("stored rows=%d, want accepted rows=%d", stored, want)
	}
	t.Logf("queue tags=%d cycles=%d interval=%dms accepted=%d skipped=%d maxDepth=%d/%d stored=%d elapsed=%s",
		tagCount, cycles, intervalMS, accepted, skipped, maxDepth, capacity, stored, elapsed.Round(time.Millisecond))
}

func TestMachcliSyntheticReaderIntegration(t *testing.T) {
	if os.Getenv("NEO_DBUS_READER_INTEGRATION") != "1" {
		t.Skip("set NEO_DBUS_READER_INTEGRATION=1 to exercise the TEST reader, pool, queue, and native writer")
	}
	db := openIntegrationDB(t)
	defer db.Close()
	table := fmt.Sprintf("DBUS_CGO_READER_%d", os.Getpid())
	createIntegrationTable(t, db, table, "DOUBLE")
	defer dropIntegrationTable(t, db, table)

	tagCount := positiveTestEnv(t, "NEO_DBUS_CGO_TAGS", 4096)
	intervalMS := positiveTestEnv(t, "NEO_DBUS_CGO_INTERVAL_MS", 10)
	durationSeconds := positiveTestEnv(t, "NEO_DBUS_READER_SECONDS", 10)
	tags := make([]tag, tagCount)
	for index := range tags {
		tags[index] = tag{Name: fmt.Sprintf("READER_%05d", index), Conversion: "BYTE2INT", Multiplier: 1}
	}
	inputs, err := json.Marshal(map[string]any{"DataCount": tagCount, "DeviceString": "%MB0"})
	if err != nil {
		t.Fatal(err)
	}
	configDB := database{Server: "localhost", Table: table, ValueColumn: "MEASURE"}
	config := jobConfig{
		Schedule: schedule{IntervalMS: int64(intervalMS)}, Execution: execution{Test: true}, Database: configDB,
		MethodCalls: []method{{Inputs: inputs, OutputSelections: []selection{{Tags: tags}}}},
		Log:         logConfig{Level: "error"},
	}
	registry := newTagRegistry()
	if err := registry.bindJob(&config); err != nil {
		t.Fatal(err)
	}
	plan, err := buildReadPlan(config)
	if err != nil {
		t.Fatal(err)
	}
	active := &activeJob{config: config, registry: registry, plan: plan, buffers: newRowBufferPool(plan)}
	root := integrationConfigRoot(t)
	d := &daemon{
		root: root, queue: make(chan *batch, queueCapacity), flushNow: make(chan struct{}, 1),
		writerPolicy: writerPolicy{QueueCapacity: queueCapacity, FlushMaxRows: 8192, FlushIntervalMS: 1000},
		tagRegistry:  registry, runtime: runtimeState{Jobs: map[string]jobRuntime{"reader": newJobRuntime("reader", "running", "")}},
		logConfigs: map[string]logConfig{"reader": config.Log}, logPolicy: (logPolicy{}).normalized(),
		logSummaries: map[string]logSummary{"reader": {StartedAt: time.Now()}}, jobPerformance: map[string]*jobPerformance{},
		runtimeDirty: make(chan struct{}, 1),
	}
	stopWriter := startTestWriter(d, nil)
	if err := d.ensureAppenderReady(context.Background(), configDB, registry); err != nil {
		stopWriter()
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(durationSeconds)*time.Second)
	defer cancel()
	d.reader(ctx, config, "reader", active)
	stopWriter()

	runtime := d.snapshotRuntime().Jobs["reader"]
	if runtime.RowsStored == 0 || runtime.RowsStored%uint64(tagCount) != 0 {
		t.Fatalf("stored runtime rows=%d for tagCount=%d", runtime.RowsStored, tagCount)
	}
	if runtime.QueueSkipped != 0 {
		t.Fatalf("TEST reader queue-full skips=%d", runtime.QueueSkipped)
	}
	if got := active.buffers.leased.Load(); got != 0 {
		t.Fatalf("TEST reader leaked %d row buffers", got)
	}
	if outstanding := active.buffers.dispose(); outstanding != 0 {
		t.Fatalf("TEST reader pool dispose outstanding=%d", outstanding)
	}
	var stored uint64
	if err := db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM "+table).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != runtime.RowsStored {
		t.Fatalf("database rows=%d, runtime rows=%d", stored, runtime.RowsStored)
	}
	t.Logf("synthetic reader tags=%d interval=%dms duration=%ds cycles=%d rows=%d overrun=%d queueFull=%d",
		tagCount, intervalMS, durationSeconds, runtime.RowsStored/uint64(tagCount), runtime.RowsStored, runtime.OverrunCount, runtime.QueueSkipped)
}

func logMachcliTraceSummary(t *testing.T, traces []machcliAppendTrace) {
	t.Helper()
	lockWait := make([]time.Duration, len(traces))
	goPrepare := make([]time.Duration, len(traces))
	cgoWall := make([]time.Duration, len(traces))
	cgoBridge := make([]time.Duration, len(traces))
	cLoop := make([]time.Duration, len(traces))
	cSetup := make([]time.Duration, len(traces))
	sqlTotal := make([]time.Duration, len(traces))
	sqlMax := make([]time.Duration, len(traces))
	order := make([]int, len(traces))
	for index, trace := range traces {
		lockWait[index] = trace.LockWait
		goPrepare[index] = trace.GoPrepare
		cgoWall[index] = trace.CGoWall
		cgoBridge[index] = nonNegativeDuration(trace.CGoWall - trace.CLoop)
		cLoop[index] = trace.CLoop
		cSetup[index] = nonNegativeDuration(trace.CLoop - trace.SQLTotal)
		sqlTotal[index] = trace.SQLTotal
		sqlMax[index] = trace.SQLMax
		order[index] = index
	}
	logDurationSeries(t, "lockWait", lockWait)
	logDurationSeries(t, "goPrepare", goPrepare)
	logDurationSeries(t, "cgoWall", cgoWall)
	logDurationSeries(t, "cgoBridge", cgoBridge)
	logDurationSeries(t, "cLoop", cLoop)
	logDurationSeries(t, "cSetupAndClock", cSetup)
	logDurationSeries(t, "sqlTotal", sqlTotal)
	logDurationSeries(t, "sqlMaxRow", sqlMax)
	sort.Slice(order, func(i, j int) bool { return traces[order[i]].Total > traces[order[j]].Total })
	limit := 10
	if len(order) < limit {
		limit = len(order)
	}
	for rank := 0; rank < limit; rank++ {
		cycle := order[rank]
		trace := traces[cycle]
		t.Logf("traceSlow rank=%d cycle=%d total=%s lock=%s prepare=%s cgoWall=%s cgoBridge=%s cLoop=%s cSetupAndClock=%s sqlTotal=%s sqlMaxRow=%s sqlMaxIndex=%d",
			rank+1, cycle+1, trace.Total, trace.LockWait, trace.GoPrepare,
			trace.CGoWall, nonNegativeDuration(trace.CGoWall-trace.CLoop), trace.CLoop,
			nonNegativeDuration(trace.CLoop-trace.SQLTotal), trace.SQLTotal,
			trace.SQLMax, trace.SQLMaxIndex)
	}
}

func logDurationSeries(t *testing.T, name string, source []time.Duration) {
	t.Helper()
	values := append([]time.Duration(nil), source...)
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
	var total time.Duration
	for _, value := range values {
		total += value
	}
	index := func(numerator, denominator int) int {
		return (len(values)*numerator - 1) / denominator
	}
	t.Logf("tracePhase=%s min=%s avg=%s p50=%s p90=%s p99=%s p999=%s max=%s",
		name, values[0], total/time.Duration(len(values)), values[index(50, 100)],
		values[index(90, 100)], values[index(99, 100)], values[index(999, 1000)],
		values[len(values)-1])
}

func nonNegativeDuration(value time.Duration) time.Duration {
	if value < 0 {
		return 0
	}
	return value
}

func positiveTestEnv(t *testing.T, name string, fallback int) int {
	t.Helper()
	text := os.Getenv(name)
	if text == "" {
		return fallback
	}
	value, err := strconv.Atoi(text)
	if err != nil || value < 1 {
		t.Fatalf("%s must be a positive integer", name)
	}
	return value
}

func nonNegativeTestEnv(t *testing.T, name string, fallback int) int {
	t.Helper()
	text := os.Getenv(name)
	if text == "" {
		return fallback
	}
	value, err := strconv.Atoi(text)
	if err != nil || value < 0 {
		t.Fatalf("%s must be a non-negative integer", name)
	}
	return value
}
