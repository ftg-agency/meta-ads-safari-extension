/*
 * src/lib/dom-scraper.js — съём данных объявлений прямо из DOM Ad Library.
 *
 * Это ОСНОВНОЙ источник данных (graphql-перехват — обогащение). Селекторы Меты
 * не стабильны, поэтому всё построено на эвристиках: ищем карточки по «Library ID /
 * Идентификатор библиотеки», тянем статус/даты/тексты/медиа максимально устойчиво.
 * При очередном редизайне FB правки нужны именно здесь.
 *
 * Только DOM, без chrome.*. Экспортирует self.FBALS_DomScraper.
 */
(function () {
  'use strict';

  // Совпадает с моделью из graphql-parser (поля, которых нет в DOM, пустые).
  function emptyAd() {
    return {
      ad_archive_id: '',
      ad_status: 'active',
      start_date: null,
      end_date: null,
      days_running: 0,
      headline: '',
      body_text: '',
      link_url: '',
      landing_domain: '',
      cta_text: '',
      publisher_platforms: [],
      images: [],
      videos: [],
      cards: [],
      ad_snapshot_url: '',
      page_id: '',
      page_name: '',
      eu_total_reach: null,
      eu_reach_breakdown: [],
      source: 'dom'
    };
  }

  function domainOf(url) {
    if (!url) return '';
    try { return new URL(url).hostname.replace(/^www\./i, ''); } catch (_) { return ''; }
  }

  function textOf(el) {
    return (el && el.textContent ? el.textContent : '').trim();
  }

  const RE_ID = /(?:Library ID|Идентификатор библиотеки|Identyfikator)\D*(\d{6,})/i;
  const RE_ACTIVE = /(Active|Активно)/i;
  const RE_INACTIVE = /(Inactive|Неактивно|Не активно)/i;
  const RE_STARTED = /(?:Started running on|Запущено|Active since)\s*([A-Za-zА-Яа-я0-9 ,.]+?\d{4})/i;

  function findAdId(card) {
    // 1) по тексту «Library ID: …»
    const m = textOf(card).match(RE_ID);
    if (m) return m[1];
    // 2) по ссылке на конкретное объявление
    const a = card.querySelector('a[href*="/ads/library/?id="], a[href*="view_all_page_id"]');
    if (a) {
      const mm = a.href.match(/[?&]id=(\d{6,})/);
      if (mm) return mm[1];
    }
    return '';
  }

  function parseStatus(card) {
    const t = textOf(card);
    if (RE_INACTIVE.test(t)) return 'inactive';
    if (RE_ACTIVE.test(t)) return 'active';
    return 'active';
  }

  function parseDates(card) {
    const t = textOf(card);
    const m = t.match(RE_STARTED);
    let start = null;
    if (m) {
      const d = Date.parse(m[1]);
      if (!isNaN(d)) start = new Date(d).toISOString().slice(0, 10);
    }
    return { start_date: start, end_date: null };
  }

  function parseMedia(card) {
    const images = [];
    const videos = [];
    card.querySelectorAll('img').forEach((img) => {
      const src = img.currentSrc || img.src;
      // отсекаем иконки/аватарки по размеру
      if (src && (img.naturalWidth > 150 || img.width > 150)) {
        images.push({ original: src, resized: '', watermarked: '' });
      }
    });
    card.querySelectorAll('video').forEach((v) => {
      const src = v.currentSrc || v.src || (v.querySelector('source') && v.querySelector('source').src);
      if (src) videos.push({ hd: src, sd: '', preview: v.poster || '' });
    });
    return { images, videos };
  }

  function parseCta(card) {
    // CTA — обычно кнопка-ссылка ближе к низу карточки
    const btn = card.querySelector('[role="button"] a, a[role="button"], div[role="button"]');
    const t = btn ? textOf(btn) : '';
    return t.length > 0 && t.length < 40 ? t : '';
  }

  function parseLink(card) {
    const a = card.querySelector('a[href*="l.facebook.com/l.php"], a[target="_blank"][href^="http"]');
    if (!a) return '';
    let href = a.href;
    // FB заворачивает внешние ссылки в l.facebook.com/l.php?u=<encoded>
    const m = href.match(/[?&]u=([^&]+)/);
    if (m) {
      try { href = decodeURIComponent(m[1]); } catch (_) { /* как есть */ }
    }
    return href;
  }

  function parseBody(card) {
    // самый длинный текстовый блок внутри карточки — обычно это тело объявления
    let best = '';
    card.querySelectorAll('div, span').forEach((el) => {
      if (el.children.length === 0) {
        const t = textOf(el);
        if (t.length > best.length && t.length < 4000) best = t;
      }
    });
    return best;
  }

  function parseCard(card, idHint) {
    const ad = emptyAd();
    ad.ad_archive_id = idHint || findAdId(card);
    if (!ad.ad_archive_id) return null;

    ad.ad_status = parseStatus(card);
    const dates = parseDates(card);
    ad.start_date = dates.start_date;
    ad.end_date = dates.end_date;

    const media = parseMedia(card);
    ad.images = media.images;
    ad.videos = media.videos;

    ad.cta_text = parseCta(card);
    ad.link_url = parseLink(card);
    ad.landing_domain = domainOf(ad.link_url);
    ad.body_text = parseBody(card);
    ad.ad_snapshot_url = 'https://www.facebook.com/ads/library/?id=' + ad.ad_archive_id;
    return ad;
  }

  // Элемент, чей СОБСТВЕННЫЙ текст содержит «Library ID …», но ни один из прямых
  // детей его не содержит — то есть самый узкий носитель этого ID (один на карточку).
  function elementOwnsId(el) {
    if (!RE_ID.test(el.textContent || '')) return false;
    for (const ch of el.children) {
      if (RE_ID.test(ch.textContent || '')) return false;
    }
    return true;
  }

  // От узкого носителя ID поднимаемся к контейнеру карточки: первый предок, в
  // котором появляется медиа или достаточно крупный текст (а не вся сетка сразу).
  function cardContainerFor(idEl) {
    let el = idEl;
    for (let i = 0; i < 8 && el.parentElement; i++) {
      el = el.parentElement;
      if (el.querySelector('img, video')) return el;
      if ((el.textContent || '').length > 80) return el;
    }
    return idEl.parentElement || idEl;
  }

  /**
   * Находит карточки на текущем экране и парсит их, сохраняя ссылку на DOM-узел
   * (нужно для drill-in). Идём от точечного носителя ID вверх к карточке — чтобы
   * не схлопнуть всю сетку в одну «карточку».
   * @param {Element} [root=document]
   * @returns {Array<{ad:Object, el:Element}>}
   */
  function findCards(root) {
    root = root || document;
    const seen = new Set();
    const out = [];

    root.querySelectorAll('div, span').forEach((el) => {
      if (!elementOwnsId(el)) return;
      const m = (el.textContent || '').match(RE_ID);
      const id = m && m[1];
      if (!id || seen.has(id)) return;
      seen.add(id);
      const container = cardContainerFor(el);
      const ad = parseCard(container, id);
      if (ad) out.push({ ad: ad, el: container });
    });

    return out;
  }

  /**
   * То же, но возвращает только объявления.
   * @param {Element} [root=document]
   * @returns {Array}
   */
  function scrapeGrid(root) {
    return findCards(root).map((x) => x.ad);
  }

  const API = { scrapeGrid, findCards, parseCard, _internal: { findAdId, parseMedia, domainOf } };
  if (typeof self !== 'undefined') self.FBALS_DomScraper = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
