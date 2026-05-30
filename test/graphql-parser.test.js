/*
 * test/graphql-parser.test.js — разбор синтетического ответа graphql в
 * нормализованную модель + дедуп + вспомогательные функции.
 */
'use strict';

const assert = require('assert');
const Parser = require('../src/lib/graphql-parser.js');

const payload = JSON.stringify({
  data: {
    ad_library_main: {
      search_results_connection: {
        edges: [
          {
            node: {
              collated_results: [
                {
                  ad_archive_id: '555',
                  is_active: true,
                  start_date: 1704067200, // 2024-01-01 UTC
                  end_date: 1706745600,   // 2024-02-01 UTC
                  publisher_platform: ['FACEBOOK', 'INSTAGRAM'],
                  ad_snapshot_url: 'https://www.facebook.com/ads/library/?id=555',
                  page_id: '42', page_name: 'TestPage',
                  snapshot: {
                    body: { text: 'Hello body' },
                    title: 'My Headline',
                    link_url: 'https://www.shop.example.com/p?x=1',
                    cta_text: 'Shop Now',
                    images: [{ original_image_url: 'https://img/o.jpg', resized_image_url: 'https://img/r.jpg' }],
                    videos: [{ video_hd_url: 'https://vid/hd.mp4', video_sd_url: 'https://vid/sd.mp4', video_preview_image_url: 'https://vid/p.jpg' }],
                    cards: [],
                    page_id: '42', page_name: 'TestPage'
                  }
                }
              ]
            }
          }
        ]
      }
    }
  }
});

const ads = Parser.parsePayload(payload, 'https://www.facebook.com/api/graphql');
assert.strictEqual(ads.length, 1, 'one ad parsed from nested payload');

const ad = ads[0];
assert.strictEqual(ad.ad_archive_id, '555', 'id');
assert.strictEqual(ad.ad_status, 'active', 'status');
assert.strictEqual(ad.start_date, '2024-01-01', 'start_date iso');
assert.strictEqual(ad.end_date, '2024-02-01', 'end_date iso');
assert.ok(ad.days_running >= 30 && ad.days_running <= 32, 'days_running ~31, got ' + ad.days_running);
assert.strictEqual(ad.headline, 'My Headline', 'headline');
assert.strictEqual(ad.body_text, 'Hello body', 'body_text');
assert.strictEqual(ad.cta_text, 'Shop Now', 'cta_text');
assert.strictEqual(ad.landing_domain, 'shop.example.com', 'landing_domain (www stripped)');
assert.deepStrictEqual(ad.publisher_platforms, ['facebook', 'instagram'], 'platforms lowercased');
assert.strictEqual(ad.images.length, 1, 'one image');
assert.strictEqual(ad.images[0].original, 'https://img/o.jpg', 'image original url');
assert.strictEqual(ad.videos.length, 1, 'one video');
assert.strictEqual(ad.videos[0].hd, 'https://vid/hd.mp4', 'video hd url');
assert.strictEqual(ad.page_name, 'TestPage', 'page_name');
assert.strictEqual(ad.source, 'graphql', 'source tag');

// дедуп: тот же payload дважды (поток JSON по строкам) -> одна карточка
const twice = Parser.parsePayload(payload + '\n' + payload, '');
assert.strictEqual(twice.length, 1, 'dedup by ad_archive_id');

// мусор не валит парсер
assert.deepStrictEqual(Parser.parsePayload('not json at all', ''), [], 'garbage -> []');
assert.deepStrictEqual(Parser.parsePayload('', ''), [], 'empty -> []');

// helpers
assert.strictEqual(Parser._internal.domainOf('https://www.acme.com/x'), 'acme.com', 'domainOf');
assert.strictEqual(Parser._internal.toIsoDate(1704067200), '2024-01-01', 'toIsoDate epoch seconds');
assert.strictEqual(Parser._internal.toIsoDate(null), null, 'toIsoDate null');

console.log('graphql-parser.test OK');
