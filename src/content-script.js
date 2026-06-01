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

  // --- глушим автоплей видео FB (грело CPU/память: десятки видео играли разом) ---
  // Нам видео НЕ нужно проигрывать — URL берём напрямую. Поэтому ставим все
  // <video> на паузу, мьютим и убираем autoplay — постоянно, пока идёт сбор.
  let videoKiller = null;
  function muteAllVideos() {
    const vids = document.querySelectorAll('video');
    for (const v of vids) {
      try {
        v.muted = true;
        v.autoplay = false;
        v.removeAttribute('autoplay');
        v.preload = 'none';
        if (!v.paused) v.pause();
      } catch (_) { /* */ }
    }
  }
  function startVideoKiller() {
    if (videoKiller) return;
    muteAllVideos();
    // на всякий — глушим и при попытке проиграть (FB заводит их заново)
    document.addEventListener('play', onPlayCapture, true);
    videoKiller = setInterval(muteAllVideos, 1000);
  }
  function stopVideoKiller() {
    if (videoKiller) { clearInterval(videoKiller); videoKiller = null; }
    document.removeEventListener('play', onPlayCapture, true);
  }
  function onPlayCapture(e) {
    const v = e.target;
    if (v && v.tagName === 'VIDEO') {
      try { v.muted = true; v.pause(); } catch (_) { /* */ }
    }
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

  // Восстановление после перезагрузки вкладки (FB убивает её по памяти).
  // Тянем ранее собранное из фона и продолжаем, а не начинаем с нуля.
  async function rehydrate() {
    let restored = 0, euAlready = 0;
    try {
      const ds = await ExtApi.sendMessage({ type: 'GET_DATASET' });
      if (ds && Array.isArray(ds.ads)) {
        for (const ad of ds.ads) {
          if (!ad.ad_archive_id) continue;
          if (!state.adsById[ad.ad_archive_id]) {
            state.adsById[ad.ad_archive_id] = ad;
            state.order.push(ad.ad_archive_id);
          }
          state.seenIds.add(ad.ad_archive_id);
          // если у объявления уже есть данные ЕС — не открываем его повторно
          if (ad.eu_total_reach != null || (ad.eu_reach_breakdown || []).length) {
            state.drilledIds.add(ad.ad_archive_id);
            euAlready++;
          }
          restored++;
        }
      }
    } catch (_) { /* фон мог не ответить — стартуем с чистого */ }
    return { restored, euAlready };
  }

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
      ads: ads,
      log: state.log.slice()   // полный лог сбора — уедет в архив (log.txt)
    };
  }

  // --- ДИАГНОСТИКА: ловим graphql-ответы с признаками охвата ЕС ---
  // Цель — выяснить, есть ли охват ЕС прямо в graphql (тогда модалки не нужны).
  // В консоли набери  __FBALS_DUMP_EU()  — скачается файл с такими ответами.
  const euDump = [];
  let euDumped = false;
  let euDumpTimer = null;
  const EU_HINT = /(eu_total_reach|reach_estimate|aaa_info|age_country_gender|reached_count|eu_reach|total_reach|demographic_distribution|delivery_by_region|reach_by_)/i;
  function captureEuPayload(text) {
    if (euDumped || !text || !EU_HINT.test(text)) return;
    if (euDump.length >= 8) return;
    euDump.push(text);
    try { console.log('%c[FBALS] поймал graphql с признаком ЕС (#' + euDump.length + '). Файл скачается автоматически через 2с…', 'color:#2e7d32;font-weight:bold'); } catch (_) {}
    // авто-выгрузка: консоль работает в другом мире, поэтому качаем сами.
    if (euDumpTimer) clearTimeout(euDumpTimer);
    euDumpTimer = setTimeout(dumpEu, 2000);
  }
  function dumpEu() {
    if (euDumped || !euDump.length) return;
    euDumped = true;
    try {
      const blob = new Blob([euDump.join('\n\n=====FBALS_SPLIT=====\n\n')], { type: 'text/plain' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'fbals-eu-graphql.txt'; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      console.log('%c[FBALS] выгружено ' + euDump.length + ' ответов → fbals-eu-graphql.txt (в Downloads)', 'color:#2e7d32;font-weight:bold');
    } catch (e) { try { console.log('[FBALS] не смог выгрузить:', e); } catch (_) {} }
  }

  // --- приём graphql из MAIN-world ---
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'FBALS_INTERCEPT') return;
    captureEuPayload(d.payload); // диагностический дамп (оставляем)
    captureEu(d.payload);        // боевой разбор ЕС из graphql (всегда)
    if (!state.running) {
      state.buffer.push(d.payload);
      if (state.buffer.length > 80) state.buffer.shift();
      return;
    }
    ingestGraphql(d.payload, d.url);
  });

  // Перехваченные данные ЕС из graphql (ad_details). Ключ — ad_archive_id, либо
  // '_last' для самого свежего (id в ответе бывает не рядом — берём по контексту
  // последнего открытого объявления).
  const euByAd = {};
  let euLast = null;
  function captureEu(text) {
    if (!Parser || !Parser.hasEuPayload || !Parser.hasEuPayload(text)) return;
    let eu = null;
    try { eu = Parser.parseEuPayload(text); } catch (_) { eu = null; }
    if (!eu) return;
    euLast = eu;
    if (eu.ad_archive_id) euByAd[eu.ad_archive_id] = eu;
  }

  function ingestGraphql(text, url) {
    if (!Parser) return;
    captureEu(text); // данные ЕС приходят тем же каналом
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
    DrillIn.configure({ perMin: 30, minInterval: 900 });
    (async function loop() {
      while (state.running && state.drillQueue.length) {
        const item = state.drillQueue.shift();
        const ad = item.ad;
        const id = ad.ad_archive_id;
        state.drillDone++;

        // Открываем карточку ТОЛЬКО чтобы спровоцировать graphql-запрос ad_details.
        // Данные ЕС берём из перехваченного ответа (чистый JSON), а НЕ из DOM —
        // модалку сразу закрываем, таблица на 100-260 строк не рендерится → нет утечки.
        euLast = null;
        let eu = null;
        try {
          await DrillIn.triggerAdDetails(item.el);   // клик + быстрый close
          // ждём, пока перехватчик принесёт ЕС-ответ (до ~6с)
          for (let i = 0; i < 20; i++) {
            await sleep(300);
            if (euByAd[id]) { eu = euByAd[id]; break; }
            if (euLast) { eu = euLast; break; } // id в ответе бывает не рядом — берём свежий
          }
        } catch (e) { /* */ }

        if (eu && (eu.eu_total_reach != null || eu.eu_reach_breakdown.length)) {
          mergeAd(Object.assign({}, ad, {
            eu_total_reach: (eu.eu_total_reach != null) ? eu.eu_total_reach : ad.eu_total_reach,
            eu_reach_breakdown: eu.eu_reach_breakdown.length ? eu.eu_reach_breakdown : ad.eu_reach_breakdown,
            uk_total_reach: (eu.uk_total_reach != null) ? eu.uk_total_reach : ad.uk_total_reach,
            targeting_age: eu.targeting_age || ad.targeting_age,
            targeting_gender: eu.targeting_gender || ad.targeting_gender,
            targeting_locations: eu.targeting_locations || ad.targeting_locations,
            payer: eu.payer || ad.payer,
            beneficiary: eu.beneficiary || ad.beneficiary,
            source: 'merged'
          }));
          sendToSW({ type: 'ADS', ads: [state.adsById[id]] });
          log('✓ ЕС ' + id + ': reach ' + eu.eu_total_reach + ' (' + eu.eu_reach_breakdown.length + ' стр.) — ' + state.drillDone + '/' + state.drillTotal, 'ok');
        } else {
          state.drillFails++;
          log('✗ ЕС ' + id + ': graphql не принёс охват (нет ЕС у объявления?) — ' + state.drillDone + '/' + state.drillTotal, 'warn');
        }
        setStatus(state.status === 'finishing' ? 'finishing' : 'running',
          { message: 'данные ЕС ' + state.drillDone + '/' + state.drillTotal });
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
    startVideoKiller();

    // восстановление после перезагрузки/повторного запуска
    const rh = await rehydrate();
    if (rh.restored) log('продолжаю: восстановлено ' + rh.restored + ' объявл. (ЕС уже есть у ' + rh.euAlready + ')', 'ok');

    log('старт сбора' + (state.config.drillEu ? ' + данные ЕС' : '') + ' · видео заглушены', 'ok');

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

      // Полный текст уже взят из карточки (pre-wrap). Модалку открываем ТОЛЬКО
      // ради данных ЕС — поэтому drill ставим в очередь лишь при drillEu.
      if (state.config.drillEu) enqueueDrill(found);

      setStatus('running', { message: 'сбор… ' + state.order.length + ' объявл.' });
      if (fresh > 0) {
        log('проход ' + state.round + ': +' + fresh + ' (всего ' + state.order.length + ', на экране ' + found.length + ')');
        state.idle = 0;
      } else {
        state.idle++;
        log('проход ' + state.round + ': новых нет (' + state.idle + '/' + state.config.idleRounds + ')', 'dim');
      }

      // При сборе ЕС нельзя укатываться вперёд: иначе карточки в очереди деталей
      // открепятся (виртуальный скролл) и клик не пройдёт. Ждём, пока очередь
      // рассосётся до небольшого хвоста.
      if (state.config.drillEu) {
        let guard = 0;
        while (state.running && state.drillQueue.length > 4 && guard < 60) {
          setStatus('running', { message: 'детали ЕС ' + state.drillDone + '/' + state.drillTotal + ' (жду очередь)' });
          await sleep(1000);
          guard++;
        }
      }

      if (state.idle >= state.config.idleRounds) break;

      // Скроллим МЯГКО (0.6 экрана): при виртуальном скролле слишком большой шаг
      // успевает открепить карточки до того, как мы их снимем — отсюда недобор
      // (52 из 73). Меньший шаг + пауза на догрузку держит выдачу под нами.
      const beforeY = window.scrollY;
      window.scrollBy(0, Math.floor(window.innerHeight * 0.6));
      await sleep(rnd(state.config.minDelay, state.config.maxDelay));

      // Если страница не прокрутилась (достигли низа) — даём FB догрузить ещё.
      if (window.scrollY === beforeY) {
        await sleep(1500);
        if (window.scrollY === beforeY) state.idle++; // реально низ — копим к остановке
      }
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
    stopVideoKiller();
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
        if (state.running) { state.running = false; stopVideoKiller(); log('останавливаю по запросу…', 'warn'); }
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
