//go:build linux && amd64

package main

import (
	"context"
	"fmt"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const clockMonotonic = 1

type absoluteCycleTimer struct {
	fd, epoll        int
	cancelFD         [2]int
	interval         time.Duration
	anchor           time.Time
	anchorNS, nextNS int64
	stop             chan struct{}
	stopped          chan struct{}
	once             sync.Once
	skipped          timerSkipped
}

func monotonicNS() (int64, error) {
	var ts syscall.Timespec
	_, _, errno := syscall.RawSyscall(syscall.SYS_CLOCK_GETTIME, clockMonotonic, uintptr(unsafe.Pointer(&ts)), 0)
	if errno != 0 {
		return 0, errno
	}
	return ts.Sec*1e9 + ts.Nsec, nil
}

func newAbsoluteCycleTimer(ctx context.Context, interval time.Duration) (cycleTimer, error) {
	t := &absoluteCycleTimer{fd: -1, epoll: -1, cancelFD: [2]int{-1, -1}, interval: interval, stop: make(chan struct{}), stopped: make(chan struct{})}
	cleanup := func(err error) (cycleTimer, error) { t.closeFDs(); return nil, fmt.Errorf("absolute timer: %w", err) }
	fd, _, errno := syscall.Syscall(syscall.SYS_TIMERFD_CREATE, clockMonotonic, syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if errno != 0 {
		return cleanup(errno)
	}
	t.fd = int(fd)
	var err error
	t.epoll, err = syscall.EpollCreate1(syscall.EPOLL_CLOEXEC)
	if err != nil {
		return cleanup(err)
	}
	if err = syscall.Pipe2(t.cancelFD[:], syscall.O_CLOEXEC|syscall.O_NONBLOCK); err != nil {
		return cleanup(err)
	}
	for _, watched := range []int{t.fd, t.cancelFD[0]} {
		if err = syscall.EpollCtl(t.epoll, syscall.EPOLL_CTL_ADD, watched, &syscall.EpollEvent{Events: syscall.EPOLLIN, Fd: int32(watched)}); err != nil {
			return cleanup(err)
		}
	}
	// Associate one wall-clock epoch boundary with monotonic time. Subsequent
	// deadlines use only monotonic time, so wall-clock changes cannot move them.
	t.anchor = time.Now()
	t.anchorNS, err = monotonicNS()
	if err != nil {
		return cleanup(err)
	}
	t.nextNS = t.anchorNS + int64(nextAligned(t.anchor, interval))
	go func() {
		defer close(t.stopped)
		select {
		case <-ctx.Done():
			for {
				_, err := syscall.Write(t.cancelFD[1], []byte{1})
				if err != syscall.EINTR {
					break
				}
			}
		case <-t.stop:
		}
	}()
	return t, nil
}

func (t *absoluteCycleTimer) Wait(ctx context.Context) (time.Time, time.Time, error) {
	if err := ctx.Err(); err != nil {
		return time.Time{}, time.Time{}, err
	}
	t.skipped = mergeTimerSkipped(t.skipped, t.SkipPast(time.Now()))
	deadline := t.nextNS
	// Linux/amd64 struct itimerspec: interval, value. One-shot absolute expiry.
	spec := [2]syscall.Timespec{{}, syscall.NsecToTimespec(deadline)}
	_, _, errno := syscall.Syscall6(syscall.SYS_TIMERFD_SETTIME, uintptr(t.fd), 1 /* TFD_TIMER_ABSTIME */, uintptr(unsafe.Pointer(&spec)), 0, 0, 0)
	if errno != 0 {
		return time.Time{}, time.Time{}, errno
	}
	events := make([]syscall.EpollEvent, 2)
	for {
		n, waitErr := syscall.EpollWait(t.epoll, events, -1)
		wake := time.Now()
		if ctx.Err() != nil {
			return time.Time{}, time.Time{}, ctx.Err()
		}
		if waitErr == syscall.EINTR {
			continue
		}
		if waitErr != nil {
			return time.Time{}, time.Time{}, waitErr
		}
		for _, event := range events[:n] {
			if int(event.Fd) != t.fd {
				continue
			}
			var ticks [8]byte
			if _, err := syscall.Read(t.fd, ticks[:]); err != nil {
				if err == syscall.EAGAIN || err == syscall.EINTR {
					continue
				}
				return time.Time{}, time.Time{}, err
			}
			t.nextNS = deadline + int64(t.interval)
			return t.anchor.Add(time.Duration(deadline - t.anchorNS)), wake, nil
		}
	}
}

func (t *absoluteCycleTimer) SkipPast(now time.Time) timerSkipped {
	mono := t.anchorNS + now.Sub(t.anchor).Nanoseconds()
	if t.nextNS > mono {
		return timerSkipped{}
	}
	count := (mono-t.nextNS)/int64(t.interval) + 1
	last := t.nextNS + (count-1)*int64(t.interval)
	t.nextNS += count * int64(t.interval)
	return timerSkipped{Count: uint64(count), Last: t.anchor.Add(time.Duration(last - t.anchorNS))}
}
func (t *absoluteCycleTimer) TakeSkipped() timerSkipped {
	s := t.skipped
	t.skipped = timerSkipped{}
	return s
}

// Close runs after Wait has returned. Join the cancellation writer before
// closing descriptors, preventing a late write to an unrelated, reused FD.
func (t *absoluteCycleTimer) Close() {
	t.once.Do(func() { close(t.stop); <-t.stopped; t.closeFDs() })
}

func (t *absoluteCycleTimer) closeFDs() {
	for _, fd := range []int{t.fd, t.epoll, t.cancelFD[0], t.cancelFD[1]} {
		if fd >= 0 {
			_ = syscall.Close(fd)
		}
	}
}
