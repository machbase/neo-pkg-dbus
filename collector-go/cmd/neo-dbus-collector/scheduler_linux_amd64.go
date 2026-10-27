//go:build linux && amd64

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

func parseCPUList(value string) (map[int]bool, error) {
	result := map[int]bool{}
	for _, part := range strings.Split(strings.TrimSpace(value), ",") {
		bounds := strings.Split(part, "-")
		if len(bounds) < 1 || len(bounds) > 2 {
			return nil, fmt.Errorf("invalid CPU list")
		}
		first, err := strconv.Atoi(bounds[0])
		if err != nil || first < 0 || first > 65535 {
			return nil, fmt.Errorf("invalid CPU number")
		}
		last := first
		if len(bounds) == 2 {
			last, err = strconv.Atoi(bounds[1])
			if err != nil || last < first || last > 65535 {
				return nil, fmt.Errorf("invalid CPU range")
			}
		}
		for i := first; i <= last; i++ {
			result[i] = true
		}
	}
	return result, nil
}

func cgroupCPUSetPath(groups, mounts string) (string, string) {
	var v1, v2 string
	for _, line := range strings.Split(groups, "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		if parts[0] == "0" && parts[1] == "" {
			v2 = parts[2]
		}
		for _, c := range strings.Split(parts[1], ",") {
			if c == "cpuset" {
				v1 = parts[2]
			}
		}
	}
	decode := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\134`, `\`).Replace
	for _, line := range strings.Split(mounts, "\n") {
		parts := strings.SplitN(line, " - ", 2)
		if len(parts) != 2 {
			continue
		}
		head, tail := strings.Fields(parts[0]), strings.Fields(parts[1])
		if len(head) < 5 || len(tail) < 3 {
			continue
		}
		group, version := "", ""
		if tail[0] == "cgroup2" && v2 != "" {
			group, version = v2, "v2"
		}
		if tail[0] == "cgroup" && v1 != "" {
			for _, option := range strings.Split(tail[2], ",") {
				if option == "cpuset" {
					group, version = v1, "v1"
				}
			}
		}
		if group == "" {
			continue
		}
		root, mount := filepath.Clean(decode(head[3])), filepath.Clean(decode(head[4]))
		group = filepath.Clean(group)
		if group == root {
			return mount, version
		}
		if root == "/" {
			return filepath.Join(mount, strings.TrimPrefix(group, "/")), version
		}
		if strings.HasPrefix(group, root+"/") {
			return filepath.Join(mount, strings.TrimPrefix(group, root+"/")), version
		}
	}
	return "", ""
}

func schedulerEnvironmentFromFiles(read func(string) ([]byte, error)) schedulerEnvironment {
	env := schedulerEnvironment{RTKernel: "unknown", Reason: "cgroup cpuset not confirmed"}
	readText := func(file string) string {
		b, e := read(file)
		if e != nil {
			return ""
		}
		return strings.TrimSpace(string(b))
	}
	if _, err := read("/.dockerenv"); err == nil {
		env.Docker = true
	}
	groups := readText("/proc/self/cgroup")
	if strings.Contains(groups, "/docker/") || strings.Contains(groups, "docker-") {
		env.Docker = true
	}
	for _, line := range strings.Split(readText("/proc/self/status"), "\n") {
		if strings.HasPrefix(line, "Cpus_allowed_list:") {
			env.CPUs = strings.TrimSpace(strings.TrimPrefix(line, "Cpus_allowed_list:"))
		}
	}
	env.Online = readText("/sys/devices/system/cpu/online")
	switch readText("/sys/kernel/realtime") {
	case "1":
		env.RTKernel = "true"
	case "0":
		env.RTKernel = "false"
	default:
		if version := readText("/proc/version"); version != "" {
			env.RTKernel = strconv.FormatBool(strings.Contains(version, "PREEMPT_RT"))
		}
	}
	dir, version := cgroupCPUSetPath(groups, readText("/proc/self/mountinfo"))
	if dir == "" {
		return env
	}
	env.CPUSet = readText(filepath.Join(dir, "cpuset.cpus"))
	if env.CPUSet == "" {
		env.Reason = "cpuset.cpus is inherited/unconfigured"
		return env
	}
	configured, e1 := parseCPUList(env.CPUSet)
	online, e2 := parseCPUList(env.Online)
	allowed, e3 := parseCPUList(env.CPUs)
	if e1 != nil || e2 != nil || e3 != nil {
		env.Reason = "CPU list is unavailable/invalid"
		return env
	}
	// cgroup v1 may populate the parent's complete mask without a Docker
	// --cpuset-cpus option. The CLI/HostConfig is not a container API: do not
	// mount the Docker socket or guess that a full inherited mask was explicit.
	// Require a proven restriction. Ambiguous/full masks use ordinary policy;
	// an operator can explicitly choose force. CPU quota alone never qualifies.
	if len(configured) >= len(online) {
		env.Reason = "cpuset does not prove a restricted CPU range"
		return env
	}
	for cpu := range configured {
		if !online[cpu] {
			env.Reason = "cpuset contains an offline CPU"
			return env
		}
	}
	for cpu := range allowed {
		if !configured[cpu] {
			env.Reason = "process affinity disagrees with cgroup cpuset"
			return env
		}
	}
	if version == "v2" {
		effective := readText(filepath.Join(dir, "cpuset.cpus.effective"))
		actual, e := parseCPUList(effective)
		if e != nil {
			env.Reason = "effective cpuset unavailable"
			return env
		}
		for cpu := range allowed {
			if !actual[cpu] {
				env.Reason = "process affinity disagrees with effective cpuset"
				return env
			}
		}
	}
	env.CPUSetVerified = true
	env.Reason = "cgroup cpuset restricts CPUs"
	return env
}

func detectSchedulerEnvironment() schedulerEnvironment {
	return schedulerEnvironmentFromFiles(os.ReadFile)
}

type threadScheduling struct {
	policy   int
	priority int32
}

func readThreadScheduling() (threadScheduling, error) {
	policy, _, e := syscall.RawSyscall(syscall.SYS_SCHED_GETSCHEDULER, 0, 0, 0)
	if e != 0 {
		return threadScheduling{}, e
	}
	var param struct{ Priority int32 }
	_, _, e = syscall.RawSyscall(syscall.SYS_SCHED_GETPARAM, 0, uintptr(unsafe.Pointer(&param)), 0)
	return threadScheduling{int(policy), param.Priority}, errnoError(e)
}
func errnoError(e syscall.Errno) error {
	if e == 0 {
		return nil
	}
	return e
}
func setThreadScheduling(s threadScheduling) error {
	param := struct{ Priority int32 }{s.priority}
	_, _, e := syscall.RawSyscall(syscall.SYS_SCHED_SETSCHEDULER, 0, uintptr(s.policy), uintptr(unsafe.Pointer(&param)))
	return errnoError(e)
}
func enterFIFO(priority int) (func() error, error) {
	runtime.LockOSThread()
	old, err := readThreadScheduling()
	if err != nil {
		runtime.UnlockOSThread()
		return nil, err
	}
	target := threadScheduling{policy: 0}
	if priority > 0 {
		target = threadScheduling{policy: 1, priority: int32(priority)}
	}
	if err = setThreadScheduling(target); err != nil {
		runtime.UnlockOSThread()
		return nil, err
	}
	actual, readErr := readThreadScheduling()
	if readErr != nil || actual != target {
		restoreErr := setThreadScheduling(old)
		if restoreErr == nil {
			runtime.UnlockOSThread()
		}
		if restoreErr != nil {
			return nil, fmt.Errorf("%w: FIFO probe restoration: %v", errSchedulerBootstrap, restoreErr)
		}
		return nil, fmt.Errorf("FIFO readback mismatch: requested=%v actual=%v read=%v", target, actual, readErr)
	}
	return func() error {
		if err := setThreadScheduling(old); err != nil {
			return err
		}
		runtime.UnlockOSThread()
		return nil
	}, nil
}
func probeReaderFIFO(priority int) error {
	if priority == 0 {
		return nil
	}
	restore, err := enterFIFO(priority)
	if err != nil {
		return fmt.Errorf("FIFO %d: %w", priority, err)
	}
	if err = restore(); err != nil {
		return fmt.Errorf("%w: restore FIFO probe: %v", errSchedulerBootstrap, err)
	}
	return nil
}
func currentThreadNice() (int, error) {
	p, e := syscall.Getpriority(syscall.PRIO_PROCESS, 0)
	return 20 - p, e
}

func bootstrapSchedulerNice(nice int, key string, procs int) error {
	actual, err := currentThreadNice()
	if err != nil {
		return err
	}
	if marker := os.Getenv(schedulerBootstrapEnv); marker != "" {
		if marker != key || actual != nice {
			return fmt.Errorf("scheduler exec readback mismatch: nice requested=%d actual=%d", nice, actual)
		}
		// Go/C threads created after exec inherit this value. Verify the initial
		// runtime threads as well, so a partial per-thread update is never hidden.
		entries, e := os.ReadDir("/proc/self/task")
		if e != nil {
			return e
		}
		for _, entry := range entries {
			tid, e := strconv.Atoi(entry.Name())
			if e != nil {
				continue
			}
			p, e := syscall.Getpriority(syscall.PRIO_PROCESS, tid)
			if e == syscall.ESRCH {
				continue
			}
			if e != nil {
				return e
			}
			if 20-p != nice {
				return fmt.Errorf("thread %d nice mismatch", tid)
			}
		}
		return nil
	}
	if nice == 0 && actual == 0 {
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err = syscall.Setpriority(syscall.PRIO_PROCESS, 0, nice); err != nil {
		return err
	}
	if err = syscall.Exec(executable, os.Args, bootstrapEnvironment(key, procs)); err != nil {
		// Only this bootstrap thread changed nice. Do not continue with mixed
		// priorities if exec failed after the change.
		return fmt.Errorf("%w: exec collector with inherited nice: %v", errSchedulerBootstrap, err)
	}
	return nil
}

func (d *daemon) enterReaderScheduling(name string) (func(), error) {
	if !d.scheduling.Enabled {
		return func() {}, nil
	}
	restore, err := enterFIFO(d.scheduling.Policy.FIFOPriority)
	if err != nil {
		if d.scheduling.Policy.Mode == "conditional" && !errors.Is(err, errSchedulerBootstrap) {
			d.logAlways(name, "WARN", "scheduler", "reader FIFO unavailable; continuing with ordinary scheduling: "+err.Error())
			return func() {}, nil
		}
		return nil, err
	}
	nice, _ := currentThreadNice()
	d.logAlways(name, "INFO", "scheduler", fmt.Sprintf("reader policy applied; tid=%d fifoPriority=%d nice=%d cpus=%q", syscall.Gettid(), d.scheduling.Policy.FIFOPriority, nice, d.scheduling.Environment.CPUs))
	return func() {
		if err := restore(); err != nil {
			// Keep the goroutine locked: when it exits Go retires the OS thread.
			// Never return a still-FIFO thread to Go's general worker pool.
			d.logAlways(name, "ERROR", "scheduler", "reader policy restore failed; retiring locked thread: "+err.Error())
		}
	}, nil
}
