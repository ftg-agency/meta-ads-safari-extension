/*
 * test/exporter.test.js — buildArchive со стабом fetch (один URL падает).
 * Проверяем: архив содержит images/, videos/, ads.json, ads.csv, manifest.txt;
 * упавший URL записан в failures, но не обрушил архив.
 */
'use strict';

const assert = require('assert');
const Exp = require('../src/lib/exporter.js');
const { dataset } = require('./fixtures.js');

// Стаб глобального fetch: для URL с «FAIL» — отказ, иначе несколько байт.
global.fetch = async function (url) {
  if (String(url).indexOf('FAIL') !== -1) throw new Error('network fail');
  return {
    ok: true,
    status: 200,
    async arrayBuffer() { return new Uint8Array([1, 2, 3, 4, 5]).buffer; },
    async blob() { return { size: 5 }; }
  };
};

(async function () {
  const media = Exp.collectMediaUrls(dataset);
  assert.ok(media.length >= 4, 'collectMediaUrls finds >= 4 assets, got ' + media.length);

  let progressSeen = 0;
  const res = await Exp.buildArchive(dataset, {
    concurrency: 3,
    onProgress: function () { progressSeen++; }
  });

  assert.ok(res.bytes instanceof Uint8Array && res.bytes.length > 0, 'archive bytes produced');
  const sig = (res.bytes[0] | (res.bytes[1] << 8) | (res.bytes[2] << 16) | (res.bytes[3] << 24)) >>> 0;
  assert.strictEqual(sig, 0x04034b50, 'archive starts with local file header signature');

  const names = res.entries;
  assert.ok(names.indexOf('ads.json') !== -1, 'archive has ads.json');
  assert.ok(names.indexOf('ads.csv') !== -1, 'archive has ads.csv');
  assert.ok(names.indexOf('manifest.txt') !== -1, 'archive has manifest.txt');
  assert.ok(names.some((n) => n.indexOf('images/') === 0), 'archive has images/*');
  assert.ok(names.some((n) => n.indexOf('videos/') === 0), 'archive has videos/*');

  assert.strictEqual(res.failures.length, 1, 'exactly one failed fetch');
  assert.ok(res.failures[0].url.indexOf('FAIL') !== -1, 'the FAIL url is the failure');
  assert.ok(!names.some((n) => n.indexOf('1002') !== -1), 'failed ad (1002) has no media entry');

  assert.ok(progressSeen > 0, 'progress callback fired');
  assert.strictEqual(res.fetched, 3, 'three assets fetched successfully');

  console.log('exporter.test OK');
})().catch(function (e) {
  console.error('exporter.test FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
