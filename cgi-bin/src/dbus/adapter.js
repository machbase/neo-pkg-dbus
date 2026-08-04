'use strict';

function loadDbus(explicit) {
  if (explicit !== undefined) return explicit;
  return require('dbus');
}

function createDbusAdapter(explicit) {
  const module = loadDbus(explicit);
  let connection = null;
  let busType = null;

  function close() {
    if (connection && typeof connection.close === 'function') {
      try { connection.close(); } catch (_) {}
    }
    connection = null;
    busType = null;
  }

  function connected(type) {
    if (connection && busType === type) return connection;
    close();
    if (!module || typeof module.Connection !== 'function') throw new Error('dbus.Connection을 사용할 수 없습니다.');
    connection = new module.Connection({ busType: type });
    busType = type;
    return connection;
  }

  return {
    connect(type) { return connected(type); },
    call(config, method, args) {
      try {
        return connected(config.busType).call({
          destination: config.destination,
          path: method.objectPath,
          method: `${method.interface}.${method.methodName}`,
          args,
        });
      } catch (callError) {
        close();
        throw callError;
      }
    },
    close,
  };
}

module.exports = { createDbusAdapter };
