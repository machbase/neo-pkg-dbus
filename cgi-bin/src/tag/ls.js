'use strict';

const { error } = require('../config/errors.js');

function invalid(reason, details) {
  throw error('TAG_GENERATION_FAILED', reason, details);
}

function generateLsTags(sourceAddress, count, maximum) {
  if (typeof sourceAddress !== 'string') invalid('LS source address는 문자열이어야 합니다.');
  const match = /^(.*?)(\d+)$/.exec(sourceAddress);
  if (!match || !match[1]) invalid('LS source address는 숫자로 끝나야 합니다.', { sourceAddress });
  if (!Number.isInteger(count) || count < 1) invalid('Tag count는 1 이상의 정수여야 합니다.', { count });
  if (!Number.isInteger(maximum) || maximum < 1 || count > maximum) {
    invalid('Tag count가 maxGeneratedTagsPerCall을 넘었습니다.', { count, maximum });
  }
  const first = Number(match[2]);
  if (!Number.isSafeInteger(first) || first + count - 1 > Number.MAX_SAFE_INTEGER) {
    invalid('LS source address 숫자 범위를 벗어났습니다.', { sourceAddress, count });
  }
  const width = match[2].length;
  return Array.from({ length: count }, (_unused, outputIndex) => {
    const suffix = String(first + outputIndex).padStart(width, '0');
    const address = `${match[1]}${suffix}`;
    return { outputIndex, sourceAddress: address, name: address, bias: 0, multiplier: 1, calcOrder: 'bm' };
  });
}

module.exports = { generateLsTags };
