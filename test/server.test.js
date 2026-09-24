'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wci-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_KEY = 'adminpass';
process.env.ORG_KEYS = JSON.stringify({ nch: 'orgpass' });
const { app } = require('../server');

let server, base;
test.before(() => new Promise((res) => { server = app.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; res(); }); }));
test.after(() => server.close());

function post(body) {
  return fetch(base + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const auth = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(u + ':' + p).toString('base64') });

test('rejects bad events and stores good ones without personal data', async () => {
  assert.strictEqual((await post({ anon: 'x', events: [] })).status, 400);
  for (let i = 0; i < 6; i++) {
    const anon = ('a' + i).padEnd(24, '0');
    const r = await post({ anon, org: 'nch', events: [{ type: 'complete', value: 1234, flags: [{ s: 'uc', t: 'likely' }, { s: 'cb', t: 'likely' }, { s: 'bogus', t: 'likely' }], income: 999 }] });
    assert.strictEqual(r.status, 200);
  }
  await post({ anon: 'a0'.padEnd(24, '0'), org: 'nch', events: [{ type: 'apply_click', scheme: 'uc' }] });
  const raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  assert.ok(!raw.includes('income'));
  assert.ok(!raw.includes('bogus'));
});

test('dashboard needs auth and scopes to org', async () => {
  assert.strictEqual((await fetch(base + '/dashboard')).status, 401);
  const r = await fetch(base + '/dashboard', { headers: auth('nch', 'orgpass') });
  assert.strictEqual(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('Universal Credit'));
  const csv = await fetch(base + '/dashboard.csv', { headers: auth('admin', 'adminpass') });
  assert.strictEqual(csv.status, 200);
  const text = await csv.text();
  assert.ok(text.includes('completed,6'));
  assert.ok(text.includes('<5')); // small-number suppression for apply clicks
});

test('app shell and rules are served', async () => {
  assert.strictEqual((await fetch(base + '/')).status, 200);
  assert.strictEqual((await fetch(base + '/rules.js')).status, 200);
  assert.strictEqual((await fetch(base + '/healthz')).status, 200);
});
