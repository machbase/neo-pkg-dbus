#include "scheduler.hpp"
#include <sstream>
#include <sys/resource.h>
#include <sys/syscall.h>
namespace collector {
std::set<int> parse_cpu_list(const std::string &text) {
    require(!trim(text).empty(), "empty CPU list");
    std::set<int> cpus;
    size_t start = 0;
    for (;;) {
        size_t end = text.find(',', start);
        auto part = text.substr(start, end == std::string::npos ? end : end - start);
        auto dash = part.find('-');
        auto number = [](const std::string &value) {
            require(!value.empty() && std::all_of(value.begin(), value.end(),
                                                  [](unsigned char c) { return std::isdigit(c); }),
                    "invalid CPU number");
            unsigned long n = std::stoul(value);
            require(n <= 65535, "invalid CPU number");
            return int(n);
        };
        int first = number(part.substr(0, dash)),
            last = dash == std::string::npos ? first : number(part.substr(dash + 1));
        require(last >= first, "invalid CPU range");
        for (int i = first; i <= last; ++i)
            cpus.insert(i);
        if (end == std::string::npos)
            return cpus;
        start = end + 1;
    }
}
static std::vector<std::string> fields(const std::string &line) {
    std::istringstream stream(line);
    std::vector<std::string> out;
    std::string part;
    while (stream >> part)
        out.push_back(part);
    return out;
}
static std::string decode_mount(std::string value) {
    for (auto pair : {std::pair{"\\040", " "}, {"\\011", "\t"}, {"\\134", "\\"}}) {
        size_t p = 0;
        while ((p = value.find(pair.first, p)) != std::string::npos) {
            value.replace(p, 4, pair.second);
            ++p;
        }
    }
    return value;
}
SchedulingEnvironment scheduling_environment(const std::function<std::string(const fs::path &)> &read) {
    SchedulingEnvironment env;
    auto groups = read("/proc/self/cgroup");
    env.docker = fs::exists("/.dockerenv") || groups.find("/docker/") != std::string::npos ||
                 groups.find("docker-") != std::string::npos;
    std::istringstream status(read("/proc/self/status"));
    std::string line;
    while (std::getline(status, line))
        if (line.rfind("Cpus_allowed_list:", 0) == 0)
            env.cpus = trim(line.substr(18));
    env.online = trim(read("/sys/devices/system/cpu/online"));
    auto rt = read("/sys/kernel/realtime");
    if (rt == "1")
        env.rt = "true";
    else if (rt == "0")
        env.rt = "false";
    else {
        auto version = read("/proc/version");
        if (!version.empty())
            env.rt = version.find("PREEMPT_RT") != std::string::npos ? "true" : "false";
    }
    std::string v1, v2;
    std::istringstream group_stream(groups);
    while (std::getline(group_stream, line)) {
        auto first = line.find(':'), second = first == std::string::npos ? first : line.find(':', first + 1);
        if (second == std::string::npos)
            continue;
        auto controllers = "," + line.substr(first + 1, second - first - 1) + ",";
        if (controllers.find(",cpuset,") != std::string::npos)
            v1 = line.substr(second + 1);
        if (line.substr(0, second) == "0:")
            v2 = line.substr(second + 1);
    }
    std::string directory, version;
    std::istringstream mounts(read("/proc/self/mountinfo"));
    while (std::getline(mounts, line)) {
        auto at = line.find(" - ");
        if (at == std::string::npos)
            continue;
        auto head = fields(line.substr(0, at)), tail = fields(line.substr(at + 3));
        if (head.size() < 5 || tail.size() < 3)
            continue;
        std::string group, candidate_version;
        if (tail[0] == "cgroup2" && !v2.empty()) {
            group = v2;
            candidate_version = "v2";
        }
        if (tail[0] == "cgroup" && ("," + tail[2] + ",").find(",cpuset,") != std::string::npos &&
            !v1.empty()) {
            group = v1;
            candidate_version = "v1";
        }
        if (group.empty())
            continue;
        auto root = fs::path(decode_mount(head[3])).lexically_normal().string();
        auto mount = fs::path(decode_mount(head[4])).lexically_normal();
        group = fs::path(group).lexically_normal().string();
        if (group == root)
            directory = mount.string();
        else if (root == "/")
            directory = (mount / group.substr(1)).string();
        else if (group.rfind(root + "/", 0) == 0)
            directory = (mount / group.substr(root.size() + 1)).string();
        else
            continue;
        version = candidate_version;
        break;
    }
    if (directory.empty())
        return env;
    env.cpuset = read(fs::path(directory) / "cpuset.cpus");
    if (env.cpuset.empty()) {
        env.reason = "cpuset.cpus is inherited/unconfigured";
        return env;
    }
    try {
        auto configured = parse_cpu_list(env.cpuset), online = parse_cpu_list(env.online),
             allowed = parse_cpu_list(env.cpus);
        if (configured.size() >= online.size()) {
            env.reason = "cpuset does not prove a restricted CPU range";
            return env;
        }
        for (int n : configured)
            if (!online.count(n)) {
                env.reason = "cpuset contains an offline CPU";
                return env;
            }
        for (int n : allowed)
            if (!configured.count(n)) {
                env.reason = "process affinity disagrees with cgroup cpuset";
                return env;
            }
        if (version == "v2") {
            auto effective = parse_cpu_list(read(fs::path(directory) / "cpuset.cpus.effective"));
            for (int n : allowed)
                if (!effective.count(n)) {
                    env.reason = "process affinity disagrees with effective cpuset";
                    return env;
                }
        }
        env.fixed = true;
        env.reason = "cgroup cpuset restricts CPUs";
    } catch (...) {
        env.reason = "CPU list is unavailable/invalid";
    }
    return env;
}
ThreadPolicy::ThreadPolicy(bool enabled, int priority, bool force, Audit audit) : audit_(std::move(audit)) {
    if (!enabled)
        return;
    previous_ = sched_getscheduler(0);
    require(previous_ >= 0 && sched_getparam(0, &previous_param_) == 0, "reader scheduling read failed");
    sched_param requested{};
    requested.sched_priority = priority;
    if (sched_setscheduler(0, priority ? SCHED_FIFO : SCHED_OTHER, &requested) != 0) {
        auto error = std::string("reader FIFO unavailable: ") + strerror(errno);
        if (force)
            throw std::runtime_error(error);
        audit_("WARN", error + "; retaining inherited policy");
        return;
    }
    changed_ = true;
    sched_param actual{};
    if (sched_getparam(0, &actual) != 0 || actual.sched_priority != priority ||
        sched_getscheduler(0) != (priority ? SCHED_FIFO : SCHED_OTHER)) {
        require(sched_setscheduler(0, previous_, &previous_param_) == 0, "reader scheduling rollback failed");
        changed_ = false;
        throw std::runtime_error("reader FIFO readback mismatch");
    }
    audit_("INFO", "reader policy applied; tid=" + std::to_string(syscall(SYS_gettid)) + " fifoPriority=" +
                       std::to_string(priority) + " nice=" + std::to_string(getpriority(PRIO_PROCESS, 0)));
}
ThreadPolicy::~ThreadPolicy() {
    if (changed_ && sched_setscheduler(0, previous_, &previous_param_) != 0) {
        try {
            audit_("ERROR", "reader policy restore failed; native thread exits without reuse");
        } catch (...) {
        }
    }
}
void ThreadPolicy::restore_checked() {
    if (!changed_)
        return;
    require(sched_setscheduler(0, previous_, &previous_param_) == 0, "scheduler bootstrap rollback failed");
    changed_ = false;
}
Scheduler Scheduler::prepare(const Policies &policy, Audit audit) {
    Scheduler result;
    result.policy = policy;
    result.environment = scheduling_environment();
    auto &env = result.environment;
    result.enabled = policy.scheduler_mode == "force" ||
                     (policy.scheduler_mode == "conditional" && env.docker && env.fixed);
    result.reason = policy.scheduler_mode == "off"     ? "disabled by configuration"
                    : policy.scheduler_mode == "force" ? "forced by configuration"
                    : result.enabled                   ? env.reason
                    : env.docker                       ? env.reason
                                                       : "not running in Docker";
    for (auto &change : policy.corrections)
        audit("WARN", "configuration corrected; " + change);
    if (result.enabled) {
        try {
            ThreadPolicy probe(true, policy.fifo, true, [](const std::string &, const std::string &) {});
            probe.restore_checked();
        } catch (const std::exception &e) {
            // A failed rollback is fatal even in conditional mode.
            if (policy.scheduler_mode == "force" ||
                std::string(e.what()).find("rollback") != std::string::npos)
                throw;
            result.enabled = false;
            result.reason = e.what();
        }
    }
    if (result.enabled) {
        if (setpriority(PRIO_PROCESS, 0, policy.nice) != 0) {
            if (policy.scheduler_mode == "force")
                throw std::runtime_error(std::string("nice application failed: ") + strerror(errno));
            result.enabled = false;
            result.reason = std::string("nice unavailable: ") + strerror(errno);
        } else {
            errno = 0;
            int actual = getpriority(PRIO_PROCESS, 0);
            require(errno == 0 && actual == policy.nice, "nice readback mismatch");
        }
    }
    audit(policy.scheduler_mode == "conditional" && !result.enabled ? "WARN" : "INFO",
          "policy selected; mode=" + policy.scheduler_mode +
              " enabled=" + (result.enabled ? "true" : "false") + " reason=" + result.reason +
              " docker=" + (env.docker ? "true" : "false") + " cpus=" + env.cpus + " cpuset=" + env.cpuset +
              " rtKernel=" + env.rt + " requestedFIFO=" + std::to_string(policy.fifo) + " requestedNice=" +
              std::to_string(policy.nice) + " appliedNice=" + std::to_string(getpriority(PRIO_PROCESS, 0)) +
              " implementation=cpp gomaxprocs=not-applicable configuredGoMaxProcs=" +
              std::to_string(policy.gomaxprocs));
    return result;
}
std::unique_ptr<ThreadPolicy> Scheduler::enter(Audit audit) const {
    return std::make_unique<ThreadPolicy>(enabled, policy.fifo, policy.scheduler_mode == "force",
                                          std::move(audit));
}
} // namespace collector
