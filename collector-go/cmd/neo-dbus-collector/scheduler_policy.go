package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
)

const schedulerBootstrapEnv = "NEO_DBUS_SCHEDULER_BOOTSTRAP"

var errSchedulerBootstrap = errors.New("scheduler bootstrap cannot safely continue")

// Deployment tuning, never a Job/FE option; changes require a service restart.
// off: leave OS priorities inherited. conditional: Docker + verified cgroup
// cpuset restriction only. force: attempt regardless of environment, fail if
// OS settings cannot be applied. PREEMPT_RT is diagnostic, not a prerequisite.
// FIFO 0..99 (0=OTHER), nice -20..19 (lower is higher), GOMAXPROCS 0..64.
// 0 GOMAXPROCS leaves the Go default/environment alone. 64 is our deployment
// safety cap, NOT a claim about Go's maximum. Out-of-range integers are clamped
// and audited; invalid modes/types are errors. Never silently clamp bad types.
type schedulerPolicy struct {
	Mode         string `json:"mode"`
	FIFOPriority int    `json:"fifoPriority"`
	Nice         int    `json:"nice"`
	GoMaxProcs   int    `json:"gomaxprocs"`
}

func defaultSchedulerPolicy() schedulerPolicy {
	return schedulerPolicy{Mode: "conditional", FIFOPriority: 50, Nice: -10}
}

func (p *schedulerPolicy) UnmarshalJSON(data []byte) error {
	type plain schedulerPolicy
	value := plain(defaultSchedulerPolicy())
	if string(data) == "null" {
		return fmt.Errorf("scheduler must be an object")
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*p = schedulerPolicy(value)
	return nil
}

func (p schedulerPolicy) normalized() (schedulerPolicy, []string, error) {
	if p.Mode != "off" && p.Mode != "conditional" && p.Mode != "force" {
		return p, nil, fmt.Errorf("invalid scheduler mode %q", p.Mode)
	}
	var corrections []string
	clamp := func(name string, value *int, min, max int) {
		original := *value
		if *value < min {
			*value = min
		}
		if *value > max {
			*value = max
		}
		if original != *value {
			corrections = append(corrections, fmt.Sprintf("%s=%d->%d", name, original, *value))
		}
	}
	clamp("fifoPriority", &p.FIFOPriority, 0, 99)
	clamp("nice", &p.Nice, -20, 19)
	clamp("gomaxprocs", &p.GoMaxProcs, 0, 64)
	return p, corrections, nil
}

type schedulerEnvironment struct {
	Docker                         bool
	CPUs, CPUSet, Online, RTKernel string
	CPUSetVerified                 bool
	Reason                         string
}

type schedulerRuntime struct {
	Policy      schedulerPolicy
	Environment schedulerEnvironment
	Enabled     bool
	Reason      string
}

func selectScheduler(p schedulerPolicy, env schedulerEnvironment) schedulerRuntime {
	r := schedulerRuntime{Policy: p, Environment: env}
	switch p.Mode {
	case "off":
		r.Reason = "disabled by configuration"
	case "force":
		r.Enabled = true
		r.Reason = "forced by configuration"
	case "conditional":
		if !env.Docker {
			r.Reason = "Docker not confirmed"
		} else if !env.CPUSetVerified {
			r.Reason = env.Reason
		} else {
			r.Enabled = true
			r.Reason = "Docker cgroup cpuset confirmed"
		}
	}
	return r
}

func schedulerAudit(root, level, message string, policy logPolicy) {
	// One compact startup audit, plus range corrections. Reuse bounded rotation;
	// no per-cycle log or new logging worker. Stderr also covers service failures.
	fmt.Fprintln(os.Stderr, "neo-dbus-collector: scheduler:", message)
	d := &daemon{root: root}
	d.writeLog("_collector", level, "scheduler", message, policy.normalized())
}

func prepareScheduler(root string) (schedulerRuntime, error) {
	config, err := loadSnapshot(root)
	if err != nil {
		return schedulerRuntime{}, err
	}
	requested := defaultSchedulerPolicy()
	if config.Scheduler != nil {
		requested = *config.Scheduler
	}
	p, corrections, err := requested.normalized()
	if err != nil {
		return schedulerRuntime{}, err
	}
	if os.Getenv(schedulerBootstrapEnv) == "" {
		for _, c := range corrections {
			schedulerAudit(root, "WARN", "configuration corrected; "+c, config.Logging)
		}
	}
	r := selectScheduler(p, detectSchedulerEnvironment())
	if p.GoMaxProcs > 0 {
		runtime.GOMAXPROCS(p.GoMaxProcs)
	}
	if r.Enabled {
		if err := probeReaderFIFO(p.FIFOPriority); err != nil {
			if p.Mode == "force" || errors.Is(err, errSchedulerBootstrap) {
				schedulerAudit(root, "ERROR", "forced FIFO preparation failed: "+err.Error(), config.Logging)
				return r, err
			}
			r.Enabled = false
			r.Reason = "FIFO unavailable: " + err.Error()
		}
	}
	if r.Enabled {
		// Exec replaces all bootstrap threads at the same PID. New Go/C threads
		// then inherit the requested nice value; changing only the main thread
		// after Go startup cannot provide this guarantee on Linux.
		key := fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%s|%v", root, p))))
		if err := bootstrapSchedulerNice(p.Nice, key, p.GoMaxProcs); err != nil {
			if p.Mode == "force" || errors.Is(err, errSchedulerBootstrap) || os.Getenv(schedulerBootstrapEnv) != "" {
				schedulerAudit(root, "ERROR", "scheduler bootstrap failed: "+err.Error(), config.Logging)
				return r, err
			}
			r.Enabled = false
			r.Reason = "nice unavailable: " + err.Error()
		}
	}
	nice, niceErr := currentThreadNice()
	niceText := fmt.Sprint(nice)
	if niceErr != nil {
		niceText = "unknown"
	}
	level := "INFO"
	if p.Mode == "conditional" && !r.Enabled {
		level = "WARN"
	}
	message := fmt.Sprintf("policy selected; mode=%s enabled=%t reason=%q docker=%t cpus=%q cpuset=%q online=%q rtKernel=%s requestedFIFO=%d requestedNice=%d appliedNice=%s gomaxprocs=%d", p.Mode, r.Enabled, r.Reason, r.Environment.Docker, r.Environment.CPUs, r.Environment.CPUSet, r.Environment.Online, r.Environment.RTKernel, p.FIFOPriority, p.Nice, niceText, runtime.GOMAXPROCS(0))
	schedulerAudit(root, level, message, config.Logging)
	return r, nil
}

func bootstrapEnvironment(key string, procs int) []string {
	env := make([]string, 0, len(os.Environ())+2)
	for _, s := range os.Environ() {
		if !strings.HasPrefix(s, schedulerBootstrapEnv+"=") && !(procs > 0 && strings.HasPrefix(s, "GOMAXPROCS=")) {
			env = append(env, s)
		}
	}
	env = append(env, schedulerBootstrapEnv+"="+key)
	if procs > 0 {
		env = append(env, fmt.Sprintf("GOMAXPROCS=%d", procs))
	}
	return env
}
