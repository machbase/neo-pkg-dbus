'use strict';

function loadDbus(explicit) {
  if (explicit !== undefined) return explicit;
  return require('dbus');
}

function createDbusAdapter(explicit) {
  const module = loadDbus(explicit);
  let connection = null;
  let connectionKey = null;

  function close() {
    if (connection && typeof connection.close === 'function') {
      try { connection.close(); } catch (_) {}
    }
    connection = null;
    connectionKey = null;
  }

  function connected(type, destination) {
    const key = `${type}\u0000${destination || ''}`;
    if (connection && connectionKey === key) return connection;
    close();
    if (!module || typeof module.Connection !== 'function') throw new Error('dbus.Connection을 사용할 수 없습니다.');
    connection = new module.Connection({ busType: type });
    connectionKey = key;
    return connection;
  }

  return {
    connect(type, destination) { return connected(type, destination); },
    call(config, method, args) {
      try {
        return connected(config.busType, config.destination).call({
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
    introspect(config) {
      try {
        const current = connected(config.busType, config.destination);
        if (typeof current.introspect !== 'function') throw new Error('dbus.Connection.introspect를 사용할 수 없습니다.');
        return current.introspect({ destination: config.destination, path: config.objectPath });
      } catch (introspectionError) {
        close();
        throw introspectionError;
      }
    },
    close,
  };
}

module.exports = { createDbusAdapter };
