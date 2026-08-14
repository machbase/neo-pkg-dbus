import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { api } from "../api.js";
import Icon from "../components/Icon.jsx";
import { LOG_LEVELS, activeLogFile, nextClearState, visibleTail } from "./liveLogsModel.js";

const MAX_LINES = 100;
const DEFAULT_WIDTH = 460;
const DEFAULT_HEIGHT = 360;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 220;
const VIEWPORT_MARGIN = 24;
const CLOSE_SIZE = 28;
const CLOSE_RIGHT = 16;
const CLOSE_TOP = 12;
const SAFE_MIN_WIDTH = CLOSE_SIZE + CLOSE_RIGHT * 2;
const SAFE_MIN_HEIGHT = CLOSE_SIZE + CLOSE_TOP * 2;
const POLL_INTERVAL_MS = 1000;
const LEVEL_RE = new RegExp(`\\[(${LOG_LEVELS.join("|")})\\]`);

function viewportBounds() {
  const width = Math.max(0, Number(window.innerWidth) || 0);
  const height = Math.max(0, Number(window.innerHeight) || 0);
  const marginX = Math.min(VIEWPORT_MARGIN, Math.max(0, (width - SAFE_MIN_WIDTH) / 2));
  const marginY = Math.min(VIEWPORT_MARGIN, Math.max(0, (height - SAFE_MIN_HEIGHT) / 2));
  return {
    width,
    height,
    marginX,
    marginY,
    availableWidth: Math.max(0, width - marginX * 2),
    availableHeight: Math.max(0, height - marginY * 2),
  };
}

function minimumPanelExtent(available, preferredMinimum, safeMinimum) {
  if (available >= preferredMinimum) return preferredMinimum;
  return Math.min(safeMinimum, available);
}

function clampSize(width, height) {
  if (typeof window === "undefined") return { width, height };
  const viewport = viewportBounds();
  const minimumWidth = minimumPanelExtent(viewport.availableWidth, MIN_WIDTH, SAFE_MIN_WIDTH);
  const minimumHeight = minimumPanelExtent(viewport.availableHeight, MIN_HEIGHT, SAFE_MIN_HEIGHT);
  return {
    width: Math.min(Math.max(minimumWidth, width), viewport.availableWidth),
    height: Math.min(Math.max(minimumHeight, height), viewport.availableHeight),
  };
}

function clampPosition(position, size) {
  if (typeof window === "undefined") return position;
  const viewport = viewportBounds();
  const maximumX = Math.max(viewport.marginX, viewport.width - size.width - viewport.marginX);
  const maximumY = Math.max(viewport.marginY, viewport.height - size.height - viewport.marginY);
  return {
    x: Math.min(Math.max(viewport.marginX, position.x), maximumX),
    y: Math.min(Math.max(viewport.marginY, position.y), maximumY),
  };
}

function defaultPosition(size) {
  if (typeof window === "undefined") return { x: VIEWPORT_MARGIN, y: VIEWPORT_MARGIN };
  return clampPosition({ x: window.innerWidth, y: window.innerHeight }, size);
}

function renderLine(value) {
  const text = String(value ?? "");
  const match = text.match(LEVEL_RE);
  if (!match) return text;
  const level = match[1];
  return (
    <>
      {text.slice(0, match.index)}
      <span className={`neo-live-logs__level neo-live-logs__level--${level.toLowerCase()}`}>[{level}]</span>
      {text.slice(match.index + match[0].length)}
    </>
  );
}

export default function LiveLogs({
  jobName,
  open,
  onClose,
  logsApi = api.logs,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
}) {
  const [lines, setLines] = useState([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [size, setSize] = useState(() => clampSize(DEFAULT_WIDTH, DEFAULT_HEIGHT));
  const [position, setPosition] = useState(() => defaultPosition(clampSize(DEFAULT_WIDTH, DEFAULT_HEIGHT)));
  const panelRef = useRef(null);
  const bodyRef = useRef(null);
  const pausedRef = useRef(false);
  const latestTailRef = useRef(null);
  const clearStateRef = useRef(null);
  const timerRef = useRef(null);
  const stopRef = useRef(() => {});
  const pauseRef = useRef(() => {});
  const resumeRef = useRef(() => {});
  const stickToBottomRef = useRef(true);
  const sizeRef = useRef(size);
  const dragRef = useRef(null);
  const startDragRef = useRef(() => {});
  const resizeRef = useRef(null);
  const startResizeRef = useRef(() => {});

  sizeRef.current = size;

  useEffect(() => {
    if (!jobName || !open) return undefined;

    let activeFile = "";
    let stopped = false;
    let currentRun = null;
    let nextGeneration = 0;

    pausedRef.current = false;
    latestTailRef.current = null;
    clearStateRef.current = null;
    stickToBottomRef.current = true;
    setLines([]);
    setConnected(false);
    setPaused(false);

    const clearTimer = () => {
      if (timerRef.current === null) return;
      cancelSchedule(timerRef.current);
      timerRef.current = null;
    };

    const isCurrent = (run) => !stopped && currentRun === run && !run.controller.signal.aborted;
    const canApply = (run) => isCurrent(run) && !pausedRef.current;

    const scheduleNext = (run, poll) => {
      if (!canApply(run)) return;
      clearTimer();
      timerRef.current = schedule(() => {
        timerRef.current = null;
        if (canApply(run)) void poll(run);
      }, POLL_INTERVAL_MS);
    };

    const poll = async (run) => {
      if (!canApply(run)) return;
      try {
        if (!activeFile) {
          const listed = await logsApi.list(jobName, { signal: run.controller.signal });
          if (!canApply(run)) return;
          const listedActiveFile = activeLogFile(listed?.files);
          if (!listedActiveFile) {
            setConnected(true);
            return;
          }
          activeFile = listedActiveFile;
        }

        const response = await logsApi.tail(jobName, activeFile, { signal: run.controller.signal });
        if (!canApply(run)) return;
        const snapshot = { ...response, file: response?.file || activeFile };
        latestTailRef.current = snapshot;
        setLines(visibleTail(snapshot, clearStateRef.current, MAX_LINES));
        setConnected(true);
      } catch (failure) {
        if (!canApply(run) || failure?.name === "AbortError") return;
        activeFile = "";
        setConnected(false);
      } finally {
        scheduleNext(run, poll);
      }
    };

    const invalidateCurrent = () => {
      clearTimer();
      const invalidated = currentRun;
      currentRun = null;
      invalidated?.controller.abort();
    };

    const startGeneration = () => {
      invalidateCurrent();
      if (stopped || pausedRef.current) return;
      const run = { generation: ++nextGeneration, controller: new AbortController() };
      currentRun = run;
      void poll(run);
    };

    stopRef.current = () => {
      if (stopped) return;
      stopped = true;
      invalidateCurrent();
    };
    pauseRef.current = invalidateCurrent;
    resumeRef.current = startGeneration;

    startGeneration();

    return () => {
      stopRef.current();
      stopRef.current = () => {};
      pauseRef.current = () => {};
      resumeRef.current = () => {};
    };
  }, [cancelSchedule, jobName, logsApi, open, schedule]);

  useEffect(() => {
    if (!open) return;
    const nextSize = clampSize(sizeRef.current.width, sizeRef.current.height);
    sizeRef.current = nextSize;
    setSize(nextSize);
    setPosition(defaultPosition(nextSize));
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onViewportResize = () => {
      const nextSize = clampSize(sizeRef.current.width, sizeRef.current.height);
      sizeRef.current = nextSize;
      setSize(nextSize);
      setPosition((current) => clampPosition(current, nextSize));
    };
    window.addEventListener("resize", onViewportResize);
    return () => window.removeEventListener("resize", onViewportResize);
  }, [open]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !stickToBottomRef.current) return;
    body.scrollTop = body.scrollHeight;
  }, [lines]);

  useEffect(() => {
    const onMove = (event) => {
      const drag = dragRef.current;
      const panel = panelRef.current;
      if (!drag || !panel) return;
      const rect = panel.getBoundingClientRect();
      setPosition(clampPosition({
        x: event.clientX - drag.offsetX,
        y: event.clientY - drag.offsetY,
      }, { width: rect.width, height: rect.height }));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    startDragRef.current = (event) => {
      if (event.target.closest("button")) return;
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      dragRef.current = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
    return () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  useEffect(() => {
    const onMove = (event) => {
      const resize = resizeRef.current;
      if (!resize) return;
      let width = resize.startWidth;
      let height = resize.startHeight;
      if (resize.direction.includes("e")) width += event.clientX - resize.startX;
      if (resize.direction.includes("s")) height += event.clientY - resize.startY;
      const viewport = viewportBounds();
      const maximumWidth = Math.max(0, viewport.width - resize.left - viewport.marginX);
      const maximumHeight = Math.max(0, viewport.height - resize.top - viewport.marginY);
      const minimumWidth = minimumPanelExtent(maximumWidth, MIN_WIDTH, SAFE_MIN_WIDTH);
      const minimumHeight = minimumPanelExtent(maximumHeight, MIN_HEIGHT, SAFE_MIN_HEIGHT);
      const nextSize = {
        width: Math.min(Math.max(minimumWidth, width), maximumWidth),
        height: Math.min(Math.max(minimumHeight, height), maximumHeight),
      };
      sizeRef.current = nextSize;
      setSize(nextSize);
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    startResizeRef.current = (event, direction) => {
      event.preventDefault();
      event.stopPropagation();
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      resizeRef.current = {
        direction,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: rect.width,
        startHeight: rect.height,
        left: rect.left,
        top: rect.top,
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
    return () => {
      resizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const togglePause = () => {
    if (pausedRef.current) {
      pausedRef.current = false;
      setPaused(false);
      resumeRef.current();
      return;
    }
    pausedRef.current = true;
    setPaused(true);
    pauseRef.current();
  };

  const clear = () => {
    clearStateRef.current = nextClearState(latestTailRef.current || {});
    stickToBottomRef.current = true;
    setLines([]);
  };

  const close = () => {
    stopRef.current();
    onClose?.();
  };

  const handleScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    stickToBottomRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 5;
  };

  if (!open) return null;

  return (
    <section
      ref={panelRef}
      className="neo-live-logs"
      aria-label="Live Logs"
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
    >
      <header className="neo-live-logs__header" onMouseDown={(event) => startDragRef.current(event)}>
        <div className="neo-live-logs__title">
          <Icon name="terminal" />
          <span className="neo-live-logs__name">Live Logs</span>
          <span className={`neo-live-logs__dot ${connected ? "neo-live-logs__dot--connected" : "neo-live-logs__dot--disconnected"}`} aria-hidden="true" />
          <span className="neo-live-logs__meta neo-live-logs__status">{connected ? "CONNECTED" : "DISCONNECTED"}</span>
          <span className="neo-live-logs__meta neo-live-logs__count">{lines.length}/{MAX_LINES}</span>
        </div>
        <div className="neo-live-logs__actions">
          <button type="button" className="neo-button" aria-label={paused ? "Resume live logs" : "Pause live logs"} title={paused ? "Resume" : "Pause"} onClick={togglePause}>
            <Icon name={paused ? "play_arrow" : "pause"} />
            <span className="neo-live-logs__action-label">{paused ? "Resume" : "Pause"}</span>
          </button>
          <button type="button" className="neo-button" aria-label="Clear live logs" title="Clear" onClick={clear}>
            <Icon name="delete_sweep" />
            <span className="neo-live-logs__action-label">Clear</span>
          </button>
        </div>
        <button type="button" className="neo-icon-button neo-live-logs__close" aria-label="Close live logs" title="Close" onClick={close}>
          <Icon name="close" />
          <span className="neo-visually-hidden">Close</span>
        </button>
      </header>
      <div ref={bodyRef} className="neo-live-logs__body" aria-label="Live log lines" onScroll={handleScroll}>
        {lines.length === 0
          ? <div className="neo-live-logs__empty">Waiting for logs...</div>
          : lines.map((line, index) => <div key={`${index}:${line}`}>{renderLine(line)}</div>)}
      </div>
      <span className="neo-live-logs__resize neo-live-logs__resize--e" aria-hidden="true" onMouseDown={(event) => startResizeRef.current(event, "e")} />
      <span className="neo-live-logs__resize neo-live-logs__resize--s" aria-hidden="true" onMouseDown={(event) => startResizeRef.current(event, "s")} />
      <span className="neo-live-logs__resize neo-live-logs__resize--se" aria-hidden="true" onMouseDown={(event) => startResizeRef.current(event, "se")} />
    </section>
  );
}
