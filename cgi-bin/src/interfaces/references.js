'use strict';
const fs = require('fs'); const path = require('path');
const JOB_NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const CALL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 100;
const METHOD_CALL_FIELDS = ['id', 'name', 'interfaceId', 'methodId', 'inputs', 'tags'];
function isValidJobName(name) {
  return typeof name === 'string' && name.length <= MAX_NAME_LENGTH
    && JOB_NAME.test(name) && !/[\\/]/.test(name);
}
function isIdentifier(value) {
  return typeof value === 'string' && value.length <= MAX_NAME_LENGTH && IDENTIFIER.test(value);
}
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function validCall(call) {
  return isObject(call)
    && Object.keys(call).every((key) => METHOD_CALL_FIELDS.includes(key))
    && typeof call.id === 'string' && CALL_ID.test(call.id)
    && typeof call.name === 'string' && Boolean(call.name.trim())
    && isIdentifier(call.interfaceId)
    && isIdentifier(call.methodId)
    && isObject(call.inputs)
    && Array.isArray(call.tags);
}
function validCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0 || !calls.every(validCall)) return false;
  return new Set(calls.map((call) => call.id)).size === calls.length
    && new Set(calls.map((call) => call.name)).size === calls.length;
}
function invalid(name, job) {
  return [{ name, documentName: job && typeof job.name === 'string' ? job.name : null, calls: [], methodIds: [], invalidConfig: true }];
}
class InterfaceReferenceAnalyzer {
  constructor(options) { this.jobDir = path.join(options.cgiRoot, 'conf.d', 'jobs'); }
  find(interfaceId, methodId) {
    if (!fs.existsSync(this.jobDir)) return [];
    return fs.readdirSync(this.jobDir).filter((file) => file.endsWith('.json')).sort().flatMap((file) => {
      const name = file.slice(0, -5); let job;
      try { job = JSON.parse(fs.readFileSync(path.join(this.jobDir, file), 'utf8')); } catch (_) { return invalid(name, null); }
      if (!job || typeof job !== 'object' || Array.isArray(job) || job.schemaVersion !== 1 || job.name !== name || !isValidJobName(name)
        || !validCalls(job.methodCalls)) return invalid(name, job);
      const calls = job.methodCalls.filter((call) => call && call.interfaceId === interfaceId && (!methodId || call.methodId === methodId));
      return calls.length ? [{ name, documentName: job.name, calls: calls.map((call) => call.id), methodIds: [...new Set(calls.map((call) => call.methodId))], invalidConfig: false }] : [];
    });
  }
}
module.exports = { InterfaceReferenceAnalyzer };
