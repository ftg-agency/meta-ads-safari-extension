/*
 * src/content-script.js — ISOLATED-world, document_start, на страницах Ad Library.
 *
 * Драйвер автоскролла: на каждом шаге снимает DOM (dom-scraper), принимает
 * graphql от interceptor (через postMessage), при необходимости «проваливается»
 * в карточки (drill-in) и батчами шлёт объявления в service-worker.
 *
 * Workstream C: консервативные задержки, бэкофф-и-резюм при детекте лимита
 * вместо немедленной остановки.
 *
 * Все вызовы расширения — только через ExtApi (загружен раньше в этом же бандле).
 */
(function () {
  'use strict';

  const ExtApi = self.ExtApi;
  const Parser = self.FBALS_Parser;
  const Dom = self.FBALS_DomScraper;
  const DrillIn = self.FBALS_DrillIn;

  // Значения по умолчанию (Workstream C — осторожные).
  const DEFAULTS = {
    maxAds: 1000,
    minDelay: 2500,
    maxDelay: 5000,
    idleRounds: 5,
    manualScroll: false,
    drillIn: false,
    drillEu: false
  };

  // Эскалация пауз при блокировке: 30с → 2м → 5м.
  const BACKOFFS = [30000, 120000, 300000];

  const state = {
    running: false,
    config: Object.assign({}, DEFAULTS),
    seenIds: new Set(),
    drilledIds: new Set(),
    buffer: [],        // graphql, пришедший до START
    collected: 0,
    idle: 0,
    blockedFlag: false,
    retries: 0,
    status: 'idle'
  };

  function rnd(min, max) { return Math.floor(min + Math.random() * (max - min)); }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function sendToSW(msg) {
    try { ExtApi.sendMessage(msg).catch(function () {}); } catch (_) { /* SW спит — игнор */ }
  }

  function setStatus(status, extra) {
    state.status = status;
    sendToSW({ type: 'STATUS', status: status, collected: state.collected, extra: extra || null });
  }

  // --- приём graphql из MAIN-world ---
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'FBALS_INTERCEPT') return;
    if (!state.running) {
      state.buffer.push(d.payload);
      if (state.buffer.length > 60) state.buffer.shift();
      return;
    }
    ingestGraphql(d.payload, d.url);
  });

  function ingestGraphql(text, url) {
    if (!Parser) return;
    let ads = [];
    try { ads = Parser.parsePayload(text, url); } catch (_) { ads = []; }
    pushAds(ads);
  }

  function pushAds(ads) {
    const fresh = [];
    for (const ad of ads) {
      if (!ad.ad_archive_id) continue;
      if (state.seenIds.has(ad.ad_archive_id)) continue; // дедуп по ad_archive_id
      state.seenIds.add(ad.ad_archive_id);
      fresh.push(ad);
    }
    if (fresh.length) {
      state.collected += fresh.length;
      sendToSW({ type: 'ADS', ads: fresh });
    }
    return fresh.length;
  }

  // --- детект блокировки / чекпоинта ---
  function isCheckpoint() {
    if (location.pathname.indexOf('/checkpoint') !== -1) return true;
    const t = document.body ? document.body.innerText.slice(0, 3000) : '';
    return /(Temporarily Blocked|временно заблокир|подтвердите, что вы|confirm your identity|unusual activity|необычн\w+ активн|too many requests|слишком много запросов)/i.test(t);
  }

  // Бэкофф-и-резюм: пауза с эскалацией, периодическая проверка снятия блока.
  async function handleBlock() {
    state.blockedFlag = true;
    while (state.retries < BACKOFFS.length) {
      const wait = BACKOFFS[state.retries];
      state.retries++;
      let left = wait;
      while (left > 0 && state.running) {
        setStatus('paused', {
          reason: 'limit',
          attempt: state.retries,
          resumeInMs: left,
          message: 'пауза (лимит), повтор через ' + Math.ceil(left / 1000) + 'с'
        });
        await sleep(Math.min(5000, left));
        left -= 5000;
      }
      if (!state.running) return false;
      if (!isCheckpoint()) {
        state.blockedFlag = false;
        setStatus('running');
        return true; // блок снят — продолжаем
      }
    }
    return false; // попытки исчерпаны
  }

  // --- drill-in для новых карточек ---
  async function drillNewCards(found) {
    if (!DrillIn) return;
    DrillIn.configure({
      perMin: state.config.drillPerMin || 20,
      minInterval: state.config.drillMinInterval || 1500
    });
    for (const item of found) {
      if (!state.running) break;
      const ad = item.ad;
      if (state.drilledIds.has(ad.ad_archive_id)) continue;
      state.drilledIds.add(ad.ad_archive_id);
      let enrich = null;
      try { enrich = await DrillIn.openAdDetails(item.el, { eu: state.config.drillEu }); } catch (_) { enrich = null; }
      if (enrich) {
        const upd = Object.assign({}, ad, {
          body_text: enrich.body_text || ad.body_text,
          eu_total_reach: (enrich.eu_total_reach !== null && enrich.eu_total_reach !== undefined) ? enrich.eu_total_reach : ad.eu_total_reach,
          eu_reach_breakdown: (enrich.eu_reach_breakdown && enrich.eu_reach_breakdown.length) ? enrich.eu_reach_breakdown : ad.eu_reach_breakdown,
          source: 'merged'
        });
        sendToSW({ type: 'ADS', ads: [upd] }); // SW обновит запись по id
      }
    }
  }

  // --- основной цикл ---
  async function runLoop() {
    state.running = true;
    state.idle = 0;
    state.retries = 0;
    setStatus('running');

    // прогоняем graphql, накопленный до старта
    const buffered = state.buffer.splice(0);
    for (const p of buffered) ingestGraphql(p, '');

    while (state.running) {
      if (state.collected >= state.config.maxAds) return finish('done');

      if (isCheckpoint()) {
        const ok = await handleBlock();
        if (!ok) return finish('blocked');
      }

      const before = state.seenIds.size;
      const found = Dom ? Dom.findCards(document) : [];
      const newCount = pushAds(found.map(function (f) { return f.ad; }));

      if (state.config.drillIn) await drillNewCards(found);

      if (state.seenIds.size === before && newCount === 0) state.idle++;
      else state.idle = 0;
      if (state.idle >= state.config.idleRounds) return finish('done');

      if (!state.config.manualScroll) {
        window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
      }

      await sleep(rnd(state.config.minDelay, state.config.maxDelay));
    }
    return finish('stopped');
  }

  function finish(reason) {
    state.running = false;
    setStatus('finished', { reason: reason });
    sendToSW({ type: 'DONE', reason: reason, collected: state.collected });
  }

  // --- сообщения от SW / popup ---
  ExtApi.onMessage(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === 'PING') {
      sendResponse && sendResponse({ alive: true, running: state.running, status: state.status, collected: state.collected });
      return true;
    }
    if (msg.type === 'START') {
      state.config = Object.assign({}, DEFAULTS, msg.config || {});
      if (!state.running) runLoop();
      sendResponse && sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'STOP') {
      state.running = false;
      sendResponse && sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'STATUS_REQ') {
      sendResponse && sendResponse({ status: state.status, collected: state.collected, running: state.running });
      return true;
    }
  });
})();
