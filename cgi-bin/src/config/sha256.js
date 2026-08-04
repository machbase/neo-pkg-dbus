'use strict';

var ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function add(left, right) { return ((left >>> 0) + (right >>> 0)) >>> 0; }
function rotateRight(value, amount) { return ((value >>> amount) | (value << (32 - amount))) >>> 0; }

function utf8Bytes(value) {
  var text = String(value);
  var bytes = [];
  for (var index = 0; index < text.length; index += 1) {
    var code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      var next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else code = 0xfffd;
    } else if (code >= 0xdc00 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >>> 18), 0x80 | ((code >>> 12) & 0x3f), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

function wordHex(value) {
  var hex = (value >>> 0).toString(16);
  return '00000000'.slice(hex.length) + hex;
}

function sha256(value) {
  var bytes = utf8Bytes(value);
  var bitLength = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  var highLength = Math.floor(bitLength / 0x100000000);
  var lowLength = bitLength >>> 0;
  bytes.push(
    (highLength >>> 24) & 0xff, (highLength >>> 16) & 0xff, (highLength >>> 8) & 0xff, highLength & 0xff,
    (lowLength >>> 24) & 0xff, (lowLength >>> 16) & 0xff, (lowLength >>> 8) & 0xff, lowLength & 0xff,
  );
  var h0 = 0x6a09e667; var h1 = 0xbb67ae85; var h2 = 0x3c6ef372; var h3 = 0xa54ff53a;
  var h4 = 0x510e527f; var h5 = 0x9b05688c; var h6 = 0x1f83d9ab; var h7 = 0x5be0cd19;
  for (var offset = 0; offset < bytes.length; offset += 64) {
    var words = new Array(64);
    var word;
    for (word = 0; word < 16; word += 1) {
      var position = offset + (word * 4);
      words[word] = ((bytes[position] << 24) | (bytes[position + 1] << 16)
        | (bytes[position + 2] << 8) | bytes[position + 3]) >>> 0;
    }
    for (word = 16; word < 64; word += 1) {
      var smallSigma0 = rotateRight(words[word - 15], 7) ^ rotateRight(words[word - 15], 18) ^ (words[word - 15] >>> 3);
      var smallSigma1 = rotateRight(words[word - 2], 17) ^ rotateRight(words[word - 2], 19) ^ (words[word - 2] >>> 10);
      words[word] = add(add(add(words[word - 16], smallSigma0), words[word - 7]), smallSigma1);
    }
    var a = h0; var b = h1; var c = h2; var d = h3;
    var e = h4; var f = h5; var g = h6; var h = h7;
    for (word = 0; word < 64; word += 1) {
      var bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      var choose = (e & f) ^ ((~e) & g);
      var temporary1 = add(add(add(add(h, bigSigma1), choose), ROUND_CONSTANTS[word]), words[word]);
      var bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      var majority = (a & b) ^ (a & c) ^ (b & c);
      var temporary2 = add(bigSigma0, majority);
      h = g; g = f; f = e; e = add(d, temporary1);
      d = c; c = b; b = a; a = add(temporary1, temporary2);
    }
    h0 = add(h0, a); h1 = add(h1, b); h2 = add(h2, c); h3 = add(h3, d);
    h4 = add(h4, e); h5 = add(h5, f); h6 = add(h6, g); h7 = add(h7, h);
  }
  return wordHex(h0) + wordHex(h1) + wordHex(h2) + wordHex(h3)
    + wordHex(h4) + wordHex(h5) + wordHex(h6) + wordHex(h7);
}

module.exports = { sha256 };
