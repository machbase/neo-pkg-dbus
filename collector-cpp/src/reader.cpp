#include "daemon.hpp"
namespace collector {
void Daemon::read_loop(const std::shared_ptr<Job> &job) {
    auto &config = job->config;
    std::string source = config.test ? "test" : "dbus";
#ifdef COLLECTOR_TESTING
    // Test builds can replay wire-shaped JSON without creating any DBUS
    // connection. This switch is absent from the delivery executable.
    bool replay = getenv("NEO_DBUS_CPP_REPLAY") && std::string(getenv("NEO_DBUS_CPP_REPLAY")) == "1";
    std::vector<std::string> prefixes;
    if (replay) {
        source = "json-replay-no-dbus";
        for (auto &call : config.calls) {
            std::string prefix = "{\"rtn\":1,\"data-count\":" + std::to_string(call.count) + ",\"data\":[";
            for (int n = 0; n < call.count; ++n)
                prefix += (n ? ",250" : "250");
            prefixes.push_back(prefix + "],\"time-stamp-us\":");
        }
    }
#endif
    JobPerformance performance(policy_, config.name, source, logger_);
    CycleTimer timer(config.interval_ms * 1'000'000, config.absolute, job->cancel);
    job->set_state("running");
    mark_dirty();
    checkpoint(true);
    logger_.log(config.name, "INFO", "collector",
                "collector started; source=" + source + " intervalMs=" + std::to_string(config.interval_ms) +
                    " timerMode=" + (config.absolute ? "absolute" : "standard") +
                    " dbusDestination=" + config.destination + " dbusInterfacePrefix=" + config.prefix);
    if (policy_.performance) {
        std::string message =
            "performance logging enabled; jobSampleCount=" + std::to_string(policy_.job_samples) +
            " writerSummaryIntervalMs=" + std::to_string(policy_.writer_summary_ms) +
            " writerFlushIntervalMs=" + std::to_string(policy_.flush_ms);
        for (auto &correction : policy_.corrections)
            message += " correction=" + correction;
        logger_.log(config.name, "INFO", "performance", std::move(message), true);
    }
    // Bus cleanup and pool/drain/log cleanup happen AFTER the scope restores
    // ordinary policy. Only the serial timer/read/parse/handoff loop is FIFO.
    std::unique_ptr<DeviceBus> bus;
    auto scheduling = scheduling_.enter([&](const std::string &level, const std::string &message) {
        logger_.log(config.name, level, "scheduler", message, true);
    });
    bool primed = false, previous_normal = false;
    std::optional<CycleDetail> previous;
    auto account = [&](const Skipped &missed, Ns detected, CycleDetail *cycle, bool normal) {
        if (!normal)
            return;
        if (missed.count)
            skip(job, false, missed.count);
        performance.skipped(missed, detected, cycle, timer.interval());
    };
    while (!job->cancel.stopped() && !writer_failed_) {
        Ns now = clock_ns();
        account(timer.advance(now), now, previous ? &*previous : nullptr, previous_normal);
        auto tick = timer.wait();
        if (!tick)
            break;
        CycleDetail current;
        current.tick = *tick;
        current.entered = clock_ns();
        bool normal = primed;
        auto &timing = current.read;
        bool slot = false, enqueued = false, first_ok = false;
        RowPool::Lease rows;
        try {
            slot = reserve();
            if (!slot) {
                if (!job->cancel.stopped() && !writer_failed_) {
                    skip(job, true);
                    performance.queue_full();
                }
            } else {
                timing.attempt = true;
                rows = job->pool->acquire();
                if (config.test) {
                    generate_rows(config, *rows);
                } else {
#ifdef COLLECTOR_TESTING
                    if (!replay) {
#endif
                        if (bus && !bus->connected())
                            bus.reset();
                        if (!bus)
                            bus = std::make_unique<DeviceBus>(job->cancel);
#ifdef COLLECTOR_TESTING
                    }
#endif
                    for (size_t index = 0; index < config.calls.size(); ++index) {
                        auto &call = config.calls[index];
                        const char *body = nullptr;
#ifdef COLLECTOR_TESTING
                        std::string replay_body;
                        if (replay) {
                            replay_body =
                                prefixes[index] + std::to_string(clock_ns(CLOCK_REALTIME) / 1000) + "}";
                            body = replay_body.c_str();
                        } else {
#endif
                            Ns start = clock_ns();
                            try {
                                body = bus->read(config, call);
                            } catch (...) {
                                timing.dbus += clock_ns() - start;
                                timing.dbus_measured = true;
                                throw;
                            }
                            timing.dbus += clock_ns() - start;
                            timing.dbus_measured = true;
#ifdef COLLECTOR_TESTING
                        }
#endif
                        if (job->cancel.stopped())
                            break;
                        Ns parse_start = clock_ns();
                        try {
                            decode_rows(body, call, *rows);
                        } catch (...) {
                            timing.parse += clock_ns() - parse_start;
                            timing.parse_measured = true;
                            throw;
                        }
                        timing.parse += clock_ns() - parse_start;
                        timing.parse_measured = true;
                    }
                }
                if (!job->cancel.stopped()) {
                    job->last_read = clock_ns(CLOCK_REALTIME);
                    mark_dirty();
                    auto completion = primed ? nullptr : std::make_shared<Completion>();
                    enqueue(Batch{job, std::move(rows), clock_ns(), completion});
                    slot = false;
                    enqueued = true;
                    timing.total = clock_ns() - current.entered;
                    if (completion)
                        first_ok = completion->wait(job->cancel);
                }
            }
        } catch (const std::exception &failure) {
            if (!job->cancel.stopped()) {
                timing.error = true;
                error(job, failure.what());
            }
        }
        rows.reset();
        if (slot)
            unreserve();
        if (timing.attempt && !enqueued)
            timing.total = clock_ns() - current.entered;
        if (job->cancel.stopped())
            timing.attempt = false;
        Ns completed = clock_ns();
        if (job->cancel.at() && job->cancel.at() < completed)
            completed = job->cancel.at();
        performance.schedule(*tick, current.entered);
        account(timer.advance(completed), completed, &current, normal);
        performance.read(timing);
        if (first_ok)
            primed = true;
        previous = current;
        previous_normal = normal;
    }
    scheduling.reset(); // No FIFO filesystem I/O, allocator teardown or drain.
    // Preserve the existing sample-count cadence; Stop does not manufacture a
    // partial performance window. Already queued complete windows are drained.
}
} // namespace collector
