function isAbort(error) {
  return error && error.name === "AbortError";
}

export function createRequestCoordinator({ load, apply, fail }) {
  let generation = 0;
  let current = null;
  let disposed = false;

  function refresh({ force = false } = {}) {
    if (disposed) return Promise.resolve();
    if (current && !force) return current.promise;
    if (current && force) current.controller.abort();

    generation += 1;
    const requestGeneration = generation;
    const controller = new AbortController();
    let pending;
    try {
      pending = Promise.resolve(load({ signal: controller.signal, generation: requestGeneration }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    const promise = pending.then(
      (value) => {
        if (!disposed && generation === requestGeneration) apply(value);
        return value;
      },
      (error) => {
        if (disposed || generation !== requestGeneration || isAbort(error)) return undefined;
        if (fail) fail(error);
        throw error;
      },
    ).finally(() => {
      if (current && current.generation === requestGeneration) current = null;
    });
    current = { controller, generation: requestGeneration, promise };
    return promise;
  }

  function cleanup() {
    disposed = true;
    generation += 1;
    if (current) current.controller.abort();
    current = null;
  }

  return { refresh, cleanup };
}
