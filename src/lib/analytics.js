/*
 * src/lib/analytics.js — сводная аналитика по собранным объявлениям.
 *
 * Чистый JS без браузерных зависимостей: computeSummary(ads, externalPage)
 * возвращает «разбор» рекламной выдачи конкурента — активные/неактивные,
 * первая/последняя дата, топ по долгожительству, частоты доменов/CTA/
 * платформ/медиа/языков и агрегаты охвата по ЕС.
 *
 * Экспортирует self.FBALS_Analytics и module.exports (импортируется в Node-тестах).
 */
(function () {
  'use strict';

  function bump(map, key) {
    if (!key && key !== 0) return;
    const k = String(key);
    map[k] = (map[k] || 0) + 1;
  }

  function sortFreqDesc(map) {
    const entries = Object.keys(map).map((k) => [k, map[k]]);
    entries.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    const out = {};
    for (const [k, v] of entries) out[k] = v;
    return out;
  }

  function minIso(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a < b ? a : b;
  }
  function maxIso(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a > b ? a : b;
  }

  // грубое определение языка по характерным символам — для частотной сводки
  function detectLang(text) {
    if (!text) return 'unknown';
    const s = String(text);
    if (/[Ѐ-ӿ]/.test(s)) return 'ru';
    if (/[一-鿿]/.test(s)) return 'zh';
    if (/[؀-ۿ]/.test(s)) return 'ar';
    if (/[֐-׿]/.test(s)) return 'he';
    if (/[぀-ヿ]/.test(s)) return 'ja';
    if (/[a-zA-Z]/.test(s)) return 'en';
    return 'other';
  }

  function adHasImages(ad) {
    return (ad.images && ad.images.length > 0) ||
      (ad.cards && ad.cards.some((c) => c.image));
  }
  function adHasVideos(ad) {
    return (ad.videos && ad.videos.length > 0) ||
      (ad.cards && ad.cards.some((c) => c.video));
  }

  /**
   * @param {Array} ads — нормализованные объявления
   * @param {{id?:string,name?:string}} [externalPage] — страница из URL/фильтров
   */
  function computeSummary(ads, externalPage) {
    ads = Array.isArray(ads) ? ads : [];

    const domains = {};
    const ctas = {};
    const platforms = {};
    const languages = {};
    const media = { images: 0, videos: 0, both: 0, none: 0 };

    let active = 0;
    let inactive = 0;
    let firstSeen = null;
    let lastSeen = null;

    let euAdsWithData = 0;
    let euTotalReach = 0;

    for (const ad of ads) {
      if (ad.ad_status === 'active') active++;
      else inactive++;

      firstSeen = minIso(firstSeen, ad.start_date);
      lastSeen = maxIso(lastSeen, ad.end_date || ad.start_date);

      if (ad.landing_domain) bump(domains, ad.landing_domain);
      if (ad.cta_text) bump(ctas, ad.cta_text);
      for (const p of (ad.publisher_platforms || [])) bump(platforms, p);
      bump(languages, detectLang(ad.body_text || ad.headline));

      const hasImg = adHasImages(ad);
      const hasVid = adHasVideos(ad);
      if (hasImg && hasVid) media.both++;
      else if (hasImg) media.images++;
      else if (hasVid) media.videos++;
      else media.none++;

      if (ad.eu_total_reach !== null && ad.eu_total_reach !== undefined) {
        euAdsWithData++;
        const n = Number(ad.eu_total_reach);
        if (!isNaN(n)) euTotalReach += n;
      }
    }

    const longevity_top = ads
      .slice()
      .sort((a, b) => (b.days_running || 0) - (a.days_running || 0))
      .slice(0, 10)
      .map((ad) => ({
        ad_archive_id: ad.ad_archive_id,
        days_running: ad.days_running || 0,
        headline: (ad.headline || '').slice(0, 120),
        ad_status: ad.ad_status
      }));

    return {
      total: ads.length,
      active: active,
      inactive: inactive,
      first_seen: firstSeen,
      last_seen: lastSeen,
      longevity_top: longevity_top,
      domains: sortFreqDesc(domains),
      ctas: sortFreqDesc(ctas),
      platforms: sortFreqDesc(platforms),
      media: media,
      languages: sortFreqDesc(languages),
      eu: {
        ads_with_data: euAdsWithData,
        total_reach: euTotalReach
      },
      eu_data_available: euAdsWithData > 0,
      page: externalPage || null
    };
  }

  const API = { computeSummary, _internal: { detectLang } };
  if (typeof self !== 'undefined') self.FBALS_Analytics = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
