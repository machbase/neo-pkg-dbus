#pragma once
#include <nlohmann/json.hpp>
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cctype>
#include <climits>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>
#include <utility>
#include <fcntl.h>
#include <poll.h>
#include <sys/stat.h>
#include <unistd.h>

namespace collector {
using Json = nlohmann::json;
using Ns = int64_t;
namespace fs = std::filesystem;
using namespace std::chrono_literals;

inline void require(bool good, const std::string &message) {
    if (!good)
        throw std::runtime_error(message);
}
inline void require(bool good, const char *message) {
    // Successful hot-path checks must not construct/allocate a std::string.
    if (!good)
        throw std::runtime_error(message);
}
inline Ns clock_ns(clockid_t clock = CLOCK_MONOTONIC) {
    timespec t{};
    if (clock_gettime(clock, &t))
        throw std::runtime_error("clock_gettime failed");
    return Ns(t.tv_sec) * 1'000'000'000 + t.tv_nsec;
}
inline std::string trim(std::string s) {
    auto white = [](unsigned char c) { return std::isspace(c); };
    s.erase(s.begin(), std::find_if_not(s.begin(), s.end(), white));
    s.erase(std::find_if_not(s.rbegin(), s.rend(), white).base(), s.end());
    return s;
}
inline std::string upper(std::string s) {
    for (auto &c : s)
        c = char(std::toupper(static_cast<unsigned char>(c)));
    return s;
}
inline std::string lower(std::string s) {
    for (auto &c : s)
        c = char(std::tolower(static_cast<unsigned char>(c)));
    return s;
}
inline bool valid_job_name(const std::string &name) {
    if (name.empty() || name.size() > 100)
        return false;
    for (unsigned char c : name)
        if (!(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && c != '_' && c != '-')
            return false;
    return true;
}
inline std::string utc(Ns epoch) {
    time_t seconds = epoch / 1'000'000'000;
    Ns nanos = epoch % 1'000'000'000;
    if (nanos < 0) {
        nanos += 1'000'000'000;
        --seconds;
    }
    tm t{};
    require(gmtime_r(&seconds, &t), "UTC conversion failed");
    char date[40], fraction[16];
    strftime(date, sizeof(date), "%Y-%m-%dT%H:%M:%S", &t);
    if (nanos == 0)
        return std::string(date) + "Z";
    snprintf(fraction, sizeof(fraction), ".%09lld", static_cast<long long>(nanos));
    std::string suffix(fraction);
    while (suffix.back() == '0')
        suffix.pop_back();
    return std::string(date) + suffix + "Z";
}
inline std::string read_text(const fs::path &path, size_t limit = SIZE_MAX) {
    std::ifstream file(path, std::ios::binary);
    require(bool(file), "cannot read " + path.filename().string());
    std::string data;
    char block[8192];
    while (file.read(block, sizeof(block)) || file.gcount()) {
        require(data.size() + size_t(file.gcount()) <= limit,
                "file exceeds supported size: " + path.filename().string());
        data.append(block, size_t(file.gcount()));
    }
    require(file.eof(), "file read failed: " + path.filename().string());
    return data;
}
inline Json read_json(const fs::path &path, size_t limit = SIZE_MAX) {
    auto text = read_text(path, limit);
    try {
        return Json::parse(text);
    } catch (const Json::parse_error &) {
        // In particular, never echo a damaged secret file's input excerpt.
        throw std::runtime_error("invalid JSON in " + path.filename().string());
    }
}
inline std::string optional_text(const fs::path &path) noexcept {
    try {
        return trim(read_text(path));
    } catch (...) {
        return {};
    }
}
struct Fd {
    int value = -1;
    Fd() = default;
    explicit Fd(int v) : value(v) { require(v >= 0, std::string("descriptor: ") + strerror(errno)); }
    Fd(const Fd &) = delete;
    Fd &operator=(const Fd &) = delete;
    Fd(Fd &&other) noexcept : value(std::exchange(other.value, -1)) {}
    Fd &operator=(Fd &&other) noexcept {
        if (this != &other) {
            reset();
            value = std::exchange(other.value, -1);
        }
        return *this;
    }
    void reset() noexcept {
        if (value >= 0) {
            close(value);
            value = -1;
        }
    }
    ~Fd() { reset(); }
};
inline void write_all(int fd, const char *data, size_t size) {
    while (size) {
        ssize_t n = write(fd, data, size);
        if (n < 0 && errno == EINTR)
            continue;
        require(n > 0, std::string("write failed: ") + strerror(errno));
        data += n;
        size -= size_t(n);
    }
}
inline void write_json_atomic(const fs::path &path, const Json &data, mode_t mode = 0644) {
    fs::create_directories(path.parent_path());
    std::string temporary = (path.parent_path() / ".collector-XXXXXX").string();
    std::vector<char> name(temporary.begin(), temporary.end());
    name.push_back(0);
    Fd fd(mkstemp(name.data()));
    try {
        require(fchmod(fd.value, mode) == 0, "checkpoint mode failed");
        auto text = data.dump(2) + "\n";
        write_all(fd.value, text.data(), text.size());
        require(fsync(fd.value) == 0, "checkpoint sync failed");
        fd.reset();
        // Native OS file rename; never JSH directory rename.
        require(rename(name.data(), path.c_str()) == 0, "checkpoint replace failed");
    } catch (...) {
        unlink(name.data());
        throw;
    }
}
class Cancellation {
    Fd read_, write_;
    std::atomic<Ns> at_{0};

  public:
    Cancellation() {
        int p[2];
        require(pipe2(p, O_CLOEXEC | O_NONBLOCK) == 0, "cancel pipe failed");
        read_.value = p[0];
        write_.value = p[1];
    }
    bool stopped() const { return at_.load() != 0; }
    Ns at() const { return at_.load(); }
    int fd() const { return read_.value; }
    void stop() noexcept {
        Ns expected = 0;
        timespec t{};
        clock_gettime(CLOCK_MONOTONIC, &t);
        Ns now = Ns(t.tv_sec) * 1'000'000'000 + t.tv_nsec;
        if (at_.compare_exchange_strong(expected, now)) {
            char c = 1;
            while (write(write_.value, &c, 1) < 0 && errno == EINTR) {
            }
        }
    }
    bool wait_for(std::chrono::milliseconds duration) const {
        pollfd p{read_.value, POLLIN, 0};
        int result;
        do {
            result = poll(&p, 1, int(duration.count()));
        } while (result < 0 && errno == EINTR);
        return stopped();
    }
};
inline std::string quote_literal(const std::string &text) {
    require(text.find('\0') == std::string::npos, "SQL literal contains NUL");
    std::string result = "'";
    for (char c : text) {
        result += c;
        if (c == '\'')
            result += c;
    }
    return result + "'";
}
inline std::vector<std::string> identifier_parts(const std::string &text) {
    std::vector<std::string> parts;
    size_t begin = 0;
    for (;;) {
        size_t end = text.find('.', begin);
        auto part = text.substr(begin, end == std::string::npos ? end : end - begin);
        require(!part.empty(), "empty SQL identifier");
        for (unsigned char c : part)
            require(std::isalnum(c) || c == '_' || c == '$', "invalid SQL identifier");
        parts.push_back(upper(part));
        require(parts.size() <= 3, "SQL identifier has too many components");
        if (end == std::string::npos)
            return parts;
        begin = end + 1;
    }
}
inline std::string quote_identifier(const std::string &text) {
    auto parts = identifier_parts(text);
    std::string result;
    for (auto &p : parts) {
        if (!result.empty())
            result += ".";
        result += "\"" + p + "\"";
    }
    return result;
}
inline std::string scrub_error(std::string message, const std::string &password = {}) {
    if (!password.empty()) {
        size_t p = 0;
        while ((p = message.find(password, p)) != std::string::npos) {
            message.replace(p, password.size(), "[redacted]");
            p += 10;
        }
    }
    for (char &c : message)
        if (c == '\r' || c == '\n' || c == '\0')
            c = ' ';
    if (message.size() > 4096)
        message.resize(4096);
    return message;
}
} // namespace collector
