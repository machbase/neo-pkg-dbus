'use strict';

// The Neo service controller runs JSH commands, not an arbitrary native
// executable. Keep the service itself as JSH and replace the shell process with
// the LS Go collector so service start/stop owns the collector's lifetime.
const path = require('path');
const process = require('process');

function externalPath(virtualPath, executablePath) {
  const value = String(virtualPath || '');
  const relative = value.replace(/^\/work\/?/, '');
  if (!relative || relative === value || relative.split('/').includes('..')) {
    throw new Error(`unsupported JSH path: ${virtualPath}`);
  }
  // `/work` belongs to JSH's virtual filesystem. process.exec('@/bin/sh', ...)
  // crosses into the host OS, where process.execPath is the physical Neo
  // executable and its directory is the package work root used by this product.
  const hostWorkRoot = path.dirname(String(executablePath || process.execPath || ''));
  if (!hostWorkRoot || hostWorkRoot === '.') throw new Error('host work root is unavailable.');
  return path.join(hostWorkRoot, relative);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\\"'\\\"'")}'`;
}

function defaultCgiRoot() {
  return path.resolve(path.dirname(process.argv[1]));
}

function daemonCommand(externalRoot, parentPid) {
  const pid = Number(parentPid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`invalid JSH process PID: ${parentPid}`);
  }
  const binary = path.join(externalRoot, 'bin', 'neo-dbus-collector');
  return `cd ${shellQuote(externalRoot)} && exec ${shellQuote(binary)} --root ${shellQuote(externalRoot)} --parent-pid ${pid}`;
}

function run(cgiRoot) {
  const virtualRoot = cgiRoot || defaultCgiRoot();
  const externalRoot = externalPath(virtualRoot);
  // The Neo service controller owns this JSH process. Pass its PID to the Go
  // collector so an abrupt JSH/service exit cannot leave an orphan collector.
  const command = daemonCommand(externalRoot, process.pid);
  const exitCode = process.exec('@/bin/sh', '-c', command);
  process.exit(exitCode);
}

const commonJsModule = typeof module !== 'undefined' && module && module.exports ? module : null;
if (!commonJsModule || (require.main && require.main === commonJsModule)) run();
if (commonJsModule) commonJsModule.exports = { daemonCommand, defaultCgiRoot, externalPath, run, shellQuote };
