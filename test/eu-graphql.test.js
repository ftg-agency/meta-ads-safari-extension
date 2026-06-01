/*
 * test/eu-graphql.test.js — разбор данных охвата ЕС из РЕАЛЬНОГО graphql-ответа
 * (зафиксирован в test/fixtures/eu-graphql-sample.txt с живой страницы).
 * Это заменяет хрупкий парсинг DOM-модалки и убирает утечку памяти.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../src/lib/graphql-parser.js');

const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'eu-graphql-sample.txt'), 'utf8');
const payload = raw.split('=====FBALS_SPLIT=====')[0];

assert.ok(P.hasEuPayload(payload), 'hasEuPayload должен опознать ЕС-ответ');

const r = P.parseEuPayload(payload);
assert.ok(r, 'parseEuPayload вернул результат');
assert.strictEqual(r.eu_total_reach, 231, 'eu_total_reach = 231');

// сумма разбивки должна совпасть с общим охватом — это и ловило фейковые reach=2
const sum = r.eu_reach_breakdown.reduce((s, x) => s + x.reach, 0);
assert.strictEqual(sum, 231, 'сумма разбивки = eu_total_reach (' + sum + ')');
assert.ok(r.eu_reach_breakdown.length >= 100, 'разбивка содержит 100+ строк, got ' + r.eu_reach_breakdown.length);

// структура строки
const row = r.eu_reach_breakdown[0];
assert.ok(row.location && row.age && row.gender && typeof row.reach === 'number', 'строка разбивки полная');
assert.ok(['Male', 'Female', 'Unknown'].indexOf(row.gender) !== -1, 'gender нормализован');

// таргетинг + payer/beneficiary (бонус, которого не было в DOM-версии)
assert.strictEqual(r.targeting_gender, 'All', 'targeting_gender');
assert.strictEqual(r.targeting_age, '18-65', 'targeting_age');
assert.strictEqual(r.targeting_locations, 'Worldwide', 'targeting_locations');
assert.strictEqual(r.uk_total_reach, 10, 'uk_total_reach = 10');
assert.strictEqual(r.payer, 'WASL APPS LLC', 'payer');
assert.strictEqual(r.beneficiary, 'WASL APPS LLC', 'beneficiary');

// мусор не валит
assert.strictEqual(P.parseEuPayload('not json'), null, 'мусор -> null');
assert.strictEqual(P.hasEuPayload('{"x":1}'), false, 'обычный payload без ЕС -> false');

console.log('eu-graphql.test OK (reach 231, ' + r.eu_reach_breakdown.length + ' rows, sum=' + sum + ')');
