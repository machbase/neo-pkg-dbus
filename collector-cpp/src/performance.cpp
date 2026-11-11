#include "performance.hpp"
#include <iomanip>
#include <sstream>
namespace collector {
static Ns positive(Ns value) { return std::max<Ns>(0, value); }
void ring(std::vector<int64_t> &values, size_t &next, int64_t value, size_t maximum) {
    if (values.size() < maximum)
        values.push_back(value);
    else {
        values[next] = value;
        next = (next + 1) % maximum;
    }
}
Quantiles quantiles(std::vector<int64_t> values) {
    if (values.empty())
        return {};
    std::sort(values.begin(), values.end());
    long double sum = 0;
    for (auto v : values)
        sum += v;
    auto percentile = [&](size_t numerator) { return values[(values.size() * numerator + 99) / 100 - 1]; };
    return {values.front(), percentile(50), int64_t(sum / values.size()), percentile(99), values.back()};
}
static std::string dbus(const ReadTiming &read) {
    return read.dbus_measured ? std::to_string(read.dbus / 1000) : "n/a";
}
static std::string detail(const std::optional<Overrun> &value) {
    if (!value)
        return {};
    auto &v = *value;
    return " lastOverrun[skippedAt=" + utc(v.at) + " skippedCycles=" + std::to_string(v.count) +
           " intervalUs=" + std::to_string(v.interval / 1000) +
           " timerWakeLagUs=" + std::to_string(v.wake_lag / 1000) +
           " readerStartLagUs=" + std::to_string(v.start_lag / 1000) +
           " skippedTimerWakeLagUs=n/a detectedLagUs=" + std::to_string(v.detected / 1000) +
           " readerTotalUs=" + std::to_string(v.total / 1000) +
           " dbusUs=" + (v.dbus_measured ? std::to_string(v.dbus / 1000) : "n/a") +
           " parseUs=" + (v.parse_measured ? std::to_string(v.parse / 1000) : "n/a") + "]";
}
std::string format_job_performance(const std::string &name, const PerfWindow &w) {
    std::vector<int64_t> db, total;
    long double parse = 0;
    int64_t parse_max = 0;
    size_t parsed = 0;
    ReadTiming minimum, maximum;
    bool first = true;
    for (auto &r : w.reads) {
        total.push_back(r.total / 1000);
        if (r.dbus_measured)
            db.push_back(r.dbus / 1000);
        if (r.parse_measured) {
            parse += r.parse / 1000;
            parse_max = std::max(parse_max, r.parse / 1000);
            ++parsed;
        }
        if (first || r.total / 1000 < minimum.total / 1000)
            minimum = r;
        if (first || r.total / 1000 > maximum.total / 1000)
            maximum = r;
        first = false;
    }
    auto d = quantiles(std::move(db)), r = quantiles(std::move(total)), wake = quantiles(w.wake),
         dispatch = quantiles(w.dispatch), start = quantiles(w.start);
    std::ostringstream s;
    s << "job=" << name << " job summary; source=" << w.source << " samples=" << w.reads.size()
      << " dbusUs[avg=" << d.avg << " p99=" << d.p99 << " max=" << d.max << "]"
      << " parseUs[avg=" << (parsed ? int64_t(parse / parsed) : 0) << " max=" << parse_max << "]"
      << " readerTotalUs[min=" << r.min << "(dbus=" << dbus(minimum) << ") p99=" << r.p99 << " max=" << r.max
      << "(dbus=" << dbus(maximum) << ")]"
      << " scheduleSamples[wake=" << w.wakes << " start=" << w.starts << "]"
      << " scheduleLagUs[timerWakeP50=" << wake.p50 << " timerWakeP99=" << wake.p99
      << " timerWakeMax=" << wake.max << " dispatchP99=" << dispatch.p99 << " dispatchMax=" << dispatch.max
      << " readerStartP99=" << start.p99 << " readerStartMax=" << start.max << "]"
      << " lateCount[1ms=" << w.late1 << " 3ms=" << w.late3 << " 5ms=" << w.late5
      << "] clockAnomalyCount=" << w.clock_resets << " skipCount=" << w.skips + w.queue_skips
      << " overIntervalCount=" << w.skips << " queueFullSkipCount=" << w.queue_skips
      << " errorCount=" << w.errors << detail(w.last);
    return s.str();
}
JobPerformance::JobPerformance(const Policies &policy, std::string name, std::string source,
                               AsyncLogger &logger)
    : policy_(policy), name_(std::move(name)), logger_(logger) {
    current_ = std::make_shared<PerfWindow>();
    current_->source = std::move(source);
    if (policy_.performance) {
        current_->reads.reserve(size_t(policy_.job_samples));
        current_->wake.reserve(size_t(policy_.job_samples));
        current_->start.reserve(size_t(policy_.job_samples));
        current_->dispatch.reserve(size_t(policy_.job_samples));
    }
}
void JobPerformance::reset() {
    auto source = current_->source;
    current_ = std::make_shared<PerfWindow>();
    current_->source = std::move(source);
    current_->reads.reserve(size_t(policy_.job_samples));
    current_->wake.reserve(size_t(policy_.job_samples));
    current_->start.reserve(size_t(policy_.job_samples));
    current_->dispatch.reserve(size_t(policy_.job_samples));
}
void JobPerformance::schedule(const Tick &tick, Ns entered) {
    if (!policy_.performance)
        return;
    auto &w = *current_;
    ++w.wakes;
    ++w.starts;
    auto lag = positive(entered - tick.scheduled) / 1000;
    if (tick.wake < tick.scheduled)
        ++w.clock_resets;
    // Retain the Go implementation's statistics population: bounded recent
    // wake samples, and every actual dispatch/start in this read-attempt window.
    ring(w.wake, w.wake_next, positive(tick.wake - tick.scheduled) / 1000, 4096);
    w.dispatch.push_back(positive(entered - tick.wake) / 1000);
    w.start.push_back(lag);
    if (lag >= 1000)
        ++w.late1;
    if (lag >= 3000)
        ++w.late3;
    if (lag >= 5000)
        ++w.late5;
}
void JobPerformance::skipped(const Skipped &skip, Ns detected, CycleDetail *previous, Ns interval) {
    if (!policy_.performance)
        return;
    current_->skips += skip.count;
    if (skip.clock_reset)
        ++current_->clock_resets;
    if (!skip.count || !previous || !previous->read.attempt)
        return;
    previous->skips += skip.count;
    if (!policy_.overrun_detail)
        return;
    auto &r = previous->read;
    current_->last = Overrun{skip.last_wall,
                             interval,
                             positive(previous->tick.wake - previous->tick.scheduled),
                             positive(previous->entered - previous->tick.scheduled),
                             r.total,
                             r.dbus,
                             r.parse,
                             positive(detected - skip.last_mono),
                             previous->skips,
                             r.dbus_measured,
                             r.parse_measured};
}
void JobPerformance::queue_full() {
    if (policy_.performance)
        ++current_->queue_skips;
}
void JobPerformance::read(const ReadTiming &timing) {
    if (!policy_.performance || !timing.attempt)
        return;
    current_->reads.push_back(timing);
    if (timing.error)
        ++current_->errors;
    if (current_->reads.size() >= size_t(policy_.job_samples)) {
        auto snapshot = current_;
        reset();
        auto name = name_;
        logger_.lazy(name, "INFO", "performance",
                     [snapshot, name] { return format_job_performance(name, *snapshot); });
    }
}
std::string format_writer_performance(WriterWindow w, Ns now, int depth, const Policies &policy) {
    auto append = quantiles(std::move(w.append)), flush = quantiles(std::move(w.flush)),
         durable = quantiles(std::move(w.durable));
    Ns duration = std::max<Ns>(1, now - w.started);
    std::ostringstream s;
    s << "writer summary; duration=" << std::fixed << std::setprecision(3)
      << double(duration) / 1e9 << "s maxQueueDepth=" << depth << " queueCapacity=" << policy.queue_capacity
      << " busyRatio=" << std::setprecision(2) << double(w.busy) * 100 / double(duration)
      << "% appendBatches=" << w.batches << " appendRows=" << w.rows
      << " appendRowsPerSec=" << std::setprecision(0)
      << (w.append_busy ? double(w.rows) * 1e9 / double(w.append_busy) : 0) << " appendUs[avg=" << append.avg
      << " p99=" << append.p99 << " max=" << append.max << "] flushIntervalMs=" << policy.flush_ms
      << " flushCount=" << w.flushes << " flushErrorCount=" << w.flush_errors << " flushMaxUs=" << flush.max
      << " queueToDurableUs[p99=" << durable.p99 << " max=" << durable.max << "]";
    return s.str();
}
} // namespace collector
