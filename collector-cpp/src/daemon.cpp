#include "daemon.hpp"
#include <iostream>
#include <pthread.h>
namespace collector {
static std::string preparation_message(const char *label, const Job &job, const Preparation &stats,
                                       Ns elapsed) {
    return std::string(label) + "; table=" + job.config.database.table +
           " requiredTags=" + std::to_string(job.names.size()) +
           " candidates=" + std::to_string(stats.candidates) + " existing=" + std::to_string(stats.existing) +
           " missing=" + std::to_string(stats.missing) + " registered=" + std::to_string(stats.registered) +
           " reused=" + (stats.reused ? "true" : "false") +
           " metadataUs=" + std::to_string(stats.metadata / 1000) +
           " registrationUs=" + std::to_string(stats.registration / 1000) +
           " totalUs=" + std::to_string(elapsed / 1000);
}
void Job::set_state(std::string value, std::string explanation) {
    std::lock_guard<std::mutex> lock(state_mutex);
    state = std::move(value);
    detail = std::move(explanation);
}
void Job::add_work() {
    std::lock_guard<std::mutex> lock(work_mutex);
    ++pending;
}
void Job::end_work() {
    std::lock_guard<std::mutex> lock(work_mutex);
    require(pending > 0, "pending batch underflow");
    --pending;
    work_changed.notify_all();
}
void Job::drain() {
    std::unique_lock<std::mutex> lock(work_mutex);
    work_changed.wait(lock, [&] { return pending == 0; });
}
Json Job::runtime() {
    Json out;
    {
        std::lock_guard<std::mutex> lock(state_mutex);
        out = {{"name", config.name},
               {"state", state},
               {"overrunCount", 0},
               {"queueSkipped", 0},
               {"rowsStored", rows_stored.load()}};
        if (!detail.empty())
            out["stateDetail"] = detail;
        if (!last_error.empty())
            out["lastError"] = last_error;
    }
    {
        std::lock_guard<std::mutex> lock(counter_mutex);
        out["overrunCount"] = overruns;
        out["queueSkipped"] = queue_skipped;
        if (last_overrun)
            out["lastOverrunAt"] = utc(last_overrun);
    }
    if (auto n = last_read.load())
        out["lastReadAt"] = utc(n);
    if (auto n = last_stored.load())
        out["lastStoredAt"] = utc(n);
    return out;
}
Daemon::Daemon(fs::path root, Policies policy, Scheduler scheduler, AsyncLogger &logger)
    : root_(std::move(root)), policy_(std::move(policy)), scheduling_(std::move(scheduler)), logger_(logger) {
    checkpoint(true);
    writer_ = std::thread([this] { writer_loop(); });
}
Daemon::~Daemon() {
    try {
        shutdown();
    } catch (const std::exception &e) {
        std::cerr << "neo-dbus-collector: shutdown: " << e.what() << "\n";
    }
}
void Daemon::mark_dirty() {
    updated_ = clock_ns(CLOCK_REALTIME);
    dirty_ = true;
}
void Daemon::remember_locked(const std::shared_ptr<Job> &job) {
    auto value = job->runtime();
    auto old = history_.find(job->config.name);
    if (old != history_.end())
        for (auto key : {"lastReadAt", "lastStoredAt"})
            if (!value.contains(key) && old->second.contains(key))
                value[key] = old->second[key];
    history_[job->config.name] = std::move(value);
}
std::shared_ptr<std::mutex> Daemon::operation(const std::string &name) {
    std::lock_guard<std::mutex> lock(locks_mutex_);
    auto value = locks_[name].lock();
    if (!value) {
        value = std::make_shared<std::mutex>();
        locks_[name] = value;
    }
    return value;
}
void Daemon::active(const std::string &name, bool enabled) {
    std::lock_guard<std::mutex> lock(active_mutex_);
    auto old = load_active(root_);
    std::set<std::string> names(old.begin(), old.end());
    if (enabled)
        names.insert(name);
    else
        names.erase(name);
    write_json_atomic(
        root_ / "conf.d/go-collector-active-jobs.json",
        Json{{"schemaVersion", 1}, {"names", std::vector<std::string>(names.begin(), names.end())}});
}
void Daemon::start(const std::string &name) {
    require(!closed_, "collector is shutting down");
    std::shared_ptr<Job> previous;
    {
        std::lock_guard<std::mutex> lock(jobs_mutex_);
        auto it = jobs_.find(name);
        if (it != jobs_.end())
            previous = it->second;
    }
    if (previous) {
        if (!previous->finished)
            return;
        if (previous->worker.joinable())
            previous->worker.join();
        {
            std::lock_guard<std::mutex> lock(jobs_mutex_);
            remember_locked(previous);
            jobs_.erase(name);
        }
    }
    auto config = load_job(root_, name);
    auto job = std::make_shared<Job>(std::move(config));
    {
        std::lock_guard<std::mutex> lock(jobs_mutex_);
        for (auto &pair : jobs_)
            if (!pair.second->finished) {
                auto &other = pair.second->config;
                require(other.database == job->config.database &&
                            other.server.host == job->config.server.host &&
                            other.server.port == job->config.server.port &&
                            other.server.user == job->config.server.user &&
                            other.server.password == job->config.server.password,
                        "stop all running Jobs before changing database settings");
            }
        auto old = history_.find(name);
        if (old != history_.end()) {
            // Preserve the displayed previous timestamps during STARTING. They are
            // parsed only for display; collection timestamps always come from PLC.
            // Copying JSON fields is handled by snapshot until the first new read.
        }
    }
    std::unique_lock<std::mutex> registry(registry_mutex_);
    // Different Job operations use independent control locks. Recheck the
    // shared writer destination while holding the publication/registry lock.
    {
        std::lock_guard<std::mutex> lock(jobs_mutex_);
        for (auto &pair : jobs_) {
            const auto &other = pair.second->config;
            require(pair.second->finished || (other.database == job->config.database &&
                                              other.server.host == job->config.server.host &&
                                              other.server.port == job->config.server.port &&
                                              other.server.user == job->config.server.user &&
                                              other.server.password == job->config.server.password),
                    "stop all running Jobs before changing database settings");
        }
    }
    size_t old_size = names_.size();
    bool desired = false;
    try {
        for (auto &call : job->config.calls)
            for (auto &tag : call.tags) {
                auto found = indices_.find(tag.name);
                if (found == indices_.end()) {
                    require(names_.size() < size_t(INT32_MAX), "TAG registry index exceeds native range");
                    auto index = uint32_t(names_.size());
                    indices_.emplace(tag.name, index);
                    names_.push_back(tag.name);
                    tag.index = index;
                } else
                    tag.index = found->second;
            }
        job->generation = generation_;
        job->names = names_;
        job->pool = std::make_shared<RowPool>(job->config);
        active(name, true);
        desired = true;
        require(!closed_, "collector is shutting down");
        {
            std::lock_guard<std::mutex> lock(jobs_mutex_);
            jobs_[name] = job;
        }
        logger_.set_policy(load_policies(root_).logging);
        logger_.set_level(name, job->config.level);
        mark_dirty();
        checkpoint(true);
        job->worker = std::thread([this, job] { prepare_and_read(job); });
    } catch (...) {
        {
            std::lock_guard<std::mutex> lock(jobs_mutex_);
            auto it = jobs_.find(name);
            if (it != jobs_.end() && it->second == job)
                jobs_.erase(it);
        }
        while (names_.size() > old_size) {
            indices_.erase(names_.back());
            names_.pop_back();
        }
        if (job->pool)
            job->pool->retire();
        if (desired)
            try {
                active(name, false);
            } catch (...) {
            }
        throw;
    }
}
void Daemon::stop(const std::string &name, bool preserve) {
    if (!preserve)
        active(name, false);
    std::shared_ptr<Job> job;
    {
        std::lock_guard<std::mutex> lock(jobs_mutex_);
        auto it = jobs_.find(name);
        if (it != jobs_.end())
            job = it->second;
    }
    if (!job)
        return;
    bool was_finished = job->finished;
    bool was_failed;
    {
        std::lock_guard<std::mutex> lock(job->state_mutex);
        was_failed = job->state == "failed";
    }
    std::exception_ptr checkpoint_error;
    if (!was_finished) {
        if (!was_failed)
            job->set_state("stopping");
        job->cancel.stop();
        mark_dirty();
        try {
            checkpoint(true);
        } catch (...) {
            checkpoint_error = std::current_exception();
        }
    }
    if (job->worker.joinable())
        job->worker.join();
    if (!was_finished && !was_failed)
        job->set_state("stopped");
    logger_.barrier();
    summary(job, true);
    if (!was_finished)
        logger_.log(name, "INFO", "collector", "collector stopped");
    {
        std::lock_guard<std::mutex> lock(jobs_mutex_);
        remember_locked(job);
        auto it = jobs_.find(name);
        if (it != jobs_.end() && it->second == job)
            jobs_.erase(it);
    }
    mark_dirty();
    reset_idle_registry();
    try {
        checkpoint(true);
    } catch (...) {
        if (!checkpoint_error)
            checkpoint_error = std::current_exception();
    }
    if (checkpoint_error)
        std::rethrow_exception(checkpoint_error);
}
void Daemon::fail_start(const std::shared_ptr<Job> &job, const std::string &failure) {
    auto message = scrub_error(failure, job->config.server.password);
    try {
        active(job->config.name, false);
    } catch (const std::exception &error) {
        logger_.log(job->config.name, "ERROR", "collector", error.what(), true);
    }
    job->set_state("failed", message);
    mark_dirty();
    try {
        checkpoint(true);
    } catch (...) {
    }
    logger_.log(job->config.name, "ERROR", "collector", "collector start failed: " + message, true);
}
void Daemon::prepare_and_read(const std::shared_ptr<Job> &job) {
    pthread_setname_np(pthread_self(), "dbus-reader");
    const auto &name = job->config.name;
    Ns start = clock_ns();
    Preparation stats;
    bool prepared = false;
    stats.required = job->names.size();
    logger_.log(name, "INFO", "collector",
                "TAG preparation started; table=" + job->config.database.table +
                    " requiredTags=" + std::to_string(stats.required),
                true);
    try {
        std::unique_lock<std::mutex> preparation(preparation_mutex_, std::defer_lock);
        while (!preparation.try_lock())
            require(!job->cancel.wait_for(20ms), "operation cancelled");
        require(!job->cancel.stopped(), "operation cancelled");
        auto ready = writer_command(job, WriterCommand::Open);
        if (ready.prepared >= job->names.size())
            stats.reused = true;
        else {
            std::vector<std::string> missing(job->names.begin() + std::ptrdiff_t(ready.prepared),
                                             job->names.end());
            stats = register_tags(job->config, ready.schema, missing, job->cancel, &stats);
            stats.required = job->names.size();
            writer_command(job, WriterCommand::Cache, ready.schema, job->names);
        }
        preparation.unlock();
        logger_.log(name, clock_ns() - start >= 10'000'000'000LL ? "WARN" : "INFO", "collector",
                    preparation_message("TAG preparation completed", *job, stats, clock_ns() - start), true);
        prepared = true;
        if (!job->cancel.stopped())
            read_loop(job);
    } catch (const std::exception &error) {
        if (!job->cancel.stopped()) {
            if (!prepared)
                logger_.log(name, "ERROR", "collector",
                            preparation_message("TAG preparation failed", *job, stats, clock_ns() - start) +
                                " error=" + scrub_error(error.what(), job->config.server.password),
                            true);
            fail_start(job, error.what());
        }
    }
    job->drain();
    if (auto outstanding = job->pool->retire())
        logger_.log(name, "ERROR", "collector",
                    "row buffer ownership leak detected at Job stop: outstanding=" +
                        std::to_string(outstanding),
                    true);
    job->finished = true;
    mark_dirty();
}
void Daemon::restore() {
    for (auto &name : load_active(root_)) {
        try {
            auto lock = operation(name);
            std::lock_guard<std::mutex> guard(*lock);
            start(name);
        } catch (const std::exception &error) {
            try {
                active(name, false);
            } catch (...) {
            }
            logger_.log("_collector", "ERROR", "collector",
                        "skipped active Job " + name + ": " + error.what(), true);
        }
    }
}
Json Daemon::apply(const Json &command) {
    auto name = command.value("name", std::string()), action = command.value("action", std::string());
    require(valid_job_name(name), "invalid job name");
    auto lock = operation(name);
    std::lock_guard<std::mutex> guard(*lock);
    if (action == "start") {
        require(!closed_, "collector is shutting down");
        start(name);
    } else if (action == "stop")
        stop(name);
    else if (action == "reload") {
        bool active = false;
        {
            std::lock_guard<std::mutex> lock(jobs_mutex_);
            active = jobs_.count(name) > 0;
        }
        if (active) {
            stop(name);
            start(name);
        }
    } else if (action == "refresh-log") {
        auto job = load_job(root_, name);
        auto previous = logger_.set_level(name, job.level);
        logger_.set_policy(load_policies(root_).logging);
        if (previous != job.level)
            logger_.log(name, "INFO", "config", "log level changed: " + previous + " -> " + job.level, true);
        else
            logger_.log(name, "INFO", "config", "log policy updated");
    } else if (action == "clear-overrun") {
        std::shared_ptr<Job> job;
        {
            std::lock_guard<std::mutex> lock(jobs_mutex_);
            auto it = jobs_.find(name);
            if (it != jobs_.end())
                job = it->second;
            else {
                auto old = history_.find(name);
                require(old != history_.end(), "job runtime is not available");
                old->second["overrunCount"] = 0;
                old->second["queueSkipped"] = 0;
                old->second.erase("lastOverrunAt");
            }
        }
        if (job) {
            std::lock_guard<std::mutex> lock(job->counter_mutex);
            job->overruns = 0;
            job->queue_skipped = 0;
            job->last_overrun = 0;
        }
        mark_dirty();
        checkpoint(true);
    } else
        require(action == "status", "unsupported control action");
    return Json{{"ok", true}, {"state", snapshot()}};
}
Json Daemon::snapshot() {
    Json jobs = Json::object();
    std::vector<std::shared_ptr<Job>> running;
    {
        std::lock_guard<std::mutex> lock(jobs_mutex_);
        for (auto &pair : history_)
            jobs[pair.first] = pair.second;
        for (auto &pair : jobs_)
            running.push_back(pair.second);
    }
    for (auto &job : running) {
        auto value = job->runtime();
        // The previous complete timestamps remain visible only until replaced.
        if (jobs.contains(job->config.name))
            for (auto key : {"lastReadAt", "lastStoredAt"})
                if (!value.contains(key) && jobs[job->config.name].contains(key))
                    value[key] = jobs[job->config.name][key];
        jobs[job->config.name] = std::move(value);
    }
    return Json{
        {"updatedAt", utc(updated_.load())}, {"queueDepth", queue_depth_.load()}, {"jobs", std::move(jobs)}};
}
void Daemon::checkpoint(bool force) {
    std::lock_guard<std::mutex> lock(checkpoint_mutex_);
    if (!dirty_.exchange(false) && !force)
        return;
    try {
        write_json_atomic(root_ / "data/go-collector-runtime.json", snapshot());
    } catch (...) {
        dirty_ = true;
        throw;
    }
}
std::vector<std::string> Daemon::active_names() {
    std::lock_guard<std::mutex> lock(jobs_mutex_);
    std::vector<std::string> names;
    for (auto &pair : jobs_)
        names.push_back(pair.first);
    std::sort(names.begin(), names.end());
    return names;
}
void Daemon::reset_idle_registry() {
    if (closed_)
        return;
    std::lock_guard<std::mutex> registry(registry_mutex_);
    {
        std::lock_guard<std::mutex> lock(jobs_mutex_);
        if (!jobs_.empty())
            return;
    }
    auto command = std::make_shared<WriterCommand>();
    command->kind = WriterCommand::Clear;
    command->generation = ++generation_;
    names_.clear();
    indices_.clear();
    {
        std::lock_guard<std::mutex> lock(pipe_mutex_);
        if (!writer_closed_)
            commands_.push_back(std::move(command));
    }
    pipe_changed_.notify_all();
}
void Daemon::maintenance() {
    std::vector<std::pair<std::string, std::shared_ptr<Job>>> ended;
    {
        std::lock_guard<std::mutex> lock(jobs_mutex_);
        for (auto &pair : jobs_)
            if (pair.second->finished)
                ended.push_back(pair);
    }
    for (auto &pair : ended) {
        auto operation_lock = operation(pair.first);
        std::unique_lock<std::mutex> guard(*operation_lock, std::try_to_lock);
        if (!guard)
            continue;
        {
            std::lock_guard<std::mutex> lock(jobs_mutex_);
            auto it = jobs_.find(pair.first);
            if (it == jobs_.end() || it->second != pair.second)
                continue;
        }
        if (pair.second->worker.joinable())
            pair.second->worker.join();
        {
            std::lock_guard<std::mutex> lock(jobs_mutex_);
            remember_locked(pair.second);
            jobs_.erase(pair.first);
        }
        mark_dirty();
    }
    {
        std::lock_guard<std::mutex> lock(jobs_mutex_);
        for (auto it = history_.begin(); it != history_.end();)
            if (!fs::exists(root_ / "conf.d/job-index" / (it->first + ".json")) && !jobs_.count(it->first)) {
                logger_.erase_level(it->first);
                it = history_.erase(it);
                mark_dirty();
            } else
                ++it;
    }
    {
        std::lock_guard<std::mutex> lock(locks_mutex_);
        for (auto it = locks_.begin(); it != locks_.end();)
            if (it->second.expired())
                it = locks_.erase(it);
            else
                ++it;
    }
    if (!ended.empty())
        reset_idle_registry();
    try {
        checkpoint();
        checkpoint_reported_ = false;
    } catch (const std::exception &error) {
        // Preserve collection during a periodic checkpoint I/O failure. Forced
        // control checkpoints still report their error after completing cleanup.
        if (!checkpoint_reported_)
            logger_.log("_collector", "ERROR", "checkpoint", error.what(), true);
        checkpoint_reported_ = true;
    }
}
void Daemon::shutdown() {
    if (closed_.exchange(true))
        return;
    std::vector<std::string> names = active_names();
    {
        std::lock_guard<std::mutex> lock(jobs_mutex_);
        for (auto &pair : jobs_)
            pair.second->cancel.stop();
    }
    for (auto &name : names) {
        auto lock = operation(name);
        std::lock_guard<std::mutex> guard(*lock);
        try {
            stop(name, true);
        } catch (const std::exception &error) {
            std::cerr << "neo-dbus-collector: stopping " << name << ": " << error.what() << "\n";
        }
    }
    {
        std::lock_guard<std::mutex> lock(pipe_mutex_);
        writer_closed_ = true;
    }
    pipe_changed_.notify_all();
    if (writer_.joinable())
        writer_.join();
    logger_.barrier();
    mark_dirty();
    try {
        checkpoint(true);
    } catch (const std::exception &error) {
        std::cerr << "neo-dbus-collector: checkpoint: " << error.what() << "\n";
    }
}
void Daemon::skip(const std::shared_ptr<Job> &job, bool queue, uint64_t count) {
    if (!count)
        return;
    uint64_t total;
    {
        std::lock_guard<std::mutex> lock(job->counter_mutex);
        job->overruns += count;
        if (queue)
            job->queue_skipped += count;
        job->last_overrun = clock_ns(CLOCK_REALTIME);
        total = job->overruns;
    }
    bool first;
    {
        std::lock_guard<std::mutex> lock(job->summary_mutex);
        first = job->summary.skipped == 0;
        job->summary.skipped += count;
        if (queue)
            job->summary.queue_skipped += count;
    }
    if (first)
        logger_.log(job->config.name, "WARN", queue ? "queue" : "scheduler",
                    "scheduled cycle skipped; overrunCount=" + std::to_string(total));
    mark_dirty();
    summary(job);
}
void Daemon::error(const std::shared_ptr<Job> &job, const std::string &failure) {
    auto message = scrub_error(failure, job->config.server.password);
    if (message.size() > 500)
        message.resize(500);
    {
        std::lock_guard<std::mutex> lock(job->state_mutex);
        job->last_error = message;
    }
    bool first;
    {
        std::lock_guard<std::mutex> lock(job->summary_mutex);
        first = job->summary.failed == 0;
        ++job->summary.cycles;
        ++job->summary.failed;
        job->summary.last_error = message;
    }
    if (first)
        logger_.log(job->config.name, "ERROR", "collector", "cycle failed: " + message);
    mark_dirty();
    summary(job);
}
void Daemon::success(const Pending &pending) {
    auto &job = pending.job;
    job->rows_stored += pending.rows;
    job->last_stored = clock_ns(CLOCK_REALTIME);
    {
        std::lock_guard<std::mutex> lock(job->state_mutex);
        job->last_error.clear();
    }
    {
        std::lock_guard<std::mutex> lock(job->summary_mutex);
        ++job->summary.cycles;
        ++job->summary.succeeded;
        job->summary.rows += pending.rows;
    }
    mark_dirty();
    summary(job);
}
void Daemon::summary(const std::shared_ptr<Job> &job, bool force) {
    auto policy = logger_.policy();
    CycleSummary value;
    {
        std::lock_guard<std::mutex> lock(job->summary_mutex);
        if (!force && clock_ns() - job->summary.started < policy.summary_ms * 1'000'000)
            return;
        value = job->summary;
        job->summary = CycleSummary{};
    }
    if (!value.cycles && !value.skipped)
        return;
    auto text = "cycle summary; duration=" + std::to_string((clock_ns() - value.started) / 1'000'000) +
                "ms cycles=" + std::to_string(value.cycles) +
                " succeeded=" + std::to_string(value.succeeded) + " failed=" + std::to_string(value.failed) +
                " storedRows=" + std::to_string(value.rows) + " skipped=" + std::to_string(value.skipped) +
                " queueSkipped=" + std::to_string(value.queue_skipped);
    if (!value.last_error.empty())
        text += " lastError=" + value.last_error;
    if (value.skipped > 1)
        logger_.log(job->config.name, "WARN", "scheduler", text);
    if (value.failed > 1)
        logger_.log(job->config.name, "ERROR", "collector", text);
    logger_.log(job->config.name, "DEBUG", "collector", text);
}
} // namespace collector
