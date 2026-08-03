import React, { useCallback, useEffect, useRef, useState } from "react";
import { jobsApi, serviceApi } from "./api";
import { createPackageChannel } from "./package-channel";
import { createRequestCoordinator } from "./request-coordinator";
import { createViewState, initialViewState } from "./view-state";
import { StatusMessages, jobErrorLabels } from "./components/CommonView";
import { JobsMain, JobsSide } from "./components/JobsView";
import { SingleMain, SingleSide } from "./components/SingleView";

const serviceMode = "jobs";
const hasSide = true;
const channelName = "app:neo-pkg-dbus";

export function healthFromJobs(jobs) {
  const errors = jobs
    .flatMap((job) => jobErrorLabels(job).map((error) => `${job.name}: ${error}`));
  return {
    healthy: errors.length === 0,
    status: errors.length === 0 ? "running" : "degraded",
    service_summary: {
      total: jobs.length,
      running: jobs.filter((job) => job.running).length,
      errors,
    },
  };
}

function readSnapshot(signal, surface) {
  if (serviceMode === "jobs") {
    return jobsApi.list({ signal })
      .then((jobs) => ({ jobs, health: healthFromJobs(jobs) }));
  }
  return serviceApi.health({ signal }).then((health) => ({ jobs: [], health }));
}

export function usePackageStatus(surface) {
  const [view, setView] = useState(initialViewState);
  const [actionError, setActionError] = useState(null);
  const [actionWarning, setActionWarning] = useState(null);
  const [pendingActions, setPendingActions] = useState(() => new Map());
  const [packageChannel, setPackageChannel] = useState(null);
  const activeRef = useRef(false);
  const coordinatorRef = useRef(null);
  const channelRef = useRef(null);

  const refresh = useCallback((force = false) => {
    if (!coordinatorRef.current) return Promise.resolve();
    return coordinatorRef.current.refresh({ force });
  }, []);

  useEffect(() => {
    activeRef.current = true;
    const coordinator = createRequestCoordinator({
      load: ({ signal }) => readSnapshot(signal, surface),
      apply: (snapshot) => {
        setView(createViewState(snapshot, null));
      },
      fail: (error) => setView(createViewState(null, error)),
    });
    coordinatorRef.current = coordinator;
    void refresh().catch(() => {});
    const timer = window.setInterval(() => { void refresh().catch(() => {}); }, 2000);
    return () => {
      activeRef.current = false;
      window.clearInterval(timer);
      coordinator.cleanup();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, [refresh, surface]);

  useEffect(() => {
    const nextPackageChannel = createPackageChannel({
      enabled: hasSide,
      surface,
      name: channelName,
      onMessage: (message) => {
        if (message.type === "refresh") void refresh(true).catch(() => {});
      },
    });
    channelRef.current = nextPackageChannel;
    setPackageChannel(nextPackageChannel);
    return () => {
      nextPackageChannel.close();
      if (channelRef.current === nextPackageChannel) channelRef.current = null;
      setPackageChannel((current) => current === nextPackageChannel ? null : current);
    };
  }, [surface, refresh]);

  const isPending = useCallback((actionKey) => pendingActions.has(actionKey), [pendingActions]);

  const runAction = useCallback(async (actionKey, operation) => {
    setActionError(null);
    setActionWarning(null);
    setPendingActions((current) => {
      const next = new Map(current);
      next.set(actionKey, (next.get(actionKey) || 0) + 1);
      return next;
    });
    try {
      let result;
      try {
        result = await operation();
      } catch (error) {
        if (activeRef.current) setActionError(error);
        return false;
      }
      if (activeRef.current && result && result.cleanupError) {
        setActionWarning(String(result.cleanupError));
      }
      if (channelRef.current) channelRef.current.refresh();
      try {
        await refresh(true);
      } catch (_) {
        // 변경은 이미 성공했습니다. 조회 오류는 view.error로 따로 표시합니다.
      }
      return true;
    } finally {
      if (activeRef.current) {
        setPendingActions((current) => {
          const count = current.get(actionKey);
          if (!count) return current;
          const next = new Map(current);
          if (count === 1) next.delete(actionKey);
          else next.set(actionKey, count - 1);
          return next;
        });
      }
    }
  }, [refresh]);

  return {
    view,
    actionError,
    actionWarning,
    isPending,
    refresh,
    runAction,
    packageChannel,
  };
}

export function StarterView({ surface }) {
  const state = usePackageStatus(surface);
  const content = serviceMode === "jobs"
    ? surface === "side"
      ? <JobsSide state={state} />
      : <JobsMain state={state} hasSide={hasSide} />
    : surface === "main"
      ? <SingleMain state={state} />
      : <SingleSide state={state} />;
  return (
    <div className="starter-shell" data-package="neo-pkg-dbus" data-service-mode={serviceMode} data-surface={surface}>
      <section className="starter-panel">
        <StatusMessages
          view={state.view}
          actionError={state.actionError}
          actionWarning={state.actionWarning}
        />
        {content}
      </section>
    </div>
  );
}
