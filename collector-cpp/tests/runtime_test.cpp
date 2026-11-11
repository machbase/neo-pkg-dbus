#include "performance.hpp"
#include <iostream>
#include <regex>
using namespace collector;
static int count = 0;
static void check(bool good, const char *reason) {
    ++count;
    require(good, reason);
}
int main() {
    fs::path root = fs::absolute("dist/runtime-test-" + std::to_string(getpid()));
    require(!fs::exists(root), "test directory already exists");
    struct Cleanup {
        fs::path p;
        ~Cleanup() {
            std::error_code error;
            fs::remove_all(p, error);
        }
    } cleanup{root};
    try {
        fs::create_directories(root / "cgi-bin");
        LogPolicy policy;
        policy.max_bytes = 65536;
        policy.max_files = 2;
        AsyncLogger logger(root / "cgi-bin", policy);
        logger.set_level("a", "WARN");
        logger.log("a", "INFO", "config", "this is filtered");
        logger.log("a", "INFO", "config", "this is an audit", true);
        logger.log("a_extra", "WARN", "test", "keep other Job prefix file");
        logger.barrier();
        check(read_text(root / "logs/a.log").find("filtered") == std::string::npos, "log filtering failed");
        check(read_text(root / "logs/a.log").find("audit") != std::string::npos, "audit log filtered out");
        for (int n = 0; n < 20; ++n)
            logger.log("a", "WARN", "test", "item=" + std::to_string(n) + ";" + std::string(40000, 'x'));
        logger.barrier();
        size_t rotations = 0;
        std::string retained;
        for (auto &file : fs::directory_iterator(root / "logs"))
            if (file.path().filename().string().rfind("a_", 0) == 0 &&
                file.path().filename() != "a_extra.log") {
                ++rotations;
                retained += read_text(file.path());
                check(std::regex_match(file.path().filename().string(),
                                       std::regex("a_[0-9]{8}_[0-9]{6}_[0-9]{3}\\.log")),
                      "rotation filename breaks the existing JSH log API");
            }
        check(rotations == 2, "log rotation count exceeds retention");
        check(retained.find("item=16;") != std::string::npos &&
                  retained.find("item=17;") != std::string::npos,
              "rotation collision discarded newer records");
        check(read_text(root / "logs/a_extra.log").find("keep other") != std::string::npos,
              "rotation removed another Job's log");
        auto values = quantiles({1, 2, 3, 4, 100});
        check(values.min == 1 && values.avg == 22 && values.p50 == 3 && values.p99 == 100 &&
                  values.max == 100,
              "nearest-rank percentile calculation");
        PerfWindow w;
        w.source = "dbus";
        w.reads = {{1000000, 100000, 1100000, true, true, true, false},
                   {1200000, 500000, 1743000, true, true, true, false},
                   {900000, 200000, 1100999, true, true, true, false}};
        w.wakes = 3;
        w.starts = 3;
        w.skips = 2;
        w.queue_skips = 3;
        w.errors = 1;
        w.wake = {0, 1000, 5000};
        w.start = {1, 1001, 5001};
        w.dispatch = {1, 1, 1};
        auto text = format_job_performance("test", w);
        check(text.find("min=1100(dbus=1000)") != std::string::npos,
              "minimum correlation/tie handling changed");
        check(text.find("max=1743(dbus=1200)") != std::string::npos, "maximum correlation changed");
        check(text.find("skipCount=5 overIntervalCount=2 queueFullSkipCount=3 errorCount=1") !=
                  std::string::npos,
              "skip kinds/counters changed");
        check(text.find("parseUs[avg=266 max=500]") != std::string::npos, "parse timing aggregation changed");
        Policies p;
        p.performance = true;
        p.job_samples = 500;
        JobPerformance perf(p, "window", "dbus", logger);
        Tick tick{1000000, 1700000000000000000, 1001000};
        ReadTiming timing{0, 100, 2000, false, true, true, false};
        CycleDetail prior{tick, 1002000, timing, 0};
        perf.skipped({3, 31000000, 1700000000030000000, false}, 31001000, &prior, 10000000);
        for (int n = 0; n < 500; ++n) {
            perf.schedule(tick, 1002000);
            perf.read(timing);
        }
        logger.barrier();
        auto summary = read_text(root / "logs/window.log");
        check(summary.find("samples=500") != std::string::npos &&
                  summary.find("lastOverrun[") != std::string::npos,
              "performance window not detached/drained");
        check(summary.find("dbusUs=n/a") != std::string::npos, "unmeasured DBUS must be n/a");
        logger.close();
        std::cout << "runtime assertions=" << count << " passed\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL " << error.what() << "\n";
        return 1;
    }
}
