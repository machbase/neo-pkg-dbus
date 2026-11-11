#include "daemon.hpp"
#include <pthread.h>
namespace collector {
bool Daemon::reserve() {
    std::lock_guard<std::mutex> lock(pipe_mutex_);
    if (writer_closed_ || reservations_ >= size_t(policy_.queue_capacity))
        return false;
    ++reservations_;
    return true;
}
void Daemon::unreserve() {
    std::lock_guard<std::mutex> lock(pipe_mutex_);
    require(reservations_ > 0, "queue reservation underflow");
    --reservations_;
}
void Daemon::enqueue(Batch batch) {
    std::lock_guard<std::mutex> lock(pipe_mutex_);
    require(!writer_closed_, "writer no longer accepts data");
    auto owner = batch.job;
    owner->add_work();
    try {
        queue_.push_back(std::move(batch));
    } catch (...) {
        owner->end_work();
        throw;
    }
    int depth = int(queue_.size());
    queue_depth_ = depth;
    int maximum = queue_peak_.load();
    while (maximum < depth && !queue_peak_.compare_exchange_weak(maximum, depth)) {
    }
    pipe_changed_.notify_all();
}
Daemon::OpenReply Daemon::writer_command(const std::shared_ptr<Job> &job, WriterCommand::Kind kind,
                                         TableSchema schema, std::vector<std::string> names) {
    auto command = std::make_shared<WriterCommand>();
    command->job = job;
    command->kind = kind;
    command->schema = std::move(schema);
    command->names = std::move(names);
    command->generation = job->generation;
    auto reply = command->result.get_future();
    {
        std::lock_guard<std::mutex> lock(pipe_mutex_);
        require(!writer_closed_, "writer is shutting down");
        commands_.push_back(command);
    }
    pipe_changed_.notify_all();
    while (reply.wait_for(20ms) != std::future_status::ready)
        require(!job->cancel.stopped(), "operation cancelled");
    return reply.get();
}
void Daemon::writer_loop() {
    pthread_setname_np(pthread_self(), "dbus-writer");
    std::unique_ptr<NativeAppender> app;
    uint64_t app_generation = 0;
    std::vector<Pending> pending;
    pending.reserve(256);
    // Completion ownership survives unwinding of the currently dequeued batch.
    // Otherwise a fatal writer exception could leave Job Stop waiting forever.
    std::optional<Pending> in_flight;
#ifdef COLLECTOR_TESTING
    const int delay_ms = getenv("NEO_DBUS_CPP_TEST_APPEND_DELAY_MS")
                             ? std::clamp(atoi(getenv("NEO_DBUS_CPP_TEST_APPEND_DELAY_MS")), 0, 1000)
                             : 0;
    const int fail_at =
        getenv("NEO_DBUS_CPP_TEST_APPEND_FAIL_AT") ? atoi(getenv("NEO_DBUS_CPP_TEST_APPEND_FAIL_AT")) : 0;
    const int fatal_at =
        getenv("NEO_DBUS_CPP_TEST_WRITER_FAIL_AT") ? atoi(getenv("NEO_DBUS_CPP_TEST_WRITER_FAIL_AT")) : 0;
    int append_attempts = 0;
#endif
    WriterWindow stats;
    Ns next_flush = clock_ns() + policy_.flush_ms * 1'000'000,
       next_summary = clock_ns() + policy_.writer_summary_ms * 1'000'000;
    auto finish = [&](Pending item, const std::string &failure) {
        if (failure.empty()) {
            success(item);
            ring(stats.durable, stats.durable_next, std::max<Ns>(0, clock_ns() - item.enqueued) / 1000, 4096);
        } else
            error(item.job, failure);
        if (item.prime)
            item.prime->finish(failure);
        item.job->end_work();
    };
    auto flush = [&]() {
        if (!app || pending.empty())
            return;
        Ns started = clock_ns();
        std::string failure;
        try {
            app->flush();
        } catch (const std::exception &error) {
            failure = error.what();
        }
        Ns elapsed = clock_ns() - started;
        stats.busy += elapsed;
        ++stats.flushes;
        ring(stats.flush, stats.flush_next, elapsed / 1000, 4096);
        if (!failure.empty()) {
            ++stats.flush_errors;
            app.reset();
        }
        for (auto &item : pending)
            finish(std::move(item), failure);
        pending.clear();
    };
    auto open = [&](const std::shared_ptr<Job> &job, TableSchema shape, bool draining = false) {
        if (app && app->matches(job->config) && app_generation == job->generation)
            return;
        flush();
        if (app) {
            try {
                app->close();
            } catch (const std::exception &failure) {
                logger_.log("_collector", "ERROR", "writer", failure.what(), true);
            }
            app.reset();
        }
        require(draining || !job->cancel.stopped(), "operation cancelled");
        if (shape.kinds.empty()) {
            NativeSql sql(job->config.server, draining ? nullptr : &job->cancel);
            shape = table_schema(sql, job->config);
        }
        app = std::make_unique<NativeAppender>(job->config, std::move(shape));
        app_generation = job->generation;
    };
    auto publish_summary = [&]() {
        if (!policy_.performance)
            return;
        auto now = clock_ns();
        auto value = std::make_shared<WriterWindow>(std::move(stats));
        stats = WriterWindow{};
        int depth = queue_peak_.exchange(queue_depth_.load());
        auto policy = policy_;
        for (auto &name : active_names())
            logger_.lazy(name, "INFO", "performance", [value, now, depth, policy] {
                return format_writer_performance(*value, now, depth, policy);
            });
    };
    try {
        for (;;) {
            Ns now = clock_ns();
            if (now >= next_flush) {
                flush();
                next_flush = clock_ns() + policy_.flush_ms * 1'000'000;
            }
            if (now >= next_summary) {
                publish_summary();
                next_summary = clock_ns() + policy_.writer_summary_ms * 1'000'000;
            }
            std::shared_ptr<WriterCommand> command;
            std::optional<Batch> batch;
            bool done = false;
            {
                std::unique_lock<std::mutex> lock(pipe_mutex_);
                if (commands_.empty() && queue_.empty() && !writer_closed_)
                    pipe_changed_.wait_for(
                        lock,
                        std::chrono::nanoseconds(
                            std::max<Ns>(0, std::min(next_flush, next_summary) - clock_ns())),
                        [&] { return writer_closed_ || !commands_.empty() || !queue_.empty(); });
                if (!commands_.empty()) {
                    command = commands_.front();
                    commands_.pop_front();
                } else if (!queue_.empty()) {
                    batch.emplace(std::move(queue_.front()));
                    queue_.pop_front();
                    in_flight = Pending{batch->job, batch->rows->size(), batch->enqueued, batch->prime};
                    require(reservations_ > 0, "writer queue reservation underflow");
                    --reservations_;
                    queue_depth_ = int(queue_.size());
                }
                done = writer_closed_ && commands_.empty() && queue_.empty() && !command && !batch;
            }
            if (done)
                break;
            if (command) {
                try {
                    if (command->kind == WriterCommand::Clear) {
                        require(pending.empty(), "cannot reset TAG registry while batches are pending");
                        if (app)
                            app->clear_tags();
                        app_generation = command->generation;
                        command->result.set_value({});
                    } else {
                        require(!command->job->cancel.stopped(), "operation cancelled");
                        open(command->job, command->schema);
                        if (command->kind == WriterCommand::Cache)
                            app->cache_tags(command->names);
                        command->result.set_value(OpenReply{app->schema, app->prepared});
                    }
                } catch (...) {
                    command->result.set_exception(std::current_exception());
                }
                continue;
            }
            if (!batch)
                continue;
#ifdef COLLECTOR_TESTING
            ++append_attempts;
            require(append_attempts != fatal_at, "injected fatal writer failure");
#endif
            auto job = batch->job;
            size_t count = batch->rows->size();
            std::string failure;
            Ns started = clock_ns();
            try {
#ifdef COLLECTOR_TESTING
                if (delay_ms)
                    std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms));
                require(append_attempts != fail_at, "injected recoverable append failure");
#endif
                open(job, {}, true);
                if (app->prepared < job->names.size())
                    app->cache_tags(job->names);
                app->append(*batch->rows);
            } catch (const std::exception &error) {
                failure = error.what();
            }
            Ns elapsed = clock_ns() - started;
            stats.busy += elapsed;
            stats.append_busy += elapsed;
            ++stats.batches;
            stats.rows += count;
            ring(stats.append, stats.append_next, elapsed / 1000, 4096);
            // SQLAppendDataV2 consumes the numeric rows synchronously. Only
            // completion metadata, never the large row array, waits for Flush.
            batch->rows.reset();
            Pending item = *in_flight;
            // The current native backend deliberately uses periodic Flush,
            // including priming/Stop. Keep that policy during the migration.
            if (failure.empty())
                pending.push_back(std::move(item));
            else {
                for (auto &earlier : pending)
                    finish(std::move(earlier), failure);
                pending.clear();
                app.reset();
                finish(std::move(item), failure);
            }
            in_flight.reset();
        }
        flush();
        if (app) {
            app->close();
            app.reset();
        }
    } catch (const std::exception &fatal) {
        writer_failed_ = true;
        logger_.log("_collector", "ERROR", "writer", std::string("writer stopped: ") + fatal.what(), true);
        if (in_flight) {
            finish(std::move(*in_flight), fatal.what());
            in_flight.reset();
        }
        for (auto &item : pending)
            finish(std::move(item), fatal.what());
        pending.clear();
        std::deque<Batch> abandoned;
        std::deque<std::shared_ptr<WriterCommand>> commands;
        {
            std::lock_guard<std::mutex> lock(pipe_mutex_);
            writer_closed_ = true;
            abandoned.swap(queue_);
            commands.swap(commands_);
            require(reservations_ >= abandoned.size(), "fatal queue reservation underflow");
            reservations_ -= abandoned.size();
            queue_depth_ = 0;
        }
        for (auto &item : abandoned) {
            item.rows.reset();
            finish(Pending{item.job, 0, item.enqueued, item.prime}, fatal.what());
        }
        for (auto &item : commands)
            try {
                item->result.set_exception(std::make_exception_ptr(std::runtime_error(fatal.what())));
            } catch (...) {
            }
        std::lock_guard<std::mutex> lock(jobs_mutex_);
        for (auto &item : jobs_) {
            item.second->set_state("failed", fatal.what());
            item.second->cancel.stop();
        }
        mark_dirty();
    }
}
} // namespace collector
