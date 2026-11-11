#pragma once
#include "model.hpp"
#include <deque>
#include <future>
namespace collector {
class AsyncLogger {
    struct Record {
        std::string job, level, stage, message;
        std::function<std::string()> format;
        std::shared_ptr<std::promise<void>> barrier;
    };
    fs::path directory_;
    mutable std::mutex settings_mutex_;
    LogPolicy policy_;
    std::unordered_map<std::string, std::string> levels_;
    std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<Record> queue_;
    bool closed_ = false, io_reported_ = false;
    std::thread worker_;
    uint64_t rotation_ = 0;
    void push(Record record);
    void run();
    void write(const Record &record);
    void purge(const std::string &job, int files);

  public:
    explicit AsyncLogger(const fs::path &root, LogPolicy policy);
    ~AsyncLogger();
    AsyncLogger(const AsyncLogger &) = delete;
    std::string set_level(const std::string &job, std::string level);
    void erase_level(const std::string &job);
    void set_policy(LogPolicy policy);
    LogPolicy policy() const;
    bool enabled(const std::string &job, const std::string &level) const;
    void log(const std::string &job, const std::string &level, const std::string &stage, std::string message,
             bool force = false);
    void lazy(const std::string &job, const std::string &level, const std::string &stage,
              std::function<std::string()> format, bool force = true);
    void barrier();
    void close();
};
} // namespace collector
