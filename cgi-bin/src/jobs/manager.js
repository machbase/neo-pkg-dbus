'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');

function loadCounterStore() {
  const generatedPath = path.resolve(__dirname, '..', 'example', 'counter.js');
  if (fs.existsSync(generatedPath)) return require(generatedPath).CounterStore;
  return require(path.resolve(
    __dirname,
    '..', '..', '..', '..', '..', 'template-common', 'cgi-bin', 'src', 'example', 'counter.js',
  )).CounterStore;
}

const CounterStore = loadCounterStore();

function loadControllerState() {
  const generatedPath = path.resolve(__dirname, '..', 'service', 'controller-state.js');
  if (fs.existsSync(generatedPath)) return require(generatedPath).classifyControllerState;
  return require(path.resolve(
    __dirname,
    '..', '..', '..', '..', '..', 'template-common', 'cgi-bin', 'src', 'service', 'controller-state.js',
  )).classifyControllerState;
}

const classifyControllerState = loadControllerState();

let nativeService = null;
try {
  nativeService = require('service');
} catch (_) {}

const PACKAGE_NAME = 'neo-pkg-dbus';
const SERVICE_MODE = 'jobs';
const SERVICE_PREFIX = '_np_neo_pkg_dbus_';
const JOB_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 60000;

function findCgiRoot() {
  const script = String((process.argv && process.argv[1]) || '').replace(/\\/g, '/');
  const marker = '/cgi-bin/';
  const markerIndex = script.indexOf(marker);
  if (markerIndex >= 0) return script.slice(0, markerIndex + '/cgi-bin'.length);
  return path.resolve(process.cwd(), 'cgi-bin');
}

function messageOf(error) {
  return error && error.message ? String(error.message) : String(error || '');
}

function controllerError(error) {
  const normalized = error instanceof Error ? error : new Error(messageOf(error));
  normalized.kind = 'controller';
  return normalized;
}

function jobNotFound(name, cause) {
  const error = new Error(`등록되지 않은 작업입니다: ${name}`);
  error.kind = 'not_found';
  if (cause) error.cause = cause;
  return error;
}

function conflictError(message) {
  const error = new Error(message);
  error.kind = 'conflict';
  return error;
}

function validationError(error) {
  const normalized = error instanceof Error ? error : new Error(messageOf(error));
  normalized.kind = 'validation';
  return normalized;
}

function appendCleanupError(target, error) {
  const message = messageOf(error);
  target.cleanupError = target.cleanupError
    ? `${target.cleanupError}; ${message}`
    : message;
}

function attachCleanupError(error, cleanupError) {
  appendCleanupError(error, cleanupError);
  error.message = `${messageOf(error)}; 보상 정리 실패로 설정을 보존했습니다. 기존 start 또는 delete API로 상태를 확인하고 복구하세요: ${error.cleanupError}`;
}

function statusOf(info) {
  const reported = String((info && (info.status || info.state)) || '').toUpperCase();
  return reported || classifyControllerState(info).state;
}

function running(info) {
  return classifyControllerState(info).running;
}

function startComplete(info) {
  return classifyControllerState(info).startComplete;
}

function stopped(info) {
  return classifyControllerState(info).state === 'STOPPED';
}

function installFailure(info, options) {
  if (!info && !(options && options.unknownIsFailure)) return null;
  const classified = classifyControllerState(info);
  if (classified.known && classified.state !== 'FAILED') return null;
  const status = classified.state === 'UNKNOWN' ? statusOf(info) : classified.state;
  return controllerError(new Error(
    classified.detail || `서비스 등록 결과가 ${status}입니다.`,
  ));
}

function isNotInstalled(error) {
  if (error && error.rpcCode !== undefined) return error.rpcCode === -32004;
  return /service\b.*\b(?:not found|not installed|does not exist)\b/i.test(messageOf(error))
    || /\b(?:no such|unknown) service\b/i.test(messageOf(error));
}

function isAlreadyInstalled(error) {
  return /service\b.*\b(?:already exists|already installed)\b/i.test(messageOf(error));
}

function normalizeConfig(config) {
  const value = config && typeof config === 'object' ? { ...config } : {};
  const intervalMs = value.intervalMs === undefined ? DEFAULT_INTERVAL_MS : value.intervalMs;
  if (!Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new Error(`intervalMs는 ${MIN_INTERVAL_MS}~${MAX_INTERVAL_MS} 사이의 정수여야 합니다.`);
  }
  return { ...value, intervalMs };
}

class JobManager {
  constructor(options) {
    const settings = options || {};
    this.service = settings.service || nativeService;
    this.cgiRoot = settings.cgiRoot || findCgiRoot();
    this.jobDir = settings.jobDir || path.join(this.cgiRoot, 'conf.d', 'jobs');
    this.dataDir = settings.dataDir || path.join(this.cgiRoot, 'data');
    this.workerPath = settings.workerPath || path.join(this.cgiRoot, 'worker.js');
    fs.mkdirSync(this.jobDir, { recursive: true });
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.counter = settings.counter || new CounterStore(this.dataDir);
  }

  validateName(name) {
    const value = String(name || '');
    if (!JOB_NAME_PATTERN.test(value)) {
      throw new Error('작업 이름은 소문자, 숫자, 하이픈만 사용하고 처음과 끝은 문자 또는 숫자여야 합니다.');
    }
    return value;
  }

  serviceName(name) {
    return `${SERVICE_PREFIX}${this.validateName(name)}`;
  }

  configPath(name) {
    return path.join(this.jobDir, `${this.validateName(name)}.json`);
  }

  requireConfigFile(name) {
    const value = this.validateName(name);
    const configPath = this.configPath(value);
    try {
      fs.statSync(configPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') throw jobNotFound(value, error);
      throw error;
    }
    return configPath;
  }

  readConfig(name) {
    const value = this.validateName(name);
    let document;
    try {
      document = JSON.parse(fs.readFileSync(this.configPath(value), 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') throw jobNotFound(value, error);
      throw error;
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error(`작업 설정은 JSON 객체여야 합니다: ${value}`);
    }
    if (document.name !== value) {
      throw new Error(`작업 설정 파일 이름 ${value}과 JSON name ${String(document.name)}이 다릅니다.`);
    }
    return {
      ...document,
      name: value,
      config: normalizeConfig(document.config),
    };
  }

  configNames() {
    const entries = fs.readdirSync(this.jobDir);
    const invalid = entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -5))
      .filter((name) => !JOB_NAME_PATTERN.test(name));
    if (invalid.length > 0) {
      throw new Error(`잘못된 작업 설정 파일 이름입니다: ${invalid.join(', ')}`);
    }
    return entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -5))
      .sort();
  }

  callService(method, args, callback) {
    let completed = false;
    const done = (error, ...result) => {
      if (completed) return;
      completed = true;
      callback(error ? controllerError(error) : null, ...result);
    };
    try {
      if (!this.service || typeof this.service[method] !== 'function') {
        throw new Error(`service.${method}()을 사용할 수 없습니다.`);
      }
      this.service[method](...args, done);
    } catch (error) {
      if (completed) throw error;
      done(controllerError(error));
    }
  }

  withCallback(callback, operation) {
    let completed = false;
    const done = (...result) => {
      if (completed) return;
      completed = true;
      callback(...result);
    };
    try {
      operation(done);
    } catch (error) {
      if (completed) throw error;
      done(error);
    }
  }

  create(payload, callback) {
    try {
      this.validateName(payload && payload.name);
    } catch (error) {
      callback(validationError(error));
      return;
    }
    this.createUnlocked(payload, callback);
  }

  update(payload, callback) {
    try {
      this.validateName(payload && payload.name);
      normalizeConfig(payload && payload.config);
    } catch (error) {
      callback(error);
      return;
    }
    this.updateUnlocked(payload, callback);
  }

  createUnlocked(payload, callback) {
    this.withCallback(callback, (done) => {
      const name = this.validateName(payload && payload.name);
      const configPath = this.configPath(name);
      if (fs.existsSync(configPath)) {
        throw conflictError(`이미 등록된 작업입니다: ${name}`);
      }
      let config;
      try {
        config = normalizeConfig(payload && payload.config);
      } catch (error) {
        throw validationError(error);
      }
      this.status(name, (statusError, info) => {
        if (statusError && !isNotInstalled(statusError)) {
          done(statusError);
          return;
        }
        if (!statusError) {
          const classified = classifyControllerState(info);
          if (classified.known) {
            done(conflictError(
              `이미 Controller에 등록된 작업입니다: ${name} (현재 상태: ${classified.state})`,
            ));
            return;
          }
          done(controllerError(new Error(
            `알 수 없는 Controller 상태에서는 생성할 수 없습니다: ${name} (현재 상태: ${statusOf(info) || 'UNKNOWN'})`,
          )));
          return;
        }

        try {
          this.counter.remove(name);
        } catch (error) {
          done(error);
          return;
        }

        const document = { name, config };
        let ownsConfig = false;
        let descriptor = null;
        try {
          descriptor = fs.openSync(configPath, 'wx');
          ownsConfig = true;
          fs.writeSync(descriptor, `${JSON.stringify(document, null, 2)}\n`);
          fs.closeSync(descriptor);
          descriptor = null;
        } catch (error) {
          if (descriptor !== null) {
            try { fs.closeSync(descriptor); } catch (_) {}
          }
          let cleanupError = null;
          if (ownsConfig) {
            try { fs.unlinkSync(configPath); } catch (unlinkError) {
              if (!unlinkError || unlinkError.code !== 'ENOENT') cleanupError = unlinkError;
            }
          }
          if (!ownsConfig && fs.existsSync(configPath)) {
            done(conflictError(`이미 등록된 작업입니다: ${name}`));
            return;
          }
          if (cleanupError) attachCleanupError(error, cleanupError);
          done(error);
          return;
        }

        this.register(name, { allowExisting: false }, (error, _registration, installedByRequest) => {
          if (!error) {
            done(null, document);
            return;
          }
          const removeConfig = (cleanupError) => {
            let configCleanupError = null;
            if (!cleanupError && ownsConfig) {
              try { fs.unlinkSync(configPath); } catch (unlinkError) {
                if (!unlinkError || unlinkError.code !== 'ENOENT') {
                  configCleanupError = unlinkError;
                }
              }
            }
            if (cleanupError || configCleanupError) {
              attachCleanupError(error, cleanupError || configCleanupError);
            }
            done(error);
          };
          if (!installedByRequest) {
            removeConfig(null);
            return;
          }
          this.cleanupRegistration(name, removeConfig);
        });
      });
    });
  }

  replaceConfig(name, document) {
    const targetPath = this.configPath(name);
    const temporaryPath = `${targetPath}.${Date.now()}-${process.pid || 0}-${Math.random().toString(16).slice(2)}.tmp`;
    let descriptor = null;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx');
      fs.writeSync(descriptor, `${JSON.stringify(document, null, 2)}\n`);
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporaryPath, targetPath);
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch (_) {}
      }
      try { fs.unlinkSync(temporaryPath); } catch (_) {}
      throw error;
    }
  }

  updateUnlocked(payload, callback) {
    this.withCallback(callback, (done) => {
      const name = this.validateName(payload && payload.name);
      this.readConfig(name);
      const document = {
        name,
        config: normalizeConfig(payload && payload.config),
      };
      const save = () => {
        try {
          this.replaceConfig(name, document);
          done(null, document);
        } catch (error) {
          done(error);
        }
      };
      this.status(name, (error, info) => {
        if (error && isNotInstalled(error)) {
          save();
          return;
        }
        if (error) {
          done(error);
          return;
        }
        if (!stopped(info)) {
          const status = statusOf(info) || 'UNKNOWN';
          done(conflictError(`작업을 중지한 뒤 수정하세요: ${name} (현재 상태: ${status})`));
          return;
        }
        save();
      });
    });
  }

  register(name, options, callback) {
    const settings = options || {};
    this.withCallback(callback, (done) => {
      const value = this.validateName(name);
      const configPath = this.configPath(value);
      this.readConfig(value);
      this.callService('install', [{
        name: this.serviceName(value),
        enable: true,
        working_dir: this.cgiRoot,
        executable: this.workerPath,
        args: [configPath],
      }], (error, info) => {
        if (error && isAlreadyInstalled(error)) {
          if (!settings.allowExisting) {
            done(conflictError(`이미 Controller에 등록된 작업입니다: ${value}`), null, false);
            return;
          }
          this.ensureRegisteredRunning(value, (ensureError, result) => {
            done(ensureError, result, false);
          });
          return;
        }
        if (error) {
          done(error, null, false);
          return;
        }
        const failure = installFailure(info);
        if (failure) {
          done(failure, null, true);
          return;
        }
        if (info && startComplete(info)) {
          done(null, { name: value, status: 'RUNNING' }, true);
          return;
        }
        this.verifyRunning(value, (verifyError, result) => {
          done(verifyError, result, true);
        });
      });
    });
  }

  verifyRunning(name, callback) {
    this.status(name, (error, info) => {
      if (error) {
        callback(error);
        return;
      }
      if (startComplete(info)) {
        callback(null, { name, status: 'RUNNING' });
        return;
      }
      const classified = classifyControllerState(info);
      callback(controllerError(new Error(
        classified.detail || `서비스가 시작되지 않았습니다: ${classified.state}`,
      )));
    });
  }

  ensureRegisteredRunning(name, callback) {
    this.status(name, (error, info) => {
      if (error) {
        callback(error);
        return;
      }
      const classified = classifyControllerState(info);
      if (classified.startComplete) {
        callback(null, { name, status: 'RUNNING' });
        return;
      }
      if (
        classified.state === 'STARTING'
        || classified.state === 'STOPPING'
        || classified.state === 'UNKNOWN'
      ) {
        callback(controllerError(new Error(
          `서비스 시작 전환이 완료되지 않았습니다: ${classified.state}`,
        )));
        return;
      }
      this.callService('start', [this.serviceName(name)], (startError, result) => {
        const failure = startError || installFailure(result);
        if (failure) callback(failure);
        else if (result && startComplete(result)) {
          callback(null, { name, status: 'RUNNING' });
        } else {
          this.verifyRunning(name, callback);
        }
      });
    });
  }

  cleanupRegistration(name, callback) {
    const serviceName = this.serviceName(name);
    const removeResult = () => {
      try {
        this.counter.remove(name);
        callback(null);
      } catch (resultError) {
        callback(resultError);
      }
    };
    const uninstall = () => {
      this.callService('uninstall', [serviceName], (error) => {
        if (error && !isNotInstalled(error)) {
          callback(error);
          return;
        }
        if (error && isNotInstalled(error)) {
          removeResult();
          return;
        }
        this.verifyUninstalled(name, (verifyError) => {
          if (verifyError) callback(verifyError);
          else removeResult();
        });
      });
    };
    this.status(name, (statusError, info) => {
      if (statusError && isNotInstalled(statusError)) {
        removeResult();
        return;
      }
      if (statusError) {
        callback(statusError);
        return;
      }
      const classified = classifyControllerState(info);
      if (classified.knownInactive) {
        uninstall();
      } else if (classified.activeForStop) {
        this.ensureStopped(name, (stopError) => {
          if (stopError) callback(stopError);
          else uninstall();
        });
      } else {
        callback(controllerError(new Error(
          `알 수 없는 Controller 상태에서는 정리할 수 없습니다: ${name} (현재 상태: ${classified.state})`,
        )));
      }
    });
  }

  status(name, callback) {
    this.withCallback(callback, (done) => {
      this.callService('status', [this.serviceName(name)], done);
    });
  }

  list(callback) {
    let names;
    try {
      names = this.configNames();
    } catch (error) {
      callback(error);
      return;
    }
    if (names.length === 0) {
      callback(null, []);
      return;
    }
    const result = new Array(names.length);
    let remaining = names.length;
    names.forEach((name, index) => {
      let config = {};
      let configError = '';
      try {
        config = this.readConfig(name).config || {};
      } catch (error) {
        configError = messageOf(error);
      }
      this.status(name, (error, info) => {
        const notInstalled = Boolean(error && isNotInstalled(error));
        const classified = classifyControllerState(info, { notInstalled });
        const serviceFailure = error ? null : installFailure(info, { unknownIsFailure: true });
        const controllerFailure = notInstalled
          ? null
          : (error || serviceFailure);
        const controllerErrorMessage = controllerFailure
          ? messageOf(controllerFailure)
          : classified.detail;
        const statusKnown = notInstalled || (!error && classified.known);
        const registered = notInstalled
          ? false
          : error
            ? null
            : statusKnown
              ? true
              : null;
        const status = error && !notInstalled ? 'ERROR' : classified.state;
        let counterResult = null;
        let resultError = '';
        try {
          counterResult = this.counter.read(name);
        } catch (counterError) {
          resultError = messageOf(counterError);
        }
        const representativeError = controllerErrorMessage || configError;
        result[index] = {
          name,
          config,
          result: counterResult,
          service: this.serviceName(name),
          status,
          statusKnown,
          registered,
          running: statusKnown && registered === true && classified.running,
          error: representativeError,
          errorKind: controllerErrorMessage ? 'controller' : configError ? 'config' : '',
          configError,
          controllerError: controllerErrorMessage,
          resultError,
        };
        remaining -= 1;
        if (remaining === 0) callback(null, result);
      });
    });
  }

  runningNames(callback) {
    this.list((error, jobs) => {
      if (error) {
        callback(error);
        return;
      }
      const statusErrors = jobs
        .filter((job) => job.statusKnown === false)
        .map((job) => `${job.name}: ${job.controllerError || job.error}`);
      if (statusErrors.length > 0) {
        callback(new Error(statusErrors.join('; ')));
        return;
      }
      callback(null, jobs.filter((job) => job.running).map((job) => job.name));
    });
  }

  start(name, callback) {
    this.ensureRunning(name, callback);
  }

  ensureRunning(name, callback) {
    let value;
    try {
      value = this.validateName(name);
    } catch (error) {
      callback(error);
      return;
    }
    this.ensureRunningUnlocked(value, callback);
  }

  ensureRunningUnlocked(name, callback) {
    this.withCallback(callback, (done) => {
      this.readConfig(name);
      this.status(name, (statusError, info) => {
        if (statusError) {
          if (isNotInstalled(statusError)) this.register(name, { allowExisting: true }, done);
          else done(statusError);
          return;
        }
        const classified = classifyControllerState(info);
        if (classified.startComplete) {
          done(null, { name, status: 'RUNNING' });
          return;
        }
        if (
          classified.state === 'STARTING'
          || classified.state === 'STOPPING'
          || classified.state === 'UNKNOWN'
        ) {
          done(controllerError(new Error(
            `서비스 시작 전환이 완료되지 않았습니다: ${classified.state}`,
          )));
          return;
        }
        this.callService('start', [this.serviceName(name)], (startError, result) => {
          const failure = startError || installFailure(result);
          if (failure) done(failure);
          else if (result && startComplete(result)) {
            done(null, { name, status: 'RUNNING' });
          } else {
            this.verifyRunning(name, done);
          }
        });
      });
    });
  }

  installConfigured(callback) {
    let names;
    try {
      names = this.configNames();
    } catch (error) {
      callback(error, []);
      return;
    }
    let index = 0;
    const next = (error) => {
      if (error || index >= names.length) {
        callback(error || null, names);
        return;
      }
      const name = names[index];
      index += 1;
      this.ensureRunning(name, next);
    };
    next(null);
  }

  stop(name, callback) {
    let value;
    try {
      value = this.validateName(name);
    } catch (error) {
      callback(error);
      return;
    }
    this.stopUnlocked(value, callback);
  }

  stopUnlocked(name, callback) {
    try {
      this.requireConfigFile(name);
    } catch (error) {
      callback(error);
      return;
    }
    this.ensureStopped(name, callback);
  }

  ensureStopped(name, callback) {
    this.withCallback(callback, (done) => {
      const serviceName = this.serviceName(name);
      this.status(name, (statusError, info) => {
        if (statusError && isNotInstalled(statusError)) {
          done(null, { name, status: 'STOPPED' });
          return;
        }
        if (statusError) {
          done(statusError);
          return;
        }
        if (stopped(info)) {
          done(null, { name, status: 'STOPPED' });
          return;
        }
        this.callService('stop', [serviceName], (stopError, result) => {
          if (stopError && isNotInstalled(stopError)) {
            done(null, { name, status: 'STOPPED' });
            return;
          }
          if (stopError) {
            done(stopError);
            return;
          }
          const failure = installFailure(result);
          if (failure) {
            done(failure);
            return;
          }
          this.verifyStopped(name, done);
        });
      });
    });
  }

  verifyStopped(name, callback) {
    this.status(name, (error, info) => {
      if (error && isNotInstalled(error)) {
        callback(null, { name, status: 'STOPPED' });
        return;
      }
      if (error) {
        callback(error);
        return;
      }
      if (stopped(info)) {
        callback(null, { name, status: 'STOPPED' });
        return;
      }
      const classified = classifyControllerState(info);
      callback(controllerError(new Error(
        classified.detail || `서비스가 멈추지 않았습니다: ${classified.state}`,
      )));
    });
  }

  verifyUninstalled(name, callback) {
    this.status(name, (error) => {
      if (error && isNotInstalled(error)) {
        callback(null);
        return;
      }
      if (error) {
        callback(error);
        return;
      }
      callback(controllerError(new Error(`서비스가 제거되지 않았습니다: ${name}`)));
    });
  }

  delete(name, callback) {
    let value;
    try {
      value = this.validateName(name);
    } catch (error) {
      callback(error);
      return;
    }
    this.deleteUnlocked(value, callback);
  }

  deleteUnlocked(name, callback) {
    this.withCallback(callback, (done) => {
      const serviceName = this.serviceName(name);
      const configPath = this.configPath(name);
      try {
        if (!fs.lstatSync(configPath).isFile()) {
          throw new Error(`작업 설정 경로는 일반 파일이어야 합니다: ${name}`);
        }
      } catch (error) {
        if (error && error.code === 'ENOENT') throw jobNotFound(name, error);
        throw error;
      }
      const removeFiles = () => {
        try { fs.unlinkSync(configPath); } catch (unlinkError) {
          if (!unlinkError || unlinkError.code !== 'ENOENT') {
            done(unlinkError);
            return;
          }
        }
        try { this.counter.remove(name); } catch (resultError) {
          done(null, { name, cleanupError: messageOf(resultError) });
          return;
        }
        done(null, { name });
      };
      const uninstall = () => {
        this.callService('uninstall', [serviceName], (error) => {
          if (error && !isNotInstalled(error)) {
            done(error);
            return;
          }
          if (error && isNotInstalled(error)) {
            removeFiles();
            return;
          }
          this.verifyUninstalled(name, (verifyError) => {
            if (verifyError) done(verifyError);
            else removeFiles();
          });
        });
      };
      this.status(name, (statusError, info) => {
        if (statusError && isNotInstalled(statusError)) {
          uninstall();
          return;
        }
        if (statusError) {
          done(statusError);
          return;
        }
        const status = statusOf(info);
        if (status === 'STOPPED' || status === 'FAILED') {
          uninstall();
          return;
        }
        if (status === 'RUNNING' || status === 'STARTING' || status === 'STOPPING') {
          this.ensureStopped(name, (stopError) => {
            if (stopError) done(stopError);
            else uninstall();
          });
          return;
        }
        done(controllerError(new Error(
          `알 수 없는 Controller 상태에서는 삭제할 수 없습니다: ${name} (현재 상태: ${status || 'UNKNOWN'})`,
        )));
      });
    });
  }

  summary(callback) {
    this.list((error, jobs) => {
      if (error) {
        callback(null, {
          scope: PACKAGE_NAME,
          total: 0,
          running: 0,
          errors: [messageOf(error)],
          error_details: [{ name: '', kind: error.kind || 'config', message: messageOf(error) }],
        });
        return;
      }
      const details = [];
      jobs.forEach((job) => {
        if (job.configError) {
          details.push({ name: job.name, kind: 'config', message: job.configError });
        }
        if (job.controllerError) {
          details.push({ name: job.name, kind: 'controller', message: job.controllerError });
        }
        if (job.resultError) {
          details.push({ name: job.name, kind: 'result', message: job.resultError });
        }
      });
      callback(null, {
        scope: PACKAGE_NAME,
        total: jobs.length,
        running: jobs.filter((job) => job.running).length,
        errors: details.map((detail) => `${detail.name}: ${detail.kind === 'result' ? '결과 오류: ' : ''}${detail.message}`),
        error_details: details,
      });
    });
  }
}

module.exports = {
  JobManager,
  PACKAGE_NAME,
  SERVICE_MODE,
  SERVICE_PREFIX,
  JOB_NAME_PATTERN,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  isNotInstalled,
  isAlreadyInstalled,
  normalizeConfig,
};
