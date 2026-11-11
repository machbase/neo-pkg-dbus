#pragma once
#include "common.hpp"
#include "native_rows.h"
#include <unordered_map>

namespace collector {
using Row = collector_row_t;
enum class Conversion { Integer, Real32, Real64 };
struct Tag {
    std::string name;
    double bias = 0, multiplier = 1;
    bool signed_value = false, multiply_first = false;
    Conversion conversion = Conversion::Integer;
    uint32_t index = 0;
};
struct Call {
    std::string id, address;
    unsigned bits = 0;
    int count = 0;
    size_t offset = 0;
    std::vector<Tag> tags;
};
struct Server {
    std::string host, user, password, table, value_column, string_column;
    int port = 0;
    std::string dsn() const;
};
struct Database {
    std::string server, table, value_column, string_column;
    bool operator==(const Database &b) const {
        return server == b.server && table == b.table && value_column == b.value_column &&
               string_column == b.string_column;
    }
};
struct JobConfig {
    std::string name, destination, prefix, level = "INFO";
    int revision = 0;
    int64_t interval_ms = 0;
    bool absolute = false, test = false;
    Database database;
    Server server;
    std::vector<Call> calls;
    size_t row_count = 0;
};
struct LogPolicy {
    int64_t max_bytes = 1024 * 1024, summary_ms = 3'600'000;
    int max_files = 3;
};
struct Policies {
    LogPolicy logging;
    int queue_capacity = 512, flush_rows = 8192;
    int64_t flush_ms = 1000, writer_summary_ms = 30'000;
    bool performance = false, overrun_detail = true;
    int job_samples = 1000;
    std::string scheduler_mode = "conditional";
    int fifo = 50, nice = -10, gomaxprocs = 0;
    std::vector<std::string> corrections;
};
Policies load_policies(const fs::path &root);
JobConfig load_job(const fs::path &root, const std::string &name);
std::vector<std::string> load_active(const fs::path &root);
unsigned address_bits(const std::string &address);
void convert_raw(uint64_t raw, unsigned bits, const Tag &tag, Row &row);
void generate_rows(const JobConfig &job, std::vector<Row> &rows);
void decode_rows(std::string_view body, const Call &call, std::vector<Row> &rows);
void decode_rows_dom(std::string_view body, const Call &call, std::vector<Row> &rows);
void convert_column(Row &row, int column_type);
bool valid_bus_name(const std::string &value, bool unique_allowed, size_t maximum);

// RAII leases hold the pool itself alive. Stop can retire a pool without
// dangling a deleter in a queued/in-flight writer batch. Retired pools never
// recache late returns. There are no strong references from a pool to a lease.
class RowPool : public std::enable_shared_from_this<RowPool> {
  public:
    struct Return {
        mutable std::shared_ptr<RowPool> owner;
        void operator()(std::vector<Row> *rows) const noexcept;
    };
    using Lease = std::unique_ptr<std::vector<Row>, Return>;

  private:
    std::mutex mutex_;
    std::vector<std::unique_ptr<std::vector<Row>>> idle_;
    std::vector<int32_t> tags_;
    bool retired_ = false;
    std::atomic<int64_t> outstanding_{0};
    void recycle(std::unique_ptr<std::vector<Row>> rows) noexcept;

  public:
    explicit RowPool(const JobConfig &job);
    Lease acquire();
    int64_t retire();
    int64_t outstanding() const { return outstanding_.load(); }
    size_t idle_count();
};
} // namespace collector
