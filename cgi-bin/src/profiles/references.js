'use strict';

const fs = require('fs');
const path = require('path');
const { classifyControllerState } = require('../service/controller-state.js');
const { isNotInstalled } = require('../service/controller-adapter.js');

const JOB_ID = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const PROFILE_METHOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function executionState(controllerState) {
  if (['RUNNING', 'STARTING', 'STOPPING'].includes(controllerState)) return 'running';
  if (['STOPPED', 'FAILED', 'NOT_INSTALLED'].includes(controllerState)) return 'stopped';
  return 'unknown';
}

function validMethodCalls(methodCalls) {
  if (!Array.isArray(methodCalls) || methodCalls.length === 0) return false;
  const callIds = new Set();
  return methodCalls.every((call) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)
      || !JOB_ID.test(call.id || '') || !PROFILE_METHOD_ID.test(call.methodId || '')
      || callIds.has(call.id)) return false;
    callIds.add(call.id);
    return true;
  });
}

function invalidRecord(stem, value, reason, global) {
  return {
    stem,
    value: value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    invalidConfig: true,
    global: Boolean(global),
    reason,
  };
}

class ReferenceAnalyzer {
  constructor(options) {
    this.jobDir = path.join(options.cgiRoot, 'conf.d', 'jobs');
    this.controller = options.controller;
    // LS has a single service process, so its per-Job state is owned by the
    // collector runtime rather than by _dbu_<job>. Generic keeps controller
    // status as its source of truth.
    this.stateInspector = options.stateInspector || null;
  }

  documents() {
    if (!fs.existsSync(this.jobDir)) return [];
    const documents = [];
    fs.readdirSync(this.jobDir).filter((name) => name.endsWith('.json')).sort().forEach((file) => {
      const stem = file.slice(0, -5);
      let value;
      try {
        value = JSON.parse(fs.readFileSync(path.join(this.jobDir, file), 'utf8'));
      } catch (readError) {
        documents.push(invalidRecord(stem, null, `Job JSON을 읽을 수 없습니다: ${readError.message}`, true));
        return;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        documents.push(invalidRecord(stem, value, 'Job document는 객체여야 합니다.', true));
        return;
      }
      const profileIdValid = PROFILE_METHOD_ID.test(value.profileId || '');
      const identityValid = JOB_ID.test(stem) && typeof value.name === 'string'
        && JOB_ID.test(value.name) && value.name === stem;
      const schemaValid = value.schemaVersion === 1;
      const callsValid = validMethodCalls(value.methodCalls);
      if (!profileIdValid || !identityValid || !schemaValid || !callsValid) {
        const reasons = [];
        if (!schemaValid) reasons.push('schemaVersion은 1이어야 합니다.');
        if (!identityValid) reasons.push('파일명과 Job name이 유효하고 같아야 합니다.');
        if (!profileIdValid) reasons.push('profileId가 필요합니다.');
        if (!callsValid) reasons.push('methodCalls 구조가 잘못되었습니다.');
        documents.push(invalidRecord(stem, value, reasons.join(' '), !profileIdValid));
        return;
      }
      documents.push({ stem, value, invalidConfig: false, global: false, reason: null });
    });
    return documents;
  }

  find(profileId, methodId) {
    const references = [];
    this.documents().filter((record) => record.global || record.value.profileId === profileId)
      .forEach((record) => {
        if (record.invalidConfig || !methodId) {
          references.push({
            name: record.stem,
            documentName: record.value.name,
            calls: [],
            invalidConfig: record.invalidConfig,
            global: record.global,
            invalidReason: record.reason,
          });
          return;
        }
        const calls = record.value.methodCalls.filter((call) => call.methodId === methodId)
          .map((call) => call.id);
        if (calls.length) references.push({
          name: record.stem,
          documentName: record.value.name,
          calls,
          invalidConfig: false,
          global: false,
          invalidReason: null,
        });
      });
    return references;
  }

  withStates(references, callback) {
    if (!references.length) {
      callback(null, []);
      return;
    }
    let pending = references.length;
    const results = new Array(references.length);
    references.forEach((reference, index) => {
      if (reference.invalidConfig) {
        results[index] = {
          ...reference,
          controllerState: 'UNKNOWN',
          controllerDetail: reference.invalidReason || 'Job config가 잘못되었습니다.',
          executionState: 'unknown',
        };
        pending -= 1;
        if (pending === 0) callback(null, results);
        return;
      }
      let finished = false;
      const done = (statusError, info) => {
        if (finished) return;
        finished = true;
        const classified = statusError
          ? (isNotInstalled(statusError)
            ? classifyControllerState(null, { notInstalled: true })
            : { state: 'UNKNOWN', known: false, activeForStop: false, detail: statusError.message })
          : classifyControllerState(info);
        results[index] = {
          ...reference,
          controllerState: classified.state,
          controllerDetail: classified.detail || null,
          executionState: executionState(classified.state),
        };
        pending -= 1;
        if (pending === 0) callback(null, results);
      };
      try {
        if (this.stateInspector) {
          this.stateInspector(reference.name, (statusError, state) => {
            if (statusError) { done(statusError); return; }
            const controllerState = state && state.controllerState;
            const known = ['RUNNING', 'STARTING', 'STOPPING', 'STOPPED', 'FAILED', 'NOT_INSTALLED'].includes(controllerState);
            if (!known) {
              done(new Error((state && state.controllerDetail) || 'LS collector Job state is unknown.'));
              return;
            }
            results[index] = {
              ...reference,
              controllerState,
              controllerDetail: state.controllerDetail || null,
              executionState: executionState(controllerState),
            };
            pending -= 1;
            if (pending === 0) callback(null, results);
          });
        } else this.controller.status(`_dbu_${reference.name}`, done);
      } catch (statusError) {
        done(statusError);
      }
    });
  }
}

module.exports = { ReferenceAnalyzer };
