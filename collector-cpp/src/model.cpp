#include "model.hpp"
#include <cmath>

namespace collector {
static int64_t integer(const Json &data, const char *key, int64_t fallback) {
    auto it = data.find(key);
    if (it == data.end())
        return fallback;
    require(it->is_number_integer(), std::string(key) + " must be an integer");
    if (it->is_number_unsigned())
        require(it->get<uint64_t>() <= uint64_t(INT64_MAX), std::string(key) + " exceeds integer range");
    return it->get<int64_t>();
}
static int bounded(const Json &data, const char *key, int def, int minimum, int maximum,
                   std::vector<std::string> &changes) {
    auto n = integer(data, key, def), result = std::clamp<int64_t>(n, minimum, maximum);
    if (n != result)
        changes.push_back(std::string(key) + "=" + std::to_string(n) + "->" + std::to_string(result));
    return int(result);
}
static int64_t normalized(const Json &data, const char *key, int64_t def, int64_t minimum, int64_t maximum) {
    auto n = integer(data, key, def);
    return n < minimum || n > maximum ? def : n;
}
Policies load_policies(const fs::path &root) {
    auto d = read_json(root / "conf.d/go-collector.json");
    require(d.value("schemaVersion", 0) == 2, "collector policy schemaVersion must be 2");
    Policies p;
    auto log = d.value("logging", Json::object());
    p.logging.max_bytes = normalized(log, "maxFileBytes", 1'048'576, 65'536, 10'485'760);
    p.logging.max_files = int(normalized(log, "maxFiles", 3, 1, 10));
    p.logging.summary_ms = normalized(log, "summaryIntervalMs", 3'600'000, 60'000, 86'400'000);
    auto writer = d.value("writer", Json::object());
    p.queue_capacity = int(normalized(writer, "queueCapacity", 512, 1, 1024));
    p.flush_rows = int(normalized(writer, "flushMaxRows", 8192, 1, 65'535));
    p.flush_ms = normalized(writer, "flushIntervalMs", 1000, 1, 3'600'000);
    auto perf = d.value("performance", Json::object());
    p.performance = perf.value("enabled", false);
    p.overrun_detail = perf.value("overrunDetailEnabled", true);
    auto n = integer(perf, "jobSampleCount", 1000);
    if (n < 500) {
        p.corrections.push_back("jobSampleCount=" + std::to_string(n) + "->500");
        n = 500;
    }
    require(n <= INT_MAX, "jobSampleCount exceeds allocation range");
    p.job_samples = int(n);
    p.writer_summary_ms = integer(perf, "writerSummaryIntervalMs", 30'000);
    if (p.writer_summary_ms < 10'000) {
        p.corrections.push_back("writerSummaryIntervalMs=" + std::to_string(p.writer_summary_ms) + "->10000");
        p.writer_summary_ms = 10'000;
    }
    auto scheduling = d.value("scheduler", Json::object());
    require(scheduling.is_object(), "scheduler must be an object");
    p.scheduler_mode = scheduling.value("mode", std::string("conditional"));
    require(p.scheduler_mode == "off" || p.scheduler_mode == "conditional" || p.scheduler_mode == "force",
            "invalid scheduler mode");
    p.fifo = bounded(scheduling, "fifoPriority", 50, 0, 99, p.corrections);
    p.nice = bounded(scheduling, "nice", -10, -20, 19, p.corrections);
    p.gomaxprocs = bounded(scheduling, "gomaxprocs", 0, 0, 64, p.corrections);
    return p;
}
std::string Server::dsn() const {
    require(!host.empty(), "database host is required");
    require(!user.empty(), "database user is required");
    require(port >= 1 && port <= 65535, "database port is outside valid range");
    for (const auto &field : {host, user, password})
        require(field.find_first_of(";\r\n") == std::string::npos && field.find('\0') == std::string::npos,
                "native connection value contains an unsupported delimiter");
    return "SERVER=" + host + ";PORT_NO=" + std::to_string(port) + ";UID=" + upper(user) +
           ";PWD=" + password + ";CONNTYPE=1";
}
bool valid_bus_name(const std::string &value, bool unique_allowed, size_t maximum) {
    if (value.empty() || value.size() > maximum)
        return false;
    bool unique = value.front() == ':';
    if (unique && !unique_allowed)
        return false;
    size_t begin = unique ? 1 : 0;
    bool dot = false, first = true;
    for (size_t i = begin; i < value.size(); ++i) {
        unsigned char c = value[i];
        if (c == '.') {
            if (first)
                return false;
            dot = true;
            first = true;
            continue;
        }
        if (c >= 128 || !(std::isalnum(c) || c == '_' || (unique_allowed && c == '-')))
            return false;
        if (first && !unique && std::isdigit(c))
            return false;
        first = false;
    }
    return dot && !first;
}
unsigned address_bits(const std::string &address) {
    auto s = trim(address);
    size_t n = !s.empty() && s.front() == '%' ? 1 : 0;
    require(s.size() >= n + 2, "LS DeviceString does not include a data type");
    switch (std::toupper(static_cast<unsigned char>(s[n + 1]))) {
    case 'X':
        return 1;
    case 'B':
        return 8;
    case 'W':
        return 16;
    case 'D':
        return 32;
    case 'L':
        return 64;
    default:
        throw std::runtime_error("LS DeviceString data type must be X, B, W, D, or L");
    }
}
JobConfig load_job(const fs::path &root, const std::string &name) {
    require(valid_job_name(name), "invalid job name");
    auto index_file = root / "conf.d/job-index" / (name + ".json");
    require(fs::exists(index_file), "job is not registered; recreate the Job");
    auto index = read_json(index_file), data = read_json(root / "conf.d/jobs" / (name + ".json"));
    require(index.value("schemaVersion", 0) == 1 && index.value("name", "") == name &&
                index.value("revision", 0) >= 1,
            "job registration index is invalid; recreate the Job");
    require(data.value("schemaVersion", 0) == 1 && data.value("name", "") == name &&
                data.at("revision") == index.at("revision"),
            "job document does not match its registration index");
    JobConfig job;
    job.name = name;
    job.revision = data.at("revision");
    job.destination = trim(data.value("dbusDestination", std::string()));
    job.prefix = trim(data.value("dbusInterfacePrefix", std::string()));
    if (job.destination.empty())
        job.destination = "ls.plc";
    if (job.prefix.empty())
        job.prefix = "ls.plc";
    require(valid_bus_name(job.destination, true, 255), "invalid DBus service name");
    require(valid_bus_name(job.prefix, false, 247), "invalid DBus interface prefix");
    auto database = data.at("database");
    job.database = {database.value("server", ""), database.value("table", ""),
                    database.value("valueColumn", ""), database.value("stringValueColumn", "")};
    auto secrets = read_json(root / "conf.d/go-collector-secrets.json");
    require(secrets.value("schemaVersion", 0) == 1 && secrets.contains("servers"),
            "collector secret schema is invalid");
    require(secrets["servers"].contains(job.database.server), "database server secret not found");
    auto server = secrets["servers"][job.database.server];
    job.server = {server.value("host", ""),        server.value("user", ""),
                  server.value("password", ""),    server.value("defaultTable", ""),
                  server.value("valueColumn", ""), server.value("stringValueColumn", ""),
                  int(integer(server, "port", 0))};
    if (!job.server.table.empty())
        job.database.table = job.server.table;
    if (!job.server.value_column.empty())
        job.database.value_column = job.server.value_column;
    job.database.string_column = job.server.string_column;
    job.interval_ms = integer(data.at("schedule"), "intervalMs", 0);
    require(job.interval_ms >= 1 && job.interval_ms <= INT64_MAX / 1'000'000,
            "intervalMs must be at least 1 and fit a timer");
    job.absolute = data.at("schedule").value("useAbsoluteTimer", false);
    job.test = data.value("execution", Json::object()).value("test", false) &&
               upper(trim(job.database.table)) == "T4_DBUS_TEST_";
    job.level = upper(data.value("log", Json::object()).value("level", std::string("INFO")));
    require(!job.database.server.empty() && !job.database.table.empty() && !job.database.value_column.empty(),
            "job runtime configuration is incomplete");
    (void)quote_identifier(job.database.table);
    (void)quote_identifier(job.database.value_column);
    (void)job.server.dsn();
    for (auto &m : data.at("methodCalls")) {
        Call call;
        call.id = m.value("id", "");
        auto inputs = m.at("inputs");
        auto count = integer(inputs, "DataCount", 0);
        require(count >= 1 && count <= 65535, "invalid LS GetDeviceData input");
        call.count = int(count);
        call.address = inputs.at("DeviceString");
        call.bits = address_bits(call.address);
        call.offset = job.row_count;
        auto selections = m.value("outputSelections", Json::array());
        auto tags = selections.size() == 1 ? selections[0].at("tags") : m.value("tags", Json::array());
        require(tags.is_array() && tags.size() == size_t(count), "LS tag count does not match DataCount");
        for (auto &value : tags) {
            Tag tag;
            tag.name = value.at("name");
            require(!trim(tag.name).empty() && tag.name.find('\0') == std::string::npos,
                    "TAG name is empty or contains NUL");
            tag.bias = value.value("bias", 0.0);
            tag.multiplier =
                value.value("multiplier", 0.0); // Match omitted Go field; canonical JSH always sets 1.
            tag.signed_value = value.value("signed", false);
            auto order = value.value("transformOrder", std::vector<std::string>{});
            tag.multiply_first = order.size() == 2 && order[0] == "multiplier";
            auto conversion = value.value("conversion", std::string());
            if (conversion.empty() || conversion == (call.bits == 8    ? "BYTE2INT"
                                                     : call.bits == 16 ? "WORD2INT"
                                                     : call.bits == 32 ? "DWORD2INT"
                                                     : call.bits == 64 ? "LWORD2INT"
                                                                       : ""))
                tag.conversion = Conversion::Integer;
            else if (conversion == "DWORD2REAL" && call.bits == 32)
                tag.conversion = Conversion::Real32;
            else if (conversion == "LWORD2LREAL" && call.bits == 64)
                tag.conversion = Conversion::Real64;
            else
                throw std::runtime_error("conversion does not match LS address type");
            call.tags.push_back(std::move(tag));
        }
        require(job.row_count <= size_t(INT_MAX) - size_t(count), "LS Job row count is too large");
        job.row_count += size_t(count);
        job.calls.push_back(std::move(call));
    }
    require(!job.calls.empty(), "LS Job has no rows");
    return job;
}
std::vector<std::string> load_active(const fs::path &root) {
    auto p = root / "conf.d/go-collector-active-jobs.json";
    if (!fs::exists(p))
        return {};
    auto data = read_json(p);
    require(data.value("schemaVersion", 0) == 1, "active Job state schemaVersion must be 1");
    std::set<std::string> names;
    for (auto &value : data.value("names", Json::array())) {
        std::string name = value;
        require(valid_job_name(name), "active Job state contains invalid name");
        names.insert(name);
    }
    return {names.begin(), names.end()};
}
void convert_raw(uint64_t raw, unsigned bits, const Tag &tag, Row &row) {
    require(bits == 1 || bits == 8 || bits == 16 || bits == 32 || bits == 64, "invalid LS value codec");
    require(bits == 64 || raw <= (uint64_t(1) << bits) - 1, "value exceeds address type");
    if (tag.conversion == Conversion::Real32) {
        uint32_t v = uint32_t(raw);
        float f;
        memcpy(&f, &v, sizeof(f));
        row.floating_value = double(f);
        row.value_kind = 2;
    } else if (tag.conversion == Conversion::Real64) {
        memcpy(&row.floating_value, &raw, sizeof(raw));
        row.value_kind = 2;
    } else if (tag.signed_value && bits != 1) {
        if (bits == 64)
            memcpy(&row.signed_value, &raw, sizeof(raw));
        else
            row.signed_value = (raw & (uint64_t(1) << (bits - 1)))
                                   ? int64_t(raw) - int64_t(uint64_t(1) << bits)
                                   : int64_t(raw);
        row.value_kind = 1;
    } else {
        row.unsigned_value = raw;
        row.value_kind = 0;
    }
    if (tag.bias != 0 || tag.multiplier != 1) {
        double n = row.value_kind == 0   ? double(row.unsigned_value)
                   : row.value_kind == 1 ? double(row.signed_value)
                                         : row.floating_value;
        row.floating_value =
            tag.multiply_first ? n * tag.multiplier + tag.bias : (n + tag.bias) * tag.multiplier;
        row.value_kind = 2;
    }
}
void generate_rows(const JobConfig &job, std::vector<Row> &rows) {
    require(rows.size() == job.row_count, "LS test buffer does not match prepared layout");
    Ns now = clock_ns(CLOCK_REALTIME);
    for (auto &call : job.calls)
        for (int i = 0; i < call.count; ++i) {
            auto &tag = call.tags[size_t(i)];
            uint64_t raw = uint64_t(i);
            if (tag.conversion == Conversion::Real32) {
                float f = float(i);
                uint32_t bits;
                memcpy(&bits, &f, sizeof(bits));
                raw = bits;
            } else if (tag.conversion == Conversion::Real64) {
                double f = double(i);
                memcpy(&raw, &f, sizeof(raw));
            } else if (call.bits < 64)
                raw &= (uint64_t(1) << call.bits) - 1;
            auto &row = rows[call.offset + size_t(i)];
            row = {};
            row.tag_index = int32_t(tag.index);
            row.timestamp_ns = now;
            convert_raw(raw, call.bits, tag, row);
        }
}
void convert_column(Row &row, int type) {
    const auto kind = row.value_kind;
    if (type == 16 || type == 20) {
        double n = kind == 0   ? double(row.unsigned_value)
                   : kind == 1 ? double(row.signed_value)
                               : row.floating_value;
        require(std::isfinite(n), "value is not finite");
        row.floating_value = n;
        return;
    }
    long double n = kind == 0   ? static_cast<long double>(row.unsigned_value)
                    : kind == 1 ? static_cast<long double>(row.signed_value)
                                : static_cast<long double>(row.floating_value);
    require(std::isfinite(n), "value is not finite");
    require(std::trunc(n) == n, "integer VALUE column cannot store a fractional result");
    auto signed_range = [&](long double minimum, long double maximum) {
        require(n >= minimum && n <= maximum, "value is outside VALUE column range");
        row.signed_value = static_cast<int64_t>(n);
    };
    auto unsigned_range = [&](long double maximum) {
        require(n >= 0 && n <= maximum, "value is outside VALUE column range");
        row.unsigned_value = static_cast<uint64_t>(n);
    };
    switch (type) {
    case 4:
        signed_range(INT16_MIN, INT16_MAX);
        break;
    case 8:
        signed_range(INT32_MIN, INT32_MAX);
        break;
    case 12:
        signed_range(static_cast<long double>(INT64_MIN), static_cast<long double>(INT64_MAX));
        break;
    case 104:
        unsigned_range(UINT16_MAX);
        break;
    case 108:
        unsigned_range(UINT32_MAX);
        break;
    case 112:
        unsigned_range(static_cast<long double>(UINT64_MAX));
        break;
    default:
        throw std::runtime_error("VALUE column type is not numeric");
    }
}
RowPool::RowPool(const JobConfig &job) : tags_(job.row_count) {
    idle_.reserve(32); // Returning a lease must not allocate or throw.
    for (auto &call : job.calls)
        for (size_t i = 0; i < call.tags.size(); ++i)
            tags_[call.offset + i] = int32_t(call.tags[i].index);
    for (int i = 0; i < 4; ++i)
        idle_.push_back(std::make_unique<std::vector<Row>>(job.row_count));
}
void RowPool::Return::operator()(std::vector<Row> *rows) const noexcept {
    if (rows) {
        // reset() destroys the data without destroying the unique_ptr/deleter.
        // An empty lease must not retain a retired Job pool indefinitely.
        auto keep_alive = std::move(owner);
        keep_alive->recycle(std::unique_ptr<std::vector<Row>>(rows));
    }
}
RowPool::Lease RowPool::acquire() {
    std::unique_ptr<std::vector<Row>> rows;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        require(!retired_, "row buffer pool is closed");
        if (!idle_.empty()) {
            rows = std::move(idle_.back());
            idle_.pop_back();
        }
    }
    if (!rows)
        rows = std::make_unique<std::vector<Row>>(tags_.size());
    for (size_t i = 0; i < rows->size(); ++i)
        (*rows)[i].tag_index = tags_[i];
    auto owner = shared_from_this();
    ++outstanding_;
    return Lease(rows.release(), Return{std::move(owner)});
}
void RowPool::recycle(std::unique_ptr<std::vector<Row>> rows) noexcept {
    std::fill(rows->begin(), rows->end(), Row{});
    std::lock_guard<std::mutex> lock(mutex_);
    if (!retired_ && idle_.size() < 32)
        idle_.push_back(std::move(rows));
    --outstanding_;
}
int64_t RowPool::retire() {
    std::lock_guard<std::mutex> lock(mutex_);
    retired_ = true;
    idle_.clear();
    return outstanding_.load();
}
size_t RowPool::idle_count() {
    std::lock_guard<std::mutex> lock(mutex_);
    return idle_.size();
}
} // namespace collector
