'use strict';

const process = require('process');
const { CounterStore } = require('../src/example/counter.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function numberArgument(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} 값은 0 이상의 정수여야 합니다.`);
  }
  return parsed;
}

function run() {
  const scenario = process.argv[2];
  const dataDir = process.argv[3];
  if (!scenario || !dataDir) {
    throw new Error('사용법: counter-store.jsh.js <scenario> <data-dir> [args...]');
  }

  const store = new CounterStore(dataDir);
  if (scenario === 'first') {
    assert(store.read('first') === null, '첫 증가 전 결과는 없어야 합니다.');
    const result = store.increment('first');
    assert(result.count === 1, '첫 증가 결과는 1이어야 합니다.');
    assert(store.read('first').count === 1, '첫 증가 결과가 저장되어야 합니다.');
    return;
  }

  if (scenario === 'increment') {
    const name = process.argv[4];
    const times = numberArgument(process.argv[5], '증가 횟수');
    for (let index = 0; index < times; index += 1) store.increment(name);
    return;
  }

  if (scenario === 'expect') {
    const name = process.argv[4];
    const expected = numberArgument(process.argv[5], '기대 값');
    const result = store.read(name);
    assert(result !== null, `${name} 결과가 있어야 합니다.`);
    assert(
      result.count === expected,
      `${name} 결과는 ${expected}여야 하지만 ${result.count}입니다.`,
    );
    return;
  }

  if (scenario === 'remove') {
    const name = process.argv[4];
    assert(store.remove(name), `${name} 결과를 지워야 합니다.`);
    assert(store.read(name) === null, `${name} 결과가 없어야 합니다.`);
    return;
  }

  throw new Error(`알 수 없는 counter smoke 시나리오입니다: ${scenario}`);
}

try {
  run();
  console.println(`counter-store jsh smoke: ${process.argv[2]} ok`);
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
