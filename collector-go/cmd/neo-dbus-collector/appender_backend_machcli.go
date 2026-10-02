//go:build machcli && cgo

package main

/*
#cgo LDFLAGS: -lm -lpthread -ldl -lrt

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <machbase_sqlcli.h>

enum {
    COL_SHORT = 1,
    COL_USHORT,
    COL_INTEGER,
    COL_UINTEGER,
    COL_LONG,
    COL_ULONG,
    COL_FLOAT,
    COL_DOUBLE,
    COL_VARYING,
    COL_DATETIME,
    COL_IP
};

typedef struct {
    int32_t tag_index;
    int64_t timestamp_ns;
    int64_t signed_value;
    uint64_t unsigned_value;
    double floating_value;
} collector_row_t;

// Temporary opt-in benchmark instrumentation. Production calls pass NULL, so
// the hot loop does not read a clock per row. Integration benchmarks pass a
// metrics pointer to separate the C loop from SQLAppendDataV2 itself and to
// identify which row owned the longest native call in a slow batch.
typedef struct {
    int64_t loop_ns;
    int64_t sql_total_ns;
    int64_t sql_max_ns;
    int32_t sql_max_index;
} collector_append_metrics_t;

static int64_t collector_monotonic_ns(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
    return (int64_t)ts.tv_sec * INT64_C(1000000000) + (int64_t)ts.tv_nsec;
}

typedef struct {
    SQLHENV env;
    SQLHDBC con;
    SQLHSTMT stmt;
    int column_count;
    int primary_index;
    int basetime_index;
    int value_index;
    int *column_kinds;
    SQL_APPEND_PARAM *params;
    char **tags;
    int tag_count;
    int tag_capacity;
    char error[1024];
} collector_appender_t;

static void copy_error(char *dst, size_t cap, const char *text) {
    if (dst == NULL || cap == 0) return;
    snprintf(dst, cap, "%s", text == NULL ? "unknown machcli error" : text);
}

static void set_error(collector_appender_t *app, const char *operation) {
    SQLINTEGER native_error = 0;
    SQLCHAR message[SQL_MAX_MESSAGE_LENGTH + 1] = {0};
    SQLCHAR state[SQL_SQLSTATE_SIZE + 1] = {0};
    SQLSMALLINT message_len = 0;
    if (app == NULL) return;
    if (SQLError(app->env, app->con, app->stmt, state, &native_error, message,
                 SQL_MAX_MESSAGE_LENGTH, &message_len) == SQL_SUCCESS) {
        snprintf(app->error, sizeof(app->error),
                 "%s: SQLSTATE=%s native=%d message=%s", operation, state,
                 (int)native_error, message);
    } else {
        snprintf(app->error, sizeof(app->error), "%s failed", operation);
    }
}

static void release_appender(collector_appender_t *app) {
    int i;
    if (app == NULL) return;
    if (app->stmt != SQL_NULL_HSTMT) SQLFreeStmt(app->stmt, SQL_DROP);
    if (app->con != SQL_NULL_HDBC) {
        SQLDisconnect(app->con);
        SQLFreeConnect(app->con);
    }
    if (app->env != SQL_NULL_HENV) SQLFreeEnv(app->env);
    for (i = 0; i < app->tag_count; i++) free(app->tags[i]);
    free(app->tags);
    free(app->params);
    free(app->column_kinds);
    free(app);
}

static void set_null(SQL_APPEND_PARAM *param, int kind) {
    memset(param, 0, sizeof(*param));
    switch (kind) {
    case COL_SHORT:    param->mShort = SQL_APPEND_SHORT_NULL; break;
    case COL_USHORT:   param->mUShort = SQL_APPEND_USHORT_NULL; break;
    case COL_INTEGER:  param->mInteger = SQL_APPEND_INTEGER_NULL; break;
    case COL_UINTEGER: param->mUInteger = SQL_APPEND_UINTEGER_NULL; break;
    case COL_LONG:     param->mLong = SQL_APPEND_LONG_NULL; break;
    case COL_ULONG:    param->mULong = SQL_APPEND_ULONG_NULL; break;
    case COL_FLOAT:    param->mFloat = SQL_APPEND_FLOAT_NULL; break;
    case COL_DOUBLE:   param->mDouble = SQL_APPEND_DOUBLE_NULL; break;
    case COL_DATETIME: param->mDateTime.mTime = SQL_APPEND_DATETIME_NULL; break;
    case COL_IP:       param->mIP.mLength = SQL_APPEND_IP_NULL; break;
    case COL_VARYING:
    default:
        param->mVarchar.mLength = SQL_APPEND_VARCHAR_NULL;
        param->mVarchar.mData = NULL;
        break;
    }
}

static collector_appender_t *collector_open(
        const char *dsn, const char *table, int column_count,
        int primary_index, int basetime_index, int value_index,
        const int *column_kinds, char *open_error, size_t open_error_cap) {
    collector_appender_t *app;
    int i;

    app = (collector_appender_t *)calloc(1, sizeof(*app));
    if (app == NULL) {
        copy_error(open_error, open_error_cap, "allocate machcli appender");
        return NULL;
    }
    app->env = SQL_NULL_HENV;
    app->con = SQL_NULL_HDBC;
    app->stmt = SQL_NULL_HSTMT;
    app->column_count = column_count;
    app->primary_index = primary_index;
    app->basetime_index = basetime_index;
    app->value_index = value_index;
    app->column_kinds = (int *)malloc(sizeof(int) * (size_t)column_count);
    app->params = (SQL_APPEND_PARAM *)calloc((size_t)column_count, sizeof(SQL_APPEND_PARAM));
    if (app->column_kinds == NULL || app->params == NULL) {
        copy_error(open_error, open_error_cap, "allocate machcli column buffer");
        release_appender(app);
        return NULL;
    }
    memcpy(app->column_kinds, column_kinds, sizeof(int) * (size_t)column_count);
    for (i = 0; i < column_count; i++) set_null(&app->params[i], app->column_kinds[i]);

    if (!SQL_SUCCEEDED(SQLAllocEnv(&app->env))) {
        set_error(app, "SQLAllocEnv");
        copy_error(open_error, open_error_cap, app->error);
        release_appender(app);
        return NULL;
    }
    if (!SQL_SUCCEEDED(SQLAllocConnect(app->env, &app->con))) {
        set_error(app, "SQLAllocConnect");
        copy_error(open_error, open_error_cap, app->error);
        release_appender(app);
        return NULL;
    }
    if (!SQL_SUCCEEDED(SQLDriverConnect(app->con, NULL, (SQLCHAR *)dsn, SQL_NTS,
                                        NULL, 0, NULL, SQL_DRIVER_NOPROMPT))) {
        set_error(app, "SQLDriverConnect");
        copy_error(open_error, open_error_cap, app->error);
        release_appender(app);
        return NULL;
    }
    if (!SQL_SUCCEEDED(SQLAllocStmt(app->con, &app->stmt))) {
        set_error(app, "SQLAllocStmt");
        copy_error(open_error, open_error_cap, app->error);
        release_appender(app);
        return NULL;
    }
    if (!SQL_SUCCEEDED(SQLAppendOpen(app->stmt, (SQLCHAR *)table, 0))) {
        set_error(app, "SQLAppendOpen");
        copy_error(open_error, open_error_cap, app->error);
        release_appender(app);
        return NULL;
    }
    return app;
}

static const char *collector_error(collector_appender_t *app) {
    if (app == NULL || app->error[0] == '\0') return "unknown machcli error";
    return app->error;
}

static int collector_add_tag(collector_appender_t *app, const char *name) {
    char **next;
    char *copy;
    int capacity;
    if (app == NULL || name == NULL) return -1;
    if (app->tag_count == app->tag_capacity) {
        capacity = app->tag_capacity == 0 ? 256 : app->tag_capacity * 2;
        next = (char **)realloc(app->tags, sizeof(char *) * (size_t)capacity);
        if (next == NULL) {
            snprintf(app->error, sizeof(app->error), "allocate TAG cache");
            return -1;
        }
        app->tags = next;
        app->tag_capacity = capacity;
    }
    copy = strdup(name);
    if (copy == NULL) {
        snprintf(app->error, sizeof(app->error), "allocate TAG name");
        return -1;
    }
    app->tags[app->tag_count] = copy;
    return app->tag_count++;
}

static int collector_append(collector_appender_t *app,
                            const collector_row_t *rows, int count,
                            collector_append_metrics_t *metrics) {
    int i;
    int64_t loop_started = 0;
    if (app == NULL || rows == NULL || count < 0) return -1;
    if (metrics != NULL) {
        memset(metrics, 0, sizeof(*metrics));
        metrics->sql_max_index = -1;
        loop_started = collector_monotonic_ns();
    }
    for (i = 0; i < count; i++) {
        int64_t sql_started = 0;
        int64_t sql_elapsed = 0;
        int tag_index = rows[i].tag_index;
        if (tag_index < 0 || tag_index >= app->tag_count) {
            snprintf(app->error, sizeof(app->error), "TAG cache index out of range: %d", tag_index);
            return -1;
        }
        app->params[app->primary_index].mVarchar.mData = app->tags[tag_index];
        app->params[app->primary_index].mVarchar.mLength =
            (unsigned int)strlen(app->tags[tag_index]);
        app->params[app->basetime_index].mDateTime.mTime =
            (SQLBIGINT)rows[i].timestamp_ns;
        switch (app->column_kinds[app->value_index]) {
        case COL_SHORT:
            app->params[app->value_index].mShort = (short)rows[i].signed_value;
            break;
        case COL_USHORT:
            app->params[app->value_index].mUShort = (unsigned short)rows[i].unsigned_value;
            break;
        case COL_INTEGER:
            app->params[app->value_index].mInteger = (int)rows[i].signed_value;
            break;
        case COL_UINTEGER:
            app->params[app->value_index].mUInteger = (unsigned int)rows[i].unsigned_value;
            break;
        case COL_LONG:
            app->params[app->value_index].mLong = (long long)rows[i].signed_value;
            break;
        case COL_ULONG:
            app->params[app->value_index].mULong = (unsigned long long)rows[i].unsigned_value;
            break;
        case COL_FLOAT:
            app->params[app->value_index].mFloat = (float)rows[i].floating_value;
            break;
        case COL_DOUBLE:
            app->params[app->value_index].mDouble = rows[i].floating_value;
            break;
        default:
            snprintf(app->error, sizeof(app->error), "unsupported machcli VALUE column kind: %d",
                     app->column_kinds[app->value_index]);
            return -1;
        }
        if (metrics != NULL) sql_started = collector_monotonic_ns();
        if (!SQL_SUCCEEDED(SQLAppendDataV2(app->stmt, app->params))) {
            set_error(app, "SQLAppendDataV2");
            return -1;
        }
        if (metrics != NULL) {
            sql_elapsed = collector_monotonic_ns() - sql_started;
            metrics->sql_total_ns += sql_elapsed;
            if (sql_elapsed > metrics->sql_max_ns) {
                metrics->sql_max_ns = sql_elapsed;
                metrics->sql_max_index = i;
            }
        }
    }
    if (metrics != NULL) metrics->loop_ns = collector_monotonic_ns() - loop_started;
    return 0;
}

static int collector_flush(collector_appender_t *app) {
    if (app == NULL) return -1;
    if (SQL_SUCCEEDED(SQLAppendFlush(app->stmt))) return 0;
    set_error(app, "SQLAppendFlush");
    return -1;
}

static int collector_close(collector_appender_t *app, char *close_error,
                           size_t close_error_cap) {
    SQLBIGINT success = 0;
    SQLBIGINT failure = 0;
    int result = 0;
    if (app == NULL) return 0;
    if (app->stmt != SQL_NULL_HSTMT &&
        !SQL_SUCCEEDED(SQLAppendClose(app->stmt, &success, &failure))) {
        set_error(app, "SQLAppendClose");
        copy_error(close_error, close_error_cap, app->error);
        result = -1;
    } else if (failure != 0) {
        snprintf(app->error, sizeof(app->error),
                 "SQLAppendClose reported failed rows: %lld", (long long)failure);
        copy_error(close_error, close_error_cap, app->error);
        result = -1;
    }
    release_appender(app);
    return result;
}
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unsafe"

	client "github.com/machbase/neo-client/v2"
	"github.com/machbase/neo-client/v2/api"
)

const machcliErrorBufferSize = 1024

type machcliAppender struct {
	database  database
	dsn       string
	primary   string
	valueType api.ColumnType
	handle    *C.collector_appender_t

	mu         sync.RWMutex
	prepareMu  sync.Mutex
	closed     bool
	tagIDs     map[string]int32
	registry   *tagRegistry
	tagIndexes []int32
	buffer     []C.collector_row_t
}

// machcliAppendTrace is intentionally private and test-only. It lets the
// integration benchmark distinguish Go preparation, the cgo boundary, the C
// loop, and the native SQLAppendDataV2 calls without changing production logs.
type machcliAppendTrace struct {
	Total       time.Duration
	LockWait    time.Duration
	GoPrepare   time.Duration
	CGoWall     time.Duration
	CLoop       time.Duration
	SQLTotal    time.Duration
	SQLMax      time.Duration
	SQLMaxIndex int
}

func (a *machcliAppender) same(config database) bool { return a.database == config }

// The C SDK stream is flushed only by the writer's periodic ticker. Explicit
// flush requests caused by priming or Job stop are intentionally ignored; a
// table switch or collector shutdown still makes data durable through
// SQLAppendClose.
func (a *machcliAppender) periodicFlushOnly() {}

func (a *machcliAppender) close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil
	}
	a.closed = true
	buffer := make([]byte, machcliErrorBufferSize)
	result := C.collector_close(a.handle, (*C.char)(unsafe.Pointer(&buffer[0])), C.size_t(len(buffer)))
	a.handle = nil
	a.registry = nil
	a.tagIDs = nil
	a.tagIndexes = nil
	a.buffer = nil
	if result != 0 {
		return errors.New(cStringBuffer(buffer))
	}
	return nil
}

func (a *machcliAppender) flush() error {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.closed || a.handle == nil {
		return errors.New("machcli appender is closed")
	}
	if C.collector_flush(a.handle) != 0 {
		return errors.New(C.GoString(C.collector_error(a.handle)))
	}
	return nil
}

func (a *machcliAppender) prepareRegistry(ctx context.Context, registry *tagRegistry, required int) error {
	_, err := a.prepareRegistryMeasured(ctx, registry, required)
	return err
}

func (a *machcliAppender) prepareRegistryMeasured(ctx context.Context, registry *tagRegistry, required int) (tagPreparationStats, error) {
	stats := tagPreparationStats{Required: required}
	if registry == nil {
		return stats, errors.New("TAG registry is unavailable")
	}
	if required < 0 || required > registry.count() {
		return stats, errors.New("invalid required TAG count")
	}
	// The writer calls this for every batch. Keep the steady-state path lock-free
	// with respect to slow metadata registration so a new Job cannot stall Jobs
	// whose TAG indexes are already prepared.
	wanted := required
	a.mu.RLock()
	ready := a.registry == registry && len(a.tagIndexes) >= wanted && !a.closed && a.handle != nil
	differentRegistry := a.registry != nil && a.registry != registry
	a.mu.RUnlock()
	if differentRegistry {
		return stats, errors.New("machcli appender received a different TAG registry")
	}
	if ready {
		stats.Reused = true
		return stats, nil
	}
	// Metadata registration performs database I/O and must not hold the append
	// lock. A separate mutex serializes concurrent Job-start preparations while
	// already-running Jobs continue to append through the read lock.
	a.prepareMu.Lock()
	defer a.prepareMu.Unlock()
	a.mu.RLock()
	if a.registry != nil && a.registry != registry {
		a.mu.RUnlock()
		return stats, errors.New("machcli appender received a different TAG registry")
	}
	prepared := len(a.tagIndexes)
	closed := a.closed || a.handle == nil
	a.mu.RUnlock()
	if closed {
		return stats, errors.New("machcli appender closed while registering TAGs")
	}
	if required <= prepared {
		stats.Reused = true
		return stats, nil
	}
	names := registry.snapshot()
	names = names[:required]
	registrationStats, err := registerTagsSQLMeasured(ctx, a.dsn, a.database, a.primary, names[prepared:])
	registrationStats.Required = required
	if err != nil {
		return registrationStats, err
	}
	stats = registrationStats
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || a.handle == nil {
		return stats, errors.New("machcli appender closed while registering TAGs")
	}
	if a.registry == nil {
		a.registry = registry
	} else if a.registry != registry {
		return stats, errors.New("machcli appender received a different TAG registry")
	}
	for index := len(a.tagIndexes); index < len(names); index++ {
		name := names[index]
		tagID, exists := a.tagIDs[name]
		if !exists {
			cName := C.CString(name)
			added := C.collector_add_tag(a.handle, cName)
			C.free(unsafe.Pointer(cName))
			if added < 0 {
				return stats, errors.New(C.GoString(C.collector_error(a.handle)))
			}
			tagID = int32(added)
			a.tagIDs[name] = tagID
		}
		a.tagIndexes = append(a.tagIndexes, tagID)
	}
	return stats, nil
}

func (a *machcliAppender) append(rows []row, registry *tagRegistry) error {
	_, err := a.appendMeasured(rows, registry, false)
	return err
}

func (a *machcliAppender) appendTraced(rows []row, registry *tagRegistry) (machcliAppendTrace, error) {
	return a.appendMeasured(rows, registry, true)
}

func (a *machcliAppender) appendMeasured(rows []row, registry *tagRegistry, traced bool) (machcliAppendTrace, error) {
	var trace machcliAppendTrace
	if len(rows) == 0 {
		return trace, nil
	}
	var totalStarted, lockStarted time.Time
	if traced {
		totalStarted = time.Now()
		lockStarted = totalStarted
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	if traced {
		trace.LockWait = time.Since(lockStarted)
	}
	if a.closed || a.handle == nil {
		return trace, errors.New("machcli appender is closed")
	}
	if registry == nil || a.registry != registry {
		return trace, errors.New("machcli TAG registry is not prepared")
	}
	var prepareStarted time.Time
	if traced {
		prepareStarted = time.Now()
	}
	if cap(a.buffer) < len(rows) {
		a.buffer = make([]C.collector_row_t, len(rows))
	} else {
		a.buffer = a.buffer[:len(rows)]
	}
	for index := range rows {
		item := &rows[index]
		if uint64(item.TagIndex) >= uint64(len(a.tagIndexes)) {
			return trace, fmt.Errorf("TAG registry index out of range: %d", item.TagIndex)
		}
		value, err := valueForColumn(item.Value, a.valueType)
		if err != nil {
			return trace, fmt.Errorf("TAG index %d: %w", item.TagIndex, err)
		}
		a.buffer[index].tag_index = C.int32_t(a.tagIndexes[item.TagIndex])
		a.buffer[index].timestamp_ns = C.int64_t(item.Time.UnixNano())
		switch number := value.(type) {
		case int16:
			a.buffer[index].signed_value = C.int64_t(number)
		case int32:
			a.buffer[index].signed_value = C.int64_t(number)
		case int64:
			a.buffer[index].signed_value = C.int64_t(number)
		case uint16:
			a.buffer[index].unsigned_value = C.uint64_t(number)
		case uint32:
			a.buffer[index].unsigned_value = C.uint64_t(number)
		case uint64:
			a.buffer[index].unsigned_value = C.uint64_t(number)
		case float32:
			a.buffer[index].floating_value = C.double(number)
		case float64:
			a.buffer[index].floating_value = C.double(number)
		default:
			return trace, fmt.Errorf("TAG index %d: unsupported converted VALUE type %T", item.TagIndex, value)
		}
	}
	if traced {
		trace.GoPrepare = time.Since(prepareStarted)
	}
	var metrics C.collector_append_metrics_t
	var metricsPointer *C.collector_append_metrics_t
	if traced {
		metricsPointer = &metrics
	}
	var cgoStarted time.Time
	if traced {
		cgoStarted = time.Now()
	}
	if C.collector_append(a.handle, &a.buffer[0], C.int(len(a.buffer)), metricsPointer) != 0 {
		return trace, errors.New(C.GoString(C.collector_error(a.handle)))
	}
	if traced {
		trace.CGoWall = time.Since(cgoStarted)
		trace.CLoop = time.Duration(int64(metrics.loop_ns))
		trace.SQLTotal = time.Duration(int64(metrics.sql_total_ns))
		trace.SQLMax = time.Duration(int64(metrics.sql_max_ns))
		trace.SQLMaxIndex = int(metrics.sql_max_index)
		trace.Total = time.Since(totalStarted)
	}
	return trace, nil
}

func openAppender(root string, config database, flushMaxRows int) (appenderStream, error) {
	secrets, err := loadSecrets(root)
	if err != nil {
		return nil, err
	}
	server, ok := secrets[config.Server]
	if !ok {
		return nil, errors.New("database server secret not found")
	}
	dsn := fmt.Sprintf("server=tcp://%s:%s@%s:%d", server.User, server.Password, server.Host, server.Port)

	// neo-client remains the metadata probe and the compatibility fallback for
	// non-DOUBLE VALUE columns. The hot append/flush path uses machcli through
	// one CGo call per logical batch.
	probe := &client.Appender{}
	if err := probe.Connect(context.Background(), dsn, config.Table); err != nil {
		return nil, err
	}
	columns := probe.Columns()
	_, _, closeErr := probe.Close()
	if closeErr != nil {
		return nil, closeErr
	}

	primary, primaryIndex := "", -1
	basetimeIndex, valueIndex := -1, -1
	var primaryType, basetimeType, valueType api.ColumnType
	columnKinds := make([]C.int, len(columns))
	for index, column := range columns {
		kind, supported := machcliColumnKind(column.Type)
		if !supported {
			return openGoAppender(root, config, flushMaxRows)
		}
		columnKinds[index] = kind
		if column.IsTagName() {
			primary, primaryIndex = column.Name, index
			primaryType = column.Type
		}
		if column.IsBaseTime() {
			basetimeIndex = index
			basetimeType = column.Type
		}
		if strings.EqualFold(column.Name, config.ValueColumn) {
			valueType, valueIndex = column.Type, index
		}
	}
	if primaryIndex < 0 || basetimeIndex < 0 || valueIndex < 0 {
		return nil, errors.New("TAG primary/basetime/value column not found")
	}
	// The C hot path writes the three required fields through their concrete
	// SQL_APPEND_PARAM union members. Keep unusual TAG schemas on the existing
	// Go Appender instead of interpreting a differently typed union member.
	if !machcliTagNameType(primaryType) || basetimeType != api.ColumnTypeDatetime ||
		!machcliNumericValueType(valueType) {
		return openGoAppender(root, config, flushMaxRows)
	}

	cDSN := C.CString(dsn)
	cTable := C.CString(config.Table)
	defer C.free(unsafe.Pointer(cDSN))
	defer C.free(unsafe.Pointer(cTable))
	openError := make([]byte, machcliErrorBufferSize)
	handle := C.collector_open(
		cDSN, cTable, C.int(len(columns)), C.int(primaryIndex), C.int(basetimeIndex),
		C.int(valueIndex), &columnKinds[0], (*C.char)(unsafe.Pointer(&openError[0])),
		C.size_t(len(openError)),
	)
	if handle == nil {
		return nil, errors.New(cStringBuffer(openError))
	}
	return &machcliAppender{
		database:  config,
		dsn:       dsn,
		primary:   primary,
		valueType: valueType,
		handle:    handle,
		tagIDs:    make(map[string]int32),
	}, nil
}

func machcliNumericValueType(typ api.ColumnType) bool {
	switch typ {
	case api.ColumnTypeShort, api.ColumnTypeUShort,
		api.ColumnTypeInteger, api.ColumnTypeUInteger,
		api.ColumnTypeLong, api.ColumnTypeULong,
		api.ColumnTypeFloat, api.ColumnTypeDouble:
		return true
	default:
		return false
	}
}

func machcliTagNameType(typ api.ColumnType) bool {
	switch typ {
	case api.ColumnTypeVarchar, api.ColumnTypeChar:
		return true
	default:
		return false
	}
}

func machcliColumnKind(typ api.ColumnType) (C.int, bool) {
	switch typ {
	case api.ColumnTypeShort:
		return C.COL_SHORT, true
	case api.ColumnTypeUShort:
		return C.COL_USHORT, true
	case api.ColumnTypeInteger:
		return C.COL_INTEGER, true
	case api.ColumnTypeUInteger:
		return C.COL_UINTEGER, true
	case api.ColumnTypeLong:
		return C.COL_LONG, true
	case api.ColumnTypeULong:
		return C.COL_ULONG, true
	case api.ColumnTypeFloat:
		return C.COL_FLOAT, true
	case api.ColumnTypeDouble:
		return C.COL_DOUBLE, true
	case api.ColumnTypeVarchar, api.ColumnTypeText, api.ColumnTypeClob,
		api.ColumnTypeBlob, api.ColumnTypeBinary, api.ColumnTypeJSON,
		api.ColumnTypeChar:
		return C.COL_VARYING, true
	case api.ColumnTypeDatetime:
		return C.COL_DATETIME, true
	case api.ColumnTypeIPv4, api.ColumnTypeIPv6, api.ColumnTypeIPNet:
		return C.COL_IP, true
	default:
		return 0, false
	}
}

func cStringBuffer(buffer []byte) string {
	for index, value := range buffer {
		if value == 0 {
			return string(buffer[:index])
		}
	}
	return string(buffer)
}

var _ appenderStream = (*machcliAppender)(nil)
