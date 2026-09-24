'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../rules');

function tierOf(out, id) {
  const r = out.results.find((x) => x.id === id);
  return r ? r.tier : null;
}

test('single parent, private renter, part-time work, no benefits', () => {
  const out = R.evaluate({
    district: 'Nottingham', age: 31, relationship: 'single', kidsCount: 2, kids: [3, 8], childDisabled: 'no',
    pregnant: 'no', otherAdults: 0, youWork: 'employed', youNet: 1100, otherIncome: 0,
    housing: 'private', rent: 750, ctAnnual: 1800, water: 'severn', savings: 'under6', caring: 'none',
    health: [], childcareCost: 200, receiving: [], have: []
  });
  assert.strictEqual(tierOf(out, 'uc'), 'likely');
  assert.strictEqual(tierOf(out, 'cb'), 'likely');
  assert.strictEqual(tierOf(out, 'fsm'), 'possible');
  assert.strictEqual(tierOf(out, 'childcarehours'), 'likely');
  assert.strictEqual(tierOf(out, 'spd'), 'likely');
  assert.strictEqual(tierOf(out, 'tfc'), 'check'); // UC vs TFC trade-off flagged
  const cb = out.results.find((r) => r.id === 'cb');
  assert.strictEqual(cb.value, Math.round((27.05 + 17.9) * 52));
  const spd = out.results.find((r) => r.id === 'spd');
  assert.strictEqual(spd.value, 450);
  assert.ok(out.summary.likelyValue >= cb.value + spd.value);
});

test('single pensioner on low State Pension, lives alone, with a health condition', () => {
  const out = R.evaluate({
    district: 'Mansfield', age: 78, relationship: 'single', kidsCount: 0, otherAdults: 0,
    youWork: 'retired', otherIncome: 900, housing: 'owned', water: 'severn', savings: 'under6',
    caring: 'none', health: ['you'], mobility: 'yes', receiving: ['sp'], have: []
  });
  assert.strictEqual(tierOf(out, 'pc'), 'likely');
  assert.strictEqual(tierOf(out, 'aa'), 'possible');
  assert.strictEqual(tierOf(out, 'buspass'), 'likely');
  assert.strictEqual(tierOf(out, 'spd'), 'likely');
  assert.strictEqual(tierOf(out, 'uc'), null);
  assert.strictEqual(tierOf(out, 'pip'), null);
  assert.strictEqual(tierOf(out, 'whd'), 'check'); // qualifying date passed
});

test('carer earning under the limit gets Carer\'s Allowance valued', () => {
  const out = R.evaluate({
    district: 'Gedling', age: 45, relationship: 'married', partnerAge: 47, kidsCount: 0, otherAdults: 0,
    youWork: 'employed', youNet: 650, partnerWork: 'employed', partnerNet: 2600, otherIncome: 0,
    housing: 'mortgage', water: 'severn', savings: '6to16', caring: '35plus', caredBenefit: 'yes',
    health: [], receiving: [], have: []
  });
  const ca = out.results.find((r) => r.id === 'ca');
  assert.strictEqual(ca.tier, 'likely');
  assert.strictEqual(ca.value, Math.round(86.45 * 52));
  assert.strictEqual(tierOf(out, 'marriage'), 'likely');
});

test('carer earning over the limit is only "check"', () => {
  const out = R.evaluate({ age: 40, relationship: 'single', youWork: 'employed', youNet: 1500, caring: '35plus', caredBenefit: 'yes', savings: 'under6', housing: 'owned', receiving: [] });
  assert.strictEqual(tierOf(out, 'ca'), 'check');
});

test('already-received schemes move to receiving and are not valued', () => {
  const out = R.evaluate({
    age: 35, relationship: 'single', kidsCount: 1, kids: [5], youWork: 'none', otherIncome: 0,
    housing: 'social', rent: 450, savings: 'under6', caring: 'none', health: [],
    receiving: ['uc', 'cb', 'ctr'], have: ['fsm']
  });
  assert.strictEqual(tierOf(out, 'uc'), 'receiving');
  assert.strictEqual(tierOf(out, 'cb'), 'receiving');
  assert.strictEqual(tierOf(out, 'fsm'), 'receiving');
  assert.strictEqual(tierOf(out, 'whd'), 'likely');
  assert.strictEqual(tierOf(out, 'nhsbenefit'), 'likely');
  assert.strictEqual(tierOf(out, 'socialtariff'), 'likely');
  assert.ok(out.results.filter((r) => r.tier === 'receiving').every((r) => r.value === null));
});

test('high-earning couple gets few suggestions and no UC', () => {
  const out = R.evaluate({
    district: 'Rushcliffe', age: 40, relationship: 'married', partnerAge: 41, kidsCount: 1, kids: [10],
    youWork: 'employed', youNet: 7000, partnerWork: 'employed', partnerNet: 4000, otherIncome: 0,
    highEarner: 'over100', housing: 'mortgage', water: 'severn', savings: 'over16', caring: 'none',
    health: [], childcareCost: 300, receiving: [], have: []
  });
  assert.strictEqual(tierOf(out, 'uc'), null);
  assert.strictEqual(tierOf(out, 'tfc'), null);
  assert.strictEqual(tierOf(out, 'cb'), 'check');
  assert.strictEqual(out.summary.likelyValue, 0);
});

test('works anywhere in England with council-specific wording', () => {
  const out = R.evaluate({ district: 'Leeds', region: 'Yorkshire and The Humber', country: 'England', age: 30, relationship: 'single', youWork: 'none', otherIncome: 0, housing: 'private', rent: 600, water: 'yorkshire', savings: 'under6', receiving: [] });
  assert.strictEqual(out.summary.inEngland, true);
  assert.strictEqual(out.summary.council, 'Leeds');
  const crf = out.results.find((r) => r.id === 'crf');
  assert.ok(crf && crf.why.join(' ').includes('Leeds'));
  assert.strictEqual(crf.applyUrl, 'https://www.gov.uk/find-local-council');
  assert.strictEqual(tierOf(out, 'bigdiff'), null);
  assert.strictEqual(tierOf(out, 'watertariff'), 'check');
});

test('two-tier area: county runs the crisis fund, local overrides apply', () => {
  const out = R.evaluate({ district: 'Gedling', county: 'Nottinghamshire', region: 'East Midlands', country: 'England', age: 30, relationship: 'single', youWork: 'none', otherIncome: 0, housing: 'social', rent: 450, savings: 'under6', receiving: ['uc'] });
  const crf = out.results.find((r) => r.id === 'crf');
  assert.ok(crf.why.join(' ').includes('Nottinghamshire County Council'));
  assert.match(crf.applyUrl, /nottinghamshire\.gov\.uk/);
  assert.strictEqual(tierOf(out, 'ctr'), 'likely');
  const w = out.results.find((r) => r.id === 'watertariff');
  assert.strictEqual(w.tier, 'possible');
  assert.match(w.applyUrl, /ccw\.org\.uk/); // unknown company -> CCW list
});

test('London rents use a higher housing cap than the North East', () => {
  const base = { country: 'England', age: 35, relationship: 'single', youWork: 'employed', youNet: 1500, otherIncome: 0, housing: 'private', rent: 1600, savings: 'under6', receiving: [] };
  const london = R._internal.ucScreen(Object.assign({ region: 'London' }, base));
  const ne = R._internal.ucScreen(Object.assign({ region: 'North East' }, base));
  assert.ok(london > ne);
});

test('a means-tested household gets its own water company link', () => {
  const out = R.evaluate({ country: 'England', age: 40, relationship: 'single', youWork: 'none', otherIncome: 0, housing: 'social', rent: 500, water: 'thames', savings: 'under6', receiving: ['uc'] });
  const w = out.results.find((r) => r.id === 'watertariff');
  assert.strictEqual(w.tier, 'possible');
  assert.strictEqual(w.applyUrl, 'https://www.thameswater.co.uk/');
});

test('outside England is flagged', () => {
  const out = R.evaluate({ country: 'Wales', age: 30, relationship: 'single', youWork: 'none', housing: 'private', rent: 500, savings: 'under6', receiving: [] });
  assert.strictEqual(out.summary.inEngland, false);
  assert.strictEqual(tierOf(out, 'crf'), null);
});

test('empty profile does not throw', () => {
  const out = R.evaluate({});
  assert.ok(Array.isArray(out.results));
});

test('every scheme has official links and review date', () => {
  R.SCHEMES.forEach((s) => {
    assert.match(s.applyUrl, /^https:\/\//, s.id);
    assert.match(s.sourceUrl, /^https:\/\//, s.id);
    assert.match(s.reviewed, /^\d{4}-\d{2}-\d{2}$/, s.id);
    assert.ok(s.evidence.length > 0, s.id);
  });
});
