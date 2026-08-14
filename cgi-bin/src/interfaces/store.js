'use strict';
const fs = require('fs');
const path = require('path');
const { error } = require('../config/errors.js');
const { writeJsonAtomic } = require('../config/atomic-json.js');
const { validateInterface } = require('./validator.js');
class InterfaceStore {
  constructor(options) { this.cgiRoot = options.cgiRoot; this.fs = options.fs || fs; this.builtInDir = path.join(this.cgiRoot, 'interfaces.d'); this.customDir = path.join(this.cgiRoot, 'conf.d', 'interfaces'); }
  readDirectory(directory, builtIn) {
    if (!this.fs.existsSync(directory)) return [];
    return this.fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort().map((name) => {
      let parsed;
      try {
        const raw = JSON.parse(this.fs.readFileSync(path.join(directory, name), 'utf8'));
        const methods = raw.methods || [];
        const hasDiscovered = methods.some((method) => method && method.source === 'discovered');
        const hasManual = methods.some((method) => method && method.source === 'manual');
        const origin = raw.origin || (hasDiscovered && !hasManual ? 'discovered' : 'manual');
        parsed = validateInterface({ ...raw, name: raw.name || raw.interface, origin }, { allowLegacyMixedOrigin: true });
      } catch (failure) { throw error('DBUS_INTERFACE_INVALID', 'DBus Interface 파일을 읽을 수 없습니다.', { file: name }); }
      if (parsed.id + '.json' !== name) throw error('DBUS_INTERFACE_INVALID', 'DBus Interface ID와 파일명이 다릅니다.', { file: name });
      return { ...parsed, builtIn };
    });
  }
  list() { const all = this.readDirectory(this.builtInDir, true).concat(this.readDirectory(this.customDir, false)); const ids = new Set(); all.forEach((item) => { if (ids.has(item.id)) throw error('DBUS_INTERFACE_INVALID', 'DBus Interface ID가 중복되었습니다.', { id: item.id }); ids.add(item.id); }); return all; }
  find(id) { return this.list().find((item) => item.id === id) || null; }
  save(value) { const valid = { ...validateInterface({ ...value, builtIn: false }), builtIn: false }; writeJsonAtomic(path.join(this.customDir, valid.id + '.json'), valid); return valid; }
  remove(id) { this.fs.unlinkSync(path.join(this.customDir, id + '.json')); }
}
module.exports = { InterfaceStore };
