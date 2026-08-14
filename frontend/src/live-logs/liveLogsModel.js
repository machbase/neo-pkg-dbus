export const LOG_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];

export function recordedLevels(level) {
    const index = LOG_LEVELS.indexOf(String(level || "info").toUpperCase());
    return LOG_LEVELS.slice(index < 0 ? 2 : index);
}

export function activeLogFile(files = []) {
    return files.find((file) => file?.active)?.name || "";
}

export function nextClearState(tail = {}) {
    return {
        file: tail.file || "",
        totalLines: Number(tail.totalLines) || 0,
    };
}

export function visibleTail(snapshot = {}, clearState, maximum = 100) {
    const maximumLines = Number.isFinite(maximum) && Number.isInteger(maximum) && maximum > 0
        ? maximum
        : 100;

    const lines = Array.isArray(snapshot.lines) ? snapshot.lines : [];
    const totalLines = Number(snapshot.totalLines) || 0;
    const sameFile = clearState?.file === snapshot.file;
    const hasGrownSinceClear = totalLines >= (Number(clearState?.totalLines) || 0);
    const clearIsValid = sameFile && hasGrownSinceClear;
    const firstVisibleLine = totalLines - lines.length;
    const linesSinceClear = clearIsValid
        ? lines.slice(Math.max(0, (Number(clearState.totalLines) || 0) - firstVisibleLine))
        : lines;

    return linesSinceClear.slice(-maximumLines);
}
