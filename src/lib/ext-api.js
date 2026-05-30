/*
 * src/lib/ext-api.js — кросс-браузерная обёртка над WebExtensions API.
 *
 * Chrome даёт callback-стиль через chrome.*, Safari/Firefox — promise-стиль
 * через browser.*. Эта обёртка приводит оба к промисам и экспонирует только то,
 * что реально используется в проекте. Грузится первой везде, где раньше был chrome.*.
 *
 * Экспортирует self.ExtApi и module.exports (для Node-тестов с моками).
 */
(function () {
  'use strict';

  // Базовый объект API выбираем лениво — чтобы тесты могли подменить globalThis.
  function api() {
    if (typeof globalThis === 'undefined') return undefined;
    return globalThis.browser ? globalThis.browser : globalThis.chrome;
  }

  function usingPromiseApi() {
    return typeof globalThis !== 'undefined' &&
      !!globalThis.browser && !!globalThis.browser.runtime;
  }

  function lastError() {
    const c = (typeof globalThis !== 'undefined') ? globalThis.chrome : undefined;
    return (c && c.runtime && c.runtime.lastError) ? c.runtime.lastError : null;
  }

  /**
   * Вызывает метод, поддерживая и callback-, и promise-стиль.
   * @param {Function} fn — метод (например chrome.runtime.sendMessage)
   * @param {Object} thisArg — контекст вызова
   * @param {Array} args — аргументы без финального callback
   */
  function callAsync(fn, thisArg, args) {
    if (usingPromiseApi()) {
      try {
        return Promise.resolve(fn.apply(thisArg, args));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return new Promise((resolve, reject) => {
      try {
        fn.apply(thisArg, args.concat([(result) => {
          const err = lastError();
          if (err) reject(new Error(err.message || String(err)));
          else resolve(result);
        }]));
      } catch (e) {
        reject(e);
      }
    });
  }

  // --- runtime / сообщения ---

  function sendMessage(message) {
    const A = api();
    return callAsync(A.runtime.sendMessage, A.runtime, [message]);
  }

  function onMessage(handler) {
    const A = api();
    A.runtime.onMessage.addListener(handler);
    return () => A.runtime.onMessage.removeListener(handler);
  }

  function getManifest() {
    const A = api();
    return A.runtime.getManifest();
  }

  function getURL(path) {
    const A = api();
    return A.runtime.getURL(path);
  }

  // --- storage.local ---

  function storageGet(keys) {
    const A = api();
    return callAsync(A.storage.local.get, A.storage.local, [keys]);
  }

  function storageSet(obj) {
    const A = api();
    return callAsync(A.storage.local.set, A.storage.local, [obj]);
  }

  function storageRemove(keys) {
    const A = api();
    return callAsync(A.storage.local.remove, A.storage.local, [keys]);
  }

  function onStorageChanged(handler) {
    const A = api();
    if (A.storage && A.storage.onChanged) A.storage.onChanged.addListener(handler);
  }

  // --- tabs ---

  const tabs = {
    query(queryInfo) {
      const A = api();
      return callAsync(A.tabs.query, A.tabs, [queryInfo]);
    },
    create(props) {
      const A = api();
      return callAsync(A.tabs.create, A.tabs, [props]);
    },
    get(tabId) {
      const A = api();
      return callAsync(A.tabs.get, A.tabs, [tabId]);
    },
    reload(tabId) {
      const A = api();
      return callAsync(A.tabs.reload, A.tabs, [tabId]);
    },
    sendMessage(tabId, message) {
      const A = api();
      return callAsync(A.tabs.sendMessage, A.tabs, [tabId, message]);
    },
    onUpdated: {
      addListener(fn) {
        const A = api();
        A.tabs.onUpdated.addListener(fn);
      },
      removeListener(fn) {
        const A = api();
        A.tabs.onUpdated.removeListener(fn);
      }
    }
  };

  // --- скачивание Blob без chrome.downloads (работает и в Safari) ---

  function downloadBlob(blob, filename) {
    if (typeof document === 'undefined') {
      throw new Error('downloadBlob доступен только в контексте с document (popup)');
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  /**
   * Регистрирует MAIN-world перехватчик во время выполнения.
   * Chrome: перехватчик объявлен в manifest (world:"MAIN") — здесь no-op.
   * Safari: декларативный MAIN-world игнорируется, регистрируем программно.
   */
  async function registerMainWorld() {
    const A = api();
    // На Chrome (callback-API) MAIN-world уже объявлен в манифесте.
    if (!usingPromiseApi()) return false;
    if (!A.scripting || !A.scripting.registerContentScripts) return false;
    try {
      const existing = await A.scripting.getRegisteredContentScripts({ ids: ['fbals-interceptor-main'] });
      if (existing && existing.length) return true;
    } catch (_) { /* getRegistered может отсутствовать */ }
    try {
      await A.scripting.registerContentScripts([{
        id: 'fbals-interceptor-main',
        js: ['src/interceptor.js'],
        matches: ['*://*.facebook.com/*'],
        runAt: 'document_start',
        world: 'MAIN',
        persistAcrossSessions: false
      }]);
      return true;
    } catch (e) {
      return false;
    }
  }

  const API = {
    sendMessage,
    onMessage,
    getManifest,
    getURL,
    storageGet,
    storageSet,
    storageRemove,
    onStorageChanged,
    tabs,
    downloadBlob,
    registerMainWorld,
    usingPromiseApi
  };

  if (typeof self !== 'undefined') self.ExtApi = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
