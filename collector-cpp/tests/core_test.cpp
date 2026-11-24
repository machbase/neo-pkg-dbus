#include "model.hpp"
#include "timer.hpp"
#include "scheduler.hpp"
#include <cmath>
#include <iostream>
#include <random>
using namespace collector;

static int assertions = 0;
static void check(bool good, const char *what) {
    ++assertions;
    require(good, what);
}
template <class Function> static void rejects(Function fn) {
    bool error = false;
    try {
        fn();
    } catch (const std::exception &) {
        error = true;
    }
    check(error, "invalid input was accepted");
}
static Call call_for(unsigned bits, int count) {
    Call call;
    call.count = count;
    call.bits = bits;
    call.offset = 2;
    call.tags.resize(size_t(count));
    for (int i = 0; i < count; ++i) {
        call.tags[size_t(i)].name = "T" + std::to_string(i);
        call.tags[size_t(i)].index = uint32_t(i + 7);
    }
    return call;
}
static void equal_rows(const std::vector<Row> &a, const std::vector<Row> &b) {
    check(a.size() == b.size(), "row count differs");
    for (size_t i = 0; i < a.size(); ++i) {
        auto &x = a[i];
        auto &y = b[i];
        check(x.tag_index == y.tag_index && x.timestamp_ns == y.timestamp_ns &&
                  x.signed_value == y.signed_value && x.unsigned_value == y.unsigned_value &&
                  x.value_kind == y.value_kind,
              "numeric row differs");
        uint64_t xb, yb;
        memcpy(&xb, &x.floating_value, 8);
        memcpy(&yb, &y.floating_value, 8);
        check(xb == yb, "floating bits differ");
    }
}
static void parsing() {
    std::mt19937_64 random(20261105);
    for (unsigned bits : {1U, 8U, 16U, 32U, 64U})
        for (int mode = 0; mode < 6; ++mode) {
            auto call = call_for(bits, 128);
            Json values = Json::array();
            for (int i = 0; i < call.count; ++i) {
                uint64_t raw = random();
                if (bits < 64)
                    raw &= (uint64_t(1) << bits) - 1;
                auto &tag = call.tags[size_t(i)];
                tag.signed_value = (mode & 1) != 0;
                if (mode == 2 && bits == 32)
                    tag.conversion = Conversion::Real32;
                if (mode == 3 && bits == 64)
                    tag.conversion = Conversion::Real64;
                if (mode >= 4) {
                    tag.bias = 1.25;
                    tag.multiplier = -2;
                    tag.multiply_first = mode == 5;
                }
                values.push_back(raw);
            }
            Json data{{"rtn", 1},
                      {"data-count", call.count},
                      {"data", values},
                      {"time-stamp-us", INT64_C(1793780000123456)},
                      {"unused", {{"nested", Json::array({1, true, nullptr, "x"})}}}};
            auto body = data.dump();
            std::vector<Row> dom(size_t(call.count) + 4), sax(dom.size());
            decode_rows_dom(body, call, dom);
            decode_rows(body, call, sax);
            equal_rows(dom, sax);
        }
    auto call = call_for(64, 2);
    std::string max =
        R"({"rtn":1,"data-count":2,"time-stamp-us":1793780000123456,"data":[18446744073709551615,9223372036854775808]})";
    std::vector<Row> rows(6);
    decode_rows(max, call, rows);
    check(rows[2].unsigned_value == UINT64_MAX && rows[3].unsigned_value == uint64_t(1) << 63,
          "uint64 JSON precision lost");
    check(rows[2].timestamp_ns == INT64_C(1793780000123456000), "PLC timestamp changed");
    for (auto body : {R"({"rtn":1,"data-count":2,"data":[1],"time-stamp-us":1})",
                      R"({"rtn":1,"data-count":2,"data":[1,2,3],"time-stamp-us":1})",
                      R"({"rtn":1,"data-count":2,"data":[1,null],"time-stamp-us":1})",
                      R"({"rtn":1,"data-count":2,"data":[1,2.0],"time-stamp-us":1})",
                      R"({"rtn":1,"data-count":2,"data":[1,-2],"time-stamp-us":1})",
                      R"({"rtn":1,"data-count":2,"data":[1,2],"time-stamp-us":9223372036854776})",
                      R"({"rtn":1,"data-count":2,"data":[1,2]})",
                      R"({"rtn":false,"data-count":2,"data":[1,2],"time-stamp-us":1})",
                      R"({"rtn":1,"data-count":2,"data":[1,2],"time-stamp-us":1} trailing)"})
        rejects([&] { decode_rows(body, call, rows); });
}
static void numbers() {
    Tag tag;
    Row row{};
    convert_raw(250, 8, tag, row);
    check(row.value_kind == 0 && row.unsigned_value == 250, "unsigned byte");
    tag.signed_value = true;
    convert_raw(250, 8, tag, row);
    check(row.signed_value == -6, "signed byte");
    convert_raw(65535, 16, tag, row);
    check(row.signed_value == -1, "signed word");
    convert_raw(UINT64_MAX, 64, tag, row);
    check(row.signed_value == -1, "signed long word");
    convert_raw(1, 1, tag, row);
    check(row.value_kind == 0 && row.unsigned_value == 1, "bit signed must be ignored");
    tag.bias = 1;
    tag.multiplier = 2;
    convert_raw(250, 8, tag, row);
    check(row.floating_value == -10, "signed before transform");
    tag.multiply_first = true;
    convert_raw(250, 8, tag, row);
    check(row.floating_value == -11, "multiply first");
    tag = Tag{};
    tag.conversion = Conversion::Real32;
    convert_raw(1065353216, 32, tag, row);
    check(row.floating_value == 1, "real bits");
    tag.conversion = Conversion::Real64;
    convert_raw(UINT64_C(4607182418800017408), 64, tag, row);
    check(row.floating_value == 1, "lreal bits");
    rejects([&] { convert_raw(256, 8, tag, row); });
    row = {};
    row.value_kind = 1;
    row.signed_value = INT64_MAX;
    convert_column(row, 12);
    check(row.signed_value == INT64_MAX, "signed long precision");
    row = {};
    row.unsigned_value = UINT64_MAX;
    convert_column(row, 112);
    check(row.unsigned_value == UINT64_MAX, "unsigned long precision");
    rejects([&] { convert_column(row, 12); });
    row = {};
    row.value_kind = 2;
    row.floating_value = 0.5;
    rejects([&] { convert_column(row, 8); });
    row.floating_value = std::ldexp(1.0, 63);
    rejects([&] { convert_column(row, 12); });
    row.floating_value = std::ldexp(1.0, 64);
    rejects([&] { convert_column(row, 112); });
    row.floating_value = std::nan("");
    rejects([&] { convert_column(row, 20); });
    row = {};
    row.value_kind = 1;
    row.signed_value = INT16_MIN;
    convert_column(row, 4);
    check(row.signed_value == INT16_MIN, "reserved NULL pattern is accepted as user data");
}
static void pool() {
    JobConfig job;
    job.row_count = 4096;
    job.calls.push_back(call_for(8, 4096));
    job.calls[0].offset = 0;
    auto pool = std::make_shared<RowPool>(job);
    std::vector<RowPool::Lease> leases;
    for (int i = 0; i < 40; ++i)
        leases.push_back(pool->acquire());
    check(pool->outstanding() == 40, "lease accounting");
    leases.clear();
    check(pool->outstanding() == 0 && pool->idle_count() == 32, "pool bounded return");
    auto live = pool->acquire();
    (*live)[0].timestamp_ns = 123;
    check(pool->retire() == 1, "retire outstanding accounting");
    std::weak_ptr<RowPool> weak = pool;
    pool.reset();
    check(!weak.expired(), "late return owner died");
    live.reset();
    check(weak.expired(), "pool lifetime leak");
}
static void timers() {
    for (Ns interval : {Ns(1'000'000), Ns(2'000'000), Ns(20'000'000)})
        for (bool absolute : {false, true}) {
            Cancellation cancel;
            CycleTimer timer(interval, absolute, cancel);
            auto tick = timer.wait();
            check(bool(tick), "timer did not fire");
            auto skipped = timer.advance(tick->scheduled + 10 * interval);
            check(skipped.count == 10 && skipped.last_mono == tick->scheduled + 10 * interval,
                  "past boundaries not skipped exactly");
            cancel.stop();
            check(!timer.wait(), "cancelled timer fired");
        }
    check(parse_cpu_list("0-2,6,7") == std::set<int>({0, 1, 2, 6, 7}), "CPU parsing");
    for (auto text : {"", "-1", "2-1", "1,", "1--2", "65536"})
        rejects([&] { parse_cpu_list(text); });
    check(valid_bus_name("high.ls.plc", true, 255), "service name");
    check(!valid_bus_name("ls..plc", false, 247), "invalid prefix");
    check(utc(INT64_C(1700000000123456000)) == "2023-11-14T22:13:20.123456Z", "UTC formatting");
}
static void environments() {
    for (auto cpu : {std::string("0"), std::string("6,7"), std::string("64,65")}) {
        std::unordered_map<std::string, std::string> files = {
            {"/proc/self/cgroup", "0::/docker/test\n"},
            {"/proc/self/status", "Cpus_allowed_list:\t" + cpu + "\n"},
            {"/proc/self/mountinfo", "1 2 0:1 /docker/test /sys/fs/cgroup rw - cgroup2 cgroup rw\n"},
            {"/sys/devices/system/cpu/online", "0-127"},
            {"/sys/kernel/realtime", "0"},
            {"/sys/fs/cgroup/cpuset.cpus", cpu},
            {"/sys/fs/cgroup/cpuset.cpus.effective", cpu}};
        auto read = [&](const fs::path &p) {
            auto it = files.find(p.string());
            return it == files.end() ? std::string() : it->second;
        };
        auto exists = [&](const fs::path &p) { return files.count(p.string()) != 0; };
        auto environment = [&] { return scheduling_environment(read, exists); };
        auto env = environment();
        check(env.docker && env.fixed && env.rt == "false", "non-RT Docker restricted CPU detection");
        check(env.supports_conditional(), "Docker cpuset permits conditional scheduling");
        files["/sys/fs/cgroup/cpuset.cpus"] = "";
        check(!environment().supports_conditional(), "CPU quota/inherited cpuset is not explicit CPU pinning");
        files["/sys/fs/cgroup/cpuset.cpus"] = "0-127";
        check(!environment().supports_conditional(), "all CPUs are not restricted CPU pinning");
        files["/sys/fs/cgroup/cpuset.cpus"] = cpu;
        files["/sys/fs/cgroup/cpuset.cpus.effective"] = "127";
        check(!environment().supports_conditional(), "effective CPU mismatch fails closed");
        files["/proc/self/cgroup"] = "3:cpuset:/docker/test\n";
        files["/proc/self/mountinfo"] = "1 2 0:1 / /sys/fs/cgroup/cpuset rw - cgroup cpuset rw,cpuset\n";
        files["/sys/fs/cgroup/cpuset/docker/test/cpuset.cpus"] = cpu;
        check(environment().supports_conditional(), "cgroup v1 CPU pinning detection");
    }
    // Isolated fixtures must not inherit the test runner's container markers.
    for (auto runtime : {std::string("docker"), std::string("podman")})
        for (bool v2 : {false, true})
            for (bool marker : {false, true}) {
                auto group = runtime == "docker" ? "/docker/test" : "/libpod_parent/libpod-test";
                // A marker is sufficient even with a private cgroup namespace.
                std::string path = marker ? "/" : group;
                std::string mount = v2 ? "/sys/fs/cgroup" : "/sys/fs/cgroup/cpuset";
                std::string directory = mount + (path == "/" ? "" : path);
                std::unordered_map<std::string, std::string> files = {
                    {"/proc/self/cgroup", (v2 ? "0::" : "1:cpuset:") + path + "\n"},
                    {"/proc/self/status", "Cpus_allowed_list:\t10-11\n"},
                    {"/proc/self/mountinfo", "1 2 0:1 / " + mount + " rw - " +
                                                (v2 ? "cgroup2 cgroup rw\n" : "cgroup cpuset rw,cpuset\n")},
                    {"/sys/devices/system/cpu/online", "0-15"},
                    {"/sys/kernel/realtime", "1"},
                    {directory + "/cpuset.cpus", "10-11"},
                    {directory + "/cpuset.cpus.effective", "10-11"}};
                if (marker)
                    files[runtime == "docker" ? "/.dockerenv" : "/run/.containerenv"] = "";
                auto read = [&](const fs::path &p) {
                    auto it = files.find(p.string());
                    return it == files.end() ? std::string() : it->second;
                };
                auto exists = [&](const fs::path &p) { return files.count(p.string()) != 0; };
                auto environment = [&] { return scheduling_environment(read, exists); };
                auto env = environment();
                check(env.docker == (runtime == "docker") && env.podman == (runtime == "podman") &&
                          env.supports_conditional(),
                      "runtime marker/cgroup grants conditional only with a confirmed cpuset");
                files["/sys/kernel/realtime"] = "0";
                check(environment().supports_conditional(), "non-RT container uses the same eligibility checks");
                files[directory + "/cpuset.cpus"] = "";
                check(!environment().supports_conditional(), "container without explicit cpuset fails closed");
                files[directory + "/cpuset.cpus"] = "0-15";
                check(!environment().supports_conditional(), "container with all CPUs fails closed");
                files[directory + "/cpuset.cpus"] = "10-11";
                if (v2) {
                    files[directory + "/cpuset.cpus.effective"] = "10";
                    check(!environment().supports_conditional(), "effective container cpuset mismatch fails closed");
                    files[directory + "/cpuset.cpus.effective"] = "10-11";
                }
                files["/proc/self/status"] = "Cpus_allowed_list:\t9-11\n";
                check(!environment().supports_conditional(), "container affinity/cpuset mismatch fails closed");
                files["/proc/self/status"] = "Cpus_allowed_list:\t10-11\n";
                files["/sys/devices/system/cpu/online"] = "0-10";
                check(!environment().supports_conditional(), "offline configured CPU fails closed");
                files["/sys/devices/system/cpu/online"] = "0-15";
                files["/proc/self/mountinfo"] = "";
                check(!environment().supports_conditional(), "missing cgroup mount fails closed");
            }
    // Rootless Podman under systemd uses a scope path rather than /libpod/.
    auto no_markers = [](const fs::path &) { return false; };
    for (auto group : {std::string("/user.slice/user-1000.slice/user@1000.service/libpod-test.scope"),
                       std::string("/libpod/test"), std::string("/"),
                       std::string("/system.slice/my-libpod-helper.service")}) {
        auto read = [&](const fs::path &p) -> std::string {
            if (p == "/proc/self/cgroup") return "0::" + group + "\n";
            if (p == "/proc/self/status") return "Cpus_allowed_list:\t10-11\n";
            if (p == "/sys/devices/system/cpu/online") return "0-15";
            if (p == "/proc/self/mountinfo") return "1 2 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n";
            if (p == fs::path("/sys/fs/cgroup" + (group == "/" ? "" : group)) / "cpuset.cpus" ||
                p == fs::path("/sys/fs/cgroup" + (group == "/" ? "" : group)) / "cpuset.cpus.effective")
                return "10-11";
            return {};
        };
        auto env = scheduling_environment(read, no_markers);
        bool podman = group.find("/libpod") != std::string::npos;
        check(env.podman == podman && !env.docker && env.supports_conditional() == podman,
              "systemd Podman scopes work; bare host or unrelated service remains ineligible");
    }
}
static void queue_policies() {
    fs::path root = fs::absolute("dist/check/queue-policy-" + std::to_string(getpid()));
    require(!fs::exists(root), "policy test directory already exists");
    struct Cleanup {
        fs::path path;
        ~Cleanup() {
            std::error_code error;
            fs::remove_all(path, error);
        }
    } cleanup{root};
    Json document{{"schemaVersion", 2}};
    auto load = [&] {
        write_json_atomic(root / "conf.d/go-collector.json", document);
        return load_policies(root).queue_capacity;
    };
    check(load() == 512, "default writer queue changed");
    for (int capacity : {1, 512, 1024, 1025, 2048, 4096, 4097, 65536, 1000000, INT_MAX}) {
        document["writer"] = {{"queueCapacity", capacity}};
        check(load() == capacity, "valid writer queue capacity was not preserved");
    }
    // Invalid direct snapshots retain the existing fallback policy. JSH rejects
    // these values before writing its snapshot instead of silently reducing it.
    for (int64_t capacity : {int64_t(-1), int64_t(0), int64_t(INT_MAX) + 1, INT64_MAX}) {
        document["writer"] = {{"queueCapacity", capacity}};
        check(load() == 512, "invalid writer queue did not retain the default fallback");
    }
    for (auto value : {Json("4096"), Json(1.5), Json(nullptr), Json(true)}) {
        document["writer"] = {{"queueCapacity", value}};
        rejects([&] { load(); });
    }
}
int main(int argc, char **argv) {
    try {
        parsing();
        numbers();
        pool();
        timers();
        environments();
        queue_policies();
        std::cout << "core assertions=" << assertions << " passed\n";
        if (argc > 1 && std::string(argv[1]) == "--benchmark") {
            auto call = call_for(8, 4096);
            call.offset = 0;
            std::vector<Row> rows(4096);
            Json values = Json::array();
            for (int i = 0; i < 4096; ++i)
                values.push_back(250);
            auto body = Json{{"rtn", 1},
                             {"data-count", 4096},
                             {"data", values},
                             {"time-stamp-us", INT64_C(1793780000123456)}}
                            .dump();
            for (bool sax : {false, true}) {
                auto start = clock_ns();
                for (int n = 0; n < 1000; ++n)
                    if (sax)
                        decode_rows(body, call, rows);
                    else
                        decode_rows_dom(body, call, rows);
                std::cout << (sax ? "sax" : "dom") << " parseAvgUs=" << (clock_ns() - start) / 1000.0 / 1000
                          << "\n";
            }
        }
        return 0;
    } catch (const std::exception &e) {
        std::cerr << "FAIL " << e.what() << "\n";
        return 1;
    }
}
