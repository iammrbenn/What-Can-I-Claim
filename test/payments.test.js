'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wci-pay-'));
process.env.DATA_DIR = dir;
process.env.STRIPE_PRICE_ID = 'price_test123';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.ORG_KEYS = JSON.stringify({ nch: 'orgpass' });
delete process.env.STRIPE_SECRET_KEY;

const { app, setStripe, _licences } = require('../server');

// Real Stripe client (for offline webhook signing) with network calls faked
const stripe = require('stripe')('sk_test_fake');
const sessions = {};
let created = null;
stripe.checkout.sessions.create = async (params) => {
  created = params;
  const id = 'cs_test_' + Object.keys(sessions).length.toString().padStart(12, '0');
  sessions[id] = { id, metadata: params.metadata, payment_status: 'unpaid' };
  return { id, url: 'https://checkout.stripe.com/c/pay/' + id };
};
stripe.checkout.sessions.retrieve = async (id) => sessions[id];
setStripe(stripe);

let server, base;
test.before(() => new Promise((res) => { server = app.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; res(); }); }));
test.after(() => server.close());

const json = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const anon = 'b'.repeat(24);

test('config reports payments and sponsorship', async () => {
  const c = await (await fetch(base + '/api/config?org=public')).json();
  assert.strictEqual(c.payEnabled, true);
  assert.strictEqual(c.sponsored, false);
  const s = await (await fetch(base + '/api/config?org=nch')).json();
  assert.strictEqual(s.sponsored, true);
});

test('checkout requires consent and creates a one-off session with the code on the receipt', async () => {
  const bad = await json('/api/checkout', { anon, org: 'public' });
  assert.strictEqual(bad.ok, false);
  const ok = await json('/api/checkout', { anon, org: 'public', consent: true });
  assert.ok(ok.url.startsWith('https://checkout.stripe.com/'));
  assert.strictEqual(created.mode, 'payment');
  assert.strictEqual(created.line_items[0].price, 'price_test123');
  assert.match(created.payment_intent_data.description, /WCI-[A-Z0-9]{5}-[A-Z0-9]{5}/);
  assert.match(created.success_url, /\{CHECKOUT_SESSION_ID\}/);
});

test('unpaid session does not unlock; paid session does; code then verifies', async () => {
  const id = Object.keys(sessions)[0];
  const code = sessions[id].metadata.code;
  let r = await (await fetch(base + '/api/checkout/confirm?session_id=' + id)).json();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.pending, true);
  assert.strictEqual((await json('/api/licence/verify', { code, anon })).ok, false);

  sessions[id].payment_status = 'paid';
  r = await (await fetch(base + '/api/checkout/confirm?session_id=' + id)).json();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, code);
  assert.strictEqual((await json('/api/licence/verify', { code: code.toLowerCase(), anon })).ok, true);
  assert.strictEqual((await json('/api/licence/verify', { code: 'WCI-AAAAA-BBBBB', anon })).ok, false);
});

test('device limit enforced', async () => {
  const code = Object.keys(_licences()).find((c) => _licences()[c].status === 'paid');
  for (let i = 0; i < 4; i++) assert.strictEqual((await json('/api/licence/verify', { code, anon: String(i).repeat(24) })).ok, true);
  const over = await json('/api/licence/verify', { code, anon: 'f'.repeat(24) });
  assert.strictEqual(over.ok, false);
});

test('signed webhook unlocks a paid session even if the buyer never returns', async () => {
  await json('/api/checkout', { anon, org: 'public', consent: true });
  const id = Object.keys(sessions)[1];
  const code = sessions[id].metadata.code;
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: { id, payment_status: 'paid', metadata: sessions[id].metadata } } });
  const badSig = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=bad' }, body: payload });
  assert.strictEqual(badSig.status, 400);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
  const good = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': header }, body: payload });
  assert.strictEqual(good.status, 200);
  assert.strictEqual(_licences()[code].status, 'paid');
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  assert.ok(events.includes('"purchase"'));
});
