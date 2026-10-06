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
	"database/sql"
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
	"github.com/machbase/neo-pkg-dbus/collector-go/internal/parentwatch"
)

const (
	configFileName         = "go-collector.json"
	secretFileName         = "go-collector-secrets.json"
	activeFileName         = "go-collector-active-jobs.json"
	runtimeFileName        = "go-collector-runtime.json"
	socketFileName         = "neo-dbus-collector.sock"
	queueCapacity          = 512
	defaultFlushMaxRows    = 8192
	defaultFlushInterval   = time.Second
	defaultMaxLogFileBytes = 1024 * 1024
	defaultMaxLogFiles     = 3
	defaultLogSummaryEvery = time.Hour
	defaultJobSampleCount  = 1000
	defaultWriterPerfEvery = 30 * time.Second
	minimumJobSampleCount  = 500
	minimumWriterPerfEvery = 10 * time.Second
	maxDurableSamples      = 4096
	testTableName          = "T4_DBUS_TEST_"
	initialJobRowBuffers   = 4
	maximumJobRowBuffers   = 32
)

type snapshot struct {
	SchemaVersion int               `json:"schemaVersion"`
	Logging       logPolicy         `json:"logging"`
	Writer        writerPolicy      `json:"writer"`
	Performance   performancePolicy `json:"performance"`
}

type conn struct {
	Host              string `json:"host"`
	Port              int    `json:"port"`
	User              string `json:"user"`
	Password          string `json:"password"`
	DefaultTable      string `json:"defaultTable"`
	ValueColumn       string `json:"valueColumn"`
	StringValueColumn string `json:"stringValueColumn"`
}

type jobConfig struct {
	SchemaVersion int       `json:"schemaVersion"`
	Name          string    `json:"name"`
	Revision      int       `json:"revision"`
	Schedule      schedule  `json:"schedule"`
	Retry         retry     `json:"retry"`
	Execution     execution `json:"execution"`
	Database      database  `json:"database"`
	MethodCalls   []method  `json:"methodCalls"`
	Log           logConfig `json:"log"`
}
type execution struct {
	Test bool `json:"test"`
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

// performancePolicy is an internal LS deployment setting. It is intentionally
// absent from the public settings API and Job model.
type performancePolicy struct {
	Enabled                 bool  `json:"enabled"`
	JobSampleCount          int   `json:"jobSampleCount"`
	WriterSummaryIntervalMS int64 `json:"writerSummaryIntervalMs"`
}

func (p performancePolicy) normalized() (performancePolicy, []string) {
	applied := p
	corrections := make([]string, 0, 2)
	if applied.JobSampleCount < minimumJobSampleCount {
		corrections = append(corrections, fmt.Sprintf("jobSampleCount=%d->%d", applied.JobSampleCount, minimumJobSampleCount))
		applied.JobSampleCount = minimumJobSampleCount
	}
	if applied.WriterSummaryIntervalMS < minimumWriterPerfEvery.Milliseconds() {
		corrections = append(corrections, fmt.Sprintf("writerSummaryIntervalMs=%d->%d", applied.WriterSummaryIntervalMS, minimumWriterPerfEvery.Milliseconds()))
		applied.WriterSummaryIntervalMS = minimumWriterPerfEvery.Milliseconds()
	}
	return applied, corrections
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
	Conversion     string   `json:"conversion"`
	Signed         bool     `json:"signed"`
	registryIndex  uint32
}

type row struct {
	TagIndex uint32
	Time     time.Time
	Value    any
}

func requiredTagCount(rows []row) int {
	required := 0
	for index := range rows {
		candidate := uint64(rows[index].TagIndex) + 1
		if candidate > uint64(required) {
			if candidate > uint64(^uint(0)>>1) {
				return -1
			}
			required = int(candidate)
		}
	}
	return required
}

// tagRegistry owns one stable numeric identity for every TAG name seen during
// the daemon lifetime. Job edits may add names, but existing indices never move;
// batches already queued before an edit therefore remain valid without retaining
// one copy of the TAG string in every row.
type tagRegistry struct {
	mu      sync.RWMutex
	names   []string
	indices map[string]uint32
}
type lsValueCodec struct {
	bits uint
}

type callPlan struct {
	count   int
	address string
	tags    []tag
	codec   lsValueCodec
	offset  int
}

type readPlan struct {
	calls    []callPlan
	rowCount int
	tagIDs   []uint32
}

// rowBufferPool retains a small per-Job working set and grows only when writer
// stalls make more buffers concurrently necessary. Empty-pool acquisition never
// blocks a reader; overflow buffers are temporary and become GC candidates when
// the retained cache has reached its limit.
type rowBufferPool struct {
	rowCount int
	tagIDs   []uint32
	idle     chan []row
	mu       sync.Mutex
	closed   atomic.Bool
	leased   atomic.Int64
}

type rowBufferLease struct {
	pool *rowBufferPool
	rows []row
	once sync.Once
}

type queueReservation struct {
	daemon *daemon
	once   sync.Once
}

type batch struct {
	Job              string
	Database         database
	Registry         *tagRegistry
	Rows             []row
	RowCount         int
	rowLease         *rowBufferLease
	queueReservation *queueReservation
	Owner            *activeJob
	Finished         chan error
	EnqueuedAt       time.Time
	FlushAfterAppend bool
}

type readTiming struct {
	DBus                time.Duration
	Parse               time.Duration
	Generate            time.Duration
	ReaderTotal         time.Duration
	DBusMeasured        bool
	ParseMeasured       bool
	GenerateMeasured    bool
	ReaderTotalMeasured bool
}

type jobPerformance struct {
	Source             string
	Attempts           int
	DBusUS             []int64
	ParseTotalUS       int64
	ParseMaxUS         int64
	ParseSamples       int
	GenerateTotalUS    int64
	GenerateMaxUS      int64
	GenerateSamples    int
	ReaderTotalUS      []int64
	TimerWakeLagUS     []int64
	TimerWakeNext      int
	DispatchLagUS      []int64
	ReaderStartLagUS   []int64
	ScheduleWakeCount  uint64
	ScheduleStartCount uint64
	Late1MSCount       uint64
	Late3MSCount       uint64
	Late5MSCount       uint64
	ClockAnomalyCount  uint64
	OverIntervalCount  uint64
	QueueFullSkipCount uint64
	ErrorCount         uint64
}

type writerPerformance struct {
	StartedAt     time.Time
	Busy          time.Duration
	AppendBusy    time.Duration
	MaxQueueDepth int
	AppendUS      []int64
	AppendNext    int
	AppendBatches uint64
	AppendRows    uint64
	FlushUS       []int64
	FlushNext     int
	FlushCount    uint64
	FlushErrors   uint64
	DurableUS     []int64
	DurableNext   int
}

type performanceLogRecord struct {
	Name    string
	Message string
	// Summary owns the detached sample arrays. Only the logger may format them;
	// readers accumulate the next window in a fresh jobPerformance instance.
	Summary *jobPerformance
	Barrier chan struct{}
}

type jobRuntime struct {
	Name          string `json:"name"`
	State         string `json:"state"`
	StateDetail   string `json:"stateDetail,omitempty"`
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

type appenderPrepareRequest struct {
	Context  context.Context
	Database database
	Registry *tagRegistry
	TagCount int
	Result   chan error
	Stats    chan tagPreparationStats
}

type tagPreparationStats struct {
	Required             int
	Candidates           int
	ExistingCandidates   int
	Missing              int
	Registered           int
	MetadataDuration     time.Duration
	RegistrationDuration time.Duration
	Reused               bool
}

type reply struct {
	OK    bool          `json:"ok"`
	Error string        `json:"error,omitempty"`
	State *runtimeState `json:"state,omitempty"`
}

type daemon struct {
	root                   string
	queue                  chan *batch
	queueSlots             chan struct{}
	queueSlotsOnce         sync.Once
	flushNow               chan struct{}
	appenderPrepare        chan appenderPrepareRequest
	tagRegistry            *tagRegistry
	appenderOpener         func(string, database, int) (appenderStream, error)
	writerPolicy           writerPolicy
	performancePolicy      performancePolicy
	performanceCorrections []string
	mu                     sync.Mutex
	jobs                   map[string]*activeJob
	runtime                runtimeState
	closed                 bool
	wg                     sync.WaitGroup
	logMu                  sync.Mutex
	logConfigs             map[string]logConfig
	logPolicy              logPolicy
	logSummaries           map[string]logSummary
	performanceMu          sync.Mutex
	jobPerformance         map[string]*jobPerformance
	writerPerformance      writerPerformance
	performanceLogs        chan performanceLogRecord
	controlMu              sync.Mutex
	controls               map[string]*sync.Mutex
	tagLockMu              sync.Mutex
	tagLocks               map[string]chan struct{}
	activeMu               sync.Mutex
	runtimeDirty           chan struct{}
	runtimeForce           chan chan error
	runtimeStop            chan struct{}
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
	registry     *tagRegistry
	plan         *readPlan
	buffers      *rowBufferPool
}

func buildReadPlan(config jobConfig) (*readPlan, error) {
	plan := &readPlan{calls: make([]callPlan, 0, len(config.MethodCalls))}
	for _, call := range config.MethodCalls {
		count, address, tags, codec, err := lsCall(call)
		if err != nil {
			return nil, err
		}
		if count > int(^uint(0)>>1)-plan.rowCount {
			return nil, errors.New("LS Job row count is too large")
		}
		plan.calls = append(plan.calls, callPlan{count: count, address: address, tags: tags, codec: codec, offset: plan.rowCount})
		plan.rowCount += count
	}
	if plan.rowCount == 0 {
		return nil, errors.New("LS Job has no rows")
	}
	plan.tagIDs = make([]uint32, plan.rowCount)
	for _, call := range plan.calls {
		for index := range call.tags {
			plan.tagIDs[call.offset+index] = call.tags[index].registryIndex
		}
	}
	return plan, nil
}

func newRowBufferPool(plan *readPlan) *rowBufferPool {
	pool := &rowBufferPool{rowCount: plan.rowCount, tagIDs: append([]uint32(nil), plan.tagIDs...), idle: make(chan []row, maximumJobRowBuffers)}
	for index := 0; index < initialJobRowBuffers; index++ {
		pool.idle <- pool.allocate()
	}
	return pool
}

func (p *rowBufferPool) allocate() []row {
	rows := make([]row, p.rowCount)
	for index := range rows {
		rows[index].TagIndex = p.tagIDs[index]
	}
	return rows
}

func (p *rowBufferPool) acquire() *rowBufferLease {
	p.mu.Lock()
	defer p.mu.Unlock()
	var rows []row
	select {
	case rows = <-p.idle:
	default:
		rows = p.allocate()
	}
	p.leased.Add(1)
	return &rowBufferLease{pool: p, rows: rows}
}

func (l *rowBufferLease) release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		p, rows := l.pool, l.rows
		l.rows = nil
		for index := range rows {
			rows[index].Time = time.Time{}
			rows[index].Value = nil
		}
		p.leased.Add(-1)
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.closed.Load() {
			for index := range rows {
				rows[index] = row{}
			}
			return
		}
		select {
		case p.idle <- rows:
		default:
			// The retained cache is full. Clear stable indices as well so this
			// temporary backing array owns no useful Job state before collection.
			for index := range rows {
				rows[index] = row{}
			}
		}
	})
}

func (p *rowBufferPool) dispose() int64 {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed.Store(true)
	for {
		select {
		case rows := <-p.idle:
			for index := range rows {
				rows[index] = row{}
			}
		default:
			return p.leased.Load()
		}
	}
}

func (d *daemon) reserveQueue() *queueReservation {
	if d == nil || d.queue == nil || cap(d.queue) == 0 {
		return nil
	}
	d.queueSlotsOnce.Do(func() { d.queueSlots = make(chan struct{}, cap(d.queue)) })
	select {
	case d.queueSlots <- struct{}{}:
		return &queueReservation{daemon: d}
	default:
		return nil
	}
}

func (r *queueReservation) release() {
	if r == nil || r.daemon == nil {
		return
	}
	r.once.Do(func() {
		select {
		case <-r.daemon.queueSlots:
		default:
		}
	})
}

func (b *batch) releaseRows() {
	if b == nil || b.rowLease == nil {
		return
	}
	b.rowLease.release()
	b.rowLease = nil
	b.Rows = nil
}

func main() {
	root := flag.String("root", "", "cgi-bin directory")
	control := flag.Bool("control", false, "send one control command")
	parentPID := flag.Int("parent-pid", 0, "exit gracefully when this parent process exits (default: disabled)")
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
	if err := runDaemon(*root, *parentPID); err != nil {
		fatal(err)
	}
}

func fatal(err error) { fmt.Fprintln(os.Stderr, "neo-dbus-collector:", err); os.Exit(1) }

func runDaemon(root string, parentPID int) (retErr error) {
	if parentPID < 0 {
		return fmt.Errorf("parent PID must not be negative: %d", parentPID)
	}

	parentContext, cancelParentMonitor := context.WithCancel(context.Background())
	defer cancelParentMonitor()
	var parentMonitor parentwatch.Monitor
	var parentDone chan error
	parentWaited := false
	if parentPID > 0 {
		var err error
		parentMonitor, err = parentwatch.New(parentPID)
		if err != nil {
			return fmt.Errorf("monitor parent process: %w", err)
		}
		parentDone = make(chan error, 1)
		go func() {
			err := parentMonitor.Wait(parentContext)
			parentDone <- err
			if err == nil || !errors.Is(err, context.Canceled) {
				cancelParentMonitor()
			}
		}()
		defer func() {
			cancelParentMonitor()
			if !parentWaited {
				waitErr := <-parentDone
				if retErr == nil && waitErr != nil && !errors.Is(waitErr, context.Canceled) {
					retErr = fmt.Errorf("monitor parent process: %w", waitErr)
				}
			}
			if closeErr := parentMonitor.Close(); retErr == nil && closeErr != nil {
				retErr = fmt.Errorf("close parent process monitor: %w", closeErr)
			}
		}()
	}

	writerPolicy, err := loadWriterPolicy(root)
	if err != nil {
		return err
	}
	performancePolicy, corrections, err := loadPerformancePolicy(root)
	if err != nil {
		return err
	}
	d := &daemon{root: root, queue: make(chan *batch, writerPolicy.QueueCapacity), flushNow: make(chan struct{}, 1), appenderPrepare: make(chan appenderPrepareRequest), tagRegistry: newTagRegistry(), writerPolicy: writerPolicy, performancePolicy: performancePolicy, performanceCorrections: corrections, jobs: map[string]*activeJob{}, runtime: runtimeState{Jobs: map[string]jobRuntime{}}, logConfigs: map[string]logConfig{}, logPolicy: (logPolicy{}).normalized(), logSummaries: map[string]logSummary{}, jobPerformance: map[string]*jobPerformance{}, writerPerformance: newWriterPerformance(time.Now()), performanceLogs: make(chan performanceLogRecord, 64), controls: map[string]*sync.Mutex{}, runtimeDirty: make(chan struct{}, 1), runtimeForce: make(chan chan error), runtimeStop: make(chan struct{})}
	if err := d.writeRuntime(); err != nil {
		return err
	}
	d.wg.Add(1)
	go func() { defer d.wg.Done(); d.runtimeCheckpointWriter() }()
	d.wg.Add(1)
	go func() { defer d.wg.Done(); d.writer() }()
	d.wg.Add(1)
	go func() { defer d.wg.Done(); d.performanceLogger() }()
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
	defer signal.Stop(signals)
	if parentDone == nil {
		<-signals
	} else {
		select {
		case <-signals:
		case parentErr := <-parentDone:
			parentWaited = true
			if parentErr != nil && !errors.Is(parentErr, context.Canceled) {
				retErr = fmt.Errorf("monitor parent process: %w", parentErr)
			} else {
				fmt.Fprintf(os.Stderr, "neo-dbus-collector: parent process %d exited, shutting down\n", parentPID)
			}
		}
	}
	d.shutdown()
	return retErr
}

func (d *daemon) restoreActiveJobs() error {
	names, err := loadActiveJobs(d.root)
	if err != nil {
		return err
	}
	for _, name := range names {
		if err := d.start(name); err != nil {
			// One obsolete/corrupt Job must not prevent the shared service from
			// starting for every other Job. Drop it from the active checkpoint;
			// the canonical file remains available for operator diagnosis.
			_ = d.setActive(name, false)
			fmt.Fprintf(os.Stderr, "neo-dbus-collector: skipped active Job %s: %v\n", name, err)
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
	control := d.controlFor(cmd.Name)
	control.Lock()
	defer control.Unlock()
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

func (d *daemon) controlFor(name string) *sync.Mutex {
	d.controlMu.Lock()
	defer d.controlMu.Unlock()
	control := d.controls[name]
	if control == nil {
		control = &sync.Mutex{}
		d.controls[name] = control
	}
	return control
}

func (d *daemon) start(name string) error {
	config, err := loadJob(d.root, name)
	if err != nil {
		return err
	}
	if config.Schedule.IntervalMS < 1 {
		return errors.New("intervalMs must be at least 1")
	}
	registry := d.tagRegistry
	if registry == nil {
		registry = newTagRegistry()
		d.tagRegistry = registry
	}
	if err := registry.bindJob(&config); err != nil {
		return err
	}
	plan, err := buildReadPlan(config)
	if err != nil {
		return err
	}
	d.mu.Lock()
	if _, exists := d.jobs[name]; exists {
		d.mu.Unlock()
		return nil
	}
	if d.closed {
		d.mu.Unlock()
		return errors.New("collector is shutting down")
	}
	d.mu.Unlock()
	// Persist the desired-active state before publishing STARTING. If Neo or the
	// collector exits during the asynchronous preparation, restoreActiveJobs()
	// will safely repeat the idempotent TAG check on the next daemon start.
	if err := d.setActive(name, true); err != nil {
		return err
	}
	d.mu.Lock()
	if _, exists := d.jobs[name]; exists {
		d.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &activeJob{cancel: cancel, done: make(chan struct{}), config: config, registry: registry, plan: plan, buffers: newRowBufferPool(plan)}
	d.jobs[name] = a
	d.logConfigs[name] = config.Log
	if policy, policyErr := loadLogPolicy(d.root); policyErr == nil {
		d.logPolicy = policy
	}
	d.logSummaries[name] = logSummary{StartedAt: time.Now()}
	d.performanceMu.Lock()
	d.jobPerformance[name] = newJobPerformance(d.performancePolicy.JobSampleCount, sourceForConfig(config))
	d.performanceMu.Unlock()
	// A logical Job start begins a new monitoring period. The checkpoint is
	// intentionally in-memory runtime state, so do not carry a previous
	// stop/start cycle's skip count or timestamps into this one.
	d.updateLocked(name, func(v *jobRuntime) {
		lastReadAt, lastStoredAt := v.LastReadAt, v.LastStoredAt
		*v = newJobRuntime(name, "starting", "Preparing tags…")
		// STARTING is preparation, not a new collection result. Keep the
		// previous completed timestamps visible until the first new cycle.
		v.LastReadAt = lastReadAt
		v.LastStoredAt = lastStoredAt
	})
	d.mu.Unlock()
	if err := d.forceRuntimeCheckpoint(); err != nil {
		_ = d.setActive(name, false)
		d.mu.Lock()
		delete(d.jobs, name)
		d.mu.Unlock()
		cancel()
		a.buffers.dispose()
		return err
	}
	d.wg.Add(1)
	go d.startJob(ctx, name, a)
	return nil
}

func (d *daemon) startJob(ctx context.Context, name string, active *activeJob) {
	defer d.wg.Done()
	defer close(active.done)
	defer func() {
		if outstanding := active.buffers.dispose(); outstanding != 0 {
			d.logAlways(name, "ERROR", "collector", fmt.Sprintf("row buffer ownership leak detected at Job stop: outstanding=%d", outstanding))
		}
	}()
	requiredTags := active.registry.count()
	d.logAlways(name, "INFO", "collector", fmt.Sprintf("TAG preparation started; table=%s requiredTags=%d", active.config.Database.Table, requiredTags))
	prepareStarted := time.Now()
	prepareStats, err := d.ensureAppenderReadyMeasured(ctx, active.config.Database, active.registry)
	prepareElapsed := time.Since(prepareStarted)
	if err != nil {
		if ctx.Err() == nil {
			d.logAlways(name, "ERROR", "collector", formatTagPreparationLog("TAG preparation failed", active.config.Database.Table, prepareElapsed, prepareStats)+" error="+err.Error())
			d.failStart(name, active, fmt.Errorf("prepare native appender: %w", err))
		}
		return
	}
	prepareLevel := "INFO"
	if prepareElapsed >= 10*time.Second {
		prepareLevel = "WARN"
	}
	d.logAlways(name, prepareLevel, "collector", formatTagPreparationLog("TAG preparation completed", active.config.Database.Table, prepareElapsed, prepareStats))
	if ctx.Err() != nil {
		return
	}
	d.mu.Lock()
	if d.jobs[name] != active || ctx.Err() != nil {
		d.mu.Unlock()
		return
	}
	d.updateLocked(name, func(v *jobRuntime) {
		v.State = "running"
		v.StateDetail = ""
	})
	d.mu.Unlock()
	if err := d.forceRuntimeCheckpoint(); err != nil {
		d.failStart(name, active, fmt.Errorf("publish running state: %w", err))
		return
	}
	d.log(name, "INFO", "collector", "collector started; source="+sourceForConfig(active.config))
	if d.performancePolicy.Enabled {
		message := fmt.Sprintf("performance logging enabled; jobSampleCount=%d writerSummaryIntervalMs=%d writerFlushIntervalMs=%d", d.performancePolicy.JobSampleCount, d.performancePolicy.WriterSummaryIntervalMS, d.writerPolicy.normalized().FlushIntervalMS)
		if len(d.performanceCorrections) > 0 {
			message += " corrections=" + strings.Join(d.performanceCorrections, ",")
		}
		d.logAlways(name, "INFO", "performance", message)
	}
	d.reader(ctx, active.config, name, active)
}

func (d *daemon) failStart(name string, active *activeJob, startErr error) {
	_ = d.setActive(name, false)
	d.mu.Lock()
	if d.jobs[name] == active {
		delete(d.jobs, name)
		d.updateLocked(name, func(v *jobRuntime) {
			v.State = "failed"
			v.StateDetail = startErr.Error()
		})
	}
	d.mu.Unlock()
	d.performanceMu.Lock()
	delete(d.jobPerformance, name)
	d.performanceMu.Unlock()
	_ = d.forceRuntimeCheckpoint()
	d.logAlways(name, "ERROR", "collector", "collector start failed: "+startErr.Error())
}

func configuredTagNames(config jobConfig) []string {
	seen := make(map[string]struct{})
	names := make([]string, 0)
	for _, call := range config.MethodCalls {
		selections := call.OutputSelections
		if len(selections) == 0 && len(call.Tags) > 0 {
			selections = []selection{{Tags: call.Tags}}
		}
		for _, output := range selections {
			for _, tag := range output.Tags {
				if _, exists := seen[tag.Name]; exists {
					continue
				}
				seen[tag.Name] = struct{}{}
				names = append(names, tag.Name)
			}
		}
	}
	return names
}

func newTagRegistry() *tagRegistry {
	return &tagRegistry{indices: make(map[string]uint32)}
}

func (r *tagRegistry) bindJob(config *jobConfig) error {
	if r == nil || config == nil {
		return errors.New("TAG registry is unavailable")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.indices == nil {
		r.indices = make(map[string]uint32)
	}
	bind := func(tags []tag) error {
		for index := range tags {
			name := strings.TrimSpace(tags[index].Name)
			if name == "" {
				return errors.New("TAG name is empty")
			}
			id, exists := r.indices[name]
			if !exists {
				if len(r.names) >= int(^uint32(0)) {
					return errors.New("TAG registry is full")
				}
				id = uint32(len(r.names))
				r.indices[name] = id
				r.names = append(r.names, name)
			}
			tags[index].registryIndex = id
		}
		return nil
	}
	for callIndex := range config.MethodCalls {
		call := &config.MethodCalls[callIndex]
		if len(call.OutputSelections) == 0 {
			if err := bind(call.Tags); err != nil {
				return err
			}
			continue
		}
		for selectionIndex := range call.OutputSelections {
			if err := bind(call.OutputSelections[selectionIndex].Tags); err != nil {
				return err
			}
		}
	}
	return nil
}

func (r *tagRegistry) snapshot() []string {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return append([]string(nil), r.names...)
}

func (r *tagRegistry) count() int {
	if r == nil {
		return 0
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.names)
}

func (r *tagRegistry) name(index uint32) (string, bool) {
	if r == nil {
		return "", false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if uint64(index) >= uint64(len(r.names)) {
		return "", false
	}
	return r.names[index], true
}

func (d *daemon) ensureAppenderReady(ctx context.Context, database database, registry *tagRegistry) error {
	_, err := d.ensureAppenderReadyMeasured(ctx, database, registry)
	return err
}

func (d *daemon) ensureAppenderReadyMeasured(ctx context.Context, database database, registry *tagRegistry) (tagPreparationStats, error) {
	if d.appenderPrepare == nil {
		return tagPreparationStats{}, errors.New("writer appender preparation is unavailable")
	}
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return tagPreparationStats{}, errors.New("collector is shutting down")
	}
	result := make(chan error, 1)
	stats := make(chan tagPreparationStats, 1)
	request := appenderPrepareRequest{Context: ctx, Database: database, Registry: registry, TagCount: registry.count(), Result: result, Stats: stats}
	select {
	case d.appenderPrepare <- request:
	case <-ctx.Done():
		return tagPreparationStats{}, ctx.Err()
	case <-d.runtimeStop:
		return tagPreparationStats{}, errors.New("collector is shutting down")
	}
	select {
	case err := <-result:
		return <-stats, err
	case <-ctx.Done():
		return tagPreparationStats{}, ctx.Err()
	case <-d.runtimeStop:
		return tagPreparationStats{}, errors.New("collector is shutting down")
	}
}

func formatTagPreparationLog(prefix string, table string, elapsed time.Duration, stats tagPreparationStats) string {
	return fmt.Sprintf("%s; table=%s requiredTags=%d candidates=%d existing=%d missing=%d registered=%d reused=%t metadataUs=%d registrationUs=%d totalUs=%d",
		prefix, table, stats.Required, stats.Candidates, stats.ExistingCandidates, stats.Missing, stats.Registered, stats.Reused,
		stats.MetadataDuration.Microseconds(), stats.RegistrationDuration.Microseconds(), elapsed.Microseconds())
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
	if _, exists := d.runtime.Jobs[name]; !exists {
		d.mu.Unlock()
		return errors.New("job runtime is not available")
	}
	d.updateLocked(name, func(v *jobRuntime) {
		v.OverrunCount = 0
		v.LastOverrunAt = ""
		v.QueueSkipped = 0
	})
	d.mu.Unlock()
	return d.forceRuntimeCheckpoint()
}

func (d *daemon) stop(name string) error {
	if err := d.setActive(name, false); err != nil {
		return err
	}
	d.mu.Lock()
	a := d.jobs[name]
	if a == nil {
		d.mu.Unlock()
		return nil
	}
	d.updateLocked(name, func(v *jobRuntime) {
		v.State = "stopping"
		v.StateDetail = ""
	})
	a.flushOnQueue.Store(true)
	a.cancel()
	d.mu.Unlock()
	d.requestFlush()
	<-a.done
	d.flushPerformanceLogs()
	d.mu.Lock()
	delete(d.jobs, name)
	d.updateLocked(name, func(v *jobRuntime) {
		v.State = "stopped"
		v.StateDetail = ""
	})
	d.mu.Unlock()
	d.performanceMu.Lock()
	delete(d.jobPerformance, name)
	d.performanceMu.Unlock()
	if err := d.forceRuntimeCheckpoint(); err != nil {
		return err
	}
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
	d.flushPerformanceLogs()
	for _, name := range names {
		d.flushLogSummary(name, true)
		d.log(name, "INFO", "collector", "collector stopped")
	}
	d.mu.Lock()
	d.jobs = map[string]*activeJob{}
	d.mu.Unlock()
	close(d.queue)
	_ = d.forceRuntimeCheckpoint()
	close(d.runtimeStop)
	if d.performanceLogs != nil {
		close(d.performanceLogs)
	}
	d.wg.Wait()
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
	timerNow := time.Now()
	timerDelay := nextAligned(timerNow, interval)
	scheduledAt := timerNow.Add(timerDelay)
	timer := time.NewTimer(timerDelay)
	defer timer.Stop()
	// Opening the native Appender is not the end of its startup cost. The first
	// real batch can create thousands of TAG metadata records and perform the
	// first durable flush. Keep that first aligned cycle serialized through its
	// Flush before enabling overlapping scheduled reads. This avoids filling the
	// bounded queue during one-time database initialization without inserting a
	// dummy row or shifting the Job away from epoch-aligned boundaries.
	primed := false
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
			wakeAt := time.Now()
			d.recordScheduleWake(name, scheduledAt, wakeAt)
			if !primed {
				d.recordScheduleStart(name, scheduledAt, wakeAt, wakeAt)
				if !config.Execution.Test && connection == nil {
					var connectError error
					connection, connectError = d.connectDBus(name)
					if connectError != nil {
						if ctx.Err() == nil {
							d.recordJobPerformance(name, readTiming{}, connectError)
						}
						timerNow = time.Now()
						timerDelay = nextAligned(timerNow, interval)
						scheduledAt = timerNow.Add(timerDelay)
						timer.Reset(timerDelay)
						continue
					}
				}
				primed = d.readOnce(ctx, config, name, connection, active, true)
			} else if !busy.CompareAndSwap(false, true) {
				d.recordOverrun(name, false)
			} else {
				active.work.Add(1)
				go func(expectedAt, timerWokeAt time.Time) {
					defer active.work.Done()
					defer busy.Store(false)
					d.recordScheduleStart(name, expectedAt, timerWokeAt, time.Now())
					if !config.Execution.Test && connection == nil {
						var connectError error
						connection, connectError = d.connectDBus(name)
						if connectError != nil {
							if ctx.Err() == nil {
								d.recordJobPerformance(name, readTiming{}, connectError)
							}
							return
						}
					}
					d.readOnce(ctx, config, name, connection, active, false)
				}(scheduledAt, wakeAt)
			}
			timerNow = time.Now()
			timerDelay = nextAligned(timerNow, interval)
			scheduledAt = timerNow.Add(timerDelay)
			timer.Reset(timerDelay)
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

func (d *daemon) readOnce(ctx context.Context, config jobConfig, name string, connection *dbus.Conn, active *activeJob, awaitDurable bool) bool {
	if ctx.Err() != nil {
		return false
	}
	reservation := d.reserveQueue()
	if reservation == nil {
		if ctx.Err() == nil {
			d.recordOverrun(name, true)
		}
		return false
	}
	if active.plan == nil {
		plan, err := buildReadPlan(config)
		if err != nil {
			reservation.release()
			d.recordError(name, err)
			return false
		}
		active.plan = plan
	}
	if active.buffers == nil {
		active.buffers = newRowBufferPool(active.plan)
	}
	lease := active.buffers.acquire()
	rows := lease.rows
	readerStarted := time.Now()
	var timing readTiming
	var err error
	if config.Execution.Test {
		timing, err = generateTestRowsInto(active.plan, rows)
	} else {
		timing, err = readDBusInto(ctx, active.plan, connection, rows)
	}
	if err != nil {
		lease.release()
		reservation.release()
		if ctx.Err() != nil {
			return false
		}
		timing.ReaderTotal = time.Since(readerStarted)
		timing.ReaderTotalMeasured = true
		d.recordJobPerformance(name, timing, err)
		d.recordError(name, err)
		return false
	}
	if ctx.Err() != nil {
		lease.release()
		reservation.release()
		return false
	}
	d.mu.Lock()
	// A queued read is not yet a durable database write. Do not clear a
	// previous writer error here; only a successful Flush may do that.
	d.updateLocked(name, func(v *jobRuntime) { v.LastReadAt = time.Now().UTC().Format(time.RFC3339Nano) })
	d.mu.Unlock()
	b := &batch{Job: name, Database: config.Database, Registry: active.registry, Rows: rows, RowCount: len(rows), rowLease: lease, queueReservation: reservation, Owner: active, EnqueuedAt: time.Now(), FlushAfterAppend: awaitDurable}
	if awaitDurable {
		b.Finished = make(chan error, 1)
	}
	// The reader has completed its responsibility after a bounded queue accepts
	// the typed batch. Keep a separate drain reference so Job stop waits for
	// durable completion without making the scheduler wait for writer Flush.
	active.work.Add(1)
	select {
	case d.queue <- b:
		if ctx.Err() == nil {
			timing.ReaderTotal = time.Since(readerStarted)
			timing.ReaderTotalMeasured = true
			d.recordJobPerformance(name, timing, nil)
		}
		d.recordQueueDepth(len(d.queue))
		if awaitDurable {
			writeErr := <-b.Finished
			active.work.Done()
			if writeErr != nil {
				d.recordError(name, writeErr)
				return false
			}
			d.recordSuccess(name, b.RowCount)
			return true
		}
		if active.flushOnQueue.Load() {
			d.requestFlush()
		}
		// Non-priming batches are completed by the single writer. Do not create
		// one flush-waiting goroutine per cycle: at a 10ms interval and a 1s
		// flush period that would retain about 100 goroutines per active Job.
	case <-ctx.Done():
		b.releaseRows()
		reservation.release()
		active.work.Done()
		return false
	default:
		b.releaseRows()
		reservation.release()
		if ctx.Err() == nil {
			timing.ReaderTotal = time.Since(readerStarted)
			timing.ReaderTotalMeasured = true
			d.recordOverrun(name, true)
			d.recordJobPerformance(name, timing, nil)
		}
		active.work.Done()
		return false
	}
	return true
}

func percentileUS(values []int64, percentile float64) int64 {
	if len(values) == 0 {
		return 0
	}
	ordered := append([]int64(nil), values...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i] < ordered[j] })
	index := int(math.Ceil(percentile*float64(len(ordered)))) - 1
	if index < 0 {
		index = 0
	}
	if index >= len(ordered) {
		index = len(ordered) - 1
	}
	return ordered[index]
}

func durationSummaryUS(values []int64) (minimum, p50, average, p99, maximum int64) {
	if len(values) == 0 {
		return 0, 0, 0, 0, 0
	}
	minimum, maximum = values[0], values[0]
	var total int64
	for _, value := range values {
		total += value
		if value < minimum {
			minimum = value
		}
		if value > maximum {
			maximum = value
		}
	}
	return minimum, percentileUS(values, 0.50), total / int64(len(values)), percentileUS(values, 0.99), maximum
}

func sourceForConfig(config jobConfig) string {
	if config.Execution.Test {
		return "test"
	}
	return "dbus"
}

func newJobPerformance(sampleCount int, source string) *jobPerformance {
	return &jobPerformance{
		Source:           source,
		DBusUS:           make([]int64, 0, sampleCount),
		ReaderTotalUS:    make([]int64, 0, sampleCount),
		TimerWakeLagUS:   make([]int64, 0, sampleCount),
		DispatchLagUS:    make([]int64, 0, sampleCount),
		ReaderStartLagUS: make([]int64, 0, sampleCount),
	}
}

func nonNegativeMicroseconds(value time.Duration) int64 {
	if value <= 0 {
		return 0
	}
	return value.Microseconds()
}

func (d *daemon) recordScheduleWake(name string, scheduledAt, wakeAt time.Time) {
	if !d.performancePolicy.Enabled {
		return
	}
	d.performanceMu.Lock()
	stats := d.jobPerformance[name]
	if stats == nil {
		stats = newJobPerformance(d.performancePolicy.JobSampleCount, "dbus")
		d.jobPerformance[name] = stats
	}
	lag := wakeAt.Sub(scheduledAt)
	if lag < 0 {
		stats.ClockAnomalyCount++
	}
	wakeUS := nonNegativeMicroseconds(lag)
	if len(stats.TimerWakeLagUS) < maxDurableSamples {
		stats.TimerWakeLagUS = append(stats.TimerWakeLagUS, wakeUS)
	} else {
		stats.TimerWakeLagUS[stats.TimerWakeNext] = wakeUS
		stats.TimerWakeNext = (stats.TimerWakeNext + 1) % maxDurableSamples
	}
	stats.ScheduleWakeCount++
	d.performanceMu.Unlock()
}

func (d *daemon) recordScheduleStart(name string, scheduledAt, wakeAt, startedAt time.Time) {
	if !d.performancePolicy.Enabled {
		return
	}
	d.performanceMu.Lock()
	stats := d.jobPerformance[name]
	if stats == nil {
		stats = newJobPerformance(d.performancePolicy.JobSampleCount, "dbus")
		d.jobPerformance[name] = stats
	}
	dispatchLag := startedAt.Sub(wakeAt)
	startLag := startedAt.Sub(scheduledAt)
	stats.DispatchLagUS = append(stats.DispatchLagUS, nonNegativeMicroseconds(dispatchLag))
	stats.ReaderStartLagUS = append(stats.ReaderStartLagUS, nonNegativeMicroseconds(startLag))
	stats.ScheduleStartCount++
	if startLag >= time.Millisecond {
		stats.Late1MSCount++
	}
	if startLag >= 3*time.Millisecond {
		stats.Late3MSCount++
	}
	if startLag >= 5*time.Millisecond {
		stats.Late5MSCount++
	}
	d.performanceMu.Unlock()
}

// Performance summaries are calculated, formatted and written by this worker.
// Readers only accumulate samples and hand off a detached window: neither
// percentile sorting nor filesystem I/O belongs to the reader's busy section.
// The bounded, lossless queue can still apply backpressure if logging stalls;
// do not interpret this change as eliminating every unmeasured busy-path delay.
func (d *daemon) performanceLogger() {
	for record := range d.performanceLogs {
		if record.Barrier != nil {
			close(record.Barrier)
			continue
		}
		d.writePerformanceRecord(record)
	}
}

func (d *daemon) writePerformanceRecord(record performanceLogRecord) {
	message := record.Message
	if record.Summary != nil {
		message = formatJobPerformance(record.Name, record.Summary)
	}
	d.logAlways(record.Name, "INFO", "performance", message)
}

func (d *daemon) enqueuePerformanceLog(name string, snapshot *jobPerformance) {
	record := performanceLogRecord{Name: name, Summary: snapshot}
	if d.performanceLogs == nil {
		// Unit tests and small embedded daemon fixtures do not start background
		// workers. Keep their observable behavior synchronous.
		d.writePerformanceRecord(record)
		return
	}
	d.performanceLogs <- record
}

func (d *daemon) flushPerformanceLogs() {
	if d.performanceLogs == nil {
		return
	}
	done := make(chan struct{})
	d.performanceLogs <- performanceLogRecord{Barrier: done}
	<-done
}

func (d *daemon) recordJobPerformance(name string, timing readTiming, readErr error) {
	if !d.performancePolicy.Enabled {
		return
	}
	d.performanceMu.Lock()
	stats := d.jobPerformance[name]
	if stats == nil {
		stats = newJobPerformance(d.performancePolicy.JobSampleCount, "dbus")
		d.jobPerformance[name] = stats
	}
	stats.Attempts++
	if timing.DBusMeasured {
		stats.DBusUS = append(stats.DBusUS, timing.DBus.Microseconds())
	}
	if timing.ParseMeasured {
		parseUS := timing.Parse.Microseconds()
		stats.ParseTotalUS += parseUS
		if parseUS > stats.ParseMaxUS {
			stats.ParseMaxUS = parseUS
		}
		stats.ParseSamples++
	}
	if timing.GenerateMeasured {
		generateUS := timing.Generate.Microseconds()
		stats.GenerateTotalUS += generateUS
		if generateUS > stats.GenerateMaxUS {
			stats.GenerateMaxUS = generateUS
		}
		stats.GenerateSamples++
	}
	if timing.ReaderTotalMeasured {
		stats.ReaderTotalUS = append(stats.ReaderTotalUS, timing.ReaderTotal.Microseconds())
	}
	if readErr != nil {
		stats.ErrorCount++
	}
	if stats.Attempts < d.performancePolicy.JobSampleCount {
		d.performanceMu.Unlock()
		return
	}
	// Transfer ownership instead of copying/sorting the samples here. All sample
	// mutations take performanceMu and use the map's replacement window, so the
	// detached snapshot remains immutable until the logger consumes it.
	snapshot := stats
	d.jobPerformance[name] = newJobPerformance(d.performancePolicy.JobSampleCount, snapshot.Source)
	d.performanceMu.Unlock()
	d.enqueuePerformanceLog(name, snapshot)
}

func formatJobPerformance(name string, snapshot *jobPerformance) string {
	_, _, average, p99, maximum := durationSummaryUS(snapshot.DBusUS)
	parseAverage := int64(0)
	if snapshot.ParseSamples > 0 {
		parseAverage = snapshot.ParseTotalUS / int64(snapshot.ParseSamples)
	}
	_, _, _, readerTotalP99, readerTotalMax := durationSummaryUS(snapshot.ReaderTotalUS)
	_, timerWakeP50, _, timerWakeP99, timerWakeMax := durationSummaryUS(snapshot.TimerWakeLagUS)
	_, _, _, dispatchP99, dispatchMax := durationSummaryUS(snapshot.DispatchLagUS)
	_, _, _, readerStartP99, readerStartMax := durationSummaryUS(snapshot.ReaderStartLagUS)
	return fmt.Sprintf(
		"job=%s job summary; source=%s samples=%d dbusUs[avg=%d p99=%d max=%d] parseUs[avg=%d max=%d] readerTotalUs[p99=%d max=%d] scheduleSamples[wake=%d start=%d] scheduleLagUs[timerWakeP50=%d timerWakeP99=%d timerWakeMax=%d dispatchP99=%d dispatchMax=%d readerStartP99=%d readerStartMax=%d] lateCount[1ms=%d 3ms=%d 5ms=%d] clockAnomalyCount=%d skipCount=%d overIntervalCount=%d queueFullSkipCount=%d errorCount=%d",
		name, snapshot.Source, snapshot.Attempts, average, p99, maximum, parseAverage, snapshot.ParseMaxUS, readerTotalP99, readerTotalMax,
		snapshot.ScheduleWakeCount, snapshot.ScheduleStartCount, timerWakeP50, timerWakeP99, timerWakeMax, dispatchP99, dispatchMax, readerStartP99, readerStartMax,
		snapshot.Late1MSCount, snapshot.Late3MSCount, snapshot.Late5MSCount, snapshot.ClockAnomalyCount,
		snapshot.OverIntervalCount+snapshot.QueueFullSkipCount, snapshot.OverIntervalCount, snapshot.QueueFullSkipCount, snapshot.ErrorCount,
	)
}

func (d *daemon) recordPerformanceSkip(name string, queueFull bool) {
	if !d.performancePolicy.Enabled {
		return
	}
	d.performanceMu.Lock()
	stats := d.jobPerformance[name]
	if stats == nil {
		stats = newJobPerformance(d.performancePolicy.JobSampleCount, "dbus")
		d.jobPerformance[name] = stats
	}
	if queueFull {
		stats.QueueFullSkipCount++
	} else {
		stats.OverIntervalCount++
	}
	d.performanceMu.Unlock()
}

func (d *daemon) recordQueueDepth(depth int) {
	if !d.performancePolicy.Enabled {
		return
	}
	d.performanceMu.Lock()
	if depth > d.writerPerformance.MaxQueueDepth {
		d.writerPerformance.MaxQueueDepth = depth
	}
	d.performanceMu.Unlock()
}

func (d *daemon) recordWriterFlush(duration time.Duration, flushErr error) {
	if !d.performancePolicy.Enabled {
		return
	}
	d.performanceMu.Lock()
	stats := &d.writerPerformance
	stats.Busy += duration
	stats.FlushCount++
	if flushErr != nil {
		stats.FlushErrors++
	}
	value := duration.Microseconds()
	if len(stats.FlushUS) < maxDurableSamples {
		stats.FlushUS = append(stats.FlushUS, value)
	} else {
		stats.FlushUS[stats.FlushNext] = value
		stats.FlushNext = (stats.FlushNext + 1) % maxDurableSamples
	}
	d.performanceMu.Unlock()
}

func newWriterPerformance(startedAt time.Time) writerPerformance {
	return writerPerformance{
		StartedAt: startedAt,
		AppendUS:  make([]int64, 0, maxDurableSamples),
		FlushUS:   make([]int64, 0, maxDurableSamples),
		DurableUS: make([]int64, 0, maxDurableSamples),
	}
}

func (d *daemon) recordWriterAppend(duration time.Duration, rows int) {
	if !d.performancePolicy.Enabled {
		return
	}
	d.performanceMu.Lock()
	stats := &d.writerPerformance
	stats.Busy += duration
	stats.AppendBusy += duration
	stats.AppendBatches++
	if rows > 0 {
		stats.AppendRows += uint64(rows)
	}
	value := duration.Microseconds()
	if len(stats.AppendUS) < maxDurableSamples {
		stats.AppendUS = append(stats.AppendUS, value)
	} else {
		stats.AppendUS[stats.AppendNext] = value
		stats.AppendNext = (stats.AppendNext + 1) % maxDurableSamples
	}
	d.performanceMu.Unlock()
}

func (d *daemon) recordDurable(batch *batch, completedAt time.Time) {
	if !d.performancePolicy.Enabled || batch == nil || batch.EnqueuedAt.IsZero() {
		return
	}
	value := completedAt.Sub(batch.EnqueuedAt).Microseconds()
	d.performanceMu.Lock()
	stats := &d.writerPerformance
	if len(stats.DurableUS) < maxDurableSamples {
		stats.DurableUS = append(stats.DurableUS, value)
	} else {
		stats.DurableUS[stats.DurableNext] = value
		stats.DurableNext = (stats.DurableNext + 1) % maxDurableSamples
	}
	d.performanceMu.Unlock()
}

func (d *daemon) flushWriterPerformance(force bool) {
	if !d.performancePolicy.Enabled {
		return
	}
	now := time.Now()
	d.performanceMu.Lock()
	stats := d.writerPerformance
	duration := now.Sub(stats.StartedAt)
	if !force && duration < time.Duration(d.performancePolicy.WriterSummaryIntervalMS)*time.Millisecond {
		d.performanceMu.Unlock()
		return
	}
	d.writerPerformance = newWriterPerformance(now)
	d.performanceMu.Unlock()
	if duration <= 0 {
		return
	}
	busyRatio := float64(stats.Busy) * 100 / float64(duration)
	_, _, _, durableP99, durableMax := durationSummaryUS(stats.DurableUS)
	_, _, appendAvg, appendP99, appendMax := durationSummaryUS(stats.AppendUS)
	_, _, _, _, flushMax := durationSummaryUS(stats.FlushUS)
	appendRowsPerSecond := float64(0)
	if stats.AppendBusy > 0 {
		appendRowsPerSecond = float64(stats.AppendRows) / stats.AppendBusy.Seconds()
	}
	message := fmt.Sprintf(
		"scope=shared writer summary; duration=%s maxQueueDepth=%d queueCapacity=%d busyRatio=%.2f%% appendBatches=%d appendRows=%d appendRowsPerSec=%.0f appendUs[avg=%d p99=%d max=%d] flushIntervalMs=%d flushCount=%d flushErrorCount=%d flushMaxUs=%d queueToDurableUs[p99=%d max=%d]",
		duration.Round(time.Millisecond), stats.MaxQueueDepth, d.writerPolicy.normalized().QueueCapacity, busyRatio,
		stats.AppendBatches, stats.AppendRows, appendRowsPerSecond, appendAvg, appendP99, appendMax,
		d.writerPolicy.normalized().FlushIntervalMS, stats.FlushCount, stats.FlushErrors, flushMax, durableP99, durableMax,
	)
	d.mu.Lock()
	names := make([]string, 0, len(d.jobs))
	for name := range d.jobs {
		names = append(names, name)
	}
	d.mu.Unlock()
	sort.Strings(names)
	for _, name := range names {
		d.logAlways(name, "INFO", "performance", message)
	}
}

func (d *daemon) writer() {
	policy := d.writerPolicy.normalized()
	ticker := time.NewTicker(time.Duration(policy.FlushIntervalMS) * time.Millisecond)
	defer ticker.Stop()
	performanceTicker := time.NewTicker(time.Duration(d.performancePolicy.WriterSummaryIntervalMS) * time.Millisecond)
	defer performanceTicker.Stop()
	var active appenderStream
	pending := make([]*batch, 0)
	finish := func(item *batch, writeErr error) {
		if item == nil {
			return
		}
		rowCount := item.RowCount
		if rowCount == 0 {
			rowCount = len(item.Rows)
		}
		item.releaseRows()
		if item.Finished != nil {
			item.Finished <- writeErr
			return
		}
		if item.Owner == nil {
			return
		}
		if writeErr != nil {
			d.recordError(item.Job, writeErr)
		} else {
			d.recordSuccess(item.Job, rowCount)
		}
		item.Owner.work.Done()
	}
	complete := func(writeErr error) {
		completedAt := time.Now()
		for _, item := range pending {
			if writeErr == nil {
				d.recordDurable(item, completedAt)
			}
			finish(item, writeErr)
		}
		pending = pending[:0]
	}
	flush := func() error {
		if len(pending) == 0 {
			return nil
		}
		started := time.Now()
		writeErr := active.flush()
		d.recordWriterFlush(time.Since(started), writeErr)
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
	prepare := func(configDB database) error {
		if active != nil && !active.same(configDB) {
			if acceptsForcedFlush(active) {
				_ = flush()
			}
			if active != nil {
				closeErr := active.close()
				active = nil
				complete(closeErr)
				if closeErr != nil {
					return closeErr
				}
			}
		}
		if active != nil {
			return nil
		}
		opener := d.appenderOpener
		if opener == nil {
			opener = func(root string, configDB database, flushMaxRows int) (appenderStream, error) {
				return openAppender(root, configDB, flushMaxRows)
			}
		}
		next, openErr := opener(d.root, configDB, policy.FlushMaxRows)
		if openErr != nil {
			return openErr
		}
		active = next
		return nil
	}
	for {
		select {
		case request := <-d.appenderPrepare:
			prepareErr := prepare(request.Database)
			if prepareErr != nil {
				if request.Stats != nil {
					request.Stats <- tagPreparationStats{Required: request.TagCount}
				}
				request.Result <- prepareErr
				continue
			}
			if request.Registry == nil {
				if request.Stats != nil {
					request.Stats <- tagPreparationStats{Required: request.TagCount}
				}
				request.Result <- errors.New("TAG registry is unavailable")
				continue
			}
			// TAG metadata I/O can take several seconds for thousands of new
			// names. The native stream's immutable registration coordinates are
			// safe to use from this preparation goroutine, while the sole writer
			// immediately resumes append/flush work for already-running Jobs.
			registrar := active
			ctx := request.Context
			if ctx == nil {
				ctx = context.Background()
			}
			configDB, registry, tagCount, result, statsResult := request.Database, request.Registry, request.TagCount, request.Result, request.Stats
			go func() {
				release, lockErr := d.acquireTagRegistration(ctx, configDB)
				if lockErr != nil {
					if statsResult != nil {
						statsResult <- tagPreparationStats{Required: tagCount}
					}
					result <- lockErr
					return
				}
				defer release()
				stats := tagPreparationStats{Required: tagCount}
				var err error
				if measured, ok := registrar.(measuredRegistryPreparer); ok {
					stats, err = measured.prepareRegistryMeasured(ctx, registry, tagCount)
				} else {
					err = registrar.prepareRegistry(ctx, registry, tagCount)
				}
				if statsResult != nil {
					statsResult <- stats
				}
				result <- err
			}()
		case b, open := <-d.queue:
			if !open {
				if acceptsForcedFlush(active) {
					_ = flush()
				}
				if active != nil {
					closeErr := active.close()
					active = nil
					complete(closeErr)
				}
				return
			}
			b.queueReservation.release()
			b.queueReservation = nil
			if prepareErr := prepare(b.Database); prepareErr != nil {
				finish(b, prepareErr)
				continue
			}
			if registryErr := active.prepareRegistry(context.Background(), b.Registry, requiredTagCount(b.Rows)); registryErr != nil {
				_ = active.close()
				active = nil
				complete(registryErr)
				finish(b, registryErr)
				continue
			}
			started := time.Now()
			appendErr := active.append(b.Rows, b.Registry)
			rowCount := b.RowCount
			if rowCount == 0 {
				rowCount = len(b.Rows)
			}
			d.recordWriterAppend(time.Since(started), rowCount)
			if appendErr != nil {
				_ = active.close()
				active = nil
				complete(appendErr)
				finish(b, appendErr)
				continue
			}
			// Native append consumes the complete Go slice synchronously. Flush
			// durability needs only batch metadata, so return the large row buffer
			// before waiting for the periodic Flush.
			b.releaseRows()
			pending = append(pending, b)
			if b.FlushAfterAppend && acceptsForcedFlush(active) {
				_ = flush()
			}
		case <-ticker.C:
			_ = flush()
		case <-d.flushNow:
			if acceptsForcedFlush(active) {
				_ = flush()
			}
		case <-performanceTicker.C:
			// The ticker already owns the interval. A second wall-clock guard can
			// observe a duration a few microseconds short of the configured value
			// and accidentally defer this summary until the next tick.
			d.flushWriterPerformance(true)
		}
	}
}

func (d *daemon) requestFlush() {
	select {
	case d.flushNow <- struct{}{}:
	default:
	}
}

func readDBus(ctx context.Context, config jobConfig, connection *dbus.Conn) ([]row, readTiming, error) {
	plan, err := buildReadPlan(config)
	if err != nil {
		return nil, readTiming{}, err
	}
	rows := make([]row, plan.rowCount)
	timing, err := readDBusInto(ctx, plan, connection, rows)
	return rows, timing, err
}

func readDBusInto(ctx context.Context, plan *readPlan, connection *dbus.Conn, rows []row) (readTiming, error) {
	timing := readTiming{}
	if plan == nil || len(rows) != plan.rowCount {
		return timing, errors.New("LS read buffer does not match the prepared Job layout")
	}
	for _, call := range plan.calls {
		object := connection.Object("ls.plc", dbus.ObjectPath("/ls/plc/device"))
		dbusStarted := time.Now()
		result := object.CallWithContext(ctx, "ls.plc.device.GetDeviceData", 0, uint16(call.count), call.address)
		timing.DBus += time.Since(dbusStarted)
		timing.DBusMeasured = true
		if result.Err != nil {
			return timing, fmt.Errorf("DBus GetDeviceData: %w", result.Err)
		}
		if len(result.Body) != 1 {
			return timing, errors.New("DBus GetDeviceData returned unexpected body")
		}
		body, ok := result.Body[0].(string)
		if !ok {
			return timing, errors.New("DBus GetDeviceData result is not a string")
		}
		parseStarted := time.Now()
		segment := rows[call.offset : call.offset+call.count]
		err := decodeLSDeviceRowsInto(body, call.count, call.tags, call.codec, segment)
		timing.Parse += time.Since(parseStarted)
		timing.ParseMeasured = true
		if err != nil {
			return timing, err
		}
	}
	return timing, nil
}

// generateTestRows is the internal non-PLC benchmark source. It deliberately
// skips both DBus and DBus JSON parsing, then enters the exact same conversion,
// transform, bounded-queue, native append, and flush path as production data.
// The dedicated table check is repeated by JSH and loadJob; this function is
// never selected from UI visibility alone.
func generateTestRows(config jobConfig) ([]row, readTiming, error) {
	plan, err := buildReadPlan(config)
	if err != nil {
		return nil, readTiming{}, err
	}
	rows := make([]row, plan.rowCount)
	timing, err := generateTestRowsInto(plan, rows)
	return rows, timing, err
}

func generateTestRowsInto(plan *readPlan, rows []row) (readTiming, error) {
	started := time.Now()
	timestamp := time.Now().UTC()
	if plan == nil || len(rows) != plan.rowCount {
		return readTiming{}, errors.New("LS test buffer does not match the prepared Job layout")
	}
	for _, call := range plan.calls {
		for index := 0; index < call.count; index++ {
			tag := call.tags[index]
			raw := syntheticRawValue(index, call.codec, tag.Conversion)
			value, err := decodeLSRawValue(raw, call.codec, tag.Conversion, tag.Signed)
			if err != nil {
				return readTiming{}, fmt.Errorf("TEST value %d: %w", index, err)
			}
			value, err = transform(value, tag)
			if err != nil {
				return readTiming{}, fmt.Errorf("TEST value %d transform: %w", index, err)
			}
			rows[call.offset+index] = row{TagIndex: tag.registryIndex, Time: timestamp, Value: value}
		}
	}
	return readTiming{Generate: time.Since(started), GenerateMeasured: true}, nil
}

func syntheticRawValue(index int, codec lsValueCodec, conversion string) uint64 {
	switch conversion {
	case "DWORD2REAL":
		return uint64(math.Float32bits(float32(index)))
	case "LWORD2LREAL":
		return math.Float64bits(float64(index))
	}
	if codec.bits == 1 {
		return uint64(index & 1)
	}
	if codec.bits < 64 {
		return uint64(index) & ((uint64(1) << codec.bits) - 1)
	}
	return uint64(index)
}

// decodeLSDeviceRows uses the timestamp supplied by the PLC, not the time at
// which the collector receives the DBus reply. LS returns time-stamp-us as a
// Unix epoch value in microseconds; every value in one GetDeviceData reply is
// a snapshot at that same PLC timestamp.
func decodeLSDeviceRows(body string, count int, tags []tag, codec lsValueCodec) ([]row, error) {
	rows := make([]row, count)
	if err := decodeLSDeviceRowsInto(body, count, tags, codec, rows); err != nil {
		return nil, err
	}
	return rows, nil
}

func decodeLSDeviceRowsInto(body string, count int, tags []tag, codec lsValueCodec, rows []row) error {
	var parsed struct {
		Result      int           `json:"rtn"`
		Count       int           `json:"data-count"`
		Data        []json.Number `json:"data"`
		TimestampUS int64         `json:"time-stamp-us"`
	}
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&parsed); err != nil {
		return fmt.Errorf("DBus JSON parse: %w", err)
	}
	if parsed.Result != 1 || parsed.Count != count || len(parsed.Data) != count || len(tags) != count || len(rows) != count {
		return errors.New("DBus GetDeviceData result count mismatch")
	}
	if parsed.TimestampUS <= 0 {
		return errors.New("DBus GetDeviceData result timestamp is missing or invalid")
	}
	timestamp := time.Unix(parsed.TimestampUS/1_000_000, (parsed.TimestampUS%1_000_000)*1_000).UTC()
	for index, encoded := range parsed.Data {
		value, err := decodeLSValue(encoded, codec, tags[index].Conversion, tags[index].Signed)
		if err != nil {
			return fmt.Errorf("DBus GetDeviceData value %d: %w", index, err)
		}
		value, err = transform(value, tags[index])
		if err != nil {
			return fmt.Errorf("DBus GetDeviceData value %d transform: %w", index, err)
		}
		rows[index] = row{TagIndex: tags[index].registryIndex, Time: timestamp, Value: value}
	}
	return nil
}

func decodeLSValue(encoded json.Number, codec lsValueCodec, conversion string, signed bool) (any, error) {
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
	return decodeLSRawValue(raw, codec, conversion, signed)
}

func decodeLSRawValue(raw uint64, codec lsValueCodec, conversion string, signed bool) (any, error) {
	if codec.bits == 0 || codec.bits > 64 {
		return nil, errors.New("invalid LS value codec")
	}
	if codec.bits < 64 && raw > (uint64(1)<<codec.bits)-1 {
		return nil, fmt.Errorf("value %d exceeds %d-bit address type", raw, codec.bits)
	}
	if conversion == "" {
		conversion = map[uint]string{8: "BYTE2INT", 16: "WORD2INT", 32: "DWORD2INT", 64: "LWORD2INT"}[codec.bits]
	}
	switch conversion {
	case "DWORD2REAL":
		if codec.bits != 32 {
			return nil, errors.New("DWORD2REAL requires a 32-bit address type")
		}
		return float64(math.Float32frombits(uint32(raw))), nil
	case "LWORD2LREAL":
		if codec.bits != 64 {
			return nil, errors.New("LWORD2LREAL requires a 64-bit address type")
		}
		return math.Float64frombits(raw), nil
	case "BYTE2INT":
		if codec.bits != 8 {
			return nil, errors.New("BYTE2INT requires an 8-bit address type")
		}
	case "WORD2INT":
		if codec.bits != 16 {
			return nil, errors.New("WORD2INT requires a 16-bit address type")
		}
	case "DWORD2INT":
		if codec.bits != 32 {
			return nil, errors.New("DWORD2INT requires a 32-bit address type")
		}
	case "LWORD2INT":
		if codec.bits != 64 {
			return nil, errors.New("LWORD2INT requires a 64-bit address type")
		}
	case "":
		if codec.bits != 1 {
			return nil, errors.New("LS integer conversion is missing")
		}
	default:
		return nil, fmt.Errorf("unsupported LS value conversion %q", conversion)
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
	database      database
	appender      *client.Appender
	dsn           string
	primary       string
	columnValues  []any
	primaryIndex  int
	basetimeIndex int
	valueIndex    int
	valueType     api.ColumnType
	registryMu    sync.Mutex
	registry      atomic.Pointer[tagRegistry]
	preparedTags  atomic.Int64
}

type appenderStream interface {
	same(database) bool
	close() error
	flush() error
	append([]row, *tagRegistry) error
	prepareRegistry(context.Context, *tagRegistry, int) error
}

type measuredRegistryPreparer interface {
	prepareRegistryMeasured(context.Context, *tagRegistry, int) (tagPreparationStats, error)
}

type periodicFlushOnlyAppender interface {
	periodicFlushOnly()
}

func acceptsForcedFlush(stream appenderStream) bool {
	if stream == nil {
		return false
	}
	_, periodicOnly := stream.(periodicFlushOnlyAppender)
	return !periodicOnly
}

func (a *nativeAppender) same(database database) bool { return a.database == database }
func (a *nativeAppender) close() error                { _, _, err := a.appender.Close(); return err }
func (a *nativeAppender) flush() error                { return a.appender.Flush() }
func (a *nativeAppender) prepareRegistry(ctx context.Context, registry *tagRegistry, required int) error {
	_, err := a.prepareRegistryMeasured(ctx, registry, required)
	return err
}

func (a *nativeAppender) prepareRegistryMeasured(ctx context.Context, registry *tagRegistry, required int) (tagPreparationStats, error) {
	stats := tagPreparationStats{Required: required}
	if registry == nil {
		return stats, errors.New("TAG registry is unavailable")
	}
	if required < 0 || required > registry.count() {
		return stats, errors.New("invalid required TAG count")
	}
	if a.registry.Load() == registry && int64(required) <= a.preparedTags.Load() {
		stats.Reused = true
		return stats, nil
	}
	a.registryMu.Lock()
	defer a.registryMu.Unlock()
	preparedRegistry := a.registry.Load()
	if preparedRegistry != nil && preparedRegistry != registry {
		return stats, errors.New("native appender received a different TAG registry")
	}
	names := registry.snapshot()
	names = names[:required]
	prepared := int(a.preparedTags.Load())
	if len(names) <= prepared {
		stats.Reused = true
		return stats, nil
	}
	registrationStats, err := registerTagsSQLMeasured(ctx, a.dsn, a.database, a.primary, names[prepared:])
	registrationStats.Required = required
	if err != nil {
		return registrationStats, err
	}
	a.registry.Store(registry)
	a.preparedTags.Store(int64(len(names)))
	return registrationStats, nil
}

func registerTagsSQL(ctx context.Context, dsn string, config database, primary string, tags []string) error {
	_, err := registerTagsSQLMeasured(ctx, dsn, config, primary, tags)
	return err
}

func registerTagsSQLMeasured(ctx context.Context, dsn string, config database, primary string, tags []string) (tagPreparationStats, error) {
	stats := tagPreparationStats{Candidates: len(tags)}
	if len(tags) == 0 {
		stats.Reused = true
		return stats, nil
	}
	db, err := sql.Open("machbase", dsn)
	if err != nil {
		return stats, err
	}
	defer db.Close()
	tableName := quoteSQLIdentifier(config.Table)
	primaryName := quoteSQLIdentifier(primary)
	metadataStarted := time.Now()
	rows, err := db.QueryContext(ctx, fmt.Sprintf("SELECT %s FROM %s METADATA", primaryName, tableName))
	if err != nil {
		stats.MetadataDuration = time.Since(metadataStarted)
		return stats, fmt.Errorf("read TAG metadata: %w", err)
	}
	existing := make(map[string]struct{})
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			stats.MetadataDuration = time.Since(metadataStarted)
			return stats, fmt.Errorf("read TAG metadata name: %w", err)
		}
		existing[name] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		stats.MetadataDuration = time.Since(metadataStarted)
		return stats, fmt.Errorf("read TAG metadata: %w", err)
	}
	if err := rows.Close(); err != nil {
		stats.MetadataDuration = time.Since(metadataStarted)
		return stats, fmt.Errorf("close TAG metadata query: %w", err)
	}
	stats.MetadataDuration = time.Since(metadataStarted)
	for _, name := range tags {
		if _, exists := existing[name]; exists {
			stats.ExistingCandidates++
		}
	}
	stats.Missing = stats.Candidates - stats.ExistingCandidates
	registrationStarted := time.Now()
	statement, err := db.PrepareContext(ctx, fmt.Sprintf("INSERT INTO %s METADATA (%s) VALUES (?)", tableName, primaryName))
	if err != nil {
		stats.RegistrationDuration = time.Since(registrationStarted)
		return stats, fmt.Errorf("prepare TAG metadata registration: %w", err)
	}
	defer statement.Close()
	for _, name := range tags {
		if _, exists := existing[name]; exists {
			continue
		}
		if _, err := statement.ExecContext(ctx, name); err != nil {
			stats.RegistrationDuration = time.Since(registrationStarted)
			return stats, fmt.Errorf("register TAG %s: %w", name, err)
		}
		existing[name] = struct{}{}
		stats.Registered++
	}
	stats.RegistrationDuration = time.Since(registrationStarted)
	return stats, nil
}

func tagRegistrationKey(config database) string {
	return strings.ToLower(strings.TrimSpace(config.Server)) + "\x00" + strings.ToUpper(strings.TrimSpace(config.Table))
}

func (d *daemon) acquireTagRegistration(ctx context.Context, config database) (func(), error) {
	d.tagLockMu.Lock()
	if d.tagLocks == nil {
		d.tagLocks = make(map[string]chan struct{})
	}
	key := tagRegistrationKey(config)
	lock := d.tagLocks[key]
	if lock == nil {
		lock = make(chan struct{}, 1)
		d.tagLocks[key] = lock
	}
	d.tagLockMu.Unlock()
	select {
	case lock <- struct{}{}:
		return func() { <-lock }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func quoteSQLIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func (a *nativeAppender) append(rows []row, registry *tagRegistry) error {
	if registry == nil {
		return errors.New("TAG registry is unavailable")
	}
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	// Validate and convert the whole logical batch before appending any row. A
	// conversion failure therefore cannot leave a partially appended batch.
	for index := range rows {
		row := &rows[index]
		if uint64(row.TagIndex) >= uint64(len(registry.names)) {
			return fmt.Errorf("TAG registry index out of range: %d", row.TagIndex)
		}
		value, err := valueForColumn(row.Value, a.valueType)
		if err != nil {
			return fmt.Errorf("Tag %s: %w", registry.names[row.TagIndex], err)
		}
		row.Value = value
	}
	// WithInputColumns performs this full-column expansion and allocates a new
	// []any for every Append call. The writer is single-threaded and Append
	// encodes synchronously, so one full-column buffer can safely be reused.
	for _, row := range rows {
		a.columnValues[a.primaryIndex] = registry.names[row.TagIndex]
		a.columnValues[a.basetimeIndex] = row.Time
		a.columnValues[a.valueIndex] = row.Value
		if err := a.appender.Append(a.columnValues...); err != nil {
			return err
		}
	}
	return nil
}

func valueForColumn(value any, typ api.ColumnType) (any, error) {
	// Parsed JSON numeric values already use float64. Preserve the existing
	// interface value on the common DOUBLE path to avoid boxing a replacement
	// value for every row.
	if typ == api.ColumnTypeDouble {
		if number, ok := value.(float64); ok {
			if math.IsNaN(number) || math.IsInf(number, 0) {
				return nil, errors.New("value is not finite")
			}
			return value, nil
		}
	}
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

func openGoAppender(root string, database database, flushMaxRows int) (*nativeAppender, error) {
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
	primaryIndex, basetimeIndex, valueIndex := -1, -1, -1
	var valueType api.ColumnType
	for index, column := range columns {
		if column.IsTagName() {
			primary = column.Name
			primaryIndex = index
		}
		if column.IsBaseTime() {
			basetime = column.Name
			basetimeIndex = index
		}
		if strings.EqualFold(column.Name, database.ValueColumn) {
			valueType = column.Type
			valueIndex = index
		}
	}
	if primary == "" || basetime == "" {
		_, _, _ = ap.Close()
		return nil, errors.New("TAG primary/basetime column not found")
	}
	value := strings.ToUpper(database.ValueColumn)
	if value == "" {
		_, _, _ = ap.Close()
		return nil, errors.New("TAG value column not configured")
	}
	if valueType == api.ColumnTypeUnknown {
		_, _, _ = ap.Close()
		return nil, errors.New("TAG VALUE column type not found")
	}
	// The writer goroutine owns the time-based Flush. Disable the connector's
	// append-driven delay so the deployment setting has one unambiguous clock;
	// the connector's byte cap remains a memory safety guard.
	ap.WithBatchMaxRows(flushMaxRows).WithBatchMaxDelay(0)
	return &nativeAppender{
		database: database, appender: ap, dsn: dsn, primary: primary,
		columnValues: make([]any, len(columns)), primaryIndex: primaryIndex,
		basetimeIndex: basetimeIndex, valueIndex: valueIndex, valueType: valueType,
	}, nil
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
	if value.SchemaVersion != 2 {
		return snapshot{}, errors.New("collector policy schemaVersion must be 2")
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

func loadPerformancePolicy(root string) (performancePolicy, []string, error) {
	value, err := loadSnapshot(root)
	if err != nil {
		return performancePolicy{}, nil, err
	}
	applied, corrections := value.Performance.normalized()
	return applied, corrections, nil
}

func loadJob(root, name string) (jobConfig, error) {
	if !validName(name) {
		return jobConfig{}, errors.New("invalid job name")
	}
	// The index is the registration-complete marker. A canonical JSON without
	// it is either a legacy Job or an interrupted Create/Update and must never
	// be restored silently.
	indexData, err := os.ReadFile(filepath.Join(root, "conf.d", "job-index", name+".json"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return jobConfig{}, errors.New("job is not registered; recreate the Job")
		}
		return jobConfig{}, err
	}
	var index struct {
		SchemaVersion int    `json:"schemaVersion"`
		Name          string `json:"name"`
		Revision      int    `json:"revision"`
	}
	if err := json.Unmarshal(indexData, &index); err != nil || index.SchemaVersion != 1 || index.Name != name || index.Revision < 1 {
		return jobConfig{}, errors.New("job registration index is invalid; recreate the Job")
	}
	data, err := os.ReadFile(filepath.Join(root, "conf.d", "jobs", name+".json"))
	if err != nil {
		return jobConfig{}, err
	}
	var job jobConfig
	if err := json.Unmarshal(data, &job); err != nil {
		return jobConfig{}, err
	}
	if job.SchemaVersion != 1 || job.Name != name || job.Revision != index.Revision {
		return jobConfig{}, errors.New("job document does not match its registration index")
	}
	servers, err := loadSecrets(root)
	if err != nil {
		return jobConfig{}, err
	}
	server, ok := servers[job.Database.Server]
	if !ok {
		return jobConfig{}, errors.New("database server secret not found")
	}
	if server.DefaultTable != "" {
		job.Database.Table = server.DefaultTable
	}
	if server.ValueColumn != "" {
		job.Database.ValueColumn = server.ValueColumn
	}
	job.Database.StringValueColumn = server.StringValueColumn
	// Final fail-closed boundary: the shared database profile is authoritative
	// and may have changed since JSH saved the Job. Synthetic input is allowed
	// only for the exact internal benchmark table and is never auto-enabled.
	job.Execution.Test = job.Execution.Test &&
		strings.EqualFold(strings.TrimSpace(job.Database.Table), testTableName)
	if job.Schedule.IntervalMS < 1 || job.Database.Server == "" || job.Database.Table == "" || job.Database.ValueColumn == "" || len(job.MethodCalls) == 0 {
		return jobConfig{}, errors.New("job runtime configuration is incomplete")
	}
	for _, call := range job.MethodCalls {
		if _, _, _, _, err := lsCall(call); err != nil {
			return jobConfig{}, fmt.Errorf("job method call %s: %w", call.ID, err)
		}
	}
	return job, nil
}
func loadSecrets(root string) (map[string]conn, error) {
	data, err := os.ReadFile(filepath.Join(root, "conf.d", secretFileName))
	if err != nil {
		return nil, err
	}
	var value struct {
		SchemaVersion int             `json:"schemaVersion"`
		Servers       map[string]conn `json:"servers"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	if value.SchemaVersion != 1 || value.Servers == nil {
		return nil, errors.New("collector secret schema is invalid")
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

func writeActiveJobs(root string, names []string) error {
	return writeJSONAtomic(filepath.Join(root, "conf.d", activeFileName), struct {
		SchemaVersion int      `json:"schemaVersion"`
		Names         []string `json:"names"`
	}{SchemaVersion: 1, Names: names}, 0644)
}

func (d *daemon) setActive(name string, active bool) error {
	d.activeMu.Lock()
	defer d.activeMu.Unlock()
	names, err := loadActiveJobs(d.root)
	if err != nil {
		return err
	}
	values := make(map[string]bool, len(names)+1)
	for _, current := range names {
		values[current] = true
	}
	if active {
		values[name] = true
	} else {
		delete(values, name)
	}
	names = names[:0]
	for current := range values {
		names = append(names, current)
	}
	sort.Strings(names)
	return writeActiveJobs(d.root, names)
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
	d.recordPerformanceSkip(name, queue)
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
	d.markRuntimeDirty()
}

func newJobRuntime(name, state, detail string) jobRuntime {
	return jobRuntime{Name: name, State: state, StateDetail: detail}
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
	return writeJSONAtomic(filepath.Join(d.root, "data", runtimeFileName), d.snapshotRuntime(), 0644)
}

func (d *daemon) markRuntimeDirty() {
	select {
	case d.runtimeDirty <- struct{}{}:
	default:
	}
}

func (d *daemon) forceRuntimeCheckpoint() error {
	// Unit-sized daemon instances and early startup failures do not have the
	// checkpoint goroutine yet. Preserve the synchronous behavior in that case.
	if d.runtimeForce == nil || d.runtimeStop == nil {
		return d.writeRuntime()
	}
	done := make(chan error, 1)
	select {
	case d.runtimeForce <- done:
		return <-done
	case <-d.runtimeStop:
		return d.writeRuntime()
	}
}

func (d *daemon) runtimeCheckpointWriter() {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	dirty := false
	for {
		select {
		case <-d.runtimeDirty:
			dirty = true
		case result := <-d.runtimeForce:
			result <- d.writeRuntime()
			dirty = false
		case <-ticker.C:
			if dirty {
				_ = d.writeRuntime()
				dirty = false
			}
		case <-d.runtimeStop:
			if dirty {
				_ = d.writeRuntime()
			}
			return
		}
	}
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
	if err == nil {
		err = temporary.Sync()
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
