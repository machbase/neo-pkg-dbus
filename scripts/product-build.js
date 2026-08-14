'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_NAME = 'neo-pkg-dbus';
const TARGETS = new Set(['generic', 'ls']);

function parseTarget(args) {
  if (!Array.isArray(args) || args.length === 0) return 'generic';
  if (args.length === 1 && /^--target=(generic|ls)$/.test(args[0])) return args[0].slice('--target='.length);
  throw new Error(`Unsupported build target: ${(args || []).join(' ')}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertManifestIdentity(root) {
  const rootManifest = readJson(path.join(root, 'package.json'));
  const cgiManifest = readJson(path.join(root, 'cgi-bin', 'package.json'));
  const identity = {
    name: rootManifest.name,
    version: rootManifest.version,
    minServerVersion: rootManifest.minServerVersion,
  };
  if (identity.name !== PACKAGE_NAME) throw new Error(`Package name must be ${PACKAGE_NAME}`);
  for (const field of Object.keys(identity)) {
    if (!identity[field] || cgiManifest[field] !== identity[field]) {
      throw new Error(`Root and CGI manifest ${field} must match`);
    }
  }
  return identity;
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const stat = fs.statSync(from);
    if (stat.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

function prepareProductBackend({ root, stagingRoot, target }) {
  if (!TARGETS.has(target)) throw new Error(`Unsupported build target: ${target}`);
  const productRoot = path.join(root, 'products', target);
  const backend = path.join(productRoot, 'backend');
  if (!fs.existsSync(path.join(backend, 'index.js'))) throw new Error(`Product Backend not found: ${target}`);
  const cgiStage = path.join(stagingRoot, 'cgi-bin');
  copyDirectory(backend, path.join(cgiStage, 'product'));
  const interfacesOutput = path.join(cgiStage, 'interfaces.d');
  fs.mkdirSync(interfacesOutput, { recursive: true });
  const profile = path.join(productRoot, 'provider.json');
  const interfaces = path.join(productRoot, 'interfaces');
  if (fs.existsSync(profile)) fs.copyFileSync(profile, path.join(cgiStage, 'provider.json'));
  if (fs.existsSync(interfaces)) copyDirectory(interfaces, interfacesOutput);
}

const GENERATED_OUTPUTS = [
  'index.html', 'main.html', 'side.html',
  path.join('cgi-bin', 'product'),
  path.join('cgi-bin', 'provider.json'),
  path.join('cgi-bin', 'interfaces.d'),
];

function validateStaging(stagingRoot, target) {
  for (const html of ['index.html', 'main.html', 'side.html']) {
    const file = path.join(stagingRoot, html);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`Frontend output not found: ${html}`);
  }
  const productFile = path.join(stagingRoot, 'cgi-bin', 'product', 'index.js');
  if (!fs.existsSync(productFile)) throw new Error('Product Backend output not found.');
  delete require.cache[require.resolve(productFile)];
  if (require(productFile).target !== target) throw new Error(`Product Backend target mismatch: ${target}`);
  const providerFile = path.join(stagingRoot, 'cgi-bin', 'provider.json');
  const interfaces = path.join(stagingRoot, 'cgi-bin', 'interfaces.d');
  if (target === 'generic' && fs.existsSync(providerFile)) throw new Error('Generic output must not contain provider.json.');
  if (target === 'generic' && fs.readdirSync(interfaces).length) throw new Error('Generic output must not contain Provider Interfaces.');
  if (target === 'ls' && !fs.existsSync(providerFile)) throw new Error('LS output requires provider.json.');
}

function copyOutput(source, destination) {
  if (fs.statSync(source).isDirectory()) copyDirectory(source, destination);
  else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function installGeneratedOutputs(root, stagingRoot) {
  const backupRoot = fs.mkdtempSync(path.join(root, '.product-build-backup-'));
  const installed = [];
  const backups = [];
  try {
    GENERATED_OUTPUTS.forEach((relative, index) => {
      const destination = path.join(root, relative);
      const source = path.join(stagingRoot, relative);
      const backup = path.join(backupRoot, String(index));
      if (fs.existsSync(destination)) {
        fs.renameSync(destination, backup);
        backups.push({ destination, backup });
      }
      if (fs.existsSync(source)) {
        copyOutput(source, destination);
        installed.push(destination);
      }
    });
  } catch (failure) {
    installed.reverse().forEach((value) => fs.rmSync(value, { recursive: true, force: true }));
    backups.reverse().forEach(({ destination, backup }) => {
      if (fs.existsSync(backup)) fs.renameSync(backup, destination);
    });
    throw failure;
  } finally {
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

function runFrontendBuild(stagingRoot, target, root) {
  const script = path.join(root, 'frontend', 'scripts', 'build-root.mjs');
  const result = spawnSync(process.execPath, [script, `--target=${target}`, `--output=${stagingRoot}`], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`Frontend build failed for target ${target}.`);
}

function buildPackage({ root, target, runFrontend = runFrontendBuild }) {
  if (!TARGETS.has(target)) throw new Error(`Unsupported build target: ${target}`);
  assertManifestIdentity(root);
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-pkg-dbus-product-'));
  try {
    runFrontend(stagingRoot, target, root);
    prepareProductBackend({ root, stagingRoot, target });
    validateStaging(stagingRoot, target);
    installGeneratedOutputs(root, stagingRoot);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function main() {
  const root = path.resolve(__dirname, '..');
  const target = parseTarget(process.argv.slice(2));
  buildPackage({ root, target });
}

if (require.main === module) main();

module.exports = {
  PACKAGE_NAME, TARGETS, parseTarget, assertManifestIdentity,
  prepareProductBackend, validateStaging, installGeneratedOutputs, buildPackage,
};
