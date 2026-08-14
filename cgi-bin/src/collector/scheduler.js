'use strict';

function calculateNextDelay(success, consecutiveFailures, intervalMs, retry) {
  if (success) return intervalMs;
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(retry.maximumDelayMs, retry.initialDelayMs * (retry.multiplier ** exponent));
}

function createScheduler(options) {
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let timer = null;
  let stopped = true;
  let failures = 0;

  function schedule(delay) {
    if (stopped) return;
    if (typeof options.onSchedule === 'function') {
      try { options.onSchedule({ delayMs: delay, consecutiveFailures: failures }); } catch (_) {}
    }
    timer = setTimer(execute, delay);
  }

  function execute() {
    if (stopped) return;
    let result;
    try { result = options.run(); } catch (runError) { result = { status: 'failed', lastError: runError.message }; }
    const success = result && result.status === 'success';
    failures = success ? 0 : failures + 1;
    if (typeof options.onResult === 'function') {
      try { options.onResult(result); } catch (_) {}
    }
    schedule(calculateNextDelay(success, failures, options.intervalMs, options.retry));
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      execute();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

module.exports = { calculateNextDelay, createScheduler };
