#include "timer.hpp"
#include <sys/epoll.h>
#include <sys/timerfd.h>
namespace collector {
CycleTimer::CycleTimer(Ns interval, bool absolute, Cancellation &cancel)
    : timer_(timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC | TFD_NONBLOCK)),
      poll_(epoll_create1(EPOLL_CLOEXEC)), interval_(interval), absolute_(absolute), cancel_(cancel) {
    Ns wall = clock_ns(CLOCK_REALTIME), mono = clock_ns();
    require(interval > 0 && interval < INT64_MAX - std::max(wall, mono),
            "interval exceeds Linux timer range");
    offset_ = wall - mono;
    Ns delay = interval - wall % interval;
    next_ = mono + delay;
    next_wall_ = wall + delay;
    for (int fd : {timer_.value, cancel.fd()}) {
        epoll_event event{};
        event.events = EPOLLIN;
        event.data.fd = fd;
        require(epoll_ctl(poll_.value, EPOLL_CTL_ADD, fd, &event) == 0, "timer epoll add failed");
    }
}
bool CycleTimer::reset_clock() {
    if (absolute_)
        return false;
    Ns wall = clock_ns(CLOCK_REALTIME), mono = clock_ns(), current_offset = wall - mono;
    if (current_offset - offset_ > 1'000'000 || current_offset - offset_ < -1'000'000) {
        offset_ = current_offset;
        Ns delay = interval_ - wall % interval_;
        next_ = mono + delay;
        next_wall_ = wall + delay;
        return true;
    }
    return false;
}
Skipped CycleTimer::advance(Ns through) {
    if (reset_clock())
        return {0, 0, 0, true};
    if (next_ > through)
        return {};
    uint64_t count = uint64_t((through - next_) / interval_ + 1);
    Ns last = next_ + Ns(count - 1) * interval_;
    Ns last_wall = next_wall_ + Ns(count - 1) * interval_;
    next_ += Ns(count) * interval_;
    next_wall_ += Ns(count) * interval_;
    return {count, last, last_wall, false};
}
std::optional<Tick> CycleTimer::wait() {
    if (cancel_.stopped())
        return {};
    Tick tick{next_, next_wall_, 0};
    Ns deadline = absolute_ ? next_ : std::max<Ns>(1, next_ - clock_ns());
    itimerspec value{};
    value.it_value = {deadline / 1'000'000'000, deadline % 1'000'000'000};
    require(timerfd_settime(timer_.value, absolute_ ? TFD_TIMER_ABSTIME : 0, &value, nullptr) == 0,
            "timer arm failed");
    epoll_event events[2];
    while (!cancel_.stopped()) {
        int n = epoll_wait(poll_.value, events, 2, -1);
        tick.wake = clock_ns();
        if (n < 0 && errno == EINTR)
            continue;
        require(n >= 0, "timer wait failed");
        if (cancel_.stopped())
            return {};
        for (int i = 0; i < n; ++i)
            if (events[i].data.fd == timer_.value) {
                uint64_t fired;
                auto size = read(timer_.value, &fired, sizeof(fired));
                if (size < 0 && (errno == EAGAIN || errno == EINTR))
                    continue;
                require(size == sizeof(fired), "timer read failed");
                next_ = tick.scheduled + interval_;
                next_wall_ = tick.scheduled_wall + interval_;
                return tick;
            }
    }
    return {};
}
} // namespace collector
