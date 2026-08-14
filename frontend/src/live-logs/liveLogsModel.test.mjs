import test from "node:test";
import assert from "node:assert/strict";

import {
    activeLogFile,
    nextClearState,
    recordedLevels,
    visibleTail,
} from "./liveLogsModel.js";

test("info level은 INFO WARN ERROR를 기록한다", () => {
    assert.deepEqual(recordedLevels("info"), ["INFO", "WARN", "ERROR"]);
});

test("active 파일을 고르고 tail을 마지막 100줄로 제한한다", () => {
    assert.equal(activeLogFile([{ name: "old.log" }, { name: "job.log", active: true }]), "job.log");
    const lines = Array.from({ length: 120 }, (_, index) => `line-${index}`);
    assert.deepEqual(visibleTail({ file: "job.log", lines, totalLines: 120 }, null), lines.slice(20));
});

test("clear 뒤 추가된 줄만 보이고 truncation은 새 snapshot으로 처리한다", () => {
    const clear = nextClearState({ file: "job.log", totalLines: 5 });
    assert.deepEqual(visibleTail({ file: "job.log", lines: ["4", "5", "6"], totalLines: 6 }, clear), ["6"]);
    assert.deepEqual(visibleTail({ file: "job.log", lines: ["new"], totalLines: 1 }, clear), ["new"]);
});

test("유효하지 않은 최대 줄 수는 기본 마지막 100줄을 표시한다", () => {
    const lines = Array.from({ length: 120 }, (_, index) => `line-${index}`);
    const snapshot = { file: "job.log", lines, totalLines: 120 };

    for (const maximum of [Number.NaN, Number.POSITIVE_INFINITY, null, 0, -1, 1.5]) {
        assert.deepEqual(visibleTail(snapshot, null, maximum), lines.slice(20));
    }
});
