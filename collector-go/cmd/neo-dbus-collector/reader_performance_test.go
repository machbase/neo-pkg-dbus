package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func readerPerformanceFixture(sampleCount int, source string) *daemon {
	return &daemon{
		performancePolicy: performancePolicy{Enabled: true, JobSampleCount: sampleCount},
		jobPerformance:    map[string]*jobPerformance{"line-a": newJobPerformance(sampleCount, source)},
		performanceLogs:   make(chan performanceLogRecord, 8),
	}
}

func readerPerformanceRecord(t *testing.T, d *daemon) performanceLogRecord {
	t.Helper()
	select {
	case record := <-d.performanceLogs:
		return record
	default:
		t.Fatal("performance window was not emitted")
		return performanceLogRecord{}
	}
}

func assertReaderPerformance(t *testing.T, record performanceLogRecord, expected string) {
	t.Helper()
	text := formatJobPerformance(record.Name, record.Summary)
	if !strings.Contains(text, expected) {
		t.Fatalf("missing %q in %s", expected, text)
	}
}

func TestReaderExtremaRetainDBusFromTheSameCycle(t *testing.T) {
	d := readerPerformanceFixture(1000, "dbus")
	d.recordJobPerformance("line-a", readTiming{ReaderTotal: 1100 * time.Microsecond, DBus: 1000 * time.Microsecond, ReaderTotalMeasured: true, DBusMeasured: true}, nil)
	for index := 0; index < 998; index++ {
		dbusUS := 800
		if index%2 == 0 {
			dbusUS = 1300
		}
		d.recordJobPerformance("line-a", readTiming{ReaderTotal: 1365 * time.Microsecond, DBus: time.Duration(dbusUS) * time.Microsecond, ReaderTotalMeasured: true, DBusMeasured: true}, nil)
	}
	d.recordJobPerformance("line-a", readTiming{ReaderTotal: 1743 * time.Microsecond, DBus: 1200 * time.Microsecond, ReaderTotalMeasured: true, DBusMeasured: true}, nil)
	record := readerPerformanceRecord(t, d)
	minimum, _, _, _, maximum := durationSummaryUS(record.Summary.DBusUS)
	if minimum != 800 || maximum != 1300 {
		t.Fatalf("fixture must have independent DBus extrema: min=%d max=%d", minimum, maximum)
	}
	assertReaderPerformance(t, record, "readerTotalUs[min=1100(dbus=1000) p99=1365 max=1743(dbus=1200)]")
}

func TestReaderExtremaKeepFirstCycleWhenMicrosecondsTie(t *testing.T) {
	d := readerPerformanceFixture(4, "dbus")
	for _, timing := range []readTiming{
		{ReaderTotal: time.Millisecond, DBus: 800 * time.Microsecond},
		{ReaderTotal: time.Millisecond + 999*time.Nanosecond, DBus: 900 * time.Microsecond},
		{ReaderTotal: 2 * time.Millisecond, DBus: time.Millisecond},
		{ReaderTotal: 2*time.Millisecond + 999*time.Nanosecond, DBus: 1500 * time.Microsecond},
	} {
		timing.ReaderTotalMeasured, timing.DBusMeasured = true, true
		d.recordJobPerformance("line-a", timing, nil)
	}
	assertReaderPerformance(t, readerPerformanceRecord(t, d), "readerTotalUs[min=1000(dbus=800) p99=2000 max=2000(dbus=1000)]")
}

func TestReaderExtremaDistinguishUnmeasuredDBusAndMeasuredZero(t *testing.T) {
	for _, test := range []struct {
		name     string
		source   string
		timing   readTiming
		expected string
	}{
		{"measured-zero", "dbus", readTiming{ReaderTotalMeasured: true, DBusMeasured: true}, "readerTotalUs[min=0(dbus=0) p99=0 max=0(dbus=0)]"},
		{"test-source", "test", readTiming{ReaderTotal: time.Millisecond, ReaderTotalMeasured: true}, "readerTotalUs[min=1000(dbus=n/a) p99=1000 max=1000(dbus=n/a)]"},
		{"missing-dbus", "dbus", readTiming{ReaderTotal: time.Microsecond, DBus: time.Second, ReaderTotalMeasured: true}, "readerTotalUs[min=1(dbus=n/a) p99=1 max=1(dbus=n/a)]"},
		{"missing-reader", "dbus", readTiming{DBus: time.Millisecond, DBusMeasured: true}, "readerTotalUs[min=0(dbus=n/a) p99=0 max=0(dbus=n/a)]"},
	} {
		t.Run(test.name, func(t *testing.T) {
			d := readerPerformanceFixture(1, test.source)
			d.recordJobPerformance("line-a", test.timing, nil)
			assertReaderPerformance(t, readerPerformanceRecord(t, d), test.expected)
		})
	}
}

func TestReaderExtremaPreservePartialErrorAndSampleFlags(t *testing.T) {
	d := readerPerformanceFixture(3, "dbus")
	d.recordJobPerformance("line-a", readTiming{}, errors.New("not measured"))
	d.recordJobPerformance("line-a", readTiming{ReaderTotal: 700 * time.Microsecond, DBus: 500 * time.Microsecond, ReaderTotalMeasured: true, DBusMeasured: true}, errors.New("second Call failed"))
	d.recordJobPerformance("line-a", readTiming{ReaderTotal: time.Millisecond, DBus: 800 * time.Microsecond, ReaderTotalMeasured: true, DBusMeasured: true}, nil)
	record := readerPerformanceRecord(t, d)
	if record.Summary.Attempts != 3 || record.Summary.ErrorCount != 2 || len(record.Summary.ReaderTotalUS) != 2 {
		t.Fatalf("sample/error policy changed: %#v", record.Summary)
	}
	assertReaderPerformance(t, record, "readerTotalUs[min=700(dbus=500) p99=1000 max=1000(dbus=800)]")
}

func TestReaderExtremaAreIndependentAcrossJobsAndWindows(t *testing.T) {
	d := readerPerformanceFixture(2, "dbus")
	for window := 0; window < 2; window++ {
		for sample := 0; sample < 2; sample++ {
			for index, name := range []string{"line-a", "line-b"} {
				value := time.Duration(window*100+index*10+sample+1) * time.Microsecond
				d.recordJobPerformance(name, readTiming{ReaderTotal: value + time.Microsecond, DBus: value, ReaderTotalMeasured: true, DBusMeasured: true}, nil)
			}
		}
	}
	for _, expected := range []string{
		"readerTotalUs[min=2(dbus=1) p99=3 max=3(dbus=2)]",
		"readerTotalUs[min=12(dbus=11) p99=13 max=13(dbus=12)]",
		"readerTotalUs[min=102(dbus=101) p99=103 max=103(dbus=102)]",
		"readerTotalUs[min=112(dbus=111) p99=113 max=113(dbus=112)]",
	} {
		assertReaderPerformance(t, readerPerformanceRecord(t, d), expected)
	}
}
