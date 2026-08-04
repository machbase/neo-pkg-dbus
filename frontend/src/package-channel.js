export function isPackageMessage(value) {
  return Boolean(value) && (
    value.type === "refresh"
    || value.type === "new-job"
    || (value.type === "navigate"
      && typeof value.path === "string"
      && value.path.length > 0)
    || (value.type === "select-job"
      && typeof value.name === "string"
      && value.name.length > 0)
  );
}

export function createPackageChannel({ enabled, name, onMessage }) {
  if (!enabled || typeof BroadcastChannel === "undefined") {
    return {
      channel: null,
      refresh() {},
      selectJob() {},
      newJob() {},
      navigate() {},
      close() {},
    };
  }
  const channel = new BroadcastChannel(name);
  channel.onmessage = (event) => {
    if (isPackageMessage(event.data) && typeof onMessage === "function") {
      onMessage(event.data);
    }
  };
  const send = (message) => {
    if (isPackageMessage(message)) channel.postMessage(message);
  };
  return {
    channel,
    refresh() { send({ type: "refresh" }); },
    selectJob(name) { send({ type: "select-job", name }); },
    newJob() { send({ type: "new-job" }); },
    navigate(path) { send({ type: "navigate", path }); },
    close() { channel.onmessage = null; channel.close(); },
  };
}
