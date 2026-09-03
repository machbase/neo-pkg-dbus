// neo-dbus-collector is the LS-only data plane for neo-pkg-dbus.
//
// JSH owns configuration, service registration, and the public CGI API. This
// program owns only DBus read/decode, the shared bounded queue, and native TAG
// append. It intentionally has one writer goroutine: neo-client Appender is
// not safe for concurrent use and low-spec PLCs must not run multiple native
// append streams at once.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/godbus/dbus/v5"
	client "github.com/machbase/neo-client/v2"
	"github.com/machbase/neo-client/v2/api"
)

const (
	configFileName         = "go-collector.json"
	secretFileName         = "go-collector-secrets.json"
	activeFileName         = "go-collector-active-jobs.json"
	runtimeFileName        = "go-collector-runtime.json"
	socketFileName         = "neo-dbus-collector.sock"
	queueCapacity          = 64
	defaultFlushMaxRows    = 1024
	defaultFlushInterval   = time.Second
	defaultMaxLogFileBytes = 1024 * 1024
	defaultMaxLogFiles     = 3
	defaultLogSummaryEvery = time.Hour
)

type snapshot struct {
	SchemaVersion int             `json:"schemaVersion"`
	Jobs          []jobConfig     `json:"jobs"`
	Servers       map[string]conn `json:"servers"`
	Logging       logPolicy       `json:"logging"`
	Writer        writerPolicy    `json:"writer"`
}

type conn struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	Password string `json:"password"`
}

type jobConfig struct {
	Name        string    `json:"name"`
	Schedule    schedule  `json:"schedule"`
	Retry       retry     `json:"retry"`
	Database    database  `json:"database"`
	MethodCalls []method  `json:"methodCalls"`
	Log         logConfig `json:"log"`
}

type logConfig struct {
	Level    string `json:"level"`
	MaxFiles int    `json:"maxFiles"`
}

type logPolicy struct {
	MaxFileBytes      int64 `json:"maxFileBytes"`
	MaxFiles          int   `json:"maxFiles"`
	SummaryIntervalMS int64 `json:"summaryIntervalMs"`
}

// writerPolicy is deployment tuning, not a Job option. One Go writer owns the
// appender, so queue capacity and flush behavior must be global to the daemon.
type writerPolicy struct {
	QueueCapacity   int   `json:"queueCapacity"`
	FlushMaxRows    int   `json:"flushMaxRows"`
	FlushIntervalMS int64 `json:"flushIntervalMs"`
}

func (p writerPolicy) normalized() writerPolicy {
	if p.QueueCapacity < 1 || p.QueueCapacity > 1024 {
		p.QueueCapacity = queueCapacity
	}
	if p.FlushMaxRows < 1 || p.FlushMaxRows > 65535 {
		p.FlushMaxRows = defaultFlushMaxRows
	}
	if p.FlushIntervalMS < 1 || p.FlushIntervalMS > time.Hour.Milliseconds() {
		p.FlushIntervalMS = defaultFlushInterval.Milliseconds()
	}
	return p
}

func (p logPolicy) normalized() logPolicy {
	if p.MaxFileBytes < 64*1024 || p.MaxFileBytes > 10*1024*1024 {
		p.MaxFileBytes = defaultMaxLogFileBytes
	}
	if p.MaxFiles < 1 || p.MaxFiles > 10 {
		p.MaxFiles = defaultMaxLogFiles
	}
	if p.SummaryIntervalMS < 60*1000 || p.SummaryIntervalMS > 24*60*60*1000 {
		p.SummaryIntervalMS = defaultLogSummaryEvery.Milliseconds()
	}
	return p
}

type schedule struct {
	IntervalMS int64 `json:"intervalMs"`
}
type retry struct {
	InitialDelayMS int64   `json:"initialDelayMs"`
	MaximumDelayMS int64   `json:"maximumDelayMs"`
	Multiplier     float64 `json:"multiplier"`
}
type database struct {
	Server            string `json:"server"`
	Table             string `json:"table"`
	ValueColumn       string `json:"valueColumn"`
	StringValueColumn string `json:"stringValueColumn"`
}
type method struct {
	ID               string          `json:"id"`
	Inputs           json.RawMessage `json:"inputs"`
	OutputSelections []selection     `json:"outputSelections"`
	Tags             []tag           `json:"tags"`
}
type selection struct {
	Tags []tag `json:"tags"`
}
type tag struct {
	Name           string   `json:"name"`
	Bias           float64  `json:"bias"`
	Multiplier     float64  `json:"multiplier"`
	TransformOrder []string `json:"transformOrder"`
	Signed         bool     `json:"signed"`
}

type row struct {
	Name  string
	Time  time.Time
	Value any
}
type lsValueCodec struct {
	bits uint
}
type batch struct {
	Job      string
	Database database
	Rows     []row
	Finished chan error
}

type jobRuntime struct {
	Name          string `json:"name"`
	State         string `json:"state"`
	LastReadAt    string `json:"lastReadAt,omitempty"`
	LastStoredAt  string `json:"lastStoredAt,omitempty"`
	LastError     string `json:"lastError,omitempty"`
	OverrunCount  uint64 `json:"overrunCount"`
	LastOverrunAt string `json:"lastOverrunAt,omitempty"`
	QueueSkipped  uint64 `json:"queueSkipped"`
	RowsStored    uint64 `json:"rowsStored"`
}
type runtimeState struct {
	UpdatedAt  string                `json:"updatedAt"`
	QueueDepth int                   `json:"queueDepth"`
	Jobs       map[string]jobRuntime `json:"jobs"`
}

type command struct {
	Action string `json:"action"`
	Name   string `json:"name"`
}
type reply struct {
	OK    bool          `json:"ok"`
	Error string        `json:"error,omitempty"`
	State *runtimeState `json:"state,omitempty"`
}

type daemon struct {
	root         string
	queue        chan *batch
	flushNow     chan struct{}
	writerPolicy writerPolicy
	mu           sync.Mutex
	jobs         map[string]*activeJob
	runtime      runtimeState
	closed       bool
	wg           sync.WaitGroup
	logMu        sync.Mutex
	logConfigs   map[string]logConfig
	logPolicy    logPolicy
	logSummaries map[string]logSummary
}

type logSummary struct {
	StartedAt    time.Time
	Cycles       uint64
	Succeeded    uint64
	Failed       uint64
	StoredRows   uint64
	Skipped      uint64
	QueueSkipped uint64
	LastError    string
}

type activeJob struct {
	cancel       context.CancelFunc
	done         chan struct{}
	work         sync.WaitGroup
	flushOnQueue atomic.Bool
	config       jobConfig
}

func main() {
	root := flag.String("root", "", "cgi-bin directory")
	control := flag.Bool("control", false, "send one control command")
	flag.Parse()
	if strings.TrimSpace(*root) == "" {
		fatal(errors.New("--root is required"))
	}
	if *control {
		if flag.NArg() != 2 {
			fatal(errors.New("control requires ACTION NAME"))
		}
		if err := sendCommand(*root, command{Action: flag.Arg(0), Name: flag.Arg(1)}); err != nil {
			fatal(err)
		}
		return
	}
	if flag.NArg() != 0 {
		fatal(errors.New("daemon accepts no positional arguments"))
	}
	if err := runDaemon(*root); err != nil {
		fatal(err)
	}
}

func fatal(err error) { fmt.Fprintln(os.Stderr, "neo-dbus-collector:", err); os.Exit(1) }

func runDaemon(root string) error {
	writerPolicy, err := loadWriterPolicy(root)
	if err != nil {
		return err
	}
	d := &daemon{root: root, queue: make(chan *batch, writerPolicy.QueueCapacity), flushNow: make(chan struct{}, 1), writerPolicy: writerPolicy, jobs: map[string]*activeJob{}, runtime: runtimeState{Jobs: map[string]jobRuntime{}}, logConfigs: map[string]logConfig{}, logPolicy: (logPolicy{}).normalized(), logSummaries: map[string]logSummary{}}
	if err := d.writeRuntime(); err != nil {
		return err
	}
	d.wg.Add(1)
	go func() { defer d.wg.Done(); d.writer() }()
	listener, err := listen(root)
	if err != nil {
		d.shutdown()
		return err
	}
	defer func() { _ = listener.Close(); _ = os.Remove(filepath.Join(root, "data", socketFileName)) }()
	if err := d.restoreActiveJobs(); err != nil {
		d.shutdown()
		return err
	}
	go d.serve(listener)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals
	d.shutdown()
	return nil
}

func (d *daemon) restoreActiveJobs() error {
	names, err := loadActiveJobs(d.root)
	if err != nil {
		return err
	}
	for _, name := range names {
		if err := d.start(name); err != nil {
			return fmt.Errorf("restore active Job %s: %w", name, err)
		}
	}
	return nil
}

func listen(root string) (net.Listener, error) {
	dir := filepath.Join(root, "data")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	file := filepath.Join(dir, socketFileName)
	if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return net.Listen("unix", file)
}

func (d *daemon) serve(listener net.Listener) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		go d.handle(connection)
	}
}

func (d *daemon) handle(connection net.Conn) {
	defer connection.Close()
	var cmd command
	err := json.NewDecoder(io.LimitReader(connection, 4096)).Decode(&cmd)
	if err == nil {
		err = d.apply(cmd)
	}
	r := reply{OK: err == nil}
	if err != nil {
		r.Error = err.Error()
	} else {
		state := d.snapshotRuntime()
		r.State = &state
	}
	_ = json.NewEncoder(connection).Encode(r)
}

func (d *daemon) apply(cmd command) error {
	if !validName(cmd.Name) {
		return errors.New("invalid job name")
	}
	switch cmd.Action {
	case "start":
		return d.start(cmd.Name)
	case "stop":
		return d.stop(cmd.Name)
	case "reload":
		return d.reload(cmd.Name)
	case "refresh-log":
		return d.refreshLog(cmd.Name)
	case "clear-overrun":
		return d.clearOverrun(cmd.Name)
	case "status":
		return nil
	default:
		return errors.New("unsupported control action")
	}
}

func (d *daemon) start(name string) error {
	config, err := loadJob(d.root, name)
	if err != nil {
		return err
	}
	if config.Schedule.IntervalMS < 1 {
		return errors.New("intervalMs must be at least 1")
	}
	d.mu.Lock()
	if _, exists := d.jobs[name]; exists {
		d.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &activeJob{cancel: cancel, done: make(chan struct{}), config: config}
	d.jobs[name] = a
	d.logConfigs[name] = config.Log
	if policy, policyErr := loadLogPolicy(d.root); policyErr == nil {
		d.logPolicy = policy
	}
	d.logSummaries[name] = logSummary{StartedAt: time.Now()}
	// A logical Job start begins a new monitoring period. The checkpoint is
	// intentionally in-memory runtime state, so do not carry a previous
	// stop/start cycle's skip count or timestamps into this one.
	d.updateLocked(name, func(v *jobRuntime) { *v = newJobRuntime(name) })
	d.mu.Unlock()
	d.log(name, "INFO", "collector", "collector started")
	d.wg.Add(1)
	go func() { defer d.wg.Done(); defer close(a.done); d.reader(ctx, config, name, a) }()
	return nil
}

func (d *daemon) reload(name string) error {
	d.mu.Lock()
	_, running := d.jobs[name]
	d.mu.Unlock()
	if !running {
		return nil
	}
	if err := d.stop(name); err != nil {
		return err
	}
	return d.start(name)
}

// refreshLog applies only the logging portion of a Job snapshot. Unlike reload,
// it deliberately leaves the DBus connection, scheduler, queue and runtime
// checkpoint untouched so an operator can change log verbosity while collecting.
func (d *daemon) refreshLog(name string) error {
	config, err := loadJob(d.root, name)
	if err != nil {
		return err
	}
	policy, err := loadLogPolicy(d.root)
	if err != nil {
		return err
	}
	d.mu.Lock()
	previousLevel := d.logConfigs[name].Level
	d.logConfigs[name] = config.Log
	d.logPolicy = policy
	d.mu.Unlock()
	previousLevel = strings.ToUpper(strings.TrimSpace(previousLevel))
	currentLevel := strings.ToUpper(strings.TrimSpace(config.Log.Level))
	if previousLevel != currentLevel {
		// This is an operator audit event and a useful boundary when viewing
		// live logs. It must be retained even when the newly selected level
		// would normally filter INFO records (for example INFO -> ERROR).
		d.logAlways(name, "INFO", "config", fmt.Sprintf("log level changed: %s -> %s", previousLevel, currentLevel))
	} else {
		d.log(name, "INFO", "config", "log policy updated")
	}
	return nil
}

// clearOverrun resets only the operator-facing skip monitoring values. It
// deliberately does not change the current reader, queue, append writer, or
// periodic log summary: clearing the dashboard is not a data-plane restart
// and must not erase diagnostic history from the current log window.
func (d *daemon) clearOverrun(name string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, exists := d.runtime.Jobs[name]; !exists {
		return errors.New("job runtime is not available")
	}
	d.updateLocked(name, func(v *jobRuntime) {
		v.OverrunCount = 0
		v.LastOverrunAt = ""
		v.QueueSkipped = 0
	})
	return nil
}

func (d *daemon) stop(name string) error {
	d.mu.Lock()
	a := d.jobs[name]
	if a == nil {
		d.mu.Unlock()
		return nil
	}
	a.flushOnQueue.Store(true)
	a.cancel()
	d.mu.Unlock()
	d.requestFlush()
	<-a.done
	d.mu.Lock()
	delete(d.jobs, name)
	d.updateLocked(name, func(v *jobRuntime) { v.State = "stopped" })
	d.mu.Unlock()
	d.flushLogSummary(name, true)
	d.log(name, "INFO", "collector", "collector stopped")
	return nil
}

func (d *daemon) shutdown() {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return
	}
	d.closed = true
	jobs := make([]*activeJob, 0, len(d.jobs))
	names := make([]string, 0, len(d.jobs))
	for name, active := range d.jobs {
		active.flushOnQueue.Store(true)
		active.cancel()
		jobs = append(jobs, active)
		names = append(names, name)
	}
	d.mu.Unlock()
	d.requestFlush()
	for _, active := range jobs {
		<-active.done
	}
	for _, name := range names {
		d.flushLogSummary(name, true)
		d.log(name, "INFO", "collector", "collector stopped")
	}
	d.mu.Lock()
	d.jobs = map[string]*activeJob{}
	d.mu.Unlock()
	close(d.queue)
	d.wg.Wait()
	_ = d.writeRuntime()
}

func (d *daemon) reader(ctx context.Context, config jobConfig, name string, active *activeJob) {
	// SystemBus() returns a process-wide shared connection. Closing it per
	// cycle lets one Job tear down another Job's DBus call. Each reader instead
	// owns one dedicated connection for its whole logical Job lifetime. A
	// failed initial connection is not retried with an independent backoff:
	// each aligned Job cycle gets exactly one connection attempt instead.
	var connection *dbus.Conn
	defer func() {
		if connection != nil {
			connection.Close()
		}
	}()
	interval := time.Duration(config.Schedule.IntervalMS) * time.Millisecond
	timer := time.NewTimer(nextAligned(time.Now(), interval))
	defer timer.Stop()
	var busy atomic.Bool
	for {
		select {
		case <-ctx.Done():
			// Job stop is complete only after its in-flight DBus call and its
			// already queued batch have finished. This is the per-Job drain
			// guarantee; other Jobs continue using the shared writer.
			active.work.Wait()
			return
		case <-timer.C:
			if !busy.CompareAndSwap(false, true) {
				d.recordOverrun(name, false)
			} else {
				active.work.Add(1)
				go func() {
					defer active.work.Done()
					defer busy.Store(false)
					if connection == nil {
						var connectError error
						connection, connectError = d.connectDBus(name)
						if connectError != nil {
							return
						}
					}
					d.readOnce(ctx, config, name, connection, active)
				}()
			}
			timer.Reset(nextAligned(time.Now(), interval))
		}
	}
}

func (d *daemon) connectDBus(name string) (*dbus.Conn, error) {
	connection, err := dbus.ConnectSystemBus()
	if err != nil {
		d.recordError(name, fmt.Errorf("DBus connect: %w", err))
		return nil, err
	}
	return connection, nil
}

// nextAligned returns a delay to the next interval boundary anchored at the
// local Unix epoch. Therefore a 10s interval fires at :00/:10/:20, not N ms
// after a previous read finished.
func nextAligned(now time.Time, interval time.Duration) time.Duration {
	if interval <= 0 {
		return 0
	}
	n := now.UnixNano()
	step := int64(interval)
	next := ((n / step) + 1) * step
	return time.Duration(next - n)
}

func (d *daemon) readOnce(ctx context.Context, config jobConfig, name string, connection *dbus.Conn, active *activeJob) {
	rows, err := readDBus(ctx, config, connection)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		d.recordError(name, err)
		return
	}
	d.mu.Lock()
	// A queued read is not yet a durable database write. Do not clear a
	// previous writer error here; only a successful Flush may do that.
	d.updateLocked(name, func(v *jobRuntime) { v.LastReadAt = time.Now().UTC().Format(time.RFC3339Nano) })
	d.mu.Unlock()
	b := &batch{Job: name, Database: config.Database, Rows: rows, Finished: make(chan error, 1)}
	// The reader has completed its responsibility after a bounded queue accepts
	// the typed batch. Keep a separate drain reference so Job stop waits for
	// durable completion without making the scheduler wait for writer Flush.
	active.work.Add(1)
	select {
	case d.queue <- b:
		if active.flushOnQueue.Load() {
			d.requestFlush()
		}
		go func() {
			defer active.work.Done()
			if writeErr := <-b.Finished; writeErr != nil {
				d.recordError(name, writeErr)
				return
			}
			d.recordSuccess(name, len(rows))
		}()
	default:
		active.work.Done()
		d.recordOverrun(name, true)
	}
}

func (d *daemon) writer() {
	policy := d.writerPolicy.normalized()
	ticker := time.NewTicker(time.Duration(policy.FlushIntervalMS) * time.Millisecond)
	defer ticker.Stop()
	var active *nativeAppender
	pending := make([]*batch, 0)
	complete := func(writeErr error) {
		for _, item := range pending {
			item.Finished <- writeErr
		}
		pending = pending[:0]
	}
	flush := func() error {
		if len(pending) == 0 {
			return nil
		}
		writeErr := active.flush()
		if writeErr != nil {
			// A native write/flush failure can leave the stream unusable. Close it
			// in the sole writer, then let the next queued batch establish a fresh
			// connection instead of poisoning every following Job batch.
			_ = active.close()
			active = nil
		}
		complete(writeErr)
		return writeErr
	}
	for {
		select {
		case b, open := <-d.queue:
			if !open {
				_ = flush()
				if active != nil {
					_ = active.close()
				}
				return
			}
			if active != nil && !active.same(b.Database) {
				_ = flush()
				if active != nil {
					_ = active.close()
					active = nil
				}
			}
			if active == nil {
				next, openErr := openAppender(d.root, b.Database, policy.FlushMaxRows)
				if openErr != nil {
					b.Finished <- openErr
					continue
				}
				active = next
			}
			if appendErr := active.append(b.Rows); appendErr != nil {
				_ = active.close()
				active = nil
				complete(appendErr)
				b.Finished <- appendErr
				continue
			}
			pending = append(pending, b)
		case <-ticker.C:
			_ = flush()
		case <-d.flushNow:
			_ = flush()
		}
	}
}

func (d *daemon) requestFlush() {
	select {
	case d.flushNow <- struct{}{}:
	default:
	}
}

func readDBus(ctx context.Context, config jobConfig, connection *dbus.Conn) ([]row, error) {
	all := make([]row, 0)
	for _, call := range config.MethodCalls {
		count, address, tags, codec, err := lsCall(call)
		if err != nil {
			return nil, err
		}
		object := connection.Object("ls.plc", dbus.ObjectPath("/ls/plc/device"))
		result := object.CallWithContext(ctx, "ls.plc.device.GetDeviceData", 0, uint16(count), address)
		if result.Err != nil {
			return nil, fmt.Errorf("DBus GetDeviceData: %w", result.Err)
		}
		if len(result.Body) != 1 {
			return nil, errors.New("DBus GetDeviceData returned unexpected body")
		}
		body, ok := result.Body[0].(string)
		if !ok {
			return nil, errors.New("DBus GetDeviceData result is not a string")
		}
		rows, err := decodeLSDeviceRows(body, count, tags, codec)
		if err != nil {
			return nil, err
		}
		all = append(all, rows...)
	}
	return all, nil
}

// decodeLSDeviceRows uses the timestamp supplied by the PLC, not the time at
// which the collector receives the DBus reply. LS returns time-stamp-us as a
// Unix epoch value in microseconds; every value in one GetDeviceData reply is
// a snapshot at that same PLC timestamp.
func decodeLSDeviceRows(body string, count int, tags []tag, codec lsValueCodec) ([]row, error) {
	var parsed struct {
		Result      int           `json:"rtn"`
		Count       int           `json:"data-count"`
		Data        []json.Number `json:"data"`
		TimestampUS int64         `json:"time-stamp-us"`
	}
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&parsed); err != nil {
		return nil, fmt.Errorf("DBus JSON parse: %w", err)
	}
	if parsed.Result != 1 || parsed.Count != count || len(parsed.Data) != count || len(tags) != count {
		return nil, errors.New("DBus GetDeviceData result count mismatch")
	}
	if parsed.TimestampUS <= 0 {
		return nil, errors.New("DBus GetDeviceData result timestamp is missing or invalid")
	}
	timestamp := time.Unix(parsed.TimestampUS/1_000_000, (parsed.TimestampUS%1_000_000)*1_000).UTC()
	rows := make([]row, 0, len(parsed.Data))
	for index, encoded := range parsed.Data {
		value, err := decodeLSValue(encoded, codec, tags[index].Signed)
		if err != nil {
			return nil, fmt.Errorf("DBus GetDeviceData value %d: %w", index, err)
		}
		value, err = transform(value, tags[index])
		if err != nil {
			return nil, fmt.Errorf("DBus GetDeviceData value %d transform: %w", index, err)
		}
		rows = append(rows, row{Name: tags[index].Name, Time: timestamp, Value: value})
	}
	return rows, nil
}

func decodeLSValue(encoded json.Number, codec lsValueCodec, signed bool) (any, error) {
	if codec.bits == 0 || codec.bits > 64 {
		return nil, errors.New("invalid LS value codec")
	}
	raw, err := strconv.ParseUint(encoded.String(), 10, 64)
	if err != nil {
		return nil, errors.New("DBus value is not an unsigned integer")
	}
	if codec.bits < 64 && raw > (uint64(1)<<codec.bits)-1 {
		return nil, fmt.Errorf("DBus value %d exceeds %d-bit address type", raw, codec.bits)
	}
	// A Bit is always 0 or 1. Signed is deliberately ignored for X addresses.
	if !signed || codec.bits == 1 {
		return raw, nil
	}
	if codec.bits == 64 {
		return int64(raw), nil
	}
	signBit := uint64(1) << (codec.bits - 1)
	if raw&signBit != 0 {
		return int64(raw) - int64(uint64(1)<<codec.bits), nil
	}
	return int64(raw), nil
}

// lsValueCodecForAddress derives the PLC representation from the second
// character after `%`: X/B/W/D/L are bit, byte, word, double word and long
// word. The PLC sends all values as unsigned JSON integers; B/W/D/L therefore
// need two's-complement conversion before the configured Tag transform.
func lsValueCodecForAddress(address string) (lsValueCodec, error) {
	value := strings.TrimPrefix(strings.TrimSpace(address), "%")
	if len(value) < 2 {
		return lsValueCodec{}, errors.New("LS DeviceString does not include a data type")
	}
	switch strings.ToUpper(value[1:2]) {
	case "X":
		return lsValueCodec{bits: 1}, nil
	case "B":
		return lsValueCodec{bits: 8}, nil
	case "W":
		return lsValueCodec{bits: 16}, nil
	case "D":
		return lsValueCodec{bits: 32}, nil
	case "L":
		return lsValueCodec{bits: 64}, nil
	default:
		return lsValueCodec{}, errors.New("LS DeviceString data type must be X, B, W, D, or L")
	}
}

func lsCall(call method) (int, string, []tag, lsValueCodec, error) {
	var input struct {
		DataCount    int    `json:"DataCount"`
		DeviceString string `json:"DeviceString"`
	}
	if err := json.Unmarshal(call.Inputs, &input); err != nil {
		return 0, "", nil, lsValueCodec{}, err
	}
	if input.DataCount < 1 || input.DataCount > 65535 || strings.TrimSpace(input.DeviceString) == "" {
		return 0, "", nil, lsValueCodec{}, errors.New("invalid LS GetDeviceData input")
	}
	codec, err := lsValueCodecForAddress(input.DeviceString)
	if err != nil {
		return 0, "", nil, lsValueCodec{}, err
	}
	tags := call.Tags
	if len(call.OutputSelections) == 1 {
		tags = call.OutputSelections[0].Tags
	}
	if len(tags) != input.DataCount {
		return 0, "", nil, lsValueCodec{}, errors.New("LS tag count does not match DataCount")
	}
	return input.DataCount, input.DeviceString, tags, codec, nil
}

func numericFloat(value any) (float64, error) {
	switch number := value.(type) {
	case uint64:
		return float64(number), nil
	case int64:
		return float64(number), nil
	case float64:
		return number, nil
	default:
		return 0, errors.New("unsupported numeric value")
	}
}

func transform(value any, tag tag) (any, error) {
	bias, multiplier := tag.Bias, tag.Multiplier
	if bias == 0 && multiplier == 1 {
		return value, nil
	}
	number, err := numericFloat(value)
	if err != nil {
		return nil, err
	}
	if len(tag.TransformOrder) == 2 && tag.TransformOrder[0] == "multiplier" {
		return number*multiplier + bias, nil
	}
	return (number + bias) * multiplier, nil
}

type nativeAppender struct {
	database  database
	appender  *client.Appender
	hasString bool
	valueType api.ColumnType
}

func (a *nativeAppender) same(database database) bool { return a.database == database }
func (a *nativeAppender) close() error                { _, _, err := a.appender.Close(); return err }
func (a *nativeAppender) flush() error                { return a.appender.Flush() }
func (a *nativeAppender) append(rows []row) error {
	values := make([]any, len(rows))
	for index, row := range rows {
		value, err := valueForColumn(row.Value, a.valueType)
		if err != nil {
			return fmt.Errorf("Tag %s: %w", row.Name, err)
		}
		values[index] = value
	}
	for _, row := range rows {
		value := values[0]
		values = values[1:]
		if a.hasString {
			if err := a.appender.Append(row.Name, row.Time, value, nil); err != nil {
				return err
			}
		} else if err := a.appender.Append(row.Name, row.Time, value); err != nil {
			return err
		}
	}
	return nil
}

func valueForColumn(value any, typ api.ColumnType) (any, error) {
	number, err := numericFloat(value)
	if err != nil {
		return nil, err
	}
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return nil, errors.New("value is not finite")
	}
	integer := func(min, max float64, convert func(int64) any) (any, error) {
		if math.Trunc(number) != number {
			return nil, errors.New("integer VALUE column cannot store a fractional result")
		}
		if number < min || number > max {
			return nil, errors.New("value is outside VALUE column range")
		}
		return convert(int64(number)), nil
	}
	switch typ {
	case api.ColumnTypeShort:
		return integer(math.MinInt16, math.MaxInt16, func(v int64) any { return int16(v) })
	case api.ColumnTypeUShort:
		return integer(0, math.MaxUint16, func(v int64) any { return uint16(v) })
	case api.ColumnTypeInteger:
		return integer(math.MinInt32, math.MaxInt32, func(v int64) any { return int32(v) })
	case api.ColumnTypeUInteger:
		return integer(0, math.MaxUint32, func(v int64) any { return uint32(v) })
	case api.ColumnTypeLong:
		if integerValue, ok := value.(int64); ok {
			return integerValue, nil
		}
		if unsignedValue, ok := value.(uint64); ok && unsignedValue > math.MaxInt64 {
			return nil, errors.New("value is outside VALUE column range")
		}
		return integer(math.MinInt64, math.MaxInt64, func(v int64) any { return v })
	case api.ColumnTypeULong:
		if unsignedValue, ok := value.(uint64); ok {
			return unsignedValue, nil
		}
		return integer(0, float64(math.MaxInt64), func(v int64) any { return uint64(v) })
	case api.ColumnTypeFloat:
		return float32(number), nil
	case api.ColumnTypeDouble:
		return number, nil
	default:
		return nil, fmt.Errorf("VALUE column type %s is not numeric", typ)
	}
}

func openAppender(root string, database database, flushMaxRows int) (*nativeAppender, error) {
	secrets, err := loadSecrets(root)
	if err != nil {
		return nil, err
	}
	server, ok := secrets[database.Server]
	if !ok {
		return nil, errors.New("database server secret not found")
	}
	dsn := fmt.Sprintf("server=tcp://%s:%s@%s:%d", server.User, server.Password, server.Host, server.Port)
	ap := &client.Appender{}
	if err := ap.Connect(context.Background(), dsn, database.Table); err != nil {
		return nil, err
	}
	columns := ap.Columns()
	primary, basetime := "", ""
	var valueType api.ColumnType
	for _, column := range columns {
		if column.IsTagName() {
			primary = column.Name
		}
		if column.IsBaseTime() {
			basetime = column.Name
		}
		if strings.EqualFold(column.Name, database.ValueColumn) {
			valueType = column.Type
		}
	}
	if primary == "" || basetime == "" {
		_, _, _ = ap.Close()
		return nil, errors.New("TAG primary/basetime column not found")
	}
	value, stringValue := strings.ToUpper(database.ValueColumn), strings.ToUpper(database.StringValueColumn)
	if value == "" {
		_, _, _ = ap.Close()
		return nil, errors.New("TAG value column not configured")
	}
	if valueType == api.ColumnTypeUnknown {
		_, _, _ = ap.Close()
		return nil, errors.New("TAG VALUE column type not found")
	}
	if stringValue != "" {
		ap.WithInputColumns(primary, basetime, value, stringValue)
	} else {
		ap.WithInputColumns(primary, basetime, value)
	}
	// The writer goroutine owns the time-based Flush. Disable the connector's
	// append-driven delay so the deployment setting has one unambiguous clock;
	// the connector's byte cap remains a memory safety guard.
	ap.WithBatchMaxRows(flushMaxRows).WithBatchMaxDelay(0)
	return &nativeAppender{database: database, appender: ap, hasString: stringValue != "", valueType: valueType}, nil
}

func loadSnapshot(root string) (snapshot, error) {
	file := filepath.Join(root, "conf.d", configFileName)
	data, err := os.ReadFile(file)
	if err != nil {
		return snapshot{}, err
	}
	var value snapshot
	if err := json.Unmarshal(data, &value); err != nil {
		return snapshot{}, err
	}
	return value, nil
}

func loadLogPolicy(root string) (logPolicy, error) {
	value, err := loadSnapshot(root)
	if err != nil {
		return logPolicy{}, err
	}
	return value.Logging.normalized(), nil
}

func loadWriterPolicy(root string) (writerPolicy, error) {
	value, err := loadSnapshot(root)
	if err != nil {
		return writerPolicy{}, err
	}
	return value.Writer.normalized(), nil
}

func loadJob(root, name string) (jobConfig, error) {
	value, err := loadSnapshot(root)
	if err != nil {
		return jobConfig{}, err
	}
	for _, job := range value.Jobs {
		if job.Name == name {
			return job, nil
		}
	}
	return jobConfig{}, errors.New("job not found in collector snapshot")
}
func loadSecrets(root string) (map[string]conn, error) {
	data, err := os.ReadFile(filepath.Join(root, "conf.d", secretFileName))
	if err != nil {
		return nil, err
	}
	var value struct {
		Servers map[string]conn `json:"servers"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	return value.Servers, nil
}

func loadActiveJobs(root string) ([]string, error) {
	data, err := os.ReadFile(filepath.Join(root, "conf.d", activeFileName))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var value struct {
		SchemaVersion int      `json:"schemaVersion"`
		Names         []string `json:"names"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	if value.SchemaVersion != 1 {
		return nil, errors.New("active Job state schemaVersion must be 1")
	}
	seen := map[string]bool{}
	names := make([]string, 0, len(value.Names))
	for _, name := range value.Names {
		if !validName(name) {
			return nil, errors.New("active Job state contains invalid name")
		}
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names, nil
}

func (d *daemon) recordOverrun(name string, queue bool) {
	d.mu.Lock()
	var count uint64
	var first bool
	d.updateLocked(name, func(v *jobRuntime) {
		now := time.Now().UTC().Format(time.RFC3339Nano)
		v.OverrunCount++
		v.LastOverrunAt = now
		if queue {
			v.QueueSkipped++
		}
		count = v.OverrunCount
	})
	summary := d.logSummaries[name]
	if summary.StartedAt.IsZero() {
		summary.StartedAt = time.Now()
	}
	summary.Skipped++
	if queue {
		summary.QueueSkipped++
	}
	first = summary.Skipped == 1
	d.logSummaries[name] = summary
	d.mu.Unlock()
	if first {
		stage := "scheduler"
		if queue {
			stage = "queue"
		}
		d.log(name, "WARN", stage, fmt.Sprintf("scheduled cycle skipped; overrunCount=%d", count))
	}
	d.flushLogSummary(name, false)
}
func (d *daemon) recordError(name string, err error) {
	d.mu.Lock()
	trimmed := trimError(err)
	d.updateLocked(name, func(v *jobRuntime) { v.LastError = trimError(err); v.State = "running" })
	summary := d.logSummaries[name]
	if summary.StartedAt.IsZero() {
		summary.StartedAt = time.Now()
	}
	summary.Cycles++
	summary.Failed++
	summary.LastError = trimmed
	first := summary.Failed == 1
	d.logSummaries[name] = summary
	d.mu.Unlock()
	if first {
		d.log(name, "ERROR", "collector", "cycle failed: "+trimmed)
	}
	d.flushLogSummary(name, false)
}

func (d *daemon) recordSuccess(name string, rows int) {
	d.mu.Lock()
	d.updateLocked(name, func(v *jobRuntime) {
		v.LastStoredAt = time.Now().UTC().Format(time.RFC3339Nano)
		v.RowsStored += uint64(rows)
	})
	summary := d.logSummaries[name]
	if summary.StartedAt.IsZero() {
		summary.StartedAt = time.Now()
	}
	summary.Cycles++
	summary.Succeeded++
	summary.StoredRows += uint64(rows)
	d.logSummaries[name] = summary
	d.mu.Unlock()
	d.flushLogSummary(name, false)
}

func (d *daemon) flushLogSummary(name string, force bool) {
	now := time.Now()
	d.mu.Lock()
	summary, exists := d.logSummaries[name]
	policy := d.logPolicy.normalized()
	if !exists || summary.StartedAt.IsZero() || (!force && now.Sub(summary.StartedAt) < time.Duration(policy.SummaryIntervalMS)*time.Millisecond) {
		d.mu.Unlock()
		return
	}
	if summary.Cycles == 0 && summary.Failed == 0 && summary.Skipped == 0 {
		d.logSummaries[name] = logSummary{StartedAt: now}
		d.mu.Unlock()
		return
	}
	d.logSummaries[name] = logSummary{StartedAt: now}
	d.mu.Unlock()

	duration := now.Sub(summary.StartedAt).Round(time.Millisecond)
	message := fmt.Sprintf("cycle summary; duration=%s cycles=%d succeeded=%d failed=%d storedRows=%d skipped=%d queueSkipped=%d", duration, summary.Cycles, summary.Succeeded, summary.Failed, summary.StoredRows, summary.Skipped, summary.QueueSkipped)
	if summary.LastError != "" {
		message += " lastError=" + summary.LastError
	}
	if summary.Skipped > 1 {
		d.log(name, "WARN", "scheduler", message)
	}
	if summary.Failed > 1 {
		d.log(name, "ERROR", "collector", message)
	}
	d.log(name, "DEBUG", "collector", message)
}
func trimError(err error) string {
	value := err.Error()
	if len(value) > 500 {
		return value[:500]
	}
	return value
}

func (d *daemon) log(name, level, stage, message string) {
	d.mu.Lock()
	config := d.logConfigs[name]
	policy := d.logPolicy.normalized()
	d.mu.Unlock()
	if !shouldLog(config.Level, level) {
		return
	}
	d.writeLog(name, level, stage, message, policy)
}

// logAlways is reserved for compact operator audit boundaries such as a log
// level transition. It bypasses the selected threshold so changing to ERROR
// cannot hide the record that explains why subsequent INFO records vanished.
func (d *daemon) logAlways(name, level, stage, message string) {
	d.mu.Lock()
	policy := d.logPolicy.normalized()
	d.mu.Unlock()
	d.writeLog(name, level, stage, message, policy)
}

func (d *daemon) writeLog(name, level, stage, message string, policy logPolicy) {
	d.logMu.Lock()
	defer d.logMu.Unlock()
	dir := filepath.Join(filepath.Dir(d.root), "logs")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return
	}
	file := filepath.Join(dir, name+".log")
	if info, err := os.Stat(file); err == nil && info.Size() >= policy.MaxFileBytes {
		stamp := time.Now().Format("20060102_150405_000")
		rotated := filepath.Join(dir, name+"_"+stamp+".log")
		if err := os.Rename(file, rotated); err == nil {
			d.purgeLogs(dir, name, policy.MaxFiles)
		}
	}
	line := "[" + level + "] " + time.Now().Format("2006-01-02 15:04:05.000") + "  " + stage + "  " + message + "\n"
	_ = appendFile(file, line)
}

func shouldLog(configured, level string) bool {
	levels := map[string]int{"TRACE": -1, "DEBUG": 0, "INFO": 1, "WARN": 2, "ERROR": 3}
	minimum, ok := levels[strings.ToUpper(configured)]
	if !ok {
		minimum = levels["INFO"]
	}
	return levels[level] >= minimum
}

func appendFile(file, line string) error {
	handle, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	_, writeErr := handle.WriteString(line)
	closeErr := handle.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

func (d *daemon) purgeLogs(dir, name string, maximum int) {
	if maximum < 1 {
		maximum = 10
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	prefix := name + "_"
	files := make([]string, 0)
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), prefix) && strings.HasSuffix(entry.Name(), ".log") {
			files = append(files, entry.Name())
		}
	}
	sort.Strings(files)
	for len(files) > maximum {
		_ = os.Remove(filepath.Join(dir, files[0]))
		files = files[1:]
	}
}
func (d *daemon) updateLocked(name string, operation func(*jobRuntime)) {
	value := d.runtime.Jobs[name]
	operation(&value)
	d.runtime.Jobs[name] = value
	d.runtime.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	d.runtime.QueueDepth = len(d.queue)
	_ = d.writeRuntimeLocked()
}

func newJobRuntime(name string) jobRuntime {
	return jobRuntime{Name: name, State: "running"}
}
func (d *daemon) snapshotRuntime() runtimeState {
	d.mu.Lock()
	defer d.mu.Unlock()
	value := runtimeState{UpdatedAt: d.runtime.UpdatedAt, QueueDepth: len(d.queue), Jobs: map[string]jobRuntime{}}
	for name, job := range d.runtime.Jobs {
		value.Jobs[name] = job
	}
	return value
}
func (d *daemon) writeRuntime() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.writeRuntimeLocked()
}
func (d *daemon) writeRuntimeLocked() error {
	d.runtime.QueueDepth = len(d.queue)
	return writeJSONAtomic(filepath.Join(d.root, "data", runtimeFileName), d.runtime, 0644)
}

func sendCommand(root string, cmd command) error {
	file := filepath.Join(root, "data", socketFileName)
	deadline := time.Now().Add(10 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		connection, err := net.DialTimeout("unix", file, 300*time.Millisecond)
		if err != nil {
			last = err
			time.Sleep(100 * time.Millisecond)
			continue
		}
		_ = connection.SetDeadline(time.Now().Add(30 * time.Second))
		if err = json.NewEncoder(connection).Encode(cmd); err == nil {
			var result reply
			err = json.NewDecoder(bufio.NewReader(connection)).Decode(&result)
			if err == nil && !result.OK {
				err = errors.New(result.Error)
			}
		}
		_ = connection.Close()
		return err
	}
	return fmt.Errorf("collector control socket unavailable: %w", last)
}

func writeJSONAtomic(file string, value any, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(file), ".collector-*")
	if err != nil {
		return err
	}
	tempName := temporary.Name()
	defer os.Remove(tempName)
	if err = temporary.Chmod(mode); err == nil {
		_, err = temporary.Write(append(data, '\n'))
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(tempName, file)
}

func validName(name string) bool {
	if len(name) == 0 || len(name) > 100 {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

// Kept small and pure so timing alignment is unit-tested without a PLC.
func sortedRuntimeNames(state runtimeState) []string {
	names := make([]string, 0, len(state.Jobs))
	for name := range state.Jobs {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
