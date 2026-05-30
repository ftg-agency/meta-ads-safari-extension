/*
 * test/ext-api.test.js — обёртка resolИ́тся и для callback-стиля (chrome),
 * и для promise-стиля (browser).
 */
'use strict';

const assert = require('assert');
const ExtApi = require('../src/lib/ext-api.js');

(async function () {
  // --- callback-стиль chrome ---
  delete globalThis.browser;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: function (msg, cb) { cb({ echo: msg }); },
      getManifest: function () { return { version: '9.9.9' }; }
    },
    storage: {
      local: {
        get: function (keys, cb) { cb({ saved: keys }); },
        set: function (obj, cb) { cb(); }
      }
    }
  };

  assert.strictEqual(ExtApi.usingPromiseApi(), false, 'chrome → callback api');
  let r = await ExtApi.sendMessage({ a: 1 });
  assert.deepStrictEqual(r, { echo: { a: 1 } }, 'chrome sendMessage resolves callback');
  let g = await ExtApi.storageGet('k');
  assert.deepStrictEqual(g, { saved: 'k' }, 'chrome storageGet resolves callback');
  await ExtApi.storageSet({ x: 1 }); // должно зарезолвиться без ошибки
  assert.strictEqual(ExtApi.getManifest().version, '9.9.9', 'chrome getManifest');

  // --- promise-стиль browser ---
  globalThis.browser = {
    runtime: {
      sendMessage: async function (msg) { return { echo2: msg }; },
      getManifest: function () { return { version: '8.8.8' }; }
    },
    storage: {
      local: {
        get: async function (keys) { return { got: keys }; },
        set: async function () { return undefined; }
      }
    }
  };

  assert.strictEqual(ExtApi.usingPromiseApi(), true, 'browser → promise api');
  r = await ExtApi.sendMessage({ b: 2 });
  assert.deepStrictEqual(r, { echo2: { b: 2 } }, 'browser sendMessage resolves promise');
  g = await ExtApi.storageGet('k2');
  assert.deepStrictEqual(g, { got: 'k2' }, 'browser storageGet resolves promise');
  await ExtApi.storageSet({ y: 1 });
  assert.strictEqual(ExtApi.getManifest().version, '8.8.8', 'browser getManifest');

  console.log('ext-api.test OK');
})().catch(function (e) {
  console.error('ext-api.test FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
