//go:build linux && amd64

package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSchedulerPolicyDefaultsBoundsAndTypes(t *testing.T) {
	var p schedulerPolicy
	if err := json.Unmarshal([]byte(`{"mode":"off"}`), &p); err != nil {
		t.Fatal(err)
	}
	if p != (schedulerPolicy{Mode: "off", FIFOPriority: 50, Nice: -10}) {
		t.Fatal(p)
	}
	for _, raw := range []string{`null`, `[]`, `{"nice":1.5}`, `{"nice":"-10"}`} {
		if json.Unmarshal([]byte(raw), &p) == nil {
			t.Fatal(raw)
		}
	}
	for _, tc := range []struct{ input, want schedulerPolicy }{
		{schedulerPolicy{"force", -1, -21, -1}, schedulerPolicy{"force", 0, -20, 0}},
		{schedulerPolicy{"conditional", 100, 20, 65}, schedulerPolicy{"conditional", 99, 19, 64}},
	} {
		got, corrections, err := tc.input.normalized()
		if err != nil || got != tc.want || len(corrections) != 3 {
			t.Fatalf("%+v %v %v", got, corrections, err)
		}
	}
	if _, _, err := (schedulerPolicy{Mode: "typo"}).normalized(); err == nil {
		t.Fatal("invalid mode accepted")
	}
}

func TestSchedulerRequiresDockerAndExplicitRestrictionRegardlessOfRT(t *testing.T) {
	for _, rt := range []string{"true", "false", "unknown"} {
		for _, docker := range []bool{false, true} {
			for _, fixed := range []bool{false, true} {
				env := schedulerEnvironment{Docker: docker, CPUSetVerified: fixed, RTKernel: rt, Reason: "not fixed"}
				for _, mode := range []string{"off", "conditional", "force"} {
					p := defaultSchedulerPolicy()
					p.Mode = mode
					got := selectScheduler(p, env)
					want := mode == "force" || (mode == "conditional" && docker && fixed)
					if got.Enabled != want || got.Reason == "" {
						t.Fatal(got)
					}
				}
			}
		}
	}
}

func TestSchedulerCgroupCPUSetDetection(t *testing.T) {
	for _, version := range []string{"v1", "v2"} {
		for _, mask := range []string{"", "0-7", "4-5", "1", "0-3", "8-9", "bad"} {
			files := map[string]string{"/.dockerenv": "", "/proc/self/status": "Cpus_allowed_list:\t4-5", "/sys/devices/system/cpu/online": "0-7", "/sys/kernel/realtime": "0"}
			if mask == "1" || mask == "0-3" {
				files["/proc/self/status"] = "Cpus_allowed_list:\t" + mask
			}
			dir := "/sys/fs/cgroup"
			if version == "v1" {
				files["/proc/self/cgroup"] = "3:cpuset:/docker/abc"
				files["/proc/self/mountinfo"] = "1 2 0:1 / /sys/fs/cgroup/cpuset ro - cgroup cgroup rw,cpuset"
				dir += "/cpuset/docker/abc"
			} else {
				files["/proc/self/cgroup"] = "0::/"
				files["/proc/self/mountinfo"] = "1 2 0:1 / /sys/fs/cgroup ro - cgroup2 cgroup rw"
				files[dir+"/cpuset.cpus.effective"] = mask
			}
			files[dir+"/cpuset.cpus"] = mask
			env := schedulerEnvironmentFromFiles(func(p string) ([]byte, error) {
				v, ok := files[p]
				if !ok {
					return nil, os.ErrNotExist
				}
				return []byte(v), nil
			})
			want := mask == "4-5" || mask == "1" || mask == "0-3"
			if !env.Docker || env.CPUSetVerified != want || env.RTKernel != "false" {
				t.Fatalf("%s %q: %+v", version, mask, env)
			}
		}
	}
	for _, input := range []string{"-1", "1-0", "65536", "1-2-3", ""} {
		if _, err := parseCPUList(input); err == nil {
			t.Fatal(input)
		}
	}
	if got, err := parseCPUList("1,4-5,8-10"); err != nil || len(got) != 6 {
		t.Fatal(got, err)
	}
}

func TestSchedulerCgroupMountRoots(t *testing.T) {
	for _, tc := range []struct{ group, mount, want string }{
		{"0::/docker/abc", "1 2 0:1 /docker/abc /sys/fs/cgroup ro - cgroup2 cgroup rw", "/sys/fs/cgroup"},
		{"0::/docker/abc/sub", "1 2 0:1 /docker/abc /sys/fs/cgroup ro - cgroup2 cgroup rw", "/sys/fs/cgroup/sub"},
		{"0::/wrong", "1 2 0:1 /docker/abc /sys/fs/cgroup ro - cgroup2 cgroup rw", ""},
	} {
		got, _ := cgroupCPUSetPath(tc.group, tc.mount)
		if got != tc.want {
			t.Fatal(got, tc)
		}
	}
}

// Real nice/exec validation is isolated in a child process. Never alter the
// developer's test runner or require CAP_SYS_NICE for the ordinary unit suite.
func TestSchedulerNiceExecReadback(t *testing.T) {
	if os.Getenv("NEO_DBUS_TEST_NICE_CHILD") == "1" {
		if err := bootstrapSchedulerNice(5, "unit-nice", 2); err != nil {
			t.Fatal(err)
		}
		if n, err := currentThreadNice(); err != nil || n != 5 {
			t.Fatal(n, err)
		}
		if os.Getenv("GOMAXPROCS") != "2" {
			t.Fatal("GOMAXPROCS not inherited")
		}
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestSchedulerNiceExecReadback$", "-test.timeout=10s")
	cmd.Env = append(os.Environ(), "NEO_DBUS_TEST_NICE_CHILD=1")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, output)
	}
	before, _ := currentThreadNice()
	if before != 0 {
		t.Logf("parent retained inherited nice %d", before)
	}
}

func TestSerialTimersAdvanceExactBoundariesWithoutReplay(t *testing.T) {
	base := time.Now()
	for _, absolute := range []bool{false, true} {
		var timer skippingCycleTimer
		if absolute {
			timer = &absoluteCycleTimer{interval: 10 * time.Millisecond, anchor: base, anchorNS: 100, nextNS: 100 + int64(10*time.Millisecond)}
		} else {
			timer = &standardCycleTimer{interval: 10 * time.Millisecond, next: base.Add(10 * time.Millisecond)}
		}
		if got := timer.SkipPast(base.Add(9 * time.Millisecond)); got.Count != 0 {
			t.Fatal(got)
		}
		got := timer.SkipPast(base.Add(35 * time.Millisecond))
		if got.Count != 3 || !got.Last.Equal(base.Add(30*time.Millisecond)) {
			t.Fatal(absolute, got)
		}
		if got := timer.SkipPast(base.Add(39 * time.Millisecond)); got.Count != 0 {
			t.Fatal(got)
		}
		if got := timer.SkipPast(base.Add(40 * time.Millisecond)); got.Count != 1 {
			t.Fatal(got)
		}
	}
}

func TestSchedulerBootstrapEnvironmentPreservesArguments(t *testing.T) {
	t.Setenv(schedulerBootstrapEnv, "old")
	t.Setenv("GOMAXPROCS", "3")
	env := bootstrapEnvironment("new", 2)
	var kept []string
	for _, s := range env {
		if strings.HasPrefix(s, schedulerBootstrapEnv+"=") || strings.HasPrefix(s, "GOMAXPROCS=") {
			kept = append(kept, s)
		}
	}
	if !reflect.DeepEqual(kept, []string{schedulerBootstrapEnv + "=new", "GOMAXPROCS=2"}) {
		t.Fatal(kept)
	}
}
