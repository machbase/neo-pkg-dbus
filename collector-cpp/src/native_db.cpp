#include "native_db.hpp"
namespace collector {
NativeSql::NativeSql(const Server &server, const Cancellation *cancel)
    : text_(65536), cancel_(cancel), password_(server.password) {
    try {
        checked(SQLAllocEnv(&env_), "SQLAllocEnv");
        checked(SQLAllocConnect(env_, &connection_), "SQLAllocConnect");
        auto connection = server.dsn();
        checked(SQLDriverConnect(connection_, nullptr, reinterpret_cast<SQLCHAR *>(connection.data()),
                                 SQL_NTS, nullptr, 0, nullptr, SQL_DRIVER_NOPROMPT),
                "SQLDriverConnect");
        new_statement();
    } catch (...) {
        close();
        throw;
    }
}
void NativeSql::close() noexcept {
    if (statement_ != SQL_NULL_HSTMT)
        SQLFreeStmt(statement_, SQL_DROP);
    if (connection_ != SQL_NULL_HDBC) {
        SQLDisconnect(connection_);
        SQLFreeConnect(connection_);
    }
    if (env_ != SQL_NULL_HENV)
        SQLFreeEnv(env_);
    statement_ = SQL_NULL_HSTMT;
    connection_ = SQL_NULL_HDBC;
    env_ = SQL_NULL_HENV;
}
void NativeSql::checked(SQLRETURN code, const char *operation) {
    if (SQL_SUCCEEDED(code))
        return;
    SQLINTEGER native = 0;
    SQLCHAR state[6]{}, text[SQL_MAX_MESSAGE_LENGTH + 1]{};
    SQLSMALLINT size = 0;
    std::string message = operation;
    if (SQLError(env_, connection_, statement_, state, &native, text, SQL_MAX_MESSAGE_LENGTH, &size) ==
        SQL_SUCCESS)
        message += ": SQLSTATE=" + std::string(reinterpret_cast<char *>(state)) +
                   " native=" + std::to_string(native) + " message=" + reinterpret_cast<char *>(text);
    else
        message += " failed";
    throw std::runtime_error(scrub_error(message, password_));
}
void NativeSql::check_cancel() const { require(!cancel_ || !cancel_->stopped(), "operation cancelled"); }
void NativeSql::new_statement() {
    if (statement_ != SQL_NULL_HSTMT) {
        SQLFreeStmt(statement_, SQL_DROP);
        statement_ = SQL_NULL_HSTMT;
    }
    check_cancel();
    checked(SQLAllocStmt(connection_, &statement_), "SQLAllocStmt");
}
void NativeSql::query(const std::string &query, const std::function<void(const SqlRow &)> &consume) {
    new_statement();
    checked(
        SQLExecDirect(statement_, reinterpret_cast<SQLCHAR *>(const_cast<char *>(query.c_str())), SQL_NTS),
        "SQLExecDirect");
    SQLSMALLINT count = 0;
    checked(SQLNumResultCols(statement_, &count), "SQLNumResultCols");
    require(count >= 0 && count <= 4096, "unexpected SQL result width");
    for (;;) {
        check_cancel();
        SQLRETURN code = SQLFetch(statement_);
        if (code == SQL_NO_DATA)
            break;
        checked(code, "SQLFetch");
        SqlRow row;
        row.reserve(size_t(count));
        for (SQLSMALLINT i = 1; i <= count; ++i) {
            SQLLEN size = 0;
            text_[0] = 0;
            checked(SQLGetData(statement_, SQLUSMALLINT(i), SQL_C_CHAR, text_.data(), SQLLEN(text_.size()),
                               &size),
                    "SQLGetData");
            if (size == SQL_NULL_DATA)
                row.emplace_back(std::nullopt);
            else {
                require(size >= 0 && size_t(size) < text_.size(), "SQL metadata value exceeds buffer");
                row.emplace_back(std::string(text_.data(), size_t(size)));
            }
        }
        consume(row);
    }
    check_cancel();
}
std::vector<SqlRow> NativeSql::query(const std::string &query) {
    std::vector<SqlRow> rows;
    this->query(query, [&](const SqlRow &row) { rows.push_back(row); });
    return rows;
}
void NativeSql::exec(const std::string &query) {
    new_statement();
    checked(
        SQLExecDirect(statement_, reinterpret_cast<SQLCHAR *>(const_cast<char *>(query.c_str())), SQL_NTS),
        "SQLExecDirect");
    check_cancel();
}
void NativeSql::prepare_insert(const std::string &query) {
    new_statement();
    checked(SQLPrepare(statement_, reinterpret_cast<SQLCHAR *>(const_cast<char *>(query.c_str())), SQL_NTS),
            "SQLPrepare");
}
void NativeSql::insert(const std::string &name) {
    check_cancel();
    input_value_ = name;
    input_length_ = SQLLEN(input_value_.size());
    checked(SQLBindParameter(statement_, 1, SQL_PARAM_INPUT, SQL_C_CHAR, SQL_VARCHAR,
                             SQLULEN(std::max<size_t>(1, input_value_.size())), 0, input_value_.data(),
                             SQLLEN(input_value_.size() + 1), &input_length_),
            "SQLBindParameter");
    checked(SQLExecute(statement_), "SQLExecute");
    check_cancel();
}
static int column_kind(int type) {
    switch (type) {
    case 4:
        return 1;
    case 104:
        return 2;
    case 8:
        return 3;
    case 108:
        return 4;
    case 12:
        return 5;
    case 112:
        return 6;
    case 16:
        return 7;
    case 20:
        return 8;
    case 5:
    case 45:
    case 49:
    case 53:
    case 57:
    case 97:
    case 61:
        return 9;
    case 6:
        return 10;
    case 32:
    case 36:
        return 11;
    default:
        throw std::runtime_error("unsupported native column type " + std::to_string(type));
    }
}
TableSchema table_schema(NativeSql &sql, const JobConfig &job) {
    auto parts = identifier_parts(job.database.table);
    std::string table = parts.back(),
                user = parts.size() >= 2 ? parts[parts.size() - 2] : upper(job.server.user);
    int64_t database = -1;
    if (parts.size() == 3 && parts.front() != "MACHBASEDB") {
        auto rows = sql.query("SELECT TO_CHAR(BACKUP_TBSID) FROM V$STORAGE_MOUNT_DATABASES WHERE MOUNTDB=" +
                              quote_literal(parts.front()));
        require(rows.size() == 1 && rows[0][0], "database does not exist");
        database = std::stoll(*rows[0][0]);
    }
    auto tables =
        sql.query("SELECT TO_CHAR(ID),TO_CHAR(TYPE) FROM M$SYS_TABLES WHERE NAME=" + quote_literal(table) +
                  " AND USER_ID=(SELECT USER_ID FROM M$SYS_USERS WHERE NAME=" + quote_literal(user) +
                  ") AND DATABASE_ID=" + std::to_string(database));
    require(tables.size() == 1 && tables[0].size() == 2 && tables[0][0] && tables[0][1],
            "table does not exist: " + job.database.table);
    require(std::stoi(*tables[0][1]) == 6, "TAG table is required");
    TableSchema schema;
    // This is scalar metadata, not the data read path. Explicit SQL text
    // conversion avoids the legacy CLI's incomplete unsigned -> SQL_C_CHAR
    // conversion while keeping integer text exact.
    auto rows = sql.query("SELECT NAME,TO_CHAR(TYPE),TO_CHAR(FLAG) FROM M$SYS_COLUMNS WHERE TABLE_ID=" +
                          *tables[0][0] + " AND DATABASE_ID=" + std::to_string(database) + " ORDER BY ID");
    for (auto &row : rows) {
        require(row.size() == 3 && row[0] && row[1] && row[2], "table column metadata is incomplete");
        auto name = *row[0];
        if (!name.empty() && name[0] == '_')
            continue; // Match existing Appender projection.
        int type = std::stoi(*row[1]), index = int(schema.kinds.size());
        uint64_t flag = std::stoull(*row[2]);
        schema.kinds.push_back(column_kind(type));
        if (flag & 0x08000000) {
            require(type == 5 || type == 45, "TAG primary column is not a string");
            schema.primary = name;
            schema.primary_index = index;
        }
        if (flag & 0x01000000) {
            require(type == 6, "TAG basetime column is not DATETIME");
            schema.basetime_index = index;
        }
        if (upper(name) == upper(job.database.value_column)) {
            schema.value_index = index;
            schema.value_type = type;
        }
    }
    require(schema.primary_index >= 0 && schema.basetime_index >= 0 && schema.value_index >= 0,
            "TAG primary/basetime/value column not found");
    require(schema.value_type == 4 || schema.value_type == 104 || schema.value_type == 8 ||
                schema.value_type == 108 || schema.value_type == 12 || schema.value_type == 112 ||
                schema.value_type == 16 || schema.value_type == 20,
            "VALUE column type is not numeric");
    return schema;
}
Preparation register_tags(const JobConfig &job, const TableSchema &schema,
                          const std::vector<std::string> &names, const Cancellation &cancel,
                          Preparation *progress) {
    Preparation stats;
    stats.candidates = names.size();
    if (progress)
        *progress = stats;
    if (names.empty()) {
        stats.reused = true;
        if (progress)
            *progress = stats;
        return stats;
    }
    NativeSql sql(job.server, &cancel);
    std::unordered_set<std::string> wanted(names.begin(), names.end()), existing;
    Ns start = clock_ns();
    // Metadata only: no full data scan or ORDER BY against measured records.
    auto query = "SELECT " + quote_identifier(schema.primary) + " FROM " +
                 quote_identifier(job.database.table) + " METADATA";
    try {
        sql.query(query, [&](const SqlRow &row) {
            if (!row.empty() && row[0] && wanted.count(*row[0]))
                existing.insert(*row[0]);
        });
    } catch (...) {
        stats.metadata = clock_ns() - start;
        stats.existing = existing.size();
        stats.missing = names.size() - existing.size();
        if (progress)
            *progress = stats;
        throw;
    }
    stats.metadata = clock_ns() - start;
    stats.existing = existing.size();
    stats.missing = names.size() - existing.size();
    start = clock_ns();
    try {
        sql.prepare_insert("INSERT INTO " + quote_identifier(job.database.table) + " METADATA (" +
                           quote_identifier(schema.primary) + ") VALUES (?)");
        for (auto &name : names)
            if (!existing.count(name)) {
                sql.insert(name);
                existing.insert(name);
                ++stats.registered;
#ifdef COLLECTOR_TESTING
                if (const char *after = getenv("NEO_DBUS_CPP_TEST_TAG_FAIL_AFTER"))
                    require(int(stats.registered) != atoi(after), "injected metadata registration failure");
#endif
            }
    } catch (...) {
        stats.registration = clock_ns() - start;
        if (progress)
            *progress = stats;
        throw;
    }
    stats.registration = clock_ns() - start;
    if (progress)
        *progress = stats;
    return stats;
}
NativeAppender::NativeAppender(const JobConfig &job, TableSchema shape)
    : database(job.database), server(job.server), schema(std::move(shape)) {
    char error[1024]{};
    auto dsn = server.dsn();
    handle_ = collector_native_open(dsn.c_str(), database.table.c_str(), int(schema.kinds.size()),
                                    schema.primary_index, schema.basetime_index, schema.value_index,
                                    schema.kinds.data(), error);
    require(handle_, scrub_error(error, server.password));
}
NativeAppender::~NativeAppender() {
    if (handle_) {
        char ignored[1024]{};
        collector_native_close(handle_, ignored);
    }
}
void NativeAppender::cache_tags(const std::vector<std::string> &names) {
    require(handle_, "native appender is closed");
    for (size_t i = prepared; i < names.size(); ++i) {
        int result = collector_native_add_tag(handle_, names[i].c_str());
        require(result == int(i), scrub_error(collector_native_error(handle_), server.password));
        prepared = i + 1;
    }
}
void NativeAppender::append(std::vector<Row> &rows) {
    require(handle_, "native appender is closed");
    for (auto &row : rows) {
        require(row.tag_index >= 0 && size_t(row.tag_index) < prepared, "TAG registry index out of range");
        convert_column(row, schema.value_type);
    }
    if (collector_native_append(handle_, rows.data(), int(rows.size())) != 0)
        throw std::runtime_error(scrub_error(collector_native_error(handle_), server.password));
}
void NativeAppender::flush() {
    require(handle_, "native appender is closed");
    if (collector_native_flush(handle_) != 0)
        throw std::runtime_error(scrub_error(collector_native_error(handle_), server.password));
}
void NativeAppender::close() {
    if (!handle_)
        return;
    char error[1024]{};
    void *old = std::exchange(handle_, nullptr);
    if (collector_native_close(old, error) != 0)
        throw std::runtime_error(scrub_error(error, server.password));
}
void NativeAppender::clear_tags() {
    require(handle_, "native appender is closed");
    collector_native_clear_tags(handle_);
    prepared = 0;
}
bool NativeAppender::matches(const JobConfig &job) const {
    return database == job.database && server.host == job.server.host && server.port == job.server.port &&
           server.user == job.server.user && server.password == job.server.password;
}
} // namespace collector
