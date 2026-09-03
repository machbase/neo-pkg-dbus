'use strict';

// The Neo service controller runs JSH commands, not an arbitrary native
// executable. Keep the service itself as JSH and replace the shell process with
// the LS Go collector so service start/stop owns the collector's lifetime.
const path = require('path');
const process = require('process');

function externalPath(virtualPath) {
  const value = String(virtualPath || '');
  const relative = value.replace(/^\/work\/?/, '');
  if (!relative || relative === value || relative.split('/').includes('..')) {
    throw new Error(`unsupported JSH path: ${virtualPath}`);
  }
  // `/work` is shared with the shell used by JSH process.exec. CGI and the
  // service launcher have different process.execPath roots on the PLC.
  return path.join('/work', relative);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\\"'\\\"'")}'`;
}

function defaultCgiRoot() {
  return path.resolve(path.dirname(process.argv[1]));
}

function run(cgiRoot) {
  const virtualRoot = cgiRoot || defaultCgiRoot();
  const externalRoot = externalPath(virtualRoot);
  const binary = path.join(externalRoot, 'bin', 'neo-dbus-collector');
  const command = `cd ${shellQuote(externalRoot)} && exec ${shellQuote(binary)} --root ${shellQuote(externalRoot)}`;
  const exitCode = process.exec('@/bin/sh', '-c', command);
  process.exit(exitCode);
}

const commonJsModule = typeof module !== 'undefined' && module && module.exports ? module : null;
if (!commonJsModule || (require.main && require.main === commonJsModule)) run();
if (commonJsModule) commonJsModule.exports = { defaultCgiRoot, externalPath, run, shellQuote };
