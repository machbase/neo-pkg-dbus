'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogReader } = require('../src/log/reader.js');
const { Logger } = require('../src/log/logger.js');

function call(target, method, ...args) {
  return new Promise((resolve, reject) => target[method](...args, (failure, value) => {
    if (failure) reject(failure);
    else resolve(value);
  }));
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (failure) => {
    assert.equal(failure && failure.code, code);
    assert.equal(JSON.stringify(failure).includes('secret'), false);
    return true;
  });
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-logs-'));
  try {
    fs.writeFileSync(path.join(root, 'line-a.log'), [
      '[INFO] started',
      '{"password":"secret","body":"raw-payload","config":{"database":{"password":"secret"}}}',
      '[INFO] finished',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'line-a_20260803_010203.log'), '[INFO] older\n');
    fs.writeFileSync(path.join(root, 'line-ab.log'), '[INFO] other job\n');
    fs.writeFileSync(path.join(root, '../ignored.txt'), 'ignored');

    const reader = createLogReader({ logDir: root, maxFileBytes: 2048, maxLines: 2, maxAllBytes: 1024 });
    assert.deepEqual(await call(reader, 'list', { name: 'line-a' }), {
      name: 'line-a',
      files: [
        { name: 'line-a.log', size: fs.statSync(path.join(root, 'line-a.log')).size, active: true },
        { name: 'line-a_20260803_010203.log', size: 13, active: false },
      ],
    });
    const all = await call(reader, 'all');
    assert.deepEqual(all.jobs.map((item) => item.name), ['line-a', 'line-ab']);
    assert.equal(all.jobs[0].fileCount, 2);

    const firstPage = await call(reader, 'content', { name: 'line-a', file: 'line-a.log', page: '1', lines: '2' });
    assert.equal(firstPage.totalLines, 3);
    assert.equal(firstPage.lines.length, 2);
    assert.equal(JSON.stringify(firstPage).includes('secret'), false);
    assert.equal(JSON.stringify(firstPage).includes('raw-payload'), false);
    assert.match(firstPage.lines[1], /\[REDACTED\]/);
    assert.equal(firstPage.nextPage, 2);
    await rejectsCode(call(reader, 'content', { name: 'line-a', file: '../line-ab.log' }), 'LOG_REQUEST_INVALID');
    await rejectsCode(call(reader, 'content', { name: '../line-a', file: 'line-a.log' }), 'LOG_REQUEST_INVALID');
    await rejectsCode(call(reader, 'content', { name: 'line-a', file: 'line-a.log', lines: '3' }), 'LOG_REQUEST_INVALID');

    const entire = await call(reader, 'contentAll', { name: 'line-a', file: 'line-a.log' });
    assert.equal(entire.content.includes('secret'), false);
    assert.equal(entire.content.includes('raw-payload'), false);
    assert.equal((await call(reader, 'tail', { name: 'line-a', lines: '2' })).lines.length, 2);

    fs.writeFileSync(path.join(root, 'large.log'), 'x'.repeat(2049));
    await rejectsCode(call(reader, 'contentAll', { name: 'large', file: 'large.log' }), 'LOG_TOO_LARGE');

    const loggerDir = path.join(root, 'writer');
    const logger = new Logger({ level: 'info', maxFiles: 2 }, {
      name: 'line-a', logDir: loggerDir, maxFileBytes: 80,
    });
    logger.info('db', { msg: 'connected', password: 'secret', body: 'raw-payload', host: 'localhost' });
    logger.info('db', { msg: 'another line long enough to rotate the active log file', token: 'secret-token' });
    logger.warn('auth', {
      msg: 'password=plain-pass token: plain-token Bearer bearer-token tcp://admin:url-pass@localhost:5656',
    });
    const written = fs.readdirSync(loggerDir).map((file) => fs.readFileSync(path.join(loggerDir, file), 'utf8')).join('\n');
    assert.equal(written.includes('secret'), false);
    assert.equal(written.includes('raw-payload'), false);
    assert.equal(written.includes('plain-pass'), false);
    assert.equal(written.includes('plain-token'), false);
    assert.equal(written.includes('bearer-token'), false);
    assert.equal(written.includes('url-pass'), false);
    assert.match(written, /password=\[REDACTED\]/);
    assert.match(written, /host=localhost/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().then(() => console.log('Log API and logger contract: ok')).catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
