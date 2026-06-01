/*
 * src/popup.js — UI «полный авто». ИСТОЧНИК ПРАВДЫ — скрипт на странице
 * (content-script), а не фоновый процесс: Safari усыпляет фон, поэтому статус,
 * счётчик и лог popup читает напрямую у активной вкладки (tabs.sendMessage).
 */
(function () {
  'use strict';

  const ExtApi = self.ExtApi;
  const Exp = self.FBALS_Exporter;
  const $ = (id) => document.getElementById(id);

  let running = false;
  let lastLogLen = -1;
  let busyExport = false;
  let activeTabId = null;

  function readConfig() {
    const maxAds = parseInt($('maxAds').value, 10);
    const eu = $('deepEu').checked;
    return {
      maxAds: (isNaN(maxAds) || maxAds <= 0) ? 100000 : maxAds,
      drillIn: eu,   // модалку открываем только ради ЕС; текст и так берём из ленты
      drillEu: eu
    };
  }

  const STATUS_TEXT = {
    idle: 'Готов', running: 'Сбор…', paused: 'Пауза',
    finishing: 'Догружаю тексты…', finished: 'Готово', stopped: 'Остановлено'
  };
  function statusText(st) {
    if (st.statusExtra && st.statusExtra.message) return st.statusExtra.message;
    return STATUS_TEXT[st.status] || st.status || 'Готов';
  }

  function renderLog(lines) {
    if (!lines) return;
    if (lines.length === lastLogLen) return;
    lastLogLen = lines.length;
    const box = $('log');
    if (!lines.length) { box.innerHTML = '<div class="l-dim">нажми «Собрать объявления»…</div>'; return; }
    box.innerHTML = lines.map((e) => {
      const cls = e.level ? (' class="l-' + e.level + '"') : '';
      const t = String(e.t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return '<div' + cls + '>' + t + '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  function applyState(st) {
    running = !!st.running;
    $('status').textContent = statusText(st);
    $('count').textContent = st.collected || 0;
    $('btnRun').textContent = running ? 'Остановить' : 'Собрать объявления';
    $('btnRun').classList.toggle('danger', running);
    $('btnRun').classList.toggle('primary', !running);
    const has = !!st.hasData;
    if (!busyExport) ['btnArchive', 'btnCSV', 'btnJSON'].forEach((id) => { $(id).disabled = !has; });
    $('btnClear').disabled = !has || running;
    renderLog(st.log);
  }

  // Находит активную вкладку и шлёт ей сообщение. Если content-script не отвечает
  // (не та страница / не внедрён) — вернём null, а не упадём.
  async function askTab(message) {
    try {
      if (activeTabId == null) {
        const tabs = await ExtApi.tabs.query({ active: true, currentWindow: true });
        if (!tabs || !tabs[0]) return null;
        activeTabId = tabs[0].id;
      }
      return await ExtApi.tabs.sendMessage(activeTabId, message);
    } catch (_) {
      activeTabId = null; // вкладка сменилась — переспросим в следующий раз
      return null;
    }
  }

  async function poll() {
    const st = await askTab({ type: 'GET_LIVE_STATE' });
    if (st) {
      applyState(st);
    } else {
      // content-script недоступен на этой вкладке
      $('status').textContent = 'Открой страницу Ad Library';
      $('count').textContent = '0';
      renderLog([{ t: 'Открой facebook.com/ads/library/… и обнови вкладку (⌘R).', level: 'warn' }]);
      $('btnRun').textContent = 'Собрать объявления';
      $('btnRun').classList.remove('danger'); $('btnRun').classList.add('primary');
    }
  }

  async function getDataset() {
    const ds = await askTab({ type: 'GET_LIVE_DATASET' });
    if (ds) return ds;
    // запасной путь — из фонового хранилища
    return ExtApi.sendMessage({ type: 'GET_DATASET' });
  }

  async function toggleRun() {
    if (running) { await askTab({ type: 'STOP' }); poll(); return; }
    const r = await askTab({ type: 'START', config: readConfig() });
    if (r == null) {
      $('status').textContent = 'Нет связи со страницей — открой Ad Library и ⌘R';
    }
    poll();
  }

  async function withBusy(label, fn) {
    busyExport = true;
    ['btnArchive', 'btnCSV', 'btnJSON'].forEach((id) => { $(id).disabled = true; });
    const prev = $('status').textContent;
    try { $('status').textContent = label; await fn(); }
    catch (e) { $('status').textContent = 'Ошибка: ' + ((e && e.message) || e); }
    finally { busyExport = false; $('status').textContent = prev; poll(); }
  }

  function bind() {
    $('btnRun').addEventListener('click', toggleRun);
    $('btnArchive').addEventListener('click', () => withBusy('Сбор архива…', async () => {
      const ds = await getDataset();
      const media = Exp.collectMediaUrls(ds);
      if (media.length === 0) { alert('Нет медиа для архива'); return; }
      if (media.length > 50 && !confirm('Архив включит ' + media.length + ' файлов (картинки + HD-видео). Продолжить?')) return;
      const res = await Exp.exportArchive(ds, {
        onProgress: (p) => { $('status').textContent = 'Архив: ' + p.fetched + '/' + p.total + ' (' + Math.round(p.bytes / 1048576) + ' МБ)'; }
      });
      $('status').textContent = 'Архив готов: ' + res.fetched + ' файлов' + (res.failures.length ? (', ошибок ' + res.failures.length) : '');
    }));
    $('btnCSV').addEventListener('click', () => withBusy('CSV…', async () => { Exp.exportCSV(await getDataset()); }));
    $('btnJSON').addEventListener('click', () => withBusy('JSON…', async () => { Exp.exportJSON(await getDataset()); }));
    $('btnClear').addEventListener('click', async () => {
      if (!confirm('Очистить собранные данные?')) return;
      await askTab({ type: 'CLEAR' });
      await ExtApi.sendMessage({ type: 'CLEAR' }).catch(() => {});
      lastLogLen = -1;
      poll();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    poll();
    setInterval(poll, 600);
  });
})();
