/* Derived verbatim from the backed-up Go C shim, except shared row declaration. */

#include "native_rows.h"
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
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0)
        return 0;
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
    if (dst == NULL || cap == 0)
        return;
    snprintf(dst, cap, "%s", text == NULL ? "unknown machcli error" : text);
}

static void set_error(collector_appender_t *app, const char *operation) {
    SQLINTEGER native_error = 0;
    SQLCHAR message[SQL_MAX_MESSAGE_LENGTH + 1] = {0};
    SQLCHAR state[SQL_SQLSTATE_SIZE + 1] = {0};
    SQLSMALLINT message_len = 0;
    if (app == NULL)
        return;
    if (SQLError(app->env, app->con, app->stmt, state, &native_error, message, SQL_MAX_MESSAGE_LENGTH,
                 &message_len) == SQL_SUCCESS) {
        snprintf(app->error, sizeof(app->error), "%s: SQLSTATE=%s native=%d message=%s", operation, state,
                 (int)native_error, message);
    } else {
        snprintf(app->error, sizeof(app->error), "%s failed", operation);
    }
}

static void release_appender(collector_appender_t *app) {
    int i;
    if (app == NULL)
        return;
    if (app->stmt != SQL_NULL_HSTMT)
        SQLFreeStmt(app->stmt, SQL_DROP);
    if (app->con != SQL_NULL_HDBC) {
        SQLDisconnect(app->con);
        SQLFreeConnect(app->con);
    }
    if (app->env != SQL_NULL_HENV)
        SQLFreeEnv(app->env);
    for (i = 0; i < app->tag_count; i++)
        free(app->tags[i]);
    free(app->tags);
    free(app->params);
    free(app->column_kinds);
    free(app);
}

static void set_null(SQL_APPEND_PARAM *param, int kind) {
    memset(param, 0, sizeof(*param));
    switch (kind) {
    case COL_SHORT:
        param->mShort = SQL_APPEND_SHORT_NULL;
        break;
    case COL_USHORT:
        param->mUShort = SQL_APPEND_USHORT_NULL;
        break;
    case COL_INTEGER:
        param->mInteger = SQL_APPEND_INTEGER_NULL;
        break;
    case COL_UINTEGER:
        param->mUInteger = SQL_APPEND_UINTEGER_NULL;
        break;
    case COL_LONG:
        param->mLong = SQL_APPEND_LONG_NULL;
        break;
    case COL_ULONG:
        param->mULong = SQL_APPEND_ULONG_NULL;
        break;
    case COL_FLOAT:
        param->mFloat = SQL_APPEND_FLOAT_NULL;
        break;
    case COL_DOUBLE:
        param->mDouble = SQL_APPEND_DOUBLE_NULL;
        break;
    case COL_DATETIME:
        param->mDateTime.mTime = SQL_APPEND_DATETIME_NULL;
        break;
    case COL_IP:
        param->mIP.mLength = SQL_APPEND_IP_NULL;
        break;
    case COL_VARYING:
    default:
        param->mVarchar.mLength = SQL_APPEND_VARCHAR_NULL;
        param->mVarchar.mData = NULL;
        break;
    }
}

static collector_appender_t *collector_open(const char *dsn, const char *table, int column_count,
                                            int primary_index, int basetime_index, int value_index,
                                            const int *column_kinds, char *open_error,
                                            size_t open_error_cap) {
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
    for (i = 0; i < column_count; i++)
        set_null(&app->params[i], app->column_kinds[i]);

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
    if (!SQL_SUCCEEDED(
            SQLDriverConnect(app->con, NULL, (SQLCHAR *)dsn, SQL_NTS, NULL, 0, NULL, SQL_DRIVER_NOPROMPT))) {
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
    if (app == NULL || app->error[0] == '\0')
        return "unknown machcli error";
    return app->error;
}

static int collector_add_tag(collector_appender_t *app, const char *name) {
    char **next;
    char *copy;
    int capacity;
    if (app == NULL || name == NULL)
        return -1;
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

static int collector_append(collector_appender_t *app, const collector_row_t *rows, int count,
                            collector_append_metrics_t *metrics) {
    int i;
    int64_t loop_started = 0;
    if (app == NULL || rows == NULL || count < 0)
        return -1;
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
        app->params[app->primary_index].mVarchar.mLength = (unsigned int)strlen(app->tags[tag_index]);
        app->params[app->basetime_index].mDateTime.mTime = (SQLBIGINT)rows[i].timestamp_ns;
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
        if (metrics != NULL)
            sql_started = collector_monotonic_ns();
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
    if (metrics != NULL)
        metrics->loop_ns = collector_monotonic_ns() - loop_started;
    return 0;
}

static int collector_flush(collector_appender_t *app) {
    if (app == NULL)
        return -1;
    if (SQL_SUCCEEDED(SQLAppendFlush(app->stmt)))
        return 0;
    set_error(app, "SQLAppendFlush");
    return -1;
}

static int collector_close(collector_appender_t *app, char *close_error, size_t close_error_cap) {
    SQLBIGINT success = 0;
    SQLBIGINT failure = 0;
    int result = 0;
    if (app == NULL)
        return 0;
    if (app->stmt != SQL_NULL_HSTMT && !SQL_SUCCEEDED(SQLAppendClose(app->stmt, &success, &failure))) {
        set_error(app, "SQLAppendClose");
        copy_error(close_error, close_error_cap, app->error);
        result = -1;
    } else if (failure != 0) {
        snprintf(app->error, sizeof(app->error), "SQLAppendClose reported failed rows: %lld",
                 (long long)failure);
        copy_error(close_error, close_error_cap, app->error);
        result = -1;
    }
    release_appender(app);
    return result;
}
