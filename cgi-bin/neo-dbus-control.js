'use strict';

// Run one Go control operation through JSH's external-command bridge. This is
// intentionally separate from the launcher: CGI scripts must wait for a single
// control reply, while the launcher must remain alive for the daemon lifetime.
const path = require('path');
const process = require('process');

function externalPath(virtualPath, executablePath) {
  const value = String(virtualPath || '');
  const relative = value.replace(/^\/work\/?/, '');
  if (!relative || relative === value || relative.split('/').includes('..')) {
    throw new Error(`unsupported JSH path: ${virtualPath}`);
  }
  // `/work` belongs to JSH's virtual filesystem. The external control process
  // must use the corresponding host path so it reaches the daemon's physical
  // Unix socket and configuration root.
  const hostWorkRoot = path.dirname(String(executablePath || process.execPath || ''));
  if (!hostWorkRoot || hostWorkRoot === '.') throw new Error('host work root is unavailable.');
  return path.join(hostWorkRoot, relative);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\\"'\\\"'")}'`;
}

function run(args, cgiRoot) {
  const action = args && args[0];
  const name = args && args[1];
  if (!/^(start|stop|reload|refresh-log|clear-overrun)$/.test(action || '') || !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(name || '')) {
    throw new Error('neo-dbus-control.js requires ACTION(start|stop|reload|refresh-log|clear-overrun) and a safe Job name.');
  }
  const virtualRoot = cgiRoot || path.resolve(path.dirname(process.argv[1]));
  const externalRoot = externalPath(virtualRoot);
  const binary = path.join(externalRoot, 'bin', 'neo-dbus-collector');
  const command = `exec ${shellQuote(binary)} --root ${shellQuote(externalRoot)} --control ${shellQuote(action)} ${shellQuote(name)}`;
  return process.exec('@/bin/sh', '-c', command);
}

const commonJsModule = typeof module !== 'undefined' && module && module.exports ? module : null;
if (!commonJsModule || (require.main && require.main === commonJsModule)) process.exit(run(process.argv.slice(2)));
if (commonJsModule) commonJsModule.exports = { externalPath, run, shellQuote };
