// neo-dbus-benchmark measures the LS DBus read and single-native-writer path.
//
// It is intentionally separate from the service daemon: it creates one
// dedicated TAG table, uses persistent DBus connections and one persistent
// native Appender, prints JSON, then drops only that table.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/godbus/dbus/v5"
	_ "github.com/machbase/neo-client/v2"
	client "github.com/machbase/neo-client/v2"
)

type config struct {
	Table    string
	Jobs     int
	Calls    int
	Values   int
	Warmup   int
	Cycles   int
	Interval time.Duration
	Phase    time.Duration
	DSN      string
}

type durationStats struct {
	Count int     `json:"count"`
	Mean  float64 `json:"meanMs"`
	Min   float64 `json:"minMs"`
	P50   float64 `json:"p50Ms"`
	P95   float64 `json:"p95Ms"`
	P99   float64 `json:"p99Ms"`
	Max   float64 `json:"maxMs"`
}

type ratioStats struct {
	Count int     `json:"count"`
	Mean  float64 `json:"meanPercent"`
	Min   float64 `json:"minPercent"`
	P50   float64 `json:"p50Percent"`
	P95   float64 `json:"p95Percent"`
	P99   float64 `json:"p99Percent"`
	Max   float64 `json:"maxPercent"`
}

type cpuUsage struct {
	BenchmarkProcess float64
	NeoContainer     float64
	PLC              float64
}

type cpuReport struct {
	BenchmarkProcess ratioStats `json:"benchmarkProcess"`
	NeoContainer     ratioStats `json:"neoContainer"`
	PLC              ratioStats `json:"plc"`
}

type jobReport struct {
	Job             int           `json:"job"`
	Values          int           `json:"values"`
	DBusRead        durationStats `json:"dbusRead"`
	JSONParse       durationStats `json:"jsonParse"`
	WriterQueueWait durationStats `json:"writerQueueWait"`
	AppendFlush     durationStats `json:"appendFlush"`
	EndToEnd        durationStats `json:"endToEnd"`
}

type callThreshold struct {
	Job              int     `json:"job"`
	Call             int     `json:"call"`
	FastHalfMedianMS float64 `json:"fastHalfMedianMs"`
	MaximumAllowedMS float64 `json:"maximumAllowedMs"`
}

type classifiedReport struct {
	Waves           int           `json:"waves"`
	WaveEndToEnd    durationStats `json:"waveEndToEnd"`
	JobMeasurements []jobReport   `json:"jobMeasurements"`
	CPU             cpuReport     `json:"cpu"`
}

type latencyClassification struct {
	Policy                  string           `json:"policy"`
	Thresholds              []callThreshold  `json:"thresholds"`
	Normal                  classifiedReport `json:"normal"`
	Excluded                classifiedReport `json:"excluded"`
	ExcludedDBusCallCount   int              `json:"excludedDbusCallCount"`
	ExcludedDBusCallLatency durationStats    `json:"excludedDbusCallLatency"`
}

type report struct {
	SchemaVersion     int                   `json:"schemaVersion"`
	StartedAt         string                `json:"startedAt"`
	CompletedAt       string                `json:"completedAt"`
	Table             string                `json:"table"`
	Jobs              int                   `json:"jobs"`
	CallsPerJob       int                   `json:"callsPerJob"`
	ValuesPerJob      int                   `json:"valuesPerJob"`
	RowsPerCycle      int                   `json:"rowsPerCycle"`
	WarmupCycles      int                   `json:"warmupCycles"`
	MeasuredCycles    int                   `json:"measuredCycles"`
	TargetIntervalMs  float64               `json:"targetIntervalMs"`
	JobPhaseSpacingMs float64               `json:"jobPhaseSpacingMs"`
	StoredRows        int64                 `json:"storedRows"`
	WaveEndToEnd      durationStats         `json:"waveEndToEnd"`
	WavesOverInterval int                   `json:"wavesOverInterval"`
	LongestDBusReadMs float64               `json:"longestDBusReadMs"`
	JobMeasurements   []jobReport           `json:"jobMeasurements"`
	CPU               cpuReport             `json:"cpu"`
	LatencyFilter     latencyClassification `json:"latencyFilter"`
	Cleanup           string                `json:"cleanup"`
}

type sample struct {
	job, cycle      int
	dbusRead        time.Duration
	jsonParse       time.Duration
	writerQueueWait time.Duration
	appendFlush     time.Duration
	endToEnd        time.Duration
	started, queued time.Time
	done            chan error
	rows            []row
	callReads       []time.Duration
}

type cpuSnapshot struct {
	process, container time.Duration
	total, idle        uint64
	processOK          bool
	containerOK        bool
	plcOK              bool
}

type row struct {
	name  string
	time  time.Time
	value float64
}

func main() {
	var cfg config
	var intervalMS int
	var phaseMS int
	flag.StringVar(&cfg.Table, "table", "", "dedicated TAG table name (required)")
	flag.IntVar(&cfg.Jobs, "jobs", 1, "concurrent DBus readers")
	flag.IntVar(&cfg.Calls, "calls-per-job", 1, "sequential DBus calls per logical Job")
	flag.IntVar(&cfg.Values, "values", 1000, "values per DBus call")
	flag.IntVar(&cfg.Warmup, "warmup", 10, "unreported warm-up waves")
	flag.IntVar(&cfg.Cycles, "cycles", 600, "reported waves")
	flag.IntVar(&intervalMS, "interval-ms", 50, "nominal wave interval")
	flag.IntVar(&phaseMS, "job-phase-ms", 0, "additional fixed phase per Job")
	flag.StringVar(&cfg.DSN, "dsn", "server=tcp://sys:manager@127.0.0.1:5656", "native connector DSN")
	flag.Parse()
	cfg.Interval = time.Duration(intervalMS) * time.Millisecond
	cfg.Phase = time.Duration(phaseMS) * time.Millisecond
	if err := validateConfig(cfg); err != nil {
		fatal(err)
	}
	if err := run(cfg); err != nil {
		fatal(err)
	}
}

func validateConfig(cfg config) error {
	if !validTable(cfg.Table) || cfg.Jobs < 1 || cfg.Jobs > 8 || cfg.Calls < 1 || cfg.Calls > 8 || cfg.Values < 1 || cfg.Values > 65535 || cfg.Values*cfg.Calls > 65535 || cfg.Warmup < 0 || cfg.Cycles < 1 || cfg.Interval < time.Millisecond || cfg.Phase < 0 || time.Duration(cfg.Jobs-1)*cfg.Phase >= cfg.Interval {
		return errors.New("invalid benchmark options")
	}
	return nil
}

func validTable(value string) bool {
	if len(value) < 1 || len(value) > 40 {
		return false
	}
	for _, ch := range value {
		if !(ch == '_' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9') {
			return false
		}
	}
	return true
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "neo-dbus-benchmark:", err)
	os.Exit(1)
}

func run(cfg config) (runErr error) {
	started := time.Now().UTC()
	db, err := sql.Open("machbase", cfg.DSN)
	if err != nil {
		return err
	}
	defer db.Close()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, fmt.Sprintf("CREATE TAG TABLE %s (NAME VARCHAR(100) PRIMARY KEY, TIME DATETIME BASE TIME, VALUE DOUBLE)", cfg.Table)); err != nil {
		return fmt.Errorf("create dedicated table: %w", err)
	}
	cleanup := "not attempted"
	tableDropped := false
	defer func() {
		if tableDropped {
			return
		}
		if _, dropErr := db.ExecContext(ctx, fmt.Sprintf("DROP TABLE %s CASCADE", cfg.Table)); dropErr != nil {
			cleanup = "drop failed: " + dropErr.Error()
			if runErr == nil {
				runErr = dropErr
			}
		} else {
			cleanup = "dropped"
		}
	}()

	connections := make([]*dbus.Conn, cfg.Jobs)
	for index := range connections {
		connections[index], err = dbus.ConnectSystemBus()
		if err != nil {
			return fmt.Errorf("connect DBus job %d: %w", index, err)
		}
		defer connections[index].Close()
	}
	appender := &client.Appender{}
	if err := appender.Connect(ctx, cfg.DSN, cfg.Table, "NAME", "TIME", "VALUE"); err != nil {
		return fmt.Errorf("open native appender: %w", err)
	}
	appenderClosed := false
	defer func() {
		if !appenderClosed {
			_, _, _ = appender.Close()
		}
	}()
	appender.WithBatchMaxRows(1024).WithBatchMaxDelay(0)

	queue := make(chan *sample, cfg.Jobs*2)
	var writer sync.WaitGroup
	writer.Add(1)
	go func() {
		defer writer.Done()
		for item := range queue {
			writeStarted := time.Now()
			item.writerQueueWait = writeStarted.Sub(item.queued)
			var writeErr error
			for _, value := range item.rows {
				if writeErr = appender.Append(value.name, value.time, value.value); writeErr != nil {
					break
				}
			}
			if writeErr == nil {
				writeErr = appender.Flush()
			}
			item.appendFlush = time.Since(writeStarted)
			item.endToEnd = time.Since(item.started)
			item.done <- writeErr
		}
	}()

	var measured []*sample
	var measuredWaves [][]*sample
	var waves []time.Duration
	var cpuMeasurements []cpuUsage
	var overInterval int
	var longestDBus time.Duration
	for cycle := 0; cycle < cfg.Warmup+cfg.Cycles; cycle++ {
		waveStarted := time.Now()
		cpuStarted := readCPU()
		items := make([]*sample, cfg.Jobs)
		var readers sync.WaitGroup
		for job := 0; job < cfg.Jobs; job++ {
			phase := time.Duration(job) * cfg.Phase
			item := &sample{job: job, cycle: cycle, started: waveStarted.Add(phase), done: make(chan error, 1)}
			items[job] = item
			readers.Add(1)
			go func(conn *dbus.Conn, target *sample, phase time.Duration) {
				defer readers.Done()
				if phase > 0 {
					time.Sleep(phase)
				}
				if err := read(conn, cfg, target); err != nil {
					target.done <- err
					return
				}
				target.queued = time.Now()
				queue <- target
			}(connections[job], item, phase)
		}
		readers.Wait()
		for _, item := range items {
			if err := <-item.done; err != nil {
				close(queue)
				writer.Wait()
				return fmt.Errorf("cycle %d job %d: %w", cycle, item.job, err)
			}
			if item.dbusRead > longestDBus {
				longestDBus = item.dbusRead
			}
			if cycle >= cfg.Warmup {
				measured = append(measured, item)
			}
		}
		waveDuration := time.Since(waveStarted)
		cpuFinished := readCPU()
		if cycle >= cfg.Warmup {
			waves = append(waves, waveDuration)
			measuredWaves = append(measuredWaves, items)
			cpuMeasurements = append(cpuMeasurements, cpuDelta(cpuStarted, cpuFinished, waveDuration))
			if waveDuration > cfg.Interval {
				overInterval++
			}
		}
		if sleep := cfg.Interval - time.Since(waveStarted); sleep > 0 {
			time.Sleep(sleep)
		}
	}
	close(queue)
	writer.Wait()
	if _, _, err := appender.Close(); err != nil {
		return fmt.Errorf("close native appender: %w", err)
	}
	appenderClosed = true
	var stored int64
	if err := db.QueryRowContext(ctx, fmt.Sprintf("SELECT COUNT(*) FROM %s", cfg.Table)).Scan(&stored); err != nil {
		return fmt.Errorf("count benchmark rows: %w", err)
	}
	if _, err := db.ExecContext(ctx, fmt.Sprintf("DROP TABLE %s CASCADE", cfg.Table)); err != nil {
		return fmt.Errorf("drop dedicated table: %w", err)
	}
	tableDropped = true
	cleanup = "dropped"
	result := report{
		SchemaVersion: 1, StartedAt: started.Format(time.RFC3339Nano), CompletedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Table: cfg.Table, Jobs: cfg.Jobs, CallsPerJob: cfg.Calls, ValuesPerJob: cfg.Values, RowsPerCycle: cfg.Jobs * cfg.Calls * cfg.Values,
		WarmupCycles: cfg.Warmup, MeasuredCycles: cfg.Cycles, TargetIntervalMs: ms(cfg.Interval), JobPhaseSpacingMs: ms(cfg.Phase), StoredRows: stored,
		WaveEndToEnd: summarize(waves), WavesOverInterval: overInterval, LongestDBusReadMs: ms(longestDBus), Cleanup: cleanup,
		JobMeasurements: summarizeJobs(measured, cfg.Jobs, cfg.Values),
		CPU:             summarizeCPU(cpuMeasurements),
		LatencyFilter:   classifyLatency(measuredWaves, cpuMeasurements, cfg),
	}
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}

func read(conn *dbus.Conn, cfg config, item *sample) error {
	object := conn.Object("ls.plc", dbus.ObjectPath("/ls/plc/device"))
	item.rows = make([]row, 0, cfg.Values*cfg.Calls)
	for call := 0; call < cfg.Calls; call++ {
		readStarted := time.Now()
		result := object.Call("ls.plc.device.GetDeviceData", 0, uint16(cfg.Values), fmt.Sprintf("%%MB%d", call*cfg.Values))
		elapsed := time.Since(readStarted)
		item.dbusRead += elapsed
		item.callReads = append(item.callReads, elapsed)
		if result.Err != nil {
			return result.Err
		}
		if len(result.Body) != 1 {
			return errors.New("unexpected DBus response body")
		}
		body, ok := result.Body[0].(string)
		if !ok {
			return errors.New("DBus response is not a JSON string")
		}
		parseStarted := time.Now()
		var decoded struct {
			Result int       `json:"rtn"`
			Count  int       `json:"data-count"`
			Data   []float64 `json:"data"`
		}
		if err := json.Unmarshal([]byte(body), &decoded); err != nil {
			return err
		}
		item.jsonParse += time.Since(parseStarted)
		if decoded.Result != 1 || decoded.Count != cfg.Values || len(decoded.Data) != cfg.Values {
			return errors.New("DBus result count mismatch")
		}
		timestamp := time.Now().UTC()
		for index, value := range decoded.Data {
			item.rows = append(item.rows, row{name: fmt.Sprintf("B%02d_%02d_%04d", item.job, call, index), time: timestamp, value: value})
		}
	}
	return nil
}

func classifyLatency(waves [][]*sample, cpuMeasurements []cpuUsage, cfg config) latencyClassification {
	limits := make([][]time.Duration, cfg.Jobs)
	thresholds := make([]callThreshold, 0, cfg.Jobs*cfg.Calls)
	for job := 0; job < cfg.Jobs; job++ {
		limits[job] = make([]time.Duration, cfg.Calls)
		for call := 0; call < cfg.Calls; call++ {
			var readings []time.Duration
			for _, wave := range waves {
				for _, item := range wave {
					if item.job == job && call < len(item.callReads) {
						readings = append(readings, item.callReads[call])
					}
				}
			}
			sort.Slice(readings, func(left, right int) bool { return readings[left] < readings[right] })
			fastHalf := readings[:(len(readings)+1)/2]
			baseline := fastHalf[(len(fastHalf)-1)/2]
			limit := baseline * 3 / 2
			limits[job][call] = limit
			thresholds = append(thresholds, callThreshold{Job: job, Call: call, FastHalfMedianMS: ms(baseline), MaximumAllowedMS: ms(limit)})
		}
	}

	var normalItems, excludedItems []*sample
	var normalWaves, excludedWaves []time.Duration
	var normalCPU, excludedCPU []cpuUsage
	var excludedCalls []time.Duration
	for waveIndex, wave := range waves {
		slow := false
		for _, item := range wave {
			for call, elapsed := range item.callReads {
				if elapsed > limits[item.job][call] {
					slow = true
					excludedCalls = append(excludedCalls, elapsed)
				}
			}
		}
		waveDuration := maxEndToEnd(wave)
		if slow {
			excludedItems = append(excludedItems, wave...)
			excludedWaves = append(excludedWaves, waveDuration)
			excludedCPU = append(excludedCPU, cpuMeasurements[waveIndex])
		} else {
			normalItems = append(normalItems, wave...)
			normalWaves = append(normalWaves, waveDuration)
			normalCPU = append(normalCPU, cpuMeasurements[waveIndex])
		}
	}
	return latencyClassification{
		Policy:                  "per physical DBus call: fastest-half median × 1.5; a wave is excluded when any call exceeds its threshold",
		Thresholds:              thresholds,
		Normal:                  classifiedReport{Waves: len(normalWaves), WaveEndToEnd: summarize(normalWaves), JobMeasurements: summarizeJobs(normalItems, cfg.Jobs, cfg.Values), CPU: summarizeCPU(normalCPU)},
		Excluded:                classifiedReport{Waves: len(excludedWaves), WaveEndToEnd: summarize(excludedWaves), JobMeasurements: summarizeJobs(excludedItems, cfg.Jobs, cfg.Values), CPU: summarizeCPU(excludedCPU)},
		ExcludedDBusCallCount:   len(excludedCalls),
		ExcludedDBusCallLatency: summarize(excludedCalls),
	}
}

func maxEndToEnd(items []*sample) time.Duration {
	var result time.Duration
	for _, item := range items {
		if item.endToEnd > result {
			result = item.endToEnd
		}
	}
	return result
}

func readCPU() cpuSnapshot {
	result := cpuSnapshot{}
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err == nil {
		result.process = timevalDuration(usage.Utime) + timevalDuration(usage.Stime)
		result.processOK = true
	}
	if data, err := os.ReadFile("/sys/fs/cgroup/cpuacct/cpuacct.usage"); err == nil {
		if nanoseconds, parseErr := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64); parseErr == nil && nanoseconds >= 0 {
			result.container = time.Duration(nanoseconds)
			result.containerOK = true
		}
	}
	if data, err := os.ReadFile("/proc/stat"); err == nil {
		fields := strings.Fields(strings.SplitN(string(data), "\n", 2)[0])
		if len(fields) >= 5 && fields[0] == "cpu" {
			var total uint64
			valid := true
			for _, field := range fields[1:] {
				value, parseErr := strconv.ParseUint(field, 10, 64)
				if parseErr != nil {
					valid = false
					break
				}
				total += value
			}
			if idle, parseErr := strconv.ParseUint(fields[4], 10, 64); valid && parseErr == nil {
				if len(fields) > 5 {
					if wait, waitErr := strconv.ParseUint(fields[5], 10, 64); waitErr == nil {
						idle += wait
					}
				}
				result.total, result.idle, result.plcOK = total, idle, total > 0
			}
		}
	}
	return result
}

func timevalDuration(value syscall.Timeval) time.Duration {
	return time.Duration(value.Sec)*time.Second + time.Duration(value.Usec)*time.Microsecond
}

func cpuDelta(before, after cpuSnapshot, wall time.Duration) cpuUsage {
	if wall <= 0 {
		return cpuUsage{BenchmarkProcess: math.NaN(), NeoContainer: math.NaN(), PLC: math.NaN()}
	}
	result := cpuUsage{BenchmarkProcess: math.NaN(), NeoContainer: math.NaN(), PLC: math.NaN()}
	if before.processOK && after.processOK && after.process >= before.process {
		result.BenchmarkProcess = 100 * float64(after.process-before.process) / float64(wall)
	}
	if before.containerOK && after.containerOK && after.container >= before.container {
		result.NeoContainer = 100 * float64(after.container-before.container) / float64(wall)
	}
	if before.plcOK && after.plcOK && after.total > before.total && after.idle >= before.idle {
		result.PLC = 100 * float64((after.total-before.total)-(after.idle-before.idle)) / float64(after.total-before.total)
	}
	return result
}

func summarizeCPU(values []cpuUsage) cpuReport {
	process, container, plc := make([]float64, 0, len(values)), make([]float64, 0, len(values)), make([]float64, 0, len(values))
	for _, value := range values {
		process = append(process, value.BenchmarkProcess)
		container = append(container, value.NeoContainer)
		plc = append(plc, value.PLC)
	}
	return cpuReport{BenchmarkProcess: summarizeRatio(process), NeoContainer: summarizeRatio(container), PLC: summarizeRatio(plc)}
}

func summarizeRatio(values []float64) ratioStats {
	filtered := make([]float64, 0, len(values))
	for _, value := range values {
		if !math.IsNaN(value) && !math.IsInf(value, 0) {
			filtered = append(filtered, value)
		}
	}
	if len(filtered) == 0 {
		return ratioStats{}
	}
	sort.Float64s(filtered)
	total := 0.0
	for _, value := range filtered {
		total += value
	}
	percentile := func(fraction float64) float64 {
		index := int(math.Ceil(fraction*float64(len(filtered)))) - 1
		if index < 0 {
			index = 0
		}
		return filtered[index]
	}
	return ratioStats{Count: len(filtered), Mean: total / float64(len(filtered)), Min: filtered[0], P50: percentile(0.50), P95: percentile(0.95), P99: percentile(0.99), Max: filtered[len(filtered)-1]}
}

func summarizeJobs(items []*sample, jobs, values int) []jobReport {
	reports := make([]jobReport, jobs)
	for job := range reports {
		var dbusRead, jsonParse, writerWait, appendFlush, endToEnd []time.Duration
		for _, item := range items {
			if item.job != job {
				continue
			}
			dbusRead = append(dbusRead, item.dbusRead)
			jsonParse = append(jsonParse, item.jsonParse)
			writerWait = append(writerWait, item.writerQueueWait)
			appendFlush = append(appendFlush, item.appendFlush)
			endToEnd = append(endToEnd, item.endToEnd)
		}
		reports[job] = jobReport{job, values, summarize(dbusRead), summarize(jsonParse), summarize(writerWait), summarize(appendFlush), summarize(endToEnd)}
	}
	return reports
}

func summarize(values []time.Duration) durationStats {
	if len(values) == 0 {
		return durationStats{}
	}
	ordered := append([]time.Duration(nil), values...)
	sort.Slice(ordered, func(left, right int) bool { return ordered[left] < ordered[right] })
	var total time.Duration
	for _, value := range ordered {
		total += value
	}
	return durationStats{Count: len(ordered), Mean: ms(total) / float64(len(ordered)), Min: ms(ordered[0]), P50: percentile(ordered, 0.50), P95: percentile(ordered, 0.95), P99: percentile(ordered, 0.99), Max: ms(ordered[len(ordered)-1])}
}

func percentile(values []time.Duration, fraction float64) float64 {
	index := int(math.Ceil(fraction*float64(len(values)))) - 1
	if index < 0 {
		index = 0
	}
	return ms(values[index])
}

func ms(value time.Duration) float64 { return float64(value) / float64(time.Millisecond) }
