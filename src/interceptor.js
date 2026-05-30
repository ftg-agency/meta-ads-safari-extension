/*
 * src/interceptor.js — выполняется в MAIN-world (страница FB), document_start.
 *
 * Патчит window.fetch и XMLHttpRequest, чтобы читать сырые ответы FB /api/graphql.
 * Содержимое отправляется в ISOLATED-world через window.postMessage с тегом
 * FBALS_INTERCEPT. Никаких chrome.* здесь нет — только DOM/postMessage.
 *
 * На Chrome подключается декларативно (manifest world:"MAIN"); на Safari —
 * программно через ExtApi.registerMainWorld().
 */
(function () {
  'use strict';

  if (window.__FBALS_INTERCEPTOR__) return; // не патчим дважды
  window.__FBALS_INTERCEPTOR__ = true;

  const TAG = 'FBALS_INTERCEPT';
  const TARGET = '/api/graphql';

  function isTarget(url) {
    return typeof url === 'string' && url.indexOf(TARGET) !== -1;
  }

  function post(url, text) {
    if (!text) return;
    try {
      window.postMessage({ source: TAG, url: url, payload: text }, '*');
    } catch (_) { /* postMessage может бросить на структурных данных — игнор */ }
  }

  // --- патч fetch ---
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let url = '';
      if (typeof input === 'string') url = input;
      else if (input && typeof input.url === 'string') url = input.url;

      const promise = origFetch.apply(this, arguments);
      if (isTarget(url)) {
        promise.then((res) => {
          try {
            res.clone().text().then((t) => post(url, t)).catch(() => {});
          } catch (_) { /* clone недоступен — пропускаем */ }
        }).catch(() => {});
      }
      return promise;
    };
  }

  // --- патч XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__fbals_url = url; } catch (_) { /* readonly — игнор */ }
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    if (isTarget(xhr.__fbals_url)) {
      xhr.addEventListener('load', function () {
        try {
          // responseText доступен только для text/'' responseType
          if (!xhr.responseType || xhr.responseType === 'text') {
            post(xhr.__fbals_url, xhr.responseText);
          }
        } catch (_) { /* cross-origin/readonly — игнор */ }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
