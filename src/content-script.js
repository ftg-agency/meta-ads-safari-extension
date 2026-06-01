/*
 * src/content-script.js — ISOLATED-world, document_start, на страницах Ad Library.
 *
 * Это «мозг» расширения и ЕДИНЫЙ источник правды во время сбора: пока вкладка
 * открыта, скрипт всегда жив (в отличие от фонового процесса, который Safari
 * усыпляет). Здесь же хранится весь датасет, счётчик и лог — popup читает их
 * НАПРЯМУЮ отсюда (tabs.sendMessage), а не у спящего фона.
 *
 * Делает: автоскролл, съём DOM (dom-scraper), приём graphql от interceptor
 * (postMessage), фоновый drill-in за полным текстом, дедуп/слияние по
 * ad_archive_id, сводка (analytics). В фон (SW) данные шлёт лишь для
 * персистентности между сессиями — best-effort, не критично.
 */
(function () {
  'use strict';

  const ExtApi = self.ExtApi;
  const Parser = self.FBALS_Parser;
  const Dom = self.FBALS_DomScraper;
  const DrillIn = self.FBALS_DrillIn;
  const Analytics = self.FBALS_Analytics;

  const DEFAULTS = {
    maxAds: 100000,
    minDelay: 2500,
    maxDelay: 5000,
    idleRounds: 5,
    drillIn: true,
    drillEu: false
  };

  // Эскалация пауз при блокировке: 30с → 2м → 5м.
  const BACKOFFS = [30000, 120000, 300000];
  const LOG_MAX = 250;

  const state = {
    running: false,
    config: Object.assign({}, DEFAULTS),
    // данные
    adsById: {},
    order: [],
    seenIds: new Set(),
    // drill-in
    drilledIds: new Set(),
    drillQueue: [],
    drillBusy: false,
    drillDone: 0,
    drillTotal: 0,
    drillFails: 0,
    // прочее
    buffer: [],
    idle: 0,
    round: 0,
    retries: 0,
    status: 'idle',
    statusExtra: null,
    log: []
  };

  function rnd(min, max) { return Math.floor(min + Math.random() * (max - min)); }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function sendToSW(msg) {
    try { ExtApi.sendMessage(msg).catch(function () {}); } catch (_) { /* SW спит — ок */ }
  }

  // --- лог: в консоль страницы И в локальный буфер (его читает popup) ---
  function log(text, level) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ts = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    const entry = { t: ts + '  ' + text, level: level || null };
    state.log.push(entry);
    if (state.log.length > LOG_MAX) state.log.shift();
    try {
      const tag = '%c[FBALS]%c ' + text;
      const color = level === 'err' ? '#c62828' : level === 'warn' ? '#b26a00' : level === 'ok' ? '#2e7d32' : '#1877f2';
      console.log(tag, 'color:' + color + ';font-weight:bold', 'color:inherit');
    } catch (_) { /* нет консоли */ }
    sendToSW({ type: 'LOG', text: text, level: level || null });
  }

  function setStatus(status, extra) {
    state.status = status;
    state.statusExtra = extra || null;
    sendToSW({ type: 'STATUS', status: status, collected: state.order.length, extra: extra || null });
  }

  // --- meta из URL ---
  function readMeta() {
    const out = { page_id: '', page_name: '', source_url: location.href, filters: {} };
    try {
      const qp = new URL(location.href).searchParams;
      out.page_id = qp.get('view_all_page_id') || '';
      out.filters = {
        q: qp.get('q') || '',
        country: qp.get('country') || '',
        active_status: qp.get('active_status') || '',
        ad_type: qp.get('ad_type') || '',
        media_type: qp.get('media_type') || ''
      };
    } catch (_) { /* кривой URL */ }
    return out;
  }

  // --- слияние / дедуп (как в SW, но локально) ---
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
    if (!id) return false;
    let isNew = false;
    if (state.adsById[id]) {
      state.adsById[id] = mergeFields(state.adsById[id], ad);
    } else {
      state.adsById[id] = ad;
      state.order.push(id);
      isNew = true;
    }
    return isNew;
  }

  function datasetAds() { return state.order.map((id) => state.adsById[id]); }

  function buildDataset() {
    const ads = datasetAds();
    const meta = readMeta();
    let version = '1.0.0';
    try { version = ExtApi.getManifest().version; } catch (_) { /* вне расширения */ }
    let summary = null;
    try { summary = Analytics ? Analytics.computeSummary(ads, { id: meta.page_id, name: meta.page_name }) : null; } catch (_) { summary = null; }
    return {
      meta: {
        generated_at: new Date().toISOString(),
        source_url: meta.source_url,
        page_id: meta.page_id,
        page_name: meta.page_name,
        filters: meta.filters,
        count: ads.length,
        version: version
      },
      summary: summary,
      ads: ads
    };
  }

  // --- приём graphql из MAIN-world ---
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'FBALS_INTERCEPT') return;
    if (!state.running) {
      state.buffer.push(d.payload);
      if (state.buffer.length > 80) state.buffer.shift();
      return;
    }
    ingestGraphql(d.payload, d.url);
  });

  function ingestGraphql(text, url) {
    if (!Parser) return;
    let ads = [];
    try { ads = Parser.parsePayload(text, url); } catch (_) { ads = []; }
    const n = pushAds(ads, 'graphql');
    if (n > 0) log('graphql: +' + n + ' (всего ' + state.order.length + ')');
  }

  function pushAds(ads, src) {
    let fresh = 0;
    const forSW = [];
    for (const ad of ads) {
      if (!ad.ad_archive_id) continue;
      const isNew = mergeAd(ad);
      forSW.push(ad);
      if (isNew && !state.seenIds.has(ad.ad_archive_id)) {
        state.seenIds.add(ad.ad_archive_id);
        fresh++;
      }
    }
    if (forSW.length) sendToSW({ type: 'ADS', ads: forSW }); // персистентность, best-effort
    return fresh;
  }

  // --- детект блокировки ---
  function isCheckpoint() {
    if (location.pathname.indexOf('/checkpoint') !== -1) return true;
    const t = document.body ? document.body.innerText.slice(0, 3000) : '';
    return /(Temporarily Blocked|временно заблокир|подтвердите, что вы|confirm your identity|unusual activity|необычн\w+ активн|too many requests|слишком много запросов)/i.test(t);
  }

  async function handleBlock() {
    while (state.retries < BACKOFFS.length) {
      const wait = BACKOFFS[state.retries];
      state.retries++;
      let left = wait;
      while (left > 0 && state.running) {
        setStatus('paused', { message: 'пауза (лимит), повтор через ' + Math.ceil(left / 1000) + 'с' });
        await sleep(Math.min(5000, left));
        left -= 5000;
      }
      if (!state.running) return false;
      if (!isCheckpoint()) { setStatus('running'); return true; }
    }
    return false;
  }

  // --- drill-in: ФОНОВО ---
  function enqueueDrill(found) {
    if (!DrillIn) return;
    for (const item of found) {
      const id = item.ad.ad_archive_id;
      if (state.drilledIds.has(id)) continue;
      state.drilledIds.add(id);
      state.drillQueue.push(item);
      state.drillTotal++;
    }
    startDrillWorker();
  }

  function startDrillWorker() {
    if (state.drillBusy) return;
    state.drillBusy = true;
    DrillIn.configure({ perMin: 20, minInterval: 1500 });
    (async function loop() {
      while (state.running && state.drillQueue.length) {
        const item = state.drillQueue.shift();
        const ad = item.ad;
        let enrich = null;
        try { enrich = await DrillIn.openAdDetails(item.el, { eu: state.config.drillEu }); } catch (e) { enrich = { _err: String((e && e.message) || e) }; }
        state.drillDone++;
        if (enrich && !enrich._err && (enrich.body_text || enrich.eu_total_reach != null)) {
          mergeAd(Object.assign({}, ad, {
            body_text: (enrich.body_text && enrich.body_text.length > (ad.body_text || '').length) ? enrich.body_text : ad.body_text,
            eu_total_reach: (enrich.eu_total_reach != null) ? enrich.eu_total_reach : ad.eu_total_reach,
            eu_reach_breakdown: (enrich.eu_reach_breakdown && enrich.eu_reach_breakdown.length) ? enrich.eu_reach_breakdown : ad.eu_reach_breakdown,
            targeting_age: enrich.targeting_age || ad.targeting_age,
            targeting_gender: enrich.targeting_gender || ad.targeting_gender,
            targeting_locations: enrich.targeting_locations || ad.targeting_locations,
            source: 'merged'
          }));
          sendToSW({ type: 'ADS', ads: [state.adsById[ad.ad_archive_id]] });
          const chars = (enrich.body_text || '').length;
          log('✓ детали ' + ad.ad_archive_id + ' (' + chars + ' симв.' + (enrich.eu_total_reach != null ? (', ЕС ' + enrich.eu_total_reach) : '') + ') — ' + state.drillDone + '/' + state.drillTotal);
        } else {
          state.drillFails++;
          log('✗ детали ' + ad.ad_archive_id + ': ' + ((enrich && enrich._err) || 'не нашёл данных') + ' — ' + state.drillDone + '/' + state.drillTotal, 'warn');
        }
        if (state.status === 'finishing') {
          setStatus('finishing', { message: 'догружаю тексты ' + state.drillDone + '/' + state.drillTotal });
        }
      }
      state.drillBusy = false;
    })();
  }

  // --- основной цикл ---
  async function runLoop() {
    state.running = true;
    state.idle = 0;
    state.round = 0;
    state.retries = 0;
    setStatus('running');

    const onLib = /\/ads\/library/i.test(location.href);
    if (!onLib) log('Внимание: это не похоже на страницу Ad Library. Открой facebook.com/ads/library/…', 'warn');
    log('старт сбора' + (state.config.drillIn ? ' + полный текст из карточек' + (state.config.drillEu ? ' + ЕС' : '') : ''), 'ok');

    const buffered = state.buffer.splice(0);
    if (buffered.length) {
      log('разбираю ' + buffered.length + ' перехваченных ответов graphql…', 'dim');
      for (const p of buffered) ingestGraphql(p, '');
    }

    while (state.running) {
      if (state.config.maxAds && state.order.length >= state.config.maxAds) {
        log('достигнут лимит ' + state.config.maxAds, 'ok');
        break;
      }
      if (isCheckpoint()) {
        log('Facebook показывает лимит/проверку — встаю на паузу', 'warn');
        const ok = await handleBlock();
        if (!ok) { log('блокировка не снялась — останавливаюсь', 'err'); return finish('blocked'); }
        log('блок снят — продолжаю', 'ok');
      }

      state.round++;
      const found = Dom ? Dom.findCards(document) : [];
      const fresh = pushAds(found.map((f) => f.ad), 'dom');
      if (state.config.drillIn) enqueueDrill(found);

      setStatus('running', { message: 'сбор… ' + state.order.length + ' объявл.' });
      if (fresh > 0) {
        log('проход ' + state.round + ': +' + fresh + ' (всего ' + state.order.length + ', на экране ' + found.length + ')');
        state.idle = 0;
      } else {
        state.idle++;
        log('проход ' + state.round + ': новых нет (' + state.idle + '/' + state.config.idleRounds + ')', 'dim');
      }

      if (state.idle >= state.config.idleRounds) break;

      window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
      await sleep(rnd(state.config.minDelay, state.config.maxDelay));
    }

    // конец скролла — дожидаемся хвоста фоновых деталей
    if (state.running && (state.drillQueue.length || state.drillBusy)) {
      log('Сбор завершён (' + state.order.length + '). Догружаю полные тексты: осталось ' + state.drillQueue.length + '…', 'ok');
      setStatus('finishing', { message: 'догружаю тексты ' + state.drillDone + '/' + state.drillTotal });
      while (state.running && (state.drillQueue.length || state.drillBusy)) await sleep(800);
    }
    return finish(state.running ? 'done' : 'stopped');
  }

  function finish(reason) {
    const was = state.running;
    state.running = false;
    state.drillQueue = [];
    setStatus('finished', { reason: reason });
    sendToSW({ type: 'DONE', reason: reason, collected: state.order.length });
    const tail = state.drillTotal ? (' · детали: ' + (state.drillDone - state.drillFails) + ' ок, ' + state.drillFails + ' без данных') : '';
    log('ГОТОВО: собрано ' + state.order.length + ' объявлений' + tail + (reason === 'stopped' ? ' (остановлено вручную)' : ''), 'ok');
    return was;
  }

  function liveState() {
    return {
      running: state.running,
      status: state.status,
      statusExtra: state.statusExtra,
      collected: state.order.length,
      hasData: state.order.length > 0,
      drill: { done: state.drillDone, total: state.drillTotal, fails: state.drillFails },
      log: state.log
    };
  }

  // --- сообщения от popup ---
  ExtApi.onMessage(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'PING':
        sendResponse && sendResponse({ alive: true });
        return true;
      case 'GET_LIVE_STATE':
        sendResponse && sendResponse(liveState());
        return true;
      case 'GET_LIVE_DATASET':
        sendResponse && sendResponse(buildDataset());
        return true;
      case 'START':
        state.config = Object.assign({}, DEFAULTS, msg.config || {});
        if (!state.running) runLoop();
        sendResponse && sendResponse({ ok: true });
        return true;
      case 'STOP':
        if (state.running) { state.running = false; log('останавливаю по запросу…', 'warn'); }
        sendResponse && sendResponse({ ok: true });
        return true;
      case 'CLEAR':
        state.adsById = {}; state.order = []; state.seenIds = new Set();
        state.drilledIds = new Set(); state.drillQueue = [];
        state.drillDone = 0; state.drillTotal = 0; state.drillFails = 0;
        state.log = []; state.status = 'idle'; state.statusExtra = null;
        sendResponse && sendResponse({ ok: true });
        return true;
    }
  });

  log('расширение подключено к странице', 'dim');
})();
