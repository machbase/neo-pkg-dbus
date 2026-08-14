'use strict';

function loadServiceModule(explicit) {
  if (explicit !== undefined) return explicit;
  try { return require('service'); } catch (_) { return null; }
}

function createControllerAdapter(serviceModule) {
  const source = loadServiceModule(serviceModule);
  let client = null;
  let clientError = null;
  try {
    if (!source || typeof source.Client !== 'function') {
      throw new Error('service.Client를 사용할 수 없습니다.');
    }
    client = new source.Client();
  } catch (creationError) {
    clientError = creationError;
  }

  function invoke(method, args, callback) {
    if (clientError) { callback(clientError); return; }
    try {
      if (!client || typeof client[method] !== 'function') {
        callback(new Error(`service.Client.${method}()을 사용할 수 없습니다.`));
        return;
      }
      client[method](...args, callback);
    } catch (callError) {
      callback(callError);
    }
  }

  return {
    status(name, callback) { invoke('status', [name], callback); },
    install(descriptor, callback) { invoke('install', [descriptor], callback); },
    start(name, callback) { invoke('start', [name], callback); },
    stop(name, callback) { invoke('stop', [name], callback); },
    uninstall(name, callback) { invoke('uninstall', [name], callback); },
    details(name, key, callback) {
      if (clientError) { callback(clientError); return; }
      try {
        if (!client || !client.details || typeof client.details.get !== 'function') {
          callback(new Error('service.Client.details.get()을 사용할 수 없습니다.'));
          return;
        }
        client.details.get(name, key, (detailsError, runtime) => {
          if (detailsError && /Detail\s+'.+'\s+not found/i.test(detailsError.message || '')) {
            callback(null, null);
            return;
          }
          if (detailsError) { callback(detailsError); return; }
          const details = runtime && runtime.details;
          callback(null, details && Object.prototype.hasOwnProperty.call(details, key)
            ? details[key] : null);
        });
      } catch (detailsError) {
        callback(detailsError);
      }
    },
  };
}

function isNotInstalled(error) {
  if (error && error.rpcCode !== undefined) return error.rpcCode === -32004;
  const message = error && error.message ? error.message : String(error || '');
  return /service\b.*\b(?:not found|not installed|does not exist)\b/i.test(message)
    || /\b(?:no such|unknown) service\b/i.test(message);
}

module.exports = { createControllerAdapter, isNotInstalled };
