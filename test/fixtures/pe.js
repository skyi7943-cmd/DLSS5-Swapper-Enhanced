'use strict';
const fs = require('fs');
const path = require('path');
// Valid but non-executable PE fixture; no code or payload is run in tests.
function writePe(file, { bitness = 64, text = '', size = 64 * 1024, version = null } = {}) {
  const is64 = bitness === 64;
  const peAt = 0x80;
  const optAt = peAt + 24;
  const optSize = is64 ? 240 : 224;
  const bytes = Buffer.alloc(size);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(peAt, 0x3c);
  bytes.writeUInt32LE(0x00004550, peAt);
  bytes.writeUInt16LE(is64 ? 0x8664 : 0x14c, peAt + 4);
  bytes.writeUInt16LE(version ? 1 : 0, peAt + 6);
  bytes.writeUInt16LE(optSize, peAt + 20);
  bytes.writeUInt16LE(is64 ? 0x20b : 0x10b, optAt);

  if (version) {
    const dataDirectory = optAt + (is64 ? 112 : 96);
    bytes.writeUInt32LE(0x1000, dataDirectory + 16); // resource RVA
    bytes.writeUInt32LE(0x200, dataDirectory + 20);
    const section = optAt + optSize;
    bytes.write('rsrc', section, 'ascii');
    bytes.writeUInt32LE(0x800, section + 8);
    bytes.writeUInt32LE(0x1000, section + 12);
    bytes.writeUInt32LE(0x800, section + 16);
    bytes.writeUInt32LE(0x200, section + 20);

    const base = 0x200;
    const directory = (at) => bytes.writeUInt16LE(1, base + at + 14);
    directory(0x00);
    bytes.writeUInt32LE(16, base + 0x10);
    bytes.writeUInt32LE(0x80000020, base + 0x14);
    directory(0x20);
    bytes.writeUInt32LE(1, base + 0x30);
    bytes.writeUInt32LE(0x80000040, base + 0x34);
    directory(0x40);
    bytes.writeUInt32LE(1033, base + 0x50);
    bytes.writeUInt32LE(0x60, base + 0x54);
    bytes.writeUInt32LE(0x1100, base + 0x60);
    bytes.writeUInt32LE(64, base + 0x64);
    const vParts = Array.isArray(version) ? version : String(version).split('.').map(Number);
    bytes.writeUInt32LE(0xfeef04bd, 0x300);
    bytes.writeUInt32LE(((vParts[0] << 16) | vParts[1]) >>> 0, 0x308);
    bytes.writeUInt32LE(((vParts[2] << 16) | vParts[3]) >>> 0, 0x30c);
  }

  if (text) bytes.write(text, 0x1000);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}
module.exports = { writePe };
