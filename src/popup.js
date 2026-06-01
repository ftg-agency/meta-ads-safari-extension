/*
 * src/popup.js — UI «полный авто». ИСТОЧНИК ПРАВДЫ — скрипт на странице
 * (content-script): Safari усыпляет фон, поэтому статус/счётчик popup читает
 * напрямую у активной вкладки (tabs.sendMessage).
 *
 * UI: одна кнопка сбора, чекбокс ЕС, лимит, прогресс-бар со строкой и кнопка ZIP.
 */
(function () {
  'use strict';

  const ExtApi = self.ExtApi;
  const Exp = self.FBALS_Exporter;
  const $ = (id) => document.getElementById(id);

  let running = false;
  let busyExport = false;
  let activeTabId = null;

  function readConfig() {
    const maxAds = parseInt($('maxAds').value, 10);
    const eu = $('deepEu').checked;
    return {
      maxAds: (isNaN(maxAds) || maxAds <= 0) ? 100000 : maxAds,
      drillIn: eu,
      drillEu: eu
    };
  }

  // Полоса прогресса: при ЕС-проходе — доля done/total; при обычном сборе —
  // неопределённый «бегущий» режим (.indet); в покое/готово — заливка по факту.
  function setProgress(mode, frac) {
    const wrap = $('progressWrap');
    const bar = $('progressBar');
    wrap.classList.toggle('indet', mode === 'indet');
    if (mode === 'frac') {
      bar.style.width = Math.max(0, Math.min(100, Math.round(frac * 100))) + '%';
    } else if (mode === 'full') {
      bar.style.width = '100%';
    } else if (mode === 'empty') {
      bar.style.width = '0%';
    }
    // в indet ширину задаёт CSS-анимация
    if (mode === 'indet') bar.style.width = '';
  }

  function progressText(st) {
    // приоритет — явное сообщение от content-script
    if (st.statusExtra && st.statusExtra.message) return st.statusExtra.message;
    switch (st.status) {
      case 'running': return 'Собрано ' + (st.collected || 0);
      case 'finishing': return 'Завершаю…';
      case 'paused': return 'Пауза (лимит)';
      case 'finished': return 'Готово: ' + (st.collected || 0) + ' объявлений';
      case 'stopped': return 'Остановлено: ' + (st.collected || 0);
      default: return 'Готов к сбору';
    }
  }

  function applyState(st) {
    running = !!st.running;
    $('count').textContent = st.collected || 0;
    $('status').textContent = running ? 'Сбор…' : (st.status === 'finished' ? 'Готово' : 'Готов');

    $('btnRun').textContent = running ? 'Остановить' : 'Собрать объявления';
    $('btnRun').classList.toggle('danger', running);
    $('btnRun').classList.toggle('primary', !running);

    if (!busyExport) $('progressText').textContent = progressText(st);

    // полоса
    const drill = st.drill || {};
    if (busyExport) {
      /* во время экспорта прогресс ведёт withBusy */
    } else if (running && drill.total > 0) {
      setProgress('frac', drill.done / drill.total);   // ЕС-проход: точная доля
    } else if (running) {
      setProgress('indet');                            // обычный сбор: бегущая
    } else if (st.status === 'finished') {
      setProgress('full');
    } else {
      setProgress('empty');
    }

    if (!busyExport) $('btnArchive').disabled = !st.hasData;
  }

  async function askTab(message) {
    try {
      if (activeTabId == null) {
        const tabs = await ExtApi.tabs.query({ active: true, currentWindow: true });
        if (!tabs || !tabs[0]) return null;
        activeTabId = tabs[0].id;
      }
      return await ExtApi.tabs.sendMessage(activeTabId, message);
    } catch (_) {
      activeTabId = null;
      return null;
    }
  }

  async function poll() {
    const st = await askTab({ type: 'GET_LIVE_STATE' });
    if (st) { applyState(st); return; }
    // content-script недоступен на этой вкладке
    running = false;
    $('status').textContent = 'Нет связи';
    $('count').textContent = '0';
    $('progressText').textContent = 'Открой facebook.com/ads/library/… и обнови вкладку (⌘R)';
    setProgress('empty');
    $('btnRun').textContent = 'Собрать объявления';
    $('btnRun').classList.remove('danger'); $('btnRun').classList.add('primary');
    $('btnArchive').disabled = true;
  }

  async function getDataset() {
    const ds = await askTab({ type: 'GET_LIVE_DATASET' });
    if (ds) return ds;
    return ExtApi.sendMessage({ type: 'GET_DATASET' });
  }

  async function toggleRun() {
    if (running) { await askTab({ type: 'STOP' }); poll(); return; }
    const r = await askTab({ type: 'START', config: readConfig() });
    if (r == null) $('progressText').textContent = 'Нет связи со страницей — открой Ad Library и ⌘R';
    poll();
  }

  function bind() {
    $('btnRun').addEventListener('click', toggleRun);
    $('btnArchive').addEventListener('click', async () => {
      busyExport = true;
      $('btnArchive').disabled = true;
      try {
        const ds = await getDataset();
        const media = Exp.collectMediaUrls(ds);
        if (media.length === 0) { $('progressText').textContent = 'Нет медиа для архива'; return; }
        $('status').textContent = 'Архив';
        setProgress('frac', 0);
        const res = await Exp.exportArchive(ds, {
          onProgress: (p) => {
            setProgress('frac', p.total ? p.fetched / p.total : 0);
            $('progressText').textContent = 'Архив: ' + p.fetched + '/' + p.total + ' (' + Math.round(p.bytes / 1048576) + ' МБ)';
          }
        });
        setProgress('full');
        $('progressText').textContent = 'Архив готов: ' + res.fetched + ' файлов' + (res.failures.length ? (', ошибок ' + res.failures.length) : '');
      } catch (e) {
        $('progressText').textContent = 'Ошибка архива: ' + ((e && e.message) || e);
      } finally {
        busyExport = false;
        poll();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    poll();
    setInterval(poll, 600);
  });
})();
