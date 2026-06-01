/*
 * src/lib/exporter.js — экспорт собранного датасета: JSON, CSV, список медиа и
 * ZIP-архив с реальными файлами креативов.
 *
 * Датасет: { meta, summary, ads:[...] }. Загружается в popup после zip.js и
 * ext-api.js. Чистые функции buildJSON/buildCSV/collectMediaUrls тестируются в Node.
 *
 * Экспортирует window/self.FBALS_Exporter и module.exports.
 */
(function () {
  'use strict';

  // Зависимости берём лениво: в браузере — глобалы, в Node — require.
  function getZip() {
    if (typeof self !== 'undefined' && self.FBALS_Zip) return self.FBALS_Zip;
    if (typeof require !== 'undefined') return require('./zip.js');
    throw new Error('FBALS_Zip недоступен');
  }
  function getExtApi() {
    if (typeof self !== 'undefined' && self.ExtApi) return self.ExtApi;
    if (typeof require !== 'undefined') return require('./ext-api.js');
    throw new Error('ExtApi недоступен');
  }

  const CSV_COLUMNS = [
    'ad_archive_id', 'ad_status', 'start_date', 'end_date', 'days_running',
    'page_id', 'page_name', 'headline', 'body_text', 'cta_text',
    'link_url', 'landing_domain', 'publisher_platforms',
    'images_count', 'videos_count', 'cards_count',
    'ads_using_creative', 'has_eu_transparency', 'low_impressions',
    'impressions', 'total_active_time',
    'eu_total_reach', 'eu_breakdown_rows',
    'targeting_age', 'targeting_gender', 'targeting_locations',
    'ad_snapshot_url'
  ];

  // --- имена файлов ---

  function dateStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function slug(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9Ѐ-ӿ]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'all';
  }

  function fileName(dataset, ext) {
    const meta = (dataset && dataset.meta) || {};
    const page = slug(meta.page_name || meta.page_id || 'all');
    return 'fb-ads-' + page + '-' + dateStamp() + '.' + ext;
  }

  // --- JSON / CSV ---

  function buildJSON(dataset) {
    return JSON.stringify(dataset, null, 2);
  }

  function csvCell(v) {
    if (v === null || v === undefined) v = '';
    v = String(v);
    if (/[",\n\r]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  function cellValue(ad, col) {
    switch (col) {
      case 'publisher_platforms':
        return (ad.publisher_platforms || []).join('|');
      case 'images_count':
        return (ad.images || []).length;
      case 'videos_count':
        return (ad.videos || []).length;
      case 'cards_count':
        return (ad.cards || []).length;
      case 'eu_total_reach':
        return (ad.eu_total_reach === null || ad.eu_total_reach === undefined) ? '' : ad.eu_total_reach;
      case 'ads_using_creative':
        return (ad.ads_using_creative === null || ad.ads_using_creative === undefined) ? '' : ad.ads_using_creative;
      case 'eu_breakdown_rows':
        return (ad.eu_reach_breakdown || []).length || '';
      case 'has_eu_transparency':
        return ad.has_eu_transparency ? '1' : '';
      case 'low_impressions':
        return ad.low_impressions ? '1' : '';
      default:
        return (ad[col] === null || ad[col] === undefined) ? '' : ad[col];
    }
  }

  function buildCSV(dataset) {
    const ads = (dataset && dataset.ads) || [];
    const rows = [CSV_COLUMNS.join(',')];
    for (const ad of ads) {
      rows.push(CSV_COLUMNS.map((col) => csvCell(cellValue(ad, col))).join(','));
    }
    return rows.join('\r\n');
  }

  // --- сбор URL медиа ---

  /**
   * Лучшие URL по каждому ассету, без дублей.
   * @returns {Array<{ad_archive_id:string, type:'image'|'video', url:string, ext:string}>}
   */
  function collectMediaUrls(dataset) {
    const out = [];
    const seen = new Set();
    function add(adId, type, url) {
      if (!url) return;
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ ad_archive_id: adId, type: type, url: url, ext: type === 'video' ? 'mp4' : 'jpg' });
    }
    const ads = (dataset && dataset.ads) || [];
    for (const ad of ads) {
      const id = ad.ad_archive_id || '';
      for (const im of (ad.images || [])) add(id, 'image', im.original || im.resized || im.watermarked);
      for (const v of (ad.videos || [])) add(id, 'video', v.hd || v.sd);
      for (const c of (ad.cards || [])) {
        add(id, 'video', c.video);
        add(id, 'image', c.image || c.video_preview);
      }
    }
    return out;
  }

  function buildMediaUrlsText(dataset) {
    return collectMediaUrls(dataset).map((m) => m.url).join('\n');
  }

  // --- ZIP-архив креативов (Workstream A) ---

  function pad3(n) {
    return String(n).padStart(3, '0');
  }

  /**
   * Скачивает медиа и собирает их вместе с ads.json/ads.csv/manifest.txt в ZIP.
   * Чистая функция: возвращает байты, скачивание — отдельно (exportArchive).
   *
   * @param {Object} dataset
   * @param {Object} [opts] { maxFiles, maxTotalBytes, concurrency, onProgress, fetchImpl }
   * @returns {Promise<{bytes:Uint8Array, entries:string[], failures:Array, fetched:number, totalBytes:number, skipped:number}>}
   */
  async function buildArchive(dataset, opts) {
    opts = opts || {};
    const maxFiles = opts.maxFiles || 500;
    const maxTotalBytes = opts.maxTotalBytes || (300 * 1024 * 1024);
    const concurrency = Math.max(1, Math.min(opts.concurrency || 5, 8));
    const onProgress = opts.onProgress || function () {};
    const doFetch = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('fetch недоступен');

    const media = collectMediaUrls(dataset);
    const capped = media.slice(0, maxFiles);
    const skipped = media.length - capped.length;

    // Заранее присваиваем стабильные имена.
    let imgN = 0;
    let vidN = 0;
    const planned = capped.map((m) => {
      let name;
      if (m.type === 'video') {
        vidN++;
        name = 'videos/' + pad3(vidN) + '-' + m.ad_archive_id + '.mp4';
      } else {
        imgN++;
        name = 'images/' + pad3(imgN) + '-' + m.ad_archive_id + '.jpg';
      }
      return { url: m.url, name: name };
    });

    const entries = [];
    const failures = [];
    const urlToName = [];
    let totalBytes = 0;
    let fetched = 0;
    let idx = 0;

    async function worker() {
      while (idx < planned.length) {
        const my = planned[idx++];
        if (totalBytes >= maxTotalBytes) {
          failures.push({ url: my.url, reason: 'превышен лимит размера (maxTotalBytes)' });
          continue;
        }
        try {
          const res = await doFetch(my.url);
          if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
          const buf = new Uint8Array(await res.arrayBuffer());
          totalBytes += buf.length;
          entries.push({ name: my.name, bytes: buf });
          urlToName.push(my.name + '\t' + my.url);
          fetched++;
          onProgress({ fetched: fetched, total: planned.length, bytes: totalBytes });
        } catch (e) {
          failures.push({ url: my.url, reason: String((e && e.message) || e) });
        }
      }
    }

    const workers = [];
    const n = Math.min(concurrency, planned.length);
    for (let i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);

    const enc = new TextEncoder();
    entries.push({ name: 'ads.json', bytes: enc.encode(buildJSON(dataset)) });
    entries.push({ name: 'ads.csv', bytes: enc.encode(buildCSV(dataset)) });

    const manifestLines = ['# Карта файлов архива (имя<TAB>URL)'];
    for (const line of urlToName) manifestLines.push(line);
    if (skipped > 0) manifestLines.push('# Пропущено по лимиту maxFiles: ' + skipped);
    if (failures.length) {
      manifestLines.push('');
      manifestLines.push('# Не удалось скачать:');
      for (const f of failures) manifestLines.push(f.url + '\t' + f.reason);
    }
    entries.push({ name: 'manifest.txt', bytes: enc.encode(manifestLines.join('\n')) });

    const Zip = getZip();
    const bytes = Zip.createZip(entries);
    return {
      bytes: bytes,
      entries: entries.map((e) => e.name),
      failures: failures,
      fetched: fetched,
      totalBytes: totalBytes,
      skipped: skipped
    };
  }

  async function exportArchive(dataset, opts) {
    const res = await buildArchive(dataset, opts);
    const blob = new Blob([res.bytes], { type: 'application/zip' });
    getExtApi().downloadBlob(blob, fileName(dataset, 'zip'));
    return res;
  }

  // --- экспорт текстовых форматов ---

  function downloadText(text, name, mime) {
    const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    getExtApi().downloadBlob(blob, name);
  }

  function exportJSON(dataset) {
    downloadText(buildJSON(dataset), fileName(dataset, 'json'), 'application/json');
  }

  function exportCSV(dataset) {
    // BOM для корректного открытия кириллицы в Excel
    downloadText('﻿' + buildCSV(dataset), fileName(dataset, 'csv'), 'text/csv');
  }

  function exportMediaList(dataset) {
    downloadText(buildMediaUrlsText(dataset), fileName(dataset, 'media.txt'), 'text/plain');
  }

  /**
   * Скачивает каждый медиафайл по отдельности (fetch -> Blob -> download),
   * без downloads.download — пригодно и для Safari. Для массового сохранения
   * предпочтительнее ZIP (exportArchive).
   */
  async function downloadMediaFiles(dataset, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    const doFetch = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('fetch недоступен');
    const media = collectMediaUrls(dataset).slice(0, opts.maxFiles || 200);
    const ext = getExtApi();
    let done = 0;
    const failures = [];
    let imgN = 0;
    let vidN = 0;
    for (const m of media) {
      let name;
      if (m.type === 'video') { vidN++; name = pad3(vidN) + '-' + m.ad_archive_id + '.mp4'; }
      else { imgN++; name = pad3(imgN) + '-' + m.ad_archive_id + '.jpg'; }
      try {
        const res = await doFetch(m.url);
        if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
        const blob = await res.blob();
        ext.downloadBlob(blob, name);
        done++;
        onProgress({ fetched: done, total: media.length });
      } catch (e) {
        failures.push({ url: m.url, reason: String((e && e.message) || e) });
      }
    }
    return { fetched: done, total: media.length, failures: failures };
  }

  const API = {
    CSV_COLUMNS,
    buildJSON,
    buildCSV,
    buildMediaUrlsText,
    collectMediaUrls,
    buildArchive,
    exportArchive,
    exportJSON,
    exportCSV,
    exportMediaList,
    downloadMediaFiles,
    fileName,
    dateStamp
  };

  if (typeof window !== 'undefined') window.FBALS_Exporter = API;
  if (typeof self !== 'undefined') self.FBALS_Exporter = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
