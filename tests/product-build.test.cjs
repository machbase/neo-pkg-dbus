'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const { parseTarget, assertManifestIdentity, prepareProductBackend, buildPackage } = require('../scripts/product-build.js');

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    if (fs.statSync(from).isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

function makePackageFixture() {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dbus-package-build-'));
  fs.mkdirSync(path.join(root, 'cgi-bin', 'conf.d', 'jobs'), { recursive: true });
  fs.copyFileSync(path.join(packageRoot, 'package.json'), path.join(root, 'package.json'));
  fs.copyFileSync(path.join(packageRoot, 'cgi-bin', 'package.json'), path.join(root, 'cgi-bin', 'package.json'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const name of ['install.js', 'start.js', 'stop.js', 'uninstall.js']) {
    fs.copyFileSync(path.join(packageRoot, 'scripts', name), path.join(root, 'scripts', name));
  }
  for (const name of ['neo-dbus-launcher.js', 'neo-dbus-control.js']) {
    fs.copyFileSync(path.join(packageRoot, 'cgi-bin', name), path.join(root, 'cgi-bin', name));
  }
  copyDirectory(path.join(packageRoot, 'products'), path.join(root, 'products'));
  fs.writeFileSync(path.join(root, 'cgi-bin', 'conf.d', 'jobs', 'keep.json'), '{"name":"keep"}');
  return root;
}

function fakeFrontend(stagingRoot, target) {
  for (const name of ['index.html', 'main.html', 'side.html']) {
    fs.writeFileSync(path.join(stagingRoot, name), `<html data-product="${target}">${name}</html>`);
  }
}

test('인자 없는 build는 generic이고 명시 target만 허용한다', () => {
  assert.equal(parseTarget([]), 'generic');
  assert.equal(parseTarget(['--target=generic']), 'generic');
  assert.equal(parseTarget(['--target=ls']), 'ls');
  assert.throws(() => parseTarget(['--target=unknown']), /Unsupported build target/);
  assert.throws(() => parseTarget(['--target=ls', '--extra']), /Unsupported build target/);
});

test('루트와 CGI manifest는 하나의 package identity를 공유한다', () => {
  const identity = assertManifestIdentity(packageRoot);
  const rootManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const cgiManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'cgi-bin', 'package.json'), 'utf8'));
  assert.deepEqual(identity, { name: 'neo-pkg-dbus', version: '1.0.1', minServerVersion: '8.5.8' });
  for (const field of ['name', 'version', 'minServerVersion']) {
    assert.equal(rootManifest[field], cgiManifest[field]);
  }
});

test('target Backend staging은 선택 제품만 포함하고 generic은 Provider asset이 없다', () => {
  const staging = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dbus-product-stage-'));
  try {
    prepareProductBackend({ root: packageRoot, stagingRoot: staging, target: 'ls' });
    assert.equal(require(path.join(staging, 'cgi-bin', 'product', 'index.js')).target, 'ls');
    assert.equal(JSON.parse(fs.readFileSync(path.join(staging, 'cgi-bin', 'provider.json'), 'utf8')).id, 'ls');
    assert.equal(JSON.parse(fs.readFileSync(path.join(staging, 'cgi-bin', 'interfaces.d', 'ls-plc-device.json'), 'utf8')).id, 'ls-plc-device');

    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    prepareProductBackend({ root: packageRoot, stagingRoot: staging, target: 'generic' });
    const genericModule = path.join(staging, 'cgi-bin', 'product', 'index.js');
    delete require.cache[require.resolve(genericModule)];
    assert.equal(require(genericModule).target, 'generic');
    assert.equal(fs.existsSync(path.join(staging, 'cgi-bin', 'provider.json')), false);
    assert.deepEqual(fs.readdirSync(path.join(staging, 'cgi-bin', 'interfaces.d')), []);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test('target 전환은 생성 영역만 바꾸고 사용자 설정을 보존한다', () => {
  const root = makePackageFixture();
  try {
    buildPackage({ root, target: 'ls', runFrontend: fakeFrontend });
    assert.match(fs.readFileSync(path.join(root, 'main.html'), 'utf8'), /data-product="ls"/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'cgi-bin', 'provider.json'), 'utf8')).id, 'ls');
    assert.equal(require(path.join(root, 'cgi-bin', 'product', 'index.js')).target, 'ls');
    for (const file of [
      path.join(root, 'scripts', 'install.js'), path.join(root, 'scripts', 'start.js'),
      path.join(root, 'scripts', 'stop.js'), path.join(root, 'scripts', 'uninstall.js'),
      path.join(root, 'cgi-bin', 'neo-dbus-launcher.js'), path.join(root, 'cgi-bin', 'neo-dbus-control.js'),
    ]) assert.equal(fs.statSync(file).mode & 0o777, 0o755, `${file} must be executable in a release artifact`);

    buildPackage({ root, target: 'generic', runFrontend: fakeFrontend });
    const genericModule = path.join(root, 'cgi-bin', 'product', 'index.js');
    delete require.cache[require.resolve(genericModule)];
    assert.match(fs.readFileSync(path.join(root, 'main.html'), 'utf8'), /data-product="generic"/);
    assert.equal(require(genericModule).target, 'generic');
    assert.equal(fs.existsSync(path.join(root, 'cgi-bin', 'provider.json')), false);
    assert.deepEqual(fs.readdirSync(path.join(root, 'cgi-bin', 'interfaces.d')), []);
    assert.equal(fs.readFileSync(path.join(root, 'cgi-bin', 'conf.d', 'jobs', 'keep.json'), 'utf8'), '{"name":"keep"}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Frontend build 실패는 이전 완성 산출물을 그대로 보존한다', () => {
  const root = makePackageFixture();
  try {
    fs.writeFileSync(path.join(root, 'index.html'), 'previous-index');
    fs.writeFileSync(path.join(root, 'main.html'), 'previous-main');
    fs.writeFileSync(path.join(root, 'side.html'), 'previous-side');
    fs.mkdirSync(path.join(root, 'cgi-bin', 'product'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cgi-bin', 'product', 'index.js'), 'module.exports={target:"previous"};');
    assert.throws(() => buildPackage({ root, target: 'ls', runFrontend() { throw new Error('frontend failed'); } }), /frontend failed/);
    assert.equal(fs.readFileSync(path.join(root, 'main.html'), 'utf8'), 'previous-main');
    assert.equal(require(path.join(root, 'cgi-bin', 'product', 'index.js')).target, 'previous');
    assert.equal(fs.existsSync(path.join(root, 'cgi-bin', 'provider.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
