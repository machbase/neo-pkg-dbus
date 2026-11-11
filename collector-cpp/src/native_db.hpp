#pragma once
#include "model.hpp"
#include "native_bridge.h"
#include <machbase_sqlcli.h>
#include <unordered_set>
namespace collector {
using SqlRow = std::vector<std::optional<std::string>>;
class NativeSql {
    SQLHENV env_ = SQL_NULL_HENV;
    SQLHDBC connection_ = SQL_NULL_HDBC;
    SQLHSTMT statement_ = SQL_NULL_HSTMT;
    std::vector<char> text_;
    const Cancellation *cancel_;
    std::string password_;
    std::string input_value_;
    SQLLEN input_length_ = 0;
    void new_statement();
    void close() noexcept;
    void checked(SQLRETURN code, const char *operation);

  public:
    explicit NativeSql(const Server &server, const Cancellation *cancel = nullptr);
    ~NativeSql() { close(); }
    NativeSql(const NativeSql &) = delete;
    void check_cancel() const;
    void query(const std::string &query, const std::function<void(const SqlRow &)> &row);
    std::vector<SqlRow> query(const std::string &query);
    void exec(const std::string &query);
    void prepare_insert(const std::string &query);
    void insert(const std::string &name);
};
struct TableSchema {
    std::vector<int> kinds;
    std::string primary;
    int primary_index = -1, basetime_index = -1, value_index = -1, value_type = 0;
};
TableSchema table_schema(NativeSql &sql, const JobConfig &job);
struct Preparation {
    size_t required = 0, candidates = 0, existing = 0, missing = 0, registered = 0;
    Ns metadata = 0, registration = 0;
    bool reused = false;
};
Preparation register_tags(const JobConfig &job, const TableSchema &schema,
                          const std::vector<std::string> &names, const Cancellation &cancel,
                          Preparation *progress = nullptr);
class NativeAppender {
    void *handle_ = nullptr;

  public:
    Database database;
    Server server;
    TableSchema schema;
    size_t prepared = 0;
    NativeAppender(const JobConfig &job, TableSchema schema);
    ~NativeAppender();
    NativeAppender(const NativeAppender &) = delete;
    void cache_tags(const std::vector<std::string> &names);
    void append(std::vector<Row> &rows);
    void flush();
    void close();
    void clear_tags();
    bool matches(const JobConfig &job) const;
};
} // namespace collector
