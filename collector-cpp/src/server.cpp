#include "daemon.hpp"
#include <csignal>
#include <iostream>
#include <pthread.h>
#include <sstream>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/un.h>
namespace collector {
static volatile sig_atomic_t signalled = 0;
static void signal_handler(int signal) { signalled = signal; }
static sockaddr_un socket_address(const fs::path &root) {
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    auto path = (root / "data/neo-dbus-collector.sock").string();
    require(path.size() < sizeof(address.sun_path), "collector Unix socket path is too long");
    memcpy(address.sun_path, path.c_str(), path.size() + 1);
    return address;
}
static Json receive_json(int fd, size_t maximum = SIZE_MAX) {
    std::string text;
    char bytes[4096];
    for (;;) {
        auto n = read(fd, bytes, sizeof(bytes));
        if (n < 0 && errno == EINTR)
            continue;
        require(n > 0, std::string("collector control response failed: ") + strerror(errno));
        text.append(bytes, size_t(n));
        require(text.size() <= maximum, "collector control message is too large");
        if (text.find('\n') != std::string::npos)
            return Json::parse(text.substr(0, text.find('\n')));
    }
}
int send_command(const fs::path &root, const std::string &action, const std::string &name) {
    auto address = socket_address(root);
    Ns deadline = clock_ns() + 10'000'000'000;
    std::string last;
    while (clock_ns() < deadline) {
        Fd fd(socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0));
        if (connect(fd.value, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0) {
            last = strerror(errno);
            std::this_thread::sleep_for(100ms);
            continue;
        }
        timeval wait{30, 0};
        setsockopt(fd.value, SOL_SOCKET, SO_RCVTIMEO, &wait, sizeof(wait));
        setsockopt(fd.value, SOL_SOCKET, SO_SNDTIMEO, &wait, sizeof(wait));
        auto text = Json{{"action", action}, {"name", name}}.dump() + "\n";
        write_all(fd.value, text.data(), text.size());
        auto result = receive_json(fd.value);
        require(result.value("ok", false), result.value("error", std::string("collector operation failed")));
        return 0;
    }
    throw std::runtime_error("collector control socket unavailable: " + last);
}
class ParentMonitor {
    Fd fd_;
    int pid_;
    std::string start_;
    static std::string start_time(int pid) {
        auto stat = optional_text("/proc/" + std::to_string(pid) + "/stat");
        auto at = stat.rfind(") ");
        if (at == std::string::npos)
            return {};
        std::istringstream fields(stat.substr(at + 2));
        std::string part;
        for (int i = 0; i <= 19; ++i) {
            if (!(fields >> part))
                return {};
            if (i == 0 && (part == "Z" || part == "X"))
                return {};
        }
        return part;
    }

  public:
    explicit ParentMonitor(int pid) : pid_(pid) {
        require(pid >= 0, "parent PID must not be negative");
        if (!pid)
            return;
        start_ = start_time(pid);
        require(!start_.empty(), "parent process does not exist");
#ifdef SYS_pidfd_open
        int descriptor = int(syscall(SYS_pidfd_open, pid, 0));
        if (descriptor >= 0)
            fd_.value = descriptor;
        else
            require(errno == ENOSYS || errno == EINVAL || errno == EPERM || errno == EACCES,
                    "cannot monitor parent process");
#endif
    }
    bool dead() {
        if (!pid_)
            return false;
        if (fd_.value >= 0) {
            pollfd p{fd_.value, POLLIN, 0};
            int ready = poll(&p, 1, 0);
            require(ready >= 0 || errno == EINTR, "parent monitor failed");
            return ready > 0;
        }
        return start_time(pid_) != start_;
    }
};
int serve(Daemon &daemon, const fs::path &root, int parent_pid) {
    ParentMonitor parent(parent_pid);
    fs::create_directories(root / "data");
    auto address = socket_address(root);
    auto path = root / "data/neo-dbus-collector.sock";
    if (fs::exists(path)) {
        Fd probe(socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0));
        if (connect(probe.value, reinterpret_cast<sockaddr *>(&address), sizeof(address)) == 0)
            throw std::runtime_error("collector control socket is already in use");
        require(errno == ECONNREFUSED || errno == ENOENT, "cannot inspect existing collector socket");
        fs::remove(path);
    }
    Fd listener(socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0));
    require(bind(listener.value, reinterpret_cast<sockaddr *>(&address), sizeof(address)) == 0,
            "collector socket bind failed");
    require(chmod(path.c_str(), 0600) == 0, "collector socket permissions failed");
    struct Remove {
        fs::path path;
        ~Remove() {
            std::error_code ignored;
            fs::remove(path, ignored);
        }
    } remove{path};
    require(listen(listener.value, 128) == 0, "collector socket listen failed");
    std::mutex mutex;
    std::condition_variable changed;
    std::deque<int> clients;
    std::set<int> accepted;
    bool closing = false;
    std::vector<std::thread> workers;
    auto close_requests = [&] {
        {
            std::lock_guard<std::mutex> lock(mutex);
            closing = true;
            for (int fd : accepted)
                ::shutdown(fd, SHUT_RDWR);
        }
        changed.notify_all();
    };
    try {
        // Bounded persistent control workers prevent one native thread/stack
        // allocation being retained for each UI action. They never read PLC data.
        for (int i = 0; i < 4; ++i)
            workers.emplace_back([&] {
                pthread_setname_np(pthread_self(), "dbus-control");
                for (;;) {
                    int client;
                    {
                        std::unique_lock<std::mutex> lock(mutex);
                        changed.wait(lock, [&] { return closing || !clients.empty(); });
                        if (clients.empty() && closing)
                            return;
                        client = clients.front();
                        clients.pop_front();
                    }
                    Fd fd(client);
                    try {
                        auto command = receive_json(fd.value, 4096);
                        Json reply;
                        try {
                            reply = daemon.apply(command);
                        } catch (const std::exception &error) {
                            reply = {{"ok", false}, {"error", error.what()}};
                        }
                        auto text = reply.dump() + "\n";
                        write_all(fd.value, text.data(), text.size());
                    } catch (...) {
                    }
                    {
                        std::lock_guard<std::mutex> lock(mutex);
                        accepted.erase(client);
                    }
                }
            });
        daemon.restore();
        Ns next_checkpoint = clock_ns();
        while (!signalled && !parent.dead() && !daemon.failed()) {
            pollfd fd{listener.value, POLLIN, 0};
            int ready = poll(&fd, 1, 100);
            require(ready >= 0 || errno == EINTR, "collector accept wait failed");
            if (ready > 0) {
                int client = accept4(listener.value, nullptr, nullptr, SOCK_CLOEXEC);
                if (client >= 0) {
                    timeval timeout{30, 0};
                    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
                    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
                    std::lock_guard<std::mutex> lock(mutex);
                    if (clients.size() >= 64)
                        close(client);
                    else {
                        accepted.insert(client);
                        clients.push_back(client);
                        changed.notify_one();
                    }
                } else
                    require(errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR,
                            "collector accept failed");
            }
            if (clock_ns() >= next_checkpoint) {
                daemon.maintenance();
                next_checkpoint = clock_ns() + 250'000'000;
            }
        }
        close_requests();
        listener.reset();
        daemon.shutdown();
        for (auto &thread : workers)
            thread.join();
        require(!daemon.failed(), "native writer terminated");
        return 0;
    } catch (...) {
        close_requests();
        listener.reset();
        daemon.shutdown();
        for (auto &thread : workers)
            if (thread.joinable())
                thread.join();
        throw;
    }
}
} // namespace collector

int main(int argc, char **argv) {
    using namespace collector;
    try {
        fs::path root;
        bool control = false;
        int parent = 0;
        std::vector<std::string> positional;
        for (int i = 1; i < argc; ++i) {
            std::string arg = argv[i];
            if (arg == "--root" && i + 1 < argc)
                root = argv[++i];
            else if (arg == "--parent-pid" && i + 1 < argc)
                parent = std::stoi(argv[++i]);
            else if (arg == "--control")
                control = true;
            else if (arg == "--help") {
                std::cout << "neo-dbus-collector --root CGI_ROOT [--parent-pid PID]\nneo-dbus-collector "
                             "--root CGI_ROOT --control ACTION NAME\n";
                return 0;
            } else
                positional.push_back(arg);
        }
        require(!root.empty(), "--root is required");
        root = fs::absolute(root);
        signal(SIGPIPE, SIG_IGN);
        if (control) {
            require(positional.size() == 2, "control requires ACTION NAME");
            return send_command(root, positional[0], positional[1]);
        }
        require(positional.empty(), "daemon accepts no positional arguments");
        require(parent >= 0, "parent PID must not be negative");
        fs::create_directories(root / "data");
        Fd singleton(open((root / "data/native-collector.lock").c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0644));
        require(flock(singleton.value, LOCK_EX | LOCK_NB) == 0, "another collector already owns this root");
        // Hold the ownership lock before any checkpoint/logging side effect.
        // Also reject an old Go collector, which does not use this lock file.
        auto address = socket_address(root);
        Fd probe(socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0));
        if (connect(probe.value, reinterpret_cast<sockaddr *>(&address), sizeof(address)) == 0)
            throw std::runtime_error("collector control socket is already in use");
        require(errno == ENOENT || errno == ECONNREFUSED, "cannot inspect collector control socket");
        signal(SIGTERM, signal_handler);
        signal(SIGINT, signal_handler);
        auto policies = load_policies(root);
        std::vector<std::pair<std::string, std::string>> startup;
        // No worker/library threads are created until nice has been selected;
        // all subsequently created native threads inherit the same nice value.
        auto scheduler = Scheduler::prepare(policies, [&](const std::string &level, const std::string &text) {
            startup.emplace_back(level, text);
        });
        AsyncLogger logger(root, policies.logging);
        for (auto &event : startup)
            logger.log("_collector", event.first, "scheduler", event.second, true);
        Daemon daemon(root, policies, scheduler, logger);
        return serve(daemon, root, parent);
    } catch (const std::exception &error) {
        std::cerr << "neo-dbus-collector: " << error.what() << "\n";
        return 1;
    }
}
