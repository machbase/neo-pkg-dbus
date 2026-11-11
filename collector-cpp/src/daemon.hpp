#pragma once
#include "device_bus.hpp"
#include "native_db.hpp"
#include "performance.hpp"
#include "scheduler.hpp"
#include <deque>
#include <future>
namespace collector {
struct Completion {
    std::mutex mutex;
    std::condition_variable changed;
    bool done = false;
    std::string error;
    void finish(std::string failure) {
        std::lock_guard<std::mutex> lock(mutex);
        done = true;
        error = std::move(failure);
        changed.notify_all();
    }
    bool wait(const Cancellation &cancel) {
        std::unique_lock<std::mutex> lock(mutex);
        while (!done && !cancel.stopped())
            changed.wait_for(lock, 20ms);
        return done && error.empty();
    }
};
struct CycleSummary {
    Ns started = clock_ns();
    uint64_t cycles = 0, succeeded = 0, failed = 0, rows = 0, skipped = 0, queue_skipped = 0;
    std::string last_error;
};
struct Job {
    JobConfig config;
    uint64_t generation = 0;
    std::vector<std::string> names;
    std::shared_ptr<RowPool> pool;
    std::thread worker;
    Cancellation cancel;
    std::atomic<bool> finished{false};
    std::atomic<Ns> last_read{0}, last_stored{0};
    std::atomic<uint64_t> rows_stored{0};
    std::mutex state_mutex, counter_mutex, work_mutex, summary_mutex;
    std::condition_variable work_changed;
    std::string state = "starting", detail = "Preparing tags…", last_error;
    uint64_t overruns = 0, queue_skipped = 0, pending = 0;
    Ns last_overrun = 0;
    CycleSummary summary;
    explicit Job(JobConfig value) : config(std::move(value)) {}
    Json runtime();
    void set_state(std::string value, std::string explanation = {});
    void add_work();
    void end_work();
    void drain();
};
class Daemon {
    struct Batch {
        std::shared_ptr<Job> job;
        RowPool::Lease rows;
        Ns enqueued = 0;
        std::shared_ptr<Completion> prime;
    };
    struct Pending {
        std::shared_ptr<Job> job;
        size_t rows = 0;
        Ns enqueued = 0;
        std::shared_ptr<Completion> prime;
    };
    struct OpenReply {
        TableSchema schema;
        size_t prepared = 0;
    };
    struct WriterCommand {
        enum Kind { Open, Cache, Clear } kind = Open;
        std::shared_ptr<Job> job;
        std::vector<std::string> names;
        TableSchema schema;
        uint64_t generation = 0;
        std::promise<OpenReply> result;
    };
    fs::path root_;
    Policies policy_;
    Scheduler scheduling_;
    AsyncLogger &logger_;
    std::mutex jobs_mutex_, active_mutex_, checkpoint_mutex_, registry_mutex_, preparation_mutex_,
        locks_mutex_;
    std::unordered_map<std::string, std::shared_ptr<Job>> jobs_;
    std::unordered_map<std::string, Json> history_;
    std::unordered_map<std::string, std::weak_ptr<std::mutex>> locks_;
    std::vector<std::string> names_;
    std::unordered_map<std::string, uint32_t> indices_;
    uint64_t generation_ = 1;
    std::atomic<bool> closed_{false}, dirty_{true};
    std::atomic<bool> writer_failed_{false};
    std::atomic<Ns> updated_{clock_ns(CLOCK_REALTIME)};
    bool checkpoint_reported_ = false; // Maintenance thread only; one log per failure episode.
    std::mutex pipe_mutex_;
    std::condition_variable pipe_changed_;
    std::deque<Batch> queue_;
    std::deque<std::shared_ptr<WriterCommand>> commands_;
    size_t reservations_ = 0;
    bool writer_closed_ = false;
    std::atomic<int> queue_depth_{0}, queue_peak_{0};
    std::thread writer_;
    std::shared_ptr<std::mutex> operation(const std::string &name);
    void mark_dirty();
    void active(const std::string &name, bool enabled);
    void start(const std::string &name);
    void stop(const std::string &name, bool preserve = false);
    void prepare_and_read(const std::shared_ptr<Job> &job);
    void read_loop(const std::shared_ptr<Job> &job);
    void writer_loop();
    OpenReply writer_command(const std::shared_ptr<Job> &job, WriterCommand::Kind kind,
                             TableSchema schema = {}, std::vector<std::string> names = {});
    bool reserve();
    void unreserve();
    void enqueue(Batch batch);
    void skip(const std::shared_ptr<Job> &job, bool queue, uint64_t count = 1);
    void error(const std::shared_ptr<Job> &job, const std::string &error);
    void success(const Pending &pending);
    void summary(const std::shared_ptr<Job> &job, bool force = false);
    void fail_start(const std::shared_ptr<Job> &job, const std::string &error);
    void reset_idle_registry();
    void remember_locked(const std::shared_ptr<Job> &job);
    std::vector<std::string> active_names();

  public:
    Daemon(fs::path root, Policies policy, Scheduler scheduler, AsyncLogger &logger);
    ~Daemon();
    void restore();
    Json apply(const Json &command);
    Json snapshot();
    void checkpoint(bool force = false);
    void maintenance();
    void shutdown();
    bool closing() const { return closed_.load(); }
    bool failed() const { return writer_failed_.load(); }
};
int send_command(const fs::path &root, const std::string &action, const std::string &name);
int serve(Daemon &daemon, const fs::path &root, int parent_pid);
} // namespace collector
