'use strict';

const fs = require('fs');
const path = require('path');

function randomNonce() {
  let result = '';
  for (let index = 0; index < 4; index += 1) {
    result += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  }
  return result;
}

function openTemporary(directory, basename) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const file = path.join(directory, `.${basename}.tmp-${randomNonce()}`);
    try {
      return { file, descriptor: fs.openSync(file, 'wx') };
    } catch (openError) {
      if (openError && openError.code === 'EEXIST') continue;
      throw openError;
    }
  }
  throw new Error('atomic JSON 임시 파일 이름을 만들 수 없습니다.');
}

function writeJsonAtomic(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = openTemporary(directory, path.basename(file));
  let descriptorOpen = true;
  try {
    fs.writeSync(temporary.descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.closeSync(temporary.descriptor);
    descriptorOpen = false;
    fs.renameSync(temporary.file, file);
  } catch (writeError) {
    if (descriptorOpen) {
      try { fs.closeSync(temporary.descriptor); } catch (_) {}
    }
    try {
      if (fs.existsSync(temporary.file)) fs.unlinkSync(temporary.file);
    } catch (_) {
      // 원래 쓰기 오류를 유지한다.
    }
    throw writeError;
  }
}

module.exports = { writeJsonAtomic };
