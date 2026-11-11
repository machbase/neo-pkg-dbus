#pragma once
#include "common.hpp"
namespace collector {
struct Skipped {
    uint64_t count = 0;
    Ns last_mono = 0, last_wall = 0;
    bool clock_reset = false;
};
struct Tick {
    Ns scheduled = 0, scheduled_wall = 0, wake = 0;
};
class CycleTimer {
    Fd timer_, poll_;
    Ns interval_, next_, next_wall_, offset_;
    bool absolute_;
    Cancellation &cancel_;
    bool reset_clock();

  public:
    CycleTimer(Ns interval, bool absolute, Cancellation &cancel);
    Skipped advance(Ns through);
    std::optional<Tick> wait();
    Ns interval() const { return interval_; }
};
} // namespace collector
