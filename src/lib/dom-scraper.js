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
      uk_total_reach: null,
      targeting_age: '',
      targeting_gender: '',
      targeting_locations: '',
      payer: '',
      beneficiary: '',
      // доп. поля из реальной разметки Ad Library
      ads_using_creative: null,   // «N ads use this creative and text»
      has_eu_transparency: false, // есть ли раздел EU transparency у объявления
      low_impressions: false,     // бейдж «Low impression count»
      impressions: '',            // строка вида «<100», если показана
      total_active_time: '',      // «Total active time 7 hrs», если показано
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

  // Текст с пробелами на границах блоков. textContent склеивает соседние спаны
  // («Lowimpressioncount», «Impressions:<100»), из-за чего regex с пробелами не
  // матчатся — тот же баг, что чинили для данных ЕС.
  function spacedText(root) {
    if (!root) return '';
    const parts = [];
    const walk = (node) => {
      for (let i = 0; i < node.childNodes.length; i++) {
        const c = node.childNodes[i];
        if (c.nodeType === 3) { const v = c.nodeValue; if (v && v.trim()) parts.push(v.trim()); }
        else if (c.nodeType === 1) walk(c);
      }
    };
    walk(root);
    return parts.join(' ');
  }

  const RE_ID = /(?:Library ID|Идентификатор библиотеки|Identyfikator)\D*(\d{6,})/i;
  const RE_INACTIVE = /(Inactive|Неактивно|Не активно)/i;
  const RE_STARTED = /(?:Started running on|Запущено|Active since)\s*([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})/i;
  // диапазон дат у неактивных: «Apr 25, 2026 - May 12, 2026»
  const RE_RANGE = /([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})\s*[-–—]\s*([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})/;
  const RE_USES = /(\d[\d,\s]*)\s*ads?\s+use\s+this\s+creative/i;
  const RE_ACTIVE_TIME = /Total active time\s+([^\n·]+?)(?:\s{2,}|$|·)/i;
  const RE_IMPRESSIONS = /Impressions:\s*([<>]?\s*[\d,. KkMm+-]+)/;

  function isoFromText(s) {
    if (!s) return null;
    const d = Date.parse(s);
    return isNaN(d) ? null : new Date(d).toISOString().slice(0, 10);
  }

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
    // статус — короткий бейдж в начале карточки; ищем именно слово, а не вхождение
    const t = textOf(card);
    if (RE_INACTIVE.test(t)) return 'inactive';
    if (/\bActive\b|\bАктивно\b/.test(t)) return 'active';
    return 'active';
  }

  function parseDates(card) {
    const t = textOf(card);
    // 1) диапазон «Apr 25, 2026 - May 12, 2026» (обычно у неактивных)
    const r = t.match(RE_RANGE);
    if (r) return { start_date: isoFromText(r[1]), end_date: isoFromText(r[2]) };
    // 2) «Started running on May 23, 2026» (активные)
    const s = t.match(RE_STARTED);
    if (s) return { start_date: isoFromText(s[1]), end_date: null };
    return { start_date: null, end_date: null };
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
    // В реальной разметке Ad Library тело объявления лежит в контейнере
    // <div style="white-space: pre-wrap">. Берём самый длинный такой блок.
    let best = '';
    const blocks = card.querySelectorAll('div[style*="pre-wrap"], div[style*="white-space"]');
    blocks.forEach((el) => {
      const t = textOf(el);
      if (t.length > best.length) best = t;
    });
    if (best) return best;
    // запасной путь — самый длинный листовой span, НО без служебного текста
    // (Library ID / даты / «Started running» / «N ads use this creative»).
    const META = /Library ID|Идентификатор|Started running|Запущено|ads? use this creative|Sponsored|Platforms|Open Dropdown|See (?:ad|summary) details|EU transparency/i;
    card.querySelectorAll('span').forEach((el) => {
      if (el.children.length !== 0) return;
      const t = textOf(el);
      if (t.length <= best.length || t.length >= 6000) return;
      if (META.test(t)) return;
      if (/^[A-Z][a-z]{2}\s+\d{1,2},\s*\d{4}/.test(t)) return; // дата
      best = t;
    });
    return best;
  }

  // «N ads use this creative and text» — сколько объявлений на этом креативе
  function parseUsesCount(card) {
    const m = textOf(card).match(RE_USES);
    if (!m) return null;
    const n = parseInt(m[1].replace(/[^\d]/g, ''), 10);
    return isNaN(n) ? null : n;
  }

  // признаки/доп.метрики, видимые прямо в карточке.
  // Используем spacedText: иначе «Low impression count» склеивается в DOM и не
  // ловится (поэтому раньше распознавался лишь у части карточек).
  function parseFlags(card) {
    const t = spacedText(card).replace(/\s+/g, ' ');
    const out = {
      has_eu_transparency: /EU transparency|Прозрачность в ЕС/i.test(t),
      low_impressions: /low\s*impression\s*count|Низк\w* (?:число|количество) показ/i.test(t),
      impressions: '',
      total_active_time: ''
    };
    const imp = t.match(RE_IMPRESSIONS);
    if (imp) out.impressions = imp[1].replace(/\s+/g, ' ').trim();
    const act = t.match(RE_ACTIVE_TIME);
    if (act) out.total_active_time = act[1].trim();
    return out;
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
    ad.ads_using_creative = parseUsesCount(card);
    const flags = parseFlags(card);
    ad.has_eu_transparency = flags.has_eu_transparency;
    ad.low_impressions = flags.low_impressions;
    ad.impressions = flags.impressions;
    ad.total_active_time = flags.total_active_time;
    ad.ad_snapshot_url = 'https://www.facebook.com/ads/library/?id=' + ad.ad_archive_id;
    return ad;
  }

  // Сколько РАЗНЫХ Library ID в поддереве элемента.
  function countIds(el) {
    const t = el.textContent || '';
    if (!RE_ID.test(t)) return 0;
    const re = /(?:Library ID|Идентификатор библиотеки|Identyfikator)\D*(\d{6,})/gi;
    const ids = new Set();
    let m;
    while ((m = re.exec(t)) !== null) ids.add(m[1]);
    return ids.size;
  }

  // Узкий носитель ID: его текст содержит Library ID, но ни один прямой ребёнок — нет.
  function elementOwnsId(el) {
    if (!RE_ID.test(el.textContent || '')) return false;
    for (const ch of el.children) {
      if (RE_ID.test(ch.textContent || '')) return false;
    }
    return true;
  }

  // Контейнер карточки = САМЫЙ БОЛЬШОЙ предок, всё ещё содержащий ровно ОДИН
  // Library ID. Так внутрь попадают тело, медиа и кнопка «See ad details»
  // именно этой карточки, а соседние карточки не сливаются.
  function cardContainerFor(idEl) {
    let el = idEl;
    let best = idEl;
    for (let i = 0; i < 14 && el.parentElement; i++) {
      const p = el.parentElement;
      const n = countIds(p);
      if (n === 1) { best = p; el = p; }     // ещё одна карточка — расширяемся
      else break;                            // у родителя ≥2 id — дальше нельзя
    }
    return best;
  }

  /**
   * Находит карточки на текущем экране и парсит их, сохраняя ссылку на DOM-узел
   * (нужно для drill-in). От точечного носителя ID расширяемся вверх до полного
   * контейнера карточки (с одним id) — чтобы взять тело/медиа, но не слить соседей.
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
