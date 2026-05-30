/*
 * src/popup.js — UI расширения. Опрашивает service-worker раз в 800мс
 * (GET_STATE), запускает/останавливает сбор и выгружает датасет
 * (JSON/CSV/медиа/ZIP). Все вызовы — через ExtApi.
 */
(function () {
  'use strict';

  const ExtApi = self.ExtApi;
  const Exp = self.FBALS_Exporter;
  const $ = (id) => document.getElementById(id);

  let pollTimer = null;

  function readConfig() {
    return {
      maxAds: parseInt($('maxAds').value, 10) || 1000,
      minDelay: parseInt($('minDelay').value, 10) || 2500,
      maxDelay: parseInt($('maxDelay').value, 10) || 5000,
      idleRounds: parseInt($('idleRounds').value, 10) || 5,
      manualScroll: $('manualScroll').checked,
      drillIn: $('drillIn').checked,
      drillEu: $('drillEu').checked
    };
  }

  function statusText(st) {
    if (st.status === 'paused' && st.statusExtra && st.statusExtra.message) {
      return st.statusExtra.message;
    }
    const map = {
      idle: 'Готов',
      running: 'Сбор…',
      paused: 'Пауза',
      finished: 'Готово',
      stopped: 'Остановлено'
    };
    return map[st.status] || st.status || 'Готов';
  }

  function setStatus(text) { $('status').textContent = text; }

  function applyState(st) {
    setStatus(statusText(st));
    $('count').textContent = st.collected || 0;
    $('btnStart').disabled = !!st.running;
    $('btnStop').disabled = !st.running;
    const has = !!st.hasData;
    ['btnJSON', 'btnCSV', 'btnMedia', 'btnArchive'].forEach((id) => { $(id).disabled = !has; });
  }

  async function poll() {
    try {
      const st = await ExtApi.sendMessage({ type: 'GET_STATE' });
      if (st) applyState(st);
    } catch (_) { /* SW просыпается — пропускаем тик */ }
  }

  async function getDataset() {
    return ExtApi.sendMessage({ type: 'GET_DATASET' });
  }

  async function onExportMedia() {
    const ds = await getDataset();
    if ($('downloadMedia').checked) {
      const media = Exp.collectMediaUrls(ds);
      if (media.length === 0) { alert('Нет медиа'); return; }
      if (media.length > 30 && !confirm('Скачать ' + media.length + ' медиафайлов по отдельности?')) return;
      setStatus('Скачивание медиа…');
      const res = await Exp.downloadMediaFiles(ds, {
        onProgress: (p) => setStatus('Медиа ' + p.fetched + '/' + p.total)
      });
      setStatus('Готово: ' + res.fetched + '/' + res.total + (res.failures.length ? (' (ошибок ' + res.failures.length + ')') : ''));
    } else {
      Exp.exportMediaList(ds);
    }
  }

  async function onExportArchive() {
    const ds = await getDataset();
    const media = Exp.collectMediaUrls(ds);
    if (media.length === 0) { alert('Нет медиа для архива'); return; }
    if (media.length > 50 && !confirm('Архив включит ' + media.length + ' файлов (картинки + HD-видео). Продолжить?')) return;
    setStatus('Сбор архива…');
    try {
      const res = await Exp.exportArchive(ds, {
        onProgress: (p) => setStatus('Архив: ' + p.fetched + '/' + p.total + ' (' + Math.round(p.bytes / 1048576) + ' МБ)')
      });
      setStatus('Архив готов: ' + res.fetched + ' файлов' + (res.failures.length ? (', ошибок ' + res.failures.length) : ''));
    } catch (e) {
      setStatus('Ошибка архива: ' + ((e && e.message) || e));
    }
  }

  function bind() {
    $('btnStart').addEventListener('click', async () => {
      setStatus('Запуск…');
      const r = await ExtApi.sendMessage({ type: 'START', config: readConfig() });
      if (r && !r.ok) setStatus('Ошибка: ' + (r.error || 'не удалось'));
    });
    $('btnStop').addEventListener('click', () => ExtApi.sendMessage({ type: 'STOP' }));
    $('btnClear').addEventListener('click', async () => {
      if (!confirm('Очистить собранные данные?')) return;
      await ExtApi.sendMessage({ type: 'CLEAR' });
      poll();
    });
    $('btnJSON').addEventListener('click', async () => { Exp.exportJSON(await getDataset()); });
    $('btnCSV').addEventListener('click', async () => { Exp.exportCSV(await getDataset()); });
    $('btnMedia').addEventListener('click', onExportMedia);
    $('btnArchive').addEventListener('click', onExportArchive);
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    poll();
    pollTimer = setInterval(poll, 800);
  });
})();
