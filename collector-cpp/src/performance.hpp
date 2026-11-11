#pragma once
#include "logger.hpp"
#include "timer.hpp"
namespace collector {
struct ReadTiming {
    Ns dbus = 0, parse = 0, total = 0;
    bool dbus_measured = false, parse_measured = false, attempt = false, error = false;
};
struct CycleDetail {
    Tick tick;
    Ns entered = 0;
    ReadTiming read;
    uint64_t skips = 0;
};
struct Overrun {
    Ns at = 0, interval = 0, wake_lag = 0, start_lag = 0, total = 0, dbus = 0, parse = 0, detected = 0;
    uint64_t count = 0;
    bool dbus_measured = false, parse_measured = false;
};
struct PerfWindow {
    std::string source;
    std::vector<ReadTiming> reads;
    std::vector<int64_t> wake, start, dispatch;
    size_t wake_next = 0, start_next = 0, dispatch_next = 0;
    uint64_t wakes = 0, starts = 0, late1 = 0, late3 = 0, late5 = 0, clock_resets = 0, skips = 0,
             queue_skips = 0, errors = 0;
    std::optional<Overrun> last;
};
struct Quantiles {
    int64_t min = 0, p50 = 0, avg = 0, p99 = 0, max = 0;
};
Quantiles quantiles(std::vector<int64_t> values);
void ring(std::vector<int64_t> &values, size_t &next, int64_t value, size_t maximum);
std::string format_job_performance(const std::string &name, const PerfWindow &window);
class JobPerformance {
    Policies policy_;
    std::string name_;
    AsyncLogger &logger_;
    std::shared_ptr<PerfWindow> current_;
    void reset();

  public:
    JobPerformance(const Policies &policy, std::string name, std::string source, AsyncLogger &logger);
    void schedule(const Tick &tick, Ns entered);
    void skipped(const Skipped &skip, Ns detected, CycleDetail *previous, Ns interval);
    void queue_full();
    void read(const ReadTiming &timing);
};
struct WriterWindow {
    Ns started = clock_ns(), busy = 0, append_busy = 0;
    uint64_t batches = 0, rows = 0, flushes = 0, flush_errors = 0;
    size_t append_next = 0, flush_next = 0, durable_next = 0;
    std::vector<int64_t> append, flush, durable;
};
std::string format_writer_performance(WriterWindow window, Ns now, int depth, const Policies &policy);
} // namespace collector
