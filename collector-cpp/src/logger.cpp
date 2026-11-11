#include "logger.hpp"
#include <iostream>
#include <pthread.h>
namespace collector {
static int severity(const std::string &level) {
    if (level == "TRACE")
        return -1;
    if (level == "DEBUG")
        return 0;
    if (level == "WARN")
        return 2;
    if (level == "ERROR")
        return 3;
    return 1;
}
AsyncLogger::AsyncLogger(const fs::path &root, LogPolicy policy)
    : directory_(root.parent_path() / "logs"), policy_(policy), worker_([this] { run(); }) {}
AsyncLogger::~AsyncLogger() { close(); }
void AsyncLogger::set_policy(LogPolicy policy) {
    std::lock_guard<std::mutex> lock(settings_mutex_);
    policy_ = policy;
}
LogPolicy AsyncLogger::policy() const {
    std::lock_guard<std::mutex> lock(settings_mutex_);
    return policy_;
}
std::string AsyncLogger::set_level(const std::string &job, std::string level) {
    std::lock_guard<std::mutex> lock(settings_mutex_);
    auto old = levels_.find(job);
    std::string previous = old == levels_.end() ? "" : old->second;
    levels_[job] = upper(trim(level));
    return previous;
}
void AsyncLogger::erase_level(const std::string &job) {
    std::lock_guard<std::mutex> lock(settings_mutex_);
    levels_.erase(job);
}
bool AsyncLogger::enabled(const std::string &job, const std::string &level) const {
    std::lock_guard<std::mutex> lock(settings_mutex_);
    auto it = levels_.find(job);
    return severity(level) >= severity(it == levels_.end() ? "INFO" : it->second);
}
void AsyncLogger::push(Record record) {
    std::unique_lock<std::mutex> lock(mutex_);
    changed_.wait(lock, [&] { return closed_ || queue_.size() < 64; });
    if (closed_) {
        if (record.barrier)
            record.barrier->set_value();
        return;
    }
    queue_.push_back(std::move(record));
    changed_.notify_all();
}
void AsyncLogger::log(const std::string &job, const std::string &level, const std::string &stage,
                      std::string message, bool force) {
    if (force || enabled(job, level))
        push({job, level, stage, std::move(message), {}, {}});
}
void AsyncLogger::lazy(const std::string &job, const std::string &level, const std::string &stage,
                       std::function<std::string()> format, bool force) {
    if (force || enabled(job, level))
        push({job, level, stage, {}, std::move(format), {}});
}
void AsyncLogger::barrier() {
    auto signal = std::make_shared<std::promise<void>>();
    auto done = signal->get_future();
    push({{}, {}, {}, {}, {}, signal});
    done.get();
}
static bool rotation_name(const std::string &name, const std::string &job) {
    std::string prefix = job + "_";
    if (name.rfind(prefix, 0) != 0 || name.size() < prefix.size() + 19 ||
        name.substr(name.size() - 4) != ".log")
        return false;
    auto stamp = name.substr(prefix.size(), name.size() - prefix.size() - 4);
    if (stamp.size() != 15 && stamp.size() != 19)
        return false;
    for (size_t i = 0; i < stamp.size(); ++i)
        if (i == 8 || i == 15) {
            if (stamp[i] != '_')
                return false;
        } else if (!std::isdigit(static_cast<unsigned char>(stamp[i])))
            return false;
    return true;
}
void AsyncLogger::purge(const std::string &job, int maximum) {
    std::vector<fs::path> files;
    for (auto &entry : fs::directory_iterator(directory_))
        if (entry.is_regular_file() && rotation_name(entry.path().filename().string(), job))
            files.push_back(entry.path());
    std::sort(files.begin(), files.end());
    while (files.size() > size_t(maximum)) {
        fs::remove(files.front());
        files.erase(files.begin());
    }
}
void AsyncLogger::write(const Record &record) {
    auto policy = this->policy();
    fs::create_directories(directory_);
    auto file = directory_ / (record.job + ".log");
    Ns now = clock_ns(CLOCK_REALTIME);
    time_t seconds = now / 1'000'000'000;
    tm time{};
    gmtime_r(&seconds, &time);
    char date[40], stamp[40], fraction[20];
    strftime(date, sizeof(date), "%Y-%m-%d %H:%M:%S", &time);
    strftime(stamp, sizeof(stamp), "%Y%m%d_%H%M%S", &time);
    snprintf(fraction, sizeof(fraction), "%03lld", static_cast<long long>((now % 1'000'000'000) / 1'000'000));
    if (fs::exists(file) && fs::file_size(file) >= uint64_t(policy.max_bytes)) {
        // The JSH log API accepts exactly the established timestamp suffix,
        // without an added sequence field. Advance a colliding millisecond
        // instead of replacing a rotation or producing an unreadable filename.
        fs::path rotated;
        for (Ns candidate = std::max<Ns>(now, Ns(rotation_) + 1'000'000);; candidate += 1'000'000) {
            time_t sec = candidate / 1'000'000'000;
            tm t{};
            gmtime_r(&sec, &t);
            char suffix[48], millis[8];
            strftime(suffix, sizeof(suffix), "%Y%m%d_%H%M%S", &t);
            snprintf(millis, sizeof(millis), "%03lld",
                     static_cast<long long>((candidate % 1'000'000'000) / 1'000'000));
            rotated = directory_ / (record.job + "_" + suffix + "_" + millis + ".log");
            if (!fs::exists(rotated)) {
                rotation_ = uint64_t(candidate);
                break;
            }
        }
        fs::rename(file, rotated);
        purge(record.job, policy.max_files);
    }
    std::string text = "[" + record.level + "] " + date + "." + fraction + "  " + record.stage + "  " +
                       record.message + "\n";
    Fd fd(open(file.c_str(), O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644));
    write_all(fd.value, text.data(), text.size());
}
void AsyncLogger::run() {
    pthread_setname_np(pthread_self(), "dbus-logger");
    for (;;) {
        Record record;
        {
            std::unique_lock<std::mutex> lock(mutex_);
            changed_.wait(lock, [&] { return closed_ || !queue_.empty(); });
            if (queue_.empty() && closed_)
                break;
            record = std::move(queue_.front());
            queue_.pop_front();
            changed_.notify_all();
        }
        if (record.barrier) {
            record.barrier->set_value();
            continue;
        }
        try {
            if (record.format)
                record.message = record.format();
            write(record);
            io_reported_ = false;
        } catch (const std::exception &error) {
            if (!io_reported_) {
                std::cerr << "neo-dbus-collector: log write failed: " << error.what() << "\n";
                io_reported_ = true;
            }
        }
    }
}
void AsyncLogger::close() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        closed_ = true;
        changed_.notify_all();
    }
    if (worker_.joinable())
        worker_.join();
}
} // namespace collector
