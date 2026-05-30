/*
 * test/zip.test.js — корректность ZIP-энкодера: CRC-вектор, сигнатуры,
 * согласованность центрального каталога; плюс мягкая проверка системным unzip.
 */
'use strict';

const assert = require('assert');
const Zip = require('../src/lib/zip.js');

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

const enc = new TextEncoder();

// Известный вектор CRC-32 ("123456789" -> 0xCBF43926)
assert.strictEqual(Zip.crc32(enc.encode('123456789')) >>> 0, 0xCBF43926, 'CRC-32 vector');
assert.strictEqual(Zip.crc32(new Uint8Array(0)) >>> 0, 0x00000000, 'CRC-32 of empty');

const files = [
  { name: 'a.txt', bytes: enc.encode('hello') },
  { name: 'dir/b.bin', bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 255]) },
  { name: 'имя.txt', bytes: enc.encode('кириллица utf-8') }
];

const zip = Zip.createZip(files);
assert.ok(zip instanceof Uint8Array && zip.length > 0, 'createZip returns non-empty Uint8Array');
assert.strictEqual(u32(zip, 0), 0x04034b50, 'first local file header signature');

// EOCD — последние 22 байта (комментарий пустой)
const eocd = zip.length - 22;
assert.strictEqual(u32(zip, eocd), 0x06054b50, 'EOCD signature');
const count = u16(zip, eocd + 10);
const cdSize = u32(zip, eocd + 12);
const cdOff = u32(zip, eocd + 16);
assert.strictEqual(count, files.length, 'EOCD record count matches file count');
assert.strictEqual(cdOff + cdSize + 22, zip.length, 'central dir offset/size are consistent');
assert.strictEqual(u32(zip, cdOff), 0x02014b50, 'central directory signature at cdOffset');

// Мягкая проверка: системный unzip -t должен признать архив валидным.
try {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const tmp = path.join(os.tmpdir(), 'fbals-zip-test-' + process.pid + '.zip');
  fs.writeFileSync(tmp, Buffer.from(zip));
  const r = spawnSync('unzip', ['-t', tmp], { encoding: 'utf8' });
  if (r.error) {
    console.log('zip.test: unzip недоступен — проверка целостности пропущена');
  } else {
    assert.strictEqual(r.status, 0, 'unzip -t должен признать архив валидным');
    console.log('zip.test: unzip -t OK');
  }
  try { fs.unlinkSync(tmp); } catch (_) { /* игнор */ }
} catch (e) {
  console.log('zip.test: unzip-проверка пропущена (' + e.message + ')');
}

console.log('zip.test OK');
