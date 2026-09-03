package main

import (
	"math"
	"os"
	"path/filepath"
	"strings"
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
	if err := os.WriteFile(filepath.Join(conf, configFileName), []byte(`{"schemaVersion":1,"jobs":[{"name":"line-a","log":{"level":"error","maxFiles":3}}]}`), 0644); err != nil {
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
	runtime := newJobRuntime("line-a")
	if runtime.Name != "line-a" || runtime.State != "running" {
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
