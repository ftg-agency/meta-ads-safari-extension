/*
 * src/lib/graphql-parser.js — разбор ответов FB /api/graphql в нормализованную модель.
 *
 * Перехватчик (interceptor.js) отдаёт сырой текст ответов graphql. Структура у
 * Меты глубоко вложенная и периодически меняется, поэтому парсер не привязан к
 * конкретному пути: он рекурсивно ищет объекты, похожие на рекламную карточку
 * (есть ad_archive_id + snapshot), и нормализует их.
 *
 * Нормализованная модель объявления (используется во всём проекте):
 *   ad_archive_id, ad_status, start_date, end_date, days_running,
 *   headline, body_text, link_url, landing_domain, cta_text,
 *   publisher_platforms[], images[], videos[], cards[],
 *   ad_snapshot_url, page_id, page_name,
 *   eu_total_reach, eu_reach_breakdown, source
 *
 * Экспортирует self.FBALS_Parser и module.exports.
 */
(function () {
  'use strict';

  // --- утилиты ---

  function domainOf(url) {
    if (!url) return '';
    try {
      const h = new URL(String(url)).hostname;
      return h.replace(/^www\./i, '');
    } catch (_) {
      // url без схемы — попробуем вытащить домен вручную
      const m = String(url).match(/^(?:https?:\/\/)?([^/?#]+)/i);
      return m ? m[1].replace(/^www\./i, '') : '';
    }
  }

  function toIsoDate(value) {
    if (value === null || value === undefined || value === '') return null;
    let ms;
    if (typeof value === 'number') {
      // epoch в секундах (FB) или миллисекундах
      ms = value < 1e12 ? value * 1000 : value;
    } else {
      const s = String(value).trim();
      if (/^\d+$/.test(s)) {
        const n = Number(s);
        ms = n < 1e12 ? n * 1000 : n;
      } else {
        const t = Date.parse(s);
        if (isNaN(t)) return null;
        ms = t;
      }
    }
    const d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }

  function daysBetween(aMs, bMs) {
    return Math.max(0, Math.round((bMs - aMs) / 86400000));
  }

  function firstDefined() {
    for (let i = 0; i < arguments.length; i++) {
      const v = arguments[i];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v === undefined || v === null) return [];
    return [v];
  }

  // --- извлечение медиа из snapshot ---

  function pickImages(snap) {
    return asArray(snap.images).map((im) => ({
      original: firstDefined(im.original_image_url, im.orig_image_url, im.original, im.url) || '',
      resized: firstDefined(im.resized_image_url, im.resized) || '',
      watermarked: firstDefined(im.watermarked_image_url, im.watermarked) || ''
    })).filter((x) => x.original || x.resized || x.watermarked);
  }

  function pickVideos(snap) {
    return asArray(snap.videos).map((v) => ({
      hd: firstDefined(v.video_hd_url, v.hd, v.video_hd) || '',
      sd: firstDefined(v.video_sd_url, v.sd, v.video_sd) || '',
      preview: firstDefined(v.video_preview_image_url, v.preview, v.video_preview) || ''
    })).filter((x) => x.hd || x.sd || x.preview);
  }

  function pickCards(snap) {
    return asArray(snap.cards).map((c) => ({
      image: firstDefined(c.original_image_url, c.orig_image_url, c.resized_image_url, c.image) || '',
      video: firstDefined(c.video_hd_url, c.video_sd_url, c.video) || '',
      video_preview: firstDefined(c.video_preview_image_url, c.video_preview) || '',
      headline: firstDefined(c.title, c.headline) || '',
      body: firstDefined((c.body && c.body.text), c.body, c.text) || '',
      link_url: firstDefined(c.link_url, c.url) || '',
      cta_text: firstDefined(c.cta_text, c.cta) || ''
    }));
  }

  // --- нормализация одной карточки ---

  function normalizeAd(node) {
    const snap = node.snapshot || node.snapshot_data || {};

    const startRaw = firstDefined(node.start_date, node.startDate, snap.start_date, node.ad_delivery_start_time);
    const endRaw = firstDefined(node.end_date, node.endDate, snap.end_date, node.ad_delivery_stop_time);
    const start_date = toIsoDate(startRaw);
    const end_date = toIsoDate(endRaw);

    let isActive;
    if (typeof node.is_active === 'boolean') isActive = node.is_active;
    else if (typeof node.isActive === 'boolean') isActive = node.isActive;
    else if (node.ad_status) isActive = /active/i.test(node.ad_status) && !/inactive/i.test(node.ad_status);
    else isActive = !end_date; // нет даты окончания — считаем активным

    const startMs = start_date ? Date.parse(start_date) : null;
    const endMs = end_date ? Date.parse(end_date) : Date.now();
    const days_running = (startMs !== null) ? daysBetween(startMs, endMs) : 0;

    const body_text = firstDefined(
      (snap.body && snap.body.text), snap.body_text, snap.body,
      (node.body && node.body.text)
    ) || '';
    const headline = firstDefined(snap.title, snap.headline, snap.caption, node.title) || '';
    const link_url = firstDefined(snap.link_url, snap.caption_url, node.link_url) || '';
    const cta_text = firstDefined(snap.cta_text, snap.cta_type, node.cta_text) || '';

    const platforms = asArray(firstDefined(
      node.publisher_platform, node.publisher_platforms, snap.publisher_platform
    )).map((p) => String(p).toLowerCase());

    return {
      ad_archive_id: String(firstDefined(node.ad_archive_id, node.adArchiveID, node.id) || ''),
      ad_status: isActive ? 'active' : 'inactive',
      start_date: start_date,
      end_date: end_date,
      days_running: days_running,
      headline: String(headline),
      body_text: String(body_text),
      link_url: String(link_url),
      landing_domain: domainOf(link_url),
      cta_text: String(cta_text),
      publisher_platforms: platforms,
      images: pickImages(snap),
      videos: pickVideos(snap),
      cards: pickCards(snap),
      ad_snapshot_url: String(firstDefined(node.ad_snapshot_url, snap.ad_snapshot_url) || ''),
      page_id: String(firstDefined(node.page_id, snap.page_id) || ''),
      page_name: String(firstDefined(node.page_name, snap.page_name) || ''),
      eu_total_reach: (node.eu_total_reach !== undefined) ? node.eu_total_reach : null,
      eu_reach_breakdown: asArray(node.eu_reach_breakdown),
      uk_total_reach: null,
      targeting_age: '',
      targeting_gender: '',
      targeting_locations: '',
      payer: '',
      beneficiary: '',
      ads_using_creative: (node.collation_count !== undefined && node.collation_count !== null) ? node.collation_count : null,
      has_eu_transparency: false,
      low_impressions: false,
      impressions: '',
      total_active_time: '',
      source: 'graphql'
    };
  }

  // --- рекурсивный поиск рекламных карточек в произвольном JSON ---

  function looksLikeAd(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const hasId = ('ad_archive_id' in obj) || ('adArchiveID' in obj);
    const hasSnap = ('snapshot' in obj) || ('snapshot_data' in obj);
    return hasId && hasSnap;
  }

  function collectAds(root) {
    const found = [];
    const stack = [root];
    let guard = 0;
    while (stack.length && guard < 200000) {
      guard++;
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (looksLikeAd(cur)) {
        found.push(cur);
        continue; // не спускаемся внутрь найденной карточки
      }
      if (Array.isArray(cur)) {
        for (let i = 0; i < cur.length; i++) stack.push(cur[i]);
      } else {
        for (const k in cur) {
          if (Object.prototype.hasOwnProperty.call(cur, k)) stack.push(cur[k]);
        }
      }
    }
    return found;
  }

  function tryParseJson(text) {
    const out = [];
    try {
      out.push(JSON.parse(text));
      return out;
    } catch (_) { /* возможно, поток JSON-объектов по строкам */ }
    const lines = String(text).split('\n');
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch (_) { /* пропускаем мусор */ }
    }
    return out;
  }

  /**
   * Разбирает сырой текст ответа graphql.
   * @param {string} text
   * @param {string} [url]
   * @returns {Array} массив нормализованных объявлений
   */
  function parsePayload(text, url) {
    if (!text) return [];
    const roots = tryParseJson(text);
    const ads = [];
    const seen = new Set();
    for (const root of roots) {
      const nodes = collectAds(root);
      for (const node of nodes) {
        const ad = normalizeAd(node);
        if (!ad.ad_archive_id) continue;
        if (seen.has(ad.ad_archive_id)) continue;
        seen.add(ad.ad_archive_id);
        ads.push(ad);
      }
    }
    return ads;
  }

  // --- разбор данных охвата ЕС из graphql (ad_details → transparency) ---
  // Структура (подтверждена на живом ответе):
  //   transparency_by_location.eu_transparency.{eu_total_reach, gender_audience,
  //   age_audience{min,max}, location_audience[], age_country_gender_reach_breakdown[]}
  //   + uk_transparency.total_reach, + aaa_info.payer_beneficiary_data[]

  function flattenBreakdown(arr) {
    const out = [];
    for (const c of asArray(arr)) {
      const country = c.country || '';
      for (const b of asArray(c.age_gender_breakdowns)) {
        const age = b.age_range || '';
        if (b.male != null) out.push({ location: country, age: age, gender: 'Male', reach: b.male });
        if (b.female != null) out.push({ location: country, age: age, gender: 'Female', reach: b.female });
        if (b.unknown != null) out.push({ location: country, age: age, gender: 'Unknown', reach: b.unknown });
      }
    }
    return out;
  }

  // Рекурсивно ищем объекты eu_transparency / ad_details с охватом.
  function findEuNodes(root) {
    const found = [];
    const stack = [root];
    let guard = 0;
    while (stack.length && guard < 200000) {
      guard++;
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (cur.eu_transparency || (cur.transparency_by_location && cur.transparency_by_location.eu_transparency)) {
        found.push(cur);
      }
      if (Array.isArray(cur)) { for (let i = 0; i < cur.length; i++) stack.push(cur[i]); }
      else { for (const k in cur) if (Object.prototype.hasOwnProperty.call(cur, k)) stack.push(cur[k]); }
    }
    return found;
  }

  /**
   * Достаёт данные ЕС из сырого graphql-ответа ad_details.
   * @returns {Object|null} { eu_total_reach, eu_reach_breakdown[], uk_total_reach,
   *   targeting_age, targeting_gender, targeting_locations, payer, beneficiary, ad_archive_id }
   */
  function parseEuPayload(text) {
    const roots = tryParseJson(text);
    for (const root of roots) {
      // ad_archive_id — рядом, чтобы привязать к объявлению
      let adId = '';
      const idm = String(text).match(/"ad_archive_id"\s*:\s*"?(\d{6,})"?/);
      if (idm) adId = idm[1];

      const details = (function find(o) {
        const st = [o]; let g = 0;
        while (st.length && g < 200000) { g++; const c = st.pop();
          if (!c || typeof c !== 'object') continue;
          if (c.transparency_by_location || c.aaa_info) return c;
          if (Array.isArray(c)) { for (const x of c) st.push(x); }
          else { for (const k in c) st.push(c[k]); }
        }
        return null;
      })(root);
      if (!details) continue;

      const tbl = details.transparency_by_location || {};
      const eu = tbl.eu_transparency;
      if (!eu) continue;

      const loc = asArray(eu.location_audience).map((l) => l.name).filter(Boolean).join(', ');
      const age = eu.age_audience ? (eu.age_audience.min + '-' + eu.age_audience.max) : '';
      const pb = (details.aaa_info && asArray(details.aaa_info.payer_beneficiary_data)[0]) || {};

      return {
        ad_archive_id: adId,
        eu_total_reach: (eu.eu_total_reach != null) ? eu.eu_total_reach : null,
        eu_reach_breakdown: flattenBreakdown(eu.age_country_gender_reach_breakdown),
        uk_total_reach: (tbl.uk_transparency && tbl.uk_transparency.total_reach != null) ? tbl.uk_transparency.total_reach : null,
        targeting_age: age,
        targeting_gender: eu.gender_audience || '',
        targeting_locations: loc,
        payer: pb.payer || '',
        beneficiary: pb.beneficiary || ''
      };
    }
    return null;
  }

  // Быстрая проверка: есть ли в тексте payload данные ЕС.
  function hasEuPayload(text) {
    return typeof text === 'string' && text.indexOf('eu_transparency') !== -1;
  }

  const API = {
    parsePayload,
    parseEuPayload,
    hasEuPayload,
    _internal: { domainOf, toIsoDate, normalizeAd, collectAds, flattenBreakdown, findEuNodes }
  };
  if (typeof self !== 'undefined') self.FBALS_Parser = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
