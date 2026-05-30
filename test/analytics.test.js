/*
 * test/analytics.test.js — computeSummary + buildJSON/buildCSV на фикстуре.
 */
'use strict';

const assert = require('assert');
const Analytics = require('../src/lib/analytics.js');
const Exp = require('../src/lib/exporter.js');
const { ads, dataset } = require('./fixtures.js');

const s = Analytics.computeSummary(ads, { id: '999', name: 'ACME' });

assert.strictEqual(s.total, ads.length, 'total');
assert.strictEqual(s.active + s.inactive, ads.length, 'active + inactive == total');
assert.strictEqual(s.active, 2, 'active count');
assert.strictEqual(s.inactive, 1, 'inactive count');

assert.ok(Array.isArray(s.longevity_top) && s.longevity_top.length > 0, 'longevity_top present');
for (let i = 1; i < s.longevity_top.length; i++) {
  assert.ok(s.longevity_top[i - 1].days_running >= s.longevity_top[i].days_running, 'longevity_top sorted desc');
}
assert.strictEqual(s.longevity_top[0].ad_archive_id, '1001', 'longest-running ad first');

assert.ok(s.domains && Object.keys(s.domains).length > 0, 'domains frequency');
assert.strictEqual(s.domains['acme.com'], 2, 'acme.com counted twice');
assert.ok(s.ctas && Object.keys(s.ctas).length > 0, 'ctas frequency');
assert.ok(s.platforms && s.platforms.facebook >= 1 && s.platforms.instagram >= 1, 'platforms frequency');

assert.strictEqual(s.eu_data_available, true, 'eu_data_available');
assert.strictEqual(s.eu.ads_with_data, 2, 'eu ads_with_data');
assert.strictEqual(s.eu.total_reach, 62000, 'eu total_reach summed (50000 + 12000)');
assert.ok(s.first_seen && s.last_seen, 'first/last seen');

// CSV / JSON
const csv = Exp.buildCSV(dataset);
const lines = csv.split('\r\n');
assert.strictEqual(lines[0], Exp.CSV_COLUMNS.join(','), 'CSV header row matches CSV_COLUMNS');
assert.strictEqual(lines.length, ads.length + 1, 'CSV has header + one row per ad');

const parsed = JSON.parse(Exp.buildJSON(dataset));
assert.strictEqual(parsed.ads.length, ads.length, 'JSON round-trips ads');
assert.ok(parsed.meta && parsed.meta.page_id === '999', 'JSON keeps meta');

console.log('analytics.test OK');
