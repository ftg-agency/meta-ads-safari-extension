/*
 * test/fixtures.js — небольшой нормализованный датасет для Node-тестов.
 * Один URL содержит «FAIL» — стаб fetch на нём падает (проверка устойчивости).
 */
'use strict';

const ads = [
  {
    ad_archive_id: '1001', ad_status: 'active',
    start_date: '2024-01-01', end_date: null, days_running: 120,
    headline: 'Headline A', body_text: 'Buy our product now',
    link_url: 'https://shop.acme.com/lp?x=1', landing_domain: 'shop.acme.com',
    cta_text: 'Shop Now', publisher_platforms: ['facebook', 'instagram'],
    images: [{ original: 'https://img.example.com/a.jpg', resized: '', watermarked: '' }],
    videos: [], cards: [],
    ad_snapshot_url: 'https://www.facebook.com/ads/library/?id=1001',
    page_id: '999', page_name: 'ACME', eu_total_reach: 50000, eu_reach_breakdown: [], source: 'graphql'
  },
  {
    ad_archive_id: '1002', ad_status: 'inactive',
    start_date: '2023-06-01', end_date: '2023-09-01', days_running: 92,
    headline: 'Заголовок Б', body_text: 'Купите сейчас со скидкой',
    link_url: 'https://www.acme.com/promo', landing_domain: 'acme.com',
    cta_text: 'Learn More', publisher_platforms: ['facebook'],
    images: [], videos: [{ hd: 'https://vid.example.com/v-FAIL.mp4', sd: '', preview: '' }], cards: [],
    ad_snapshot_url: 'https://www.facebook.com/ads/library/?id=1002',
    page_id: '999', page_name: 'ACME', eu_total_reach: null, eu_reach_breakdown: [], source: 'dom'
  },
  {
    ad_archive_id: '1003', ad_status: 'active',
    start_date: '2024-03-15', end_date: null, days_running: 30,
    headline: 'Card ad', body_text: 'Multi card promo',
    link_url: 'https://acme.com/x', landing_domain: 'acme.com',
    cta_text: 'Shop Now', publisher_platforms: ['instagram'],
    images: [], videos: [],
    cards: [{
      image: 'https://img.example.com/c1.jpg', video: 'https://vid.example.com/c1.mp4',
      video_preview: '', headline: 'c', body: 'b', link_url: '', cta_text: ''
    }],
    ad_snapshot_url: 'https://www.facebook.com/ads/library/?id=1003',
    page_id: '999', page_name: 'ACME', eu_total_reach: 12000, eu_reach_breakdown: [], source: 'graphql'
  }
];

const dataset = {
  meta: {
    page_id: '999', page_name: 'ACME',
    source_url: 'https://www.facebook.com/ads/library/?view_all_page_id=999',
    filters: {}, count: ads.length, version: '1.0.0'
  },
  summary: {},
  ads: ads
};

module.exports = { ads, dataset };
