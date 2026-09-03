export function isPackageMessage(value) {
  return Boolean(value) && (
    value.type === "ready"
    ||
    value.type === "refresh"
    || value.type === "new-job"
    || (value.type === "open-create-modal"
      && (value.target === "dbus-interface" || value.target === "db-server"))
    || (value.type === "navigate"
      && typeof value.path === "string"
      && value.path.length > 0)
    || (value.type === "select-job"
      && typeof value.name === "string"
      && value.name.length > 0)
  );
}

export function createPackageChannel({ enabled, name, onMessage }) {
  if (!enabled) {
    return {
      channel: null,
      refresh() {},
    selectJob() {},
      newJob() {},
      openCreateModal() {},
      navigate() {},
      close() {},
    };
  }

  // Neo can render side.html and main.html in separate embedded documents.
  // BroadcastChannel is preferred, but some embedded browser contexts expose
  // it without delivering messages between those documents. localStorage's
  // cross-document storage event is a same-origin fallback for that case.
  const storageKey = `neo-pkg-dbus:channel:${name}`;
  const recentMessages = new Map();
  const receive = (message) => {
    if (!isPackageMessage(message) || typeof onMessage !== "function") return;
    const fingerprint = JSON.stringify(message);
    const now = Date.now();
    const previous = recentMessages.get(fingerprint) || 0;
    if (now - previous < 100) return;
    recentMessages.set(fingerprint, now);
    onMessage(message);
  };
  let channel = null;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(name);
    channel.onmessage = (event) => receive(event.data);
  }
  const storageListener = (event) => {
    if (event.key !== storageKey || !event.newValue) return;
    try { receive(JSON.parse(event.newValue).message); } catch (_) {}
  };
  if (typeof window !== "undefined") window.addEventListener("storage", storageListener);
  const send = (message) => {
    if (!isPackageMessage(message)) return;
    channel?.postMessage(message);
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(storageKey, JSON.stringify({ message, sentAt: Date.now() }));
        window.localStorage.removeItem(storageKey);
      }
    } catch (_) {
      // Storage can be disabled in a private or sandboxed browser. In that
      // case BroadcastChannel remains the available transport.
    }
  };
  return {
    channel,
    ready(surface = "") { send({ type: "ready", ...(surface ? { surface } : {}) }); },
    refresh() { send({ type: "refresh" }); },
    selectJob(name, { sync = false } = {}) { send({ type: "select-job", name, ...(sync ? { sync: true } : {}) }); },
    newJob() { send({ type: "new-job" }); },
    openCreateModal(target) { send({ type: "open-create-modal", target }); },
    navigate(path) { send({ type: "navigate", path }); },
    close() {
      if (channel) { channel.onmessage = null; channel.close(); }
      if (typeof window !== "undefined") window.removeEventListener("storage", storageListener);
    },
  };
}
