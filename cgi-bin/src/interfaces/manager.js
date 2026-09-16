'use strict';
const fs = require('fs');
const path = require('path');
const { error } = require('../config/errors.js');
const { createJobOperationLock } = require('../jobs/operation-lock.js');
const { profileLockKey } = require('../config/profile-lock-key.js');
const { createDbusAdapter } = require('../dbus/adapter.js');
const { loadProductPolicy } = require('../config/product-policy.js');
const { typeFromSignature } = require('../dbus/types.js');
const { InterfaceStore } = require('./store.js');
const { InterfaceReferenceAnalyzer } = require('./references.js');
const { isIdentifier, validateInterface, validateMethod, validateXmlSize, MAX_INTERFACES } = require('./validator.js');
function slug(value) { return String(value).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase(); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function interfaceId(value) { if (!isIdentifier(value)) throw error('DBUS_INTERFACE_INVALID', 'DBus Interface ID 형식이 잘못되었습니다.', { id: value }); return value; }
function methodId(value) { if (!isIdentifier(value)) throw error('DBUS_METHOD_INVALID', 'DBus Method ID 형식이 잘못되었습니다.', { methodId: value }); return value; }
class InterfaceManager {
  constructor(options) { const settings = options || {}; this.cgiRoot = settings.cgiRoot; const productPolicy = settings.productPolicy || loadProductPolicy(this.cgiRoot); this.store = settings.store || new InterfaceStore({ cgiRoot: this.cgiRoot }); this.references = settings.references || new InterfaceReferenceAnalyzer({ cgiRoot: this.cgiRoot, useIndex: productPolicy.target === 'ls' }); this.mutationLock = settings.mutationLock || createJobOperationLock({ directory: path.join(this.cgiRoot, 'conf.d', '.interface-mutation-locks') }); this.jobLock = settings.jobLock || createJobOperationLock({ directory: path.join(this.cgiRoot, 'conf.d', '.job-operation-locks') }); this.readerLock = settings.readerLock || createJobOperationLock({ directory: path.join(this.cgiRoot, 'conf.d', '.interface-mutation-readers') }); this.dbusFactory = settings.dbusFactory || (() => createDbusAdapter()); }
  execute(callback, action) { try { callback(null, action()); } catch (failure) { callback(failure); } }
  required(id) { interfaceId(id); const found = this.store.find(id); if (!found) throw error('DBUS_INTERFACE_NOT_FOUND', 'DBus Interface를 찾을 수 없습니다.', { id }); return found; }
  writable(id) { const found = this.required(id); if (found.builtIn) throw error('DBUS_INTERFACE_READ_ONLY', 'Built-in DBus Interface는 바꿀 수 없습니다.', { id }); return found; }
  listInterfaces() { return this.store.list().map((item) => ({ id: item.id, name: item.name, busType: item.busType, destination: item.destination, objectPath: item.objectPath, interface: item.interface, builtIn: item.builtIn, methodCount: item.methods.length })); }
  getInterface(id, callback) { this.execute(callback, () => { const item = this.required(id); return { interface: item, references: this.references.find(id) }; }); }
  guard(id, callback, action) { let fence; const jobs = []; try { interfaceId(id); fence = this.mutationLock.acquire(profileLockKey(id)); const readerDir = path.join(this.cgiRoot, 'conf.d', '.interface-mutation-readers'); const prefix = `${profileLockKey(id)}--`; if (fs.existsSync(readerDir)) fs.readdirSync(readerDir).filter((entry) => entry.startsWith(prefix) && entry.endsWith('.lock')).forEach((entry) => { const reader = this.readerLock.acquire(entry.slice(0, -5)); reader.release(); }); const refs = this.references.find(id); [...new Set(refs.map((ref) => ref.name))].sort().forEach((name) => jobs.push(this.jobLock.acquire(name))); const refreshed = this.references.find(id); return this.execute((failure, value) => { [...jobs].reverse().forEach((handle) => handle.release()); fence.release(); callback(failure, value); }, () => action(refreshed)); } catch (failure) { [...jobs].reverse().forEach((handle) => handle.release()); if (fence) fence.release(); callback(failure); } }
  createInterface(value, callback) {
    let next;
    let allocation;
    try {
      if (typeof value?.name !== 'string' || !value.name.trim()) throw error('DBUS_INTERFACE_INVALID', 'DBus Interface 이름은 필수입니다.');
      next = validateInterface({ ...value, origin: value.origin || 'manual', builtIn: false }, { idOptional: true });
      allocation = this.mutationLock.acquire(profileLockKey('dbus-interface-create'));
      const used = new Set(this.store.list().map((item) => item.id));
      const base = slug(next.name) || slug(next.interface) || 'dbus-interface';
      let id = base;
      let suffix = 2;
      while (used.has(id)) { id = `${base}-${suffix}`; suffix += 1; }
      const saved = this.store.save({ ...next, id, builtIn: false });
      allocation.release();
      allocation = null;
      callback(null, saved);
    } catch (failure) {
      if (allocation) allocation.release();
      callback(failure);
    }
  }
  updateInterface(value, callback) { let next; try { next = validateInterface({ ...value, builtIn: false }); } catch (failure) { callback(failure); return; } const id = next.id; this.guard(id, callback, (refs) => { const current = this.writable(id); if (current.origin !== next.origin) throw error('DBUS_INTERFACE_INVALID', 'DBus Interface origin은 바꿀 수 없습니다.', { interfaceId: id }); const callShapeChanged = !same({ ...current, name: '' }, { ...next, name: '' }); if (refs.length && callShapeChanged) throw error('DBUS_INTERFACE_IN_USE', 'Job이 참조하는 DBus Interface는 호출 구조를 바꿀 수 없습니다.', { jobs: refs }); const currentDiscovered = current.methods.filter((method) => method.source === 'discovered'); const nextDiscovered = next.methods.filter((method) => method.source === 'discovered'); if (current.origin !== 'manual' && !same(current.methods, next.methods)) throw error('DBUS_METHOD_READ_ONLY', '자동 발견 DBus Method가 있는 Interface에서는 Method를 직접 바꿀 수 없습니다.', { interfaceId: id }); if (current.origin === 'manual' && !same(currentDiscovered, nextDiscovered)) throw error('DBUS_METHOD_READ_ONLY', '자동 발견 DBus Method는 직접 바꿀 수 없습니다.', { interfaceId: id }); return this.store.save(next); }); }
  updateDiscoveredInterface(value, callback) { let next; try { next = validateInterface({ ...value, origin: 'discovered', builtIn: false }); } catch (failure) { callback(failure); return; } this.guard(next.id, callback, (refs) => { const current = this.writable(next.id); if (current.origin !== 'discovered') throw error('DBUS_INTERFACE_INVALID', '자동 발견 DBus Interface가 아닙니다.', { interfaceId: next.id }); if (refs.length) throw error('DBUS_INTERFACE_IN_USE', 'Job이 참조하는 DBus Interface는 바꿀 수 없습니다.', { jobs: refs }); return this.store.save(next); }); }
  deleteInterface(id, callback) { this.guard(id, callback, (refs) => { this.writable(id); if (refs.length) throw error('DBUS_INTERFACE_IN_USE', 'Job이 참조하는 DBus Interface는 지울 수 없습니다.', { jobs: refs }); this.store.remove(id); return { id }; }); }
  createMethod(interfaceIdValue, value, callback) { let method; try { interfaceId(interfaceIdValue); method = validateMethod(value); } catch (failure) { callback(failure); return; } this.guard(interfaceIdValue, callback, (refs) => { const item = this.writable(interfaceIdValue); if (refs.length) throw error('DBUS_INTERFACE_IN_USE', 'Job이 참조하는 DBus Interface에서는 Method를 바꿀 수 없습니다.', { jobs: refs }); if (item.origin !== 'manual' || method.source !== 'manual') throw error('DBUS_METHOD_READ_ONLY', '자동 발견 DBus Method가 있는 Interface에서는 Method를 직접 바꿀 수 없습니다.', { interfaceId: interfaceIdValue, methodId: method.id }); if (item.methods.some((candidate) => candidate.id === method.id)) throw error('DBUS_METHOD_IN_USE', '같은 Method ID가 이미 있습니다.', { interfaceId: interfaceIdValue, methodId: method.id }); this.store.save({ ...item, methods: item.methods.concat(method) }); return method; }); }
  updateMethod(interfaceIdValue, methodIdValue, value, callback) { let method; try { interfaceId(interfaceIdValue); methodId(methodIdValue); method = validateMethod(value); } catch (failure) { callback(failure); return; } this.guard(interfaceIdValue, callback, (refs) => { const item = this.writable(interfaceIdValue); if (refs.length) throw error('DBUS_INTERFACE_IN_USE', 'Job이 참조하는 DBus Interface에서는 Method를 바꿀 수 없습니다.', { jobs: refs }); const current = item.methods.find((candidate) => candidate.id === methodIdValue); if (item.origin !== 'manual' || !current || current.source !== 'manual' || method.source !== 'manual') throw error('DBUS_METHOD_READ_ONLY', '자동 발견 DBus Method가 있는 Interface에서는 Method를 직접 바꿀 수 없습니다.', { interfaceId: interfaceIdValue, methodId: methodIdValue }); if (method.id !== methodIdValue) throw error('DBUS_METHOD_INVALID', '요청의 Method ID가 서로 다릅니다.', { methodId: methodIdValue, bodyMethodId: method.id }); this.store.save({ ...item, methods: item.methods.map((candidate) => candidate.id === methodIdValue ? method : candidate) }); return method; }); }
  deleteMethod(interfaceIdValue, methodIdValue, callback) { try { interfaceId(interfaceIdValue); methodId(methodIdValue); } catch (failure) { callback(failure); return; } this.guard(interfaceIdValue, callback, (refs) => { const item = this.writable(interfaceIdValue); if (refs.length) throw error('DBUS_INTERFACE_IN_USE', 'Job이 참조하는 DBus Interface에서는 Method를 바꿀 수 없습니다.', { jobs: refs }); const current = item.methods.find((candidate) => candidate.id === methodIdValue); if (item.origin !== 'manual' || !current || current.source !== 'manual') throw error('DBUS_METHOD_READ_ONLY', '자동 발견 DBus Method가 있는 Interface에서는 Method를 직접 바꿀 수 없습니다.', { interfaceId: interfaceIdValue, methodId: methodIdValue }); this.store.save({ ...item, methods: item.methods.filter((candidate) => candidate.id !== methodIdValue) }); return { interfaceId: interfaceIdValue, methodId: methodIdValue }; }); }
  parseIntrospection(node, connection) {
    validateXmlSize(JSON.stringify(node));
    const read = (value, lower, upper) => value && (value[lower] === undefined ? value[upper] : value[lower]);
    const foundInterfaces = read(node, 'interfaces', 'Interfaces');
    if (!Array.isArray(foundInterfaces)) throw error('INTROSPECTION_UNSUPPORTED', 'Introspection Interface 결과가 없습니다.');
    const interfaces = foundInterfaces.map((discovered) => {
      const interfaceName = read(discovered, 'name', 'Name');
      const foundMethods = read(discovered, 'methods', 'Methods');
      if (!discovered || typeof interfaceName !== 'string' || !Array.isArray(foundMethods)) throw error('INTROSPECTION_UNSUPPORTED', 'Introspection Interface 형식이 잘못되었습니다.');
      const methods = foundMethods.map((method) => {
        const member = read(method, 'name', 'Name');
        const foundArguments = read(method, 'args', 'Args');
        if (!method || typeof member !== 'string' || !Array.isArray(foundArguments)) throw error('INTROSPECTION_UNSUPPORTED', 'Introspection Method 형식이 잘못되었습니다.');
        const usedNames = new Set();
        const inputs = [];
        const outputs = [];
        foundArguments.forEach((argument, index) => {
          const signature = read(argument, 'type', 'Type');
          const direction = read(argument, 'direction', 'Direction');
          const type = typeFromSignature(signature);
          if (!type) throw error('INTROSPECTION_UNSUPPORTED', 'Introspection parameter type이 잘못되었습니다.', { type: signature });
          const target = direction === 'out' ? outputs : inputs;
          const prefix = direction === 'out' ? 'output' : 'input';
          let name = read(argument, 'name', 'Name');
          name = typeof name === 'string' && name ? name : `${prefix}${target.length + 1}`;
          if (usedNames.has(name)) name = `${prefix}${index + 1}`;
          while (usedNames.has(name)) name = `${name}_`;
          usedNames.add(name);
          target.push({ name, type });
        });
        return { id: slug(member), source: 'discovered', member, inputs, outputs };
      });
      return validateInterface({ schemaVersion: 1, id: slug(interfaceName), name: interfaceName, origin: 'discovered', builtIn: false, ...connection, interface: interfaceName, methods });
    });
    if (!interfaces.length || interfaces.length > MAX_INTERFACES) throw error('INTROSPECTION_UNSUPPORTED', 'Introspection Interface 결과가 없습니다.');
    return interfaces;
  }
  discover(value, callback) { this.execute(callback, () => { const connection = { busType: value && value.busType, destination: value && value.destination, objectPath: value && value.objectPath }; validateInterface({ schemaVersion: 1, id: 'temporary-interface', origin: 'discovered', builtIn: false, ...connection, interface: 'temporary.Interface', methods: [] }); let dbus; try { dbus = this.dbusFactory(); dbus.connect(connection.busType, connection.destination); return this.parseIntrospection(dbus.introspect(connection), connection); } catch (_) { throw error('INTROSPECTION_UNSUPPORTED', 'DBus Introspection을 사용할 수 없습니다.'); } finally { if (dbus) dbus.close(); } }); }
}
module.exports = { InterfaceManager };
