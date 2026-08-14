'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadProviderProfile } = require('../src/config/provider-profile.js');

const packageRoot = path.resolve(__dirname, '..', '..');
const profileRoot = path.join(packageRoot, 'products', 'ls');

test('LS profile resolves to the GetDeviceData interface and output shape', () => {
  const asset = path.join(profileRoot, 'provider.json');
  assert.equal(fs.existsSync(asset), true, 'LS Provider Profile asset이 필요합니다.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-ls-provider-'));
  try {
    fs.copyFileSync(asset, path.join(root, 'provider.json'));
    const profile = loadProviderProfile(root);
    assert.equal(profile.id, 'ls');
    assert.equal(profile.interfaceId, 'ls-plc-device');
    assert.equal(profile.methodId, 'get-device-data');
    assert.deepEqual(profile.outputSelections[0], {
      id: 'return-data', sourceIndex: 0, interpretation: 'json', selector: '/data', valueType: 'array', elementType: 'numeric', tags: [],
    });
    assert.deepEqual(profile.tagGenerator, { kind: 'ls-memory-address-v1' });
    assert.equal(Object.hasOwn(profile, 'displayName'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('모든 target은 공통 package identity와 server floor를 사용한다', () => {
  const rootManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const cgiManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'cgi-bin', 'package.json'), 'utf8'));
  for (const manifest of [rootManifest, cgiManifest]) {
    assert.equal(manifest.name, 'neo-pkg-dbus');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.minServerVersion, '8.5.6');
  }
  assert.equal(rootManifest.version, cgiManifest.version);
});
