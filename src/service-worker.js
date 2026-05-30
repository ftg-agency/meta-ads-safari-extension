/*
 * src/service-worker.js — фон расширения.
 *
 * Дедуп объявлений по ad_archive_id, слияние обогащённых полей, расчёт сводки
 * (analytics) и сохранение датасета в storage.local. Управляет запуском сбора
 * (handleStart: пинг content-script, при «мёртвом» — перезагрузка вкладки) и
 * отвечает popup на опрос состояния/выгрузку датасета.
 *
 * Все вызовы расширения — через ExtApi. На Chrome зависимости подгружаются
 * importScripts; на Safari они объявлены в background.scripts (guard это учитывает).
 */

// Chrome SW: подтянуть зависимости. Safari: уже загружены через background.scripts.
if (!self.FBALS_Analytics && typeof importScripts === 'function') {
  importScripts('lib/ext-api.js', 'lib/analytics.js');
}

(function () {
  'use strict';

  const Analytics = self.FBALS_Analytics;
  const ExtApi = self.ExtApi;

  const store = {
    adsById: {},
    order: [],
    status: 'idle',
    running: false,
    lastStatusExtra: null,
    startedAt: null,
    meta: { page_id: '', page_name: '', source_url: '', filters: {} }
  };

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // --- слияние / дедуп ---

  function mergeFields(a, b) {
    const out = Object.assign({}, a);
    for (const k in b) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
      const v = b[k];
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = v;
    }
    if (a.source && b.source && a.source !== b.source) out.source = 'merged';
    return out;
  }

  function mergeAd(ad) {
    const id = ad && ad.ad_archive_id;
    if (!id) return;
    if (store.adsById[id]) {
      store.adsById[id] = mergeFields(store.adsById[id], ad);
    } else {
      store.adsById[id] = ad;
      store.order.push(id);
    }
    if (!store.meta.page_name && ad.page_name) store.meta.page_name = ad.page_name;
    if (!store.meta.page_id && ad.page_id) store.meta.page_id = ad.page_id;
  }

  function datasetAds() {
    return store.order.map((id) => store.adsById[id]);
  }

  function buildDataset() {
    const ads = datasetAds();
    let version = '0.0.0';
    try { version = ExtApi.getManifest().version; } catch (_) { /* вне расширения */ }
    const summary = Analytics.computeSummary(ads, { id: store.meta.page_id, name: store.meta.page_name });
    return {
      meta: {
        generated_at: new Date().toISOString(),
        source_url: store.meta.source_url,
        page_id: store.meta.page_id,
        page_name: store.meta.page_name,
        filters: store.meta.filters,
        count: ads.length,
        version: version
      },
      summary: summary,
      ads: ads
    };
  }

  // --- сохранение (с дебаунсом) ---

  let persistTimer = null;
  let initialized = false;
  let pendingPersist = false;
  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(function () { persistTimer = null; persist(); }, 1000);
  }
  async function persist() {
    // Не перезаписываем хранилище, пока не загрузили прежний датасет: иначе
    // пробуждение SW во время сбора затёрло бы историю частичными данными.
    if (!initialized) { pendingPersist = true; return; }
    try { await ExtApi.storageSet({ fbals_dataset: buildDataset() }); } catch (_) { /* квота/ошибка — игнор */ }
  }

  // --- разбор фильтров из URL вкладки ---

  function parseFiltersFromUrl(url) {
    const out = { page_id: '', filters: {}, source_url: url || '' };
    try {
      const u = new URL(url);
      const qp = u.searchParams;
      out.page_id = qp.get('view_all_page_id') || '';
      out.filters = {
        q: qp.get('q') || '',
        country: qp.get('country') || '',
        active_status: qp.get('active_status') || '',
        ad_type: qp.get('ad_type') || '',
        media_type: qp.get('media_type') || ''
      };
    } catch (_) { /* кривой URL — пусто */ }
    return out;
  }

  // --- ожидание загрузки вкладки ---

  function waitForTabComplete(tabId, timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = async function () {
        try {
          const tb = await ExtApi.tabs.get(tabId);
          if (tb && tb.status === 'complete') return resolve(true);
        } catch (_) { /* вкладка закрыта */ }
        if (Date.now() - t0 > timeoutMs) return resolve(false);
        setTimeout(tick, 500);
      };
      tick();
    });
  }

  // --- запуск / остановка ---

  async function handleStart(config) {
    const tabs = await ExtApi.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab) return { ok: false, error: 'Нет активной вкладки' };
    if (!/facebook\.com\/ads\/library/i.test(tab.url || '')) {
      return { ok: false, error: 'Откройте страницу facebook.com/ads/library/…' };
    }

    const ctx = parseFiltersFromUrl(tab.url);
    store.meta.source_url = ctx.source_url;
    store.meta.page_id = ctx.page_id || store.meta.page_id;
    store.meta.filters = ctx.filters;

    // пинг content-script; если не отвечает — перезагрузка вкладки
    let alive = false;
    try {
      const r = await ExtApi.tabs.sendMessage(tab.id, { type: 'PING' });
      alive = !!(r && r.alive);
    } catch (_) { alive = false; }

    if (!alive) {
      try { await ExtApi.tabs.reload(tab.id); } catch (_) { /* игнор */ }
      await waitForTabComplete(tab.id, 15000);
      await sleep(1500);
    }

    store.running = true;
    store.status = 'running';
    store.startedAt = Date.now();
    try {
      await ExtApi.tabs.sendMessage(tab.id, { type: 'START', config: config || {} });
    } catch (e) {
      store.running = false;
      store.status = 'idle';
      return { ok: false, error: 'content-script не отвечает (обновите вкладку)' };
    }
    return { ok: true };
  }

  async function handleStop() {
    store.running = false;
    store.status = 'stopped';
    try {
      const tabs = await ExtApi.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0]) await ExtApi.tabs.sendMessage(tabs[0].id, { type: 'STOP' });
    } catch (_) { /* игнор */ }
    return { ok: true };
  }

  function getState() {
    const ads = datasetAds();
    return {
      running: store.running,
      status: store.status,
      statusExtra: store.lastStatusExtra,
      collected: store.order.length,
      hasData: store.order.length > 0,
      page: { id: store.meta.page_id, name: store.meta.page_name },
      summary: ads.length ? Analytics.computeSummary(ads, { id: store.meta.page_id, name: store.meta.page_name }) : null
    };
  }

  // --- маршрутизация сообщений ---

  ExtApi.onMessage(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'ADS':
        (msg.ads || []).forEach(mergeAd);
        schedulePersist();
        return; // ответ не нужен

      case 'STATUS':
        store.status = msg.status || store.status;
        store.lastStatusExtra = msg.extra || null;
        if (msg.status === 'finished' || msg.status === 'stopped') store.running = false;
        return;

      case 'DONE':
        store.running = false;
        store.status = 'finished';
        store.lastStatusExtra = { reason: msg.reason };
        persist();
        return;

      case 'START':
        handleStart(msg.config)
          .then((r) => sendResponse(r))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case 'STOP':
        handleStop().then((r) => sendResponse(r));
        return true;

      case 'GET_STATE':
        sendResponse(getState());
        return true;

      case 'GET_DATASET':
        sendResponse(buildDataset());
        return true;

      case 'CLEAR':
        store.adsById = {};
        store.order = [];
        store.status = 'idle';
        store.lastStatusExtra = null;
        persist();
        sendResponse({ ok: true });
        return true;
    }
  });

  // --- инициализация ---

  (async function init() {
    try {
      const r = await ExtApi.storageGet('fbals_dataset');
      const ds = r && r.fbals_dataset;
      if (ds && Array.isArray(ds.ads)) {
        for (const ad of ds.ads) {
          if (!ad.ad_archive_id) continue;
          if (store.adsById[ad.ad_archive_id]) {
            // запись уже прилетела до загрузки — «живые» данные приоритетнее
            store.adsById[ad.ad_archive_id] = mergeFields(ad, store.adsById[ad.ad_archive_id]);
          } else {
            store.adsById[ad.ad_archive_id] = ad;
            store.order.push(ad.ad_archive_id);
          }
        }
        if (ds.meta) {
          store.meta.page_id = store.meta.page_id || ds.meta.page_id || '';
          store.meta.page_name = store.meta.page_name || ds.meta.page_name || '';
          store.meta.source_url = store.meta.source_url || ds.meta.source_url || '';
          if (!Object.keys(store.meta.filters || {}).length) store.meta.filters = ds.meta.filters || {};
        }
      }
    } catch (_) { /* нет сохранённого датасета */ }

    initialized = true;
    if (pendingPersist) { pendingPersist = false; persist(); }

    // Safari: зарегистрировать MAIN-world перехватчик (на Chrome — no-op).
    try { await ExtApi.registerMainWorld(); } catch (_) { /* игнор */ }
  })();
})();
