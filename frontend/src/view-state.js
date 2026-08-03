export function initialViewState() {
  return {
    phase: "initial-loading",
    snapshot: { jobs: [], health: null },
    error: null,
  };
}

export function createViewState(snapshot, error) {
  if (error) {
    return {
      phase: `${error.kind || "cgi"}-error`,
      snapshot: {
        jobs: [],
        health: error.kind === "controller" ? error.data : null,
      },
      error,
    };
  }
  const jobs = snapshot && Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
  const isEmptyJobs = snapshot && snapshot.health && snapshot.health.service_summary && jobs.length === 0;
  return {
    phase: isEmptyJobs ? "ready-empty" : "ready-data",
    snapshot: snapshot || { jobs: [], health: null },
    error: null,
  };
}
