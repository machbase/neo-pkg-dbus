#pragma once
#include "model.hpp"
#include <sched.h>
namespace collector {
struct SchedulingEnvironment {
    bool docker = false, fixed = false;
    std::string cpus, cpuset, online, rt = "unknown", reason = "cgroup cpuset not confirmed";
};
using Audit = std::function<void(const std::string &, const std::string &)>;
std::set<int> parse_cpu_list(const std::string &text);
SchedulingEnvironment
scheduling_environment(const std::function<std::string(const fs::path &)> &read = optional_text);
class ThreadPolicy {
    bool changed_ = false;
    int previous_ = 0;
    sched_param previous_param_{};
    Audit audit_;

  public:
    ThreadPolicy(bool enabled, int priority, bool force, Audit audit);
    void restore_checked();
    ~ThreadPolicy();
    ThreadPolicy(const ThreadPolicy &) = delete;
};
struct Scheduler {
    Policies policy;
    SchedulingEnvironment environment;
    bool enabled = false;
    std::string reason;
    static Scheduler prepare(const Policies &policy, Audit audit);
    std::unique_ptr<ThreadPolicy> enter(Audit audit) const;
};
} // namespace collector
