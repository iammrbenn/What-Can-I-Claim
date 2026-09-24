/*
 * WhatCanIClaim? - MVP server
 *
 * - Serves the web app (all screening runs in the browser; no personal data is sent here).
 * - Collects ANONYMOUS usage events for pilot-partner dashboards.
 * - Partner dashboard at /dashboard (HTTP Basic auth).
 *
 * Env vars:
 *   PORT        - set by Railway
 *   DATA_DIR    - where events.jsonl is stored (mount a Railway volume, e.g. /data)
 *   ADMIN_KEY   - password for user "admin" (sees every organisation)
 *   ORG_KEYS    - JSON map of org code -> password, e.g. {"nch":"secret1","ncu":"secret2"}
 *                 Users arriving via a partner link (?org=code) get the full app free.
 *   STRIPE_SECRET_KEY      - sk_live_... / sk_test_...  (one-off unlock payment)
 *   STRIPE_PRICE_ID        - price_... for a ONE-TIME price (e.g. 4.99 GBP)
 *   STRIPE_WEBHOOK_SECRET  - whsec_... for /api/stripe/webhook
 *   PUBLIC_URL             - optional, e.g. https://whatcaniclaim.co.uk (else taken from the request)
 *   MAX_DEVICES            - devices one unlock code can be used on (default 5)
 *
 * Pure ASCII file.
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Rules = require('./rules');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
let ORG_KEYS = {};
try { ORG_KEYS = JSON.parse(process.env.ORG_KEYS || '{}'); } catch (e) { console.error('ORG_KEYS is not valid JSON'); }

fs.mkdirSync(DATA_DIR, { recursive: true });

const SMALL_NUMBER = 5; // suppress counts under this on dashboards
const MAX_DEVICES = parseInt(process.env.MAX_DEVICES || '5', 10);
const LICENCE_FILE = path.join(DATA_DIR, 'licences.json');

// ---------------------------------------------------------------------------
// Stripe (one-off unlock). Injectable so tests can use a fake client.
// ---------------------------------------------------------------------------
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
let priceDisplay = process.env.PRICE_DISPLAY || '\u00A34.99';
function paymentsEnabled() { return !!(stripe && PRICE_ID); }
function setStripe(client) { stripe = client; }

async function loadPriceDisplay() {
  if (!paymentsEnabled()) return;
  try {
    const p = await stripe.prices.retrieve(PRICE_ID);
    if (p && p.unit_amount != null) {
      const sym = { gbp: '\u00A3', usd: '$', eur: '\u20AC' }[p.currency] || '';
      priceDisplay = sym + (p.unit_amount / 100).toFixed(2);
    }
    if (p && p.type !== 'one_time') console.warn('WARNING: STRIPE_PRICE_ID is not a one-time price');
  } catch (e) {
    console.warn('Could not load Stripe price:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Licence store: { CODE: { status: 'pending'|'paid', session, created, paidAt, devices: [anon] } }
// ---------------------------------------------------------------------------
let licences = {};
try { licences = JSON.parse(fs.readFileSync(LICENCE_FILE, 'utf8')); } catch (e) { licences = {}; }
function saveLicences() {
  const tmp = LICENCE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(licences));
  fs.renameSync(tmp, LICENCE_FILE);
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
function newCode() {
  let code;
  do {
    const b = crypto.randomBytes(10);
    let s = '';
    for (let i = 0; i < 10; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
    code = 'WCI-' + s.slice(0, 5) + '-' + s.slice(5);
  } while (licences[code]);
  return code;
}
function normCode(c) {
  return typeof c === 'string' ? c.trim().toUpperCase().replace(/\s+/g, '') : '';
}
function markPaid(code, sessionId) {
  const l = licences[code];
  if (!l) { licences[code] = { status: 'paid', session: sessionId, created: new Date().toISOString(), paidAt: new Date().toISOString(), devices: [] }; }
  else if (l.status !== 'paid') { l.status = 'paid'; l.paidAt = new Date().toISOString(); }
  else return false;
  saveLicences();
  return true;
}
function isSponsored(org) {
  return typeof org === 'string' && org !== 'public' && Object.prototype.hasOwnProperty.call(ORG_KEYS, org);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self' https://api.postcodes.io; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

// Stripe webhook needs the raw body, so it goes before express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '256kb' }), (req, res) => {
  if (!stripe || !WEBHOOK_SECRET) return res.status(400).send('Webhook not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send('Bad signature');
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object;
    const code = s.metadata && normCode(s.metadata.code);
    if (code && s.payment_status === 'paid' && markPaid(code, s.id)) {
      logEvent({ type: 'purchase', org: s.metadata.org, a: s.metadata.anon });
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '32kb' }));

// Shared rules file is served to the browser
app.get('/rules.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'rules.js'));
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));

app.get('/healthz', (req, res) => res.json({ ok: true, rulesReviewed: Rules.RATES.reviewed }));

// ---------------------------------------------------------------------------
// Anonymous events
// ---------------------------------------------------------------------------
const EVENT_TYPES = new Set(['start', 'complete', 'apply_click', 'status', 'paywall_view', 'checkout_start']);
const TIERS = new Set(['likely', 'possible', 'check', 'receiving']);
const STATUSES = new Set(['none', 'applying', 'receiving', 'not_eligible']);
const SCHEME_IDS = new Set(Rules.SCHEME_IDS);

// Minimal in-memory rate limit (IP is never stored)
const hits = new Map();
setInterval(() => hits.clear(), 60 * 1000).unref();
function rateLimited(ip) {
  const key = crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
  const count = (hits.get(key) || 0) + 1;
  hits.set(key, count);
  return count > 60;
}

function cleanOrg(o) {
  return typeof o === 'string' && /^[a-z0-9-]{1,32}$/.test(o) ? o : 'public';
}

function cleanEvent(e) {
  if (!e || !EVENT_TYPES.has(e.type)) return null;
  const out = { type: e.type };
  if (e.type === 'complete') {
    out.value = Math.max(0, Math.min(100000, Math.round(Number(e.value) / 50) * 50 || 0));
    out.flags = Array.isArray(e.flags)
      ? e.flags.slice(0, 80)
        .filter((f) => f && SCHEME_IDS.has(f.s) && TIERS.has(f.t))
        .map((f) => ({ s: f.s, t: f.t }))
      : [];
  }
  if (e.type === 'apply_click') {
    if (!SCHEME_IDS.has(e.scheme)) return null;
    out.scheme = e.scheme;
  }
  if (e.type === 'status') {
    if (!SCHEME_IDS.has(e.scheme) || !STATUSES.has(e.status)) return null;
    out.scheme = e.scheme;
    out.status = e.status;
  }
  return out;
}

app.post('/api/events', (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ ok: false });
  const body = req.body || {};
  const anon = typeof body.anon === 'string' && /^[a-f0-9]{16,32}$/.test(body.anon) ? body.anon : null;
  if (!anon || !Array.isArray(body.events)) return res.status(400).json({ ok: false });
  const org = cleanOrg(body.org);
  const day = new Date().toISOString().slice(0, 10); // day only - no precise timestamps
  const lines = body.events.slice(0, 10).map(cleanEvent).filter(Boolean)
    .map((e) => JSON.stringify(Object.assign({ d: day, org: org, a: anon }, e)));
  if (!lines.length) return res.status(400).json({ ok: false });
  fs.appendFile(EVENTS_FILE, lines.join('\n') + '\n', (err) => {
    if (err) { console.error('event write failed', err.message); return res.status(500).json({ ok: false }); }
    res.json({ ok: true });
  });
});

// Server-side event (e.g. purchase) - same anonymous format
function logEvent(e) {
  const anon = typeof e.a === 'string' && /^[a-f0-9]{16,32}$/.test(e.a) ? e.a : 'server';
  const line = JSON.stringify({ d: new Date().toISOString().slice(0, 10), org: cleanOrg(e.org), a: anon, type: e.type });
  fs.appendFile(EVENTS_FILE, line + '\n', () => {});
}

// ---------------------------------------------------------------------------
// One-off unlock
// ---------------------------------------------------------------------------
function baseUrl(req) {
  return (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
}

app.get('/api/config', (req, res) => {
  const org = cleanOrg(req.query.org);
  res.json({
    payEnabled: paymentsEnabled(),
    priceDisplay,
    sponsored: isSponsored(org)
  });
});

app.post('/api/checkout', async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ ok: false });
  if (!paymentsEnabled()) return res.status(503).json({ ok: false, error: 'Payments are not set up yet.' });
  const body = req.body || {};
  if (body.consent !== true) return res.status(400).json({ ok: false, error: 'Please confirm you want immediate access.' });
  const anon = typeof body.anon === 'string' && /^[a-f0-9]{16,32}$/.test(body.anon) ? body.anon : '';
  const org = cleanOrg(body.org);
  const code = newCode();
  try {
    const base = baseUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: base + '/?paid={CHECKOUT_SESSION_ID}',
      cancel_url: base + '/?cancelled=1',
      allow_promotion_codes: true,
      metadata: { code, anon, org },
      payment_intent_data: {
        description: 'WhatCanIClaim? lifetime unlock. Your unlock code: ' + code,
        metadata: { code }
      },
      custom_text: {
        submit: { message: 'You get full access straight away. By paying you agree that your 14-day right to cancel ends once access starts.' }
      }
    });
    licences[code] = { status: 'pending', session: session.id, created: new Date().toISOString(), consentAt: new Date().toISOString(), devices: anon ? [anon] : [] };
    saveLicences();
    res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error('checkout failed', e.message);
    res.status(502).json({ ok: false, error: 'Could not start payment. Please try again.' });
  }
});

// Called when Stripe redirects back after payment
app.get('/api/checkout/confirm', async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ ok: false });
  const id = typeof req.query.session_id === 'string' && /^cs_[A-Za-z0-9_]{10,200}$/.test(req.query.session_id) ? req.query.session_id : null;
  if (!id || !stripe) return res.status(400).json({ ok: false });
  try {
    const s = await stripe.checkout.sessions.retrieve(id);
    const code = s.metadata && normCode(s.metadata.code);
    if (!code) return res.status(404).json({ ok: false });
    if (s.payment_status !== 'paid') return res.json({ ok: false, pending: true });
    if (markPaid(code, s.id)) logEvent({ type: 'purchase', org: s.metadata.org, a: s.metadata.anon });
    res.json({ ok: true, code });
  } catch (e) {
    res.status(502).json({ ok: false });
  }
});

// Use an unlock code on this (or another) device
app.post('/api/licence/verify', (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ ok: false });
  const code = normCode((req.body || {}).code);
  const anon = (req.body || {}).anon;
  const l = licences[code];
  if (!l || l.status !== 'paid') return res.json({ ok: false, error: 'That code is not recognised. Check it matches the code on your receipt.' });
  if (typeof anon === 'string' && /^[a-f0-9]{16,32}$/.test(anon) && l.devices.indexOf(anon) === -1) {
    if (l.devices.length >= MAX_DEVICES) return res.json({ ok: false, error: 'This code has been used on ' + MAX_DEVICES + ' devices already. Contact us if you need help.' });
    l.devices.push(anon);
    saveLicences();
  }
  res.json({ ok: true, code });
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
let cache = { mtime: 0, events: [] };
function loadEvents() {
  let stat;
  try { stat = fs.statSync(EVENTS_FILE); } catch (e) { return []; }
  if (stat.mtimeMs === cache.mtime) return cache.events;
  const events = [];
  fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').forEach((line) => {
    if (!line) return;
    try { events.push(JSON.parse(line)); } catch (e) { /* skip bad line */ }
  });
  cache = { mtime: stat.mtimeMs, events };
  return events;
}

function aggregate(org, from, to) {
  const events = loadEvents().filter((e) =>
    (org === '*' || e.org === org) && (!from || e.d >= from) && (!to || e.d <= to));
  const started = new Set();
  const latestComplete = new Map(); // anon -> complete event
  const applyClicks = new Map(); // scheme -> Set(anon)
  const applyUsers = new Set();
  const statusLatest = new Map(); // anon|scheme -> status
  const paywall = new Set();
  const checkout = new Set();
  let purchases = 0;
  events.forEach((e) => {
    if (e.type === 'paywall_view') paywall.add(e.a);
    if (e.type === 'checkout_start') checkout.add(e.a);
    if (e.type === 'purchase') purchases += 1;
    if (e.type === 'start') started.add(e.a);
    if (e.type === 'complete') { started.add(e.a); latestComplete.set(e.a, e); }
    if (e.type === 'apply_click') {
      if (!applyClicks.has(e.scheme)) applyClicks.set(e.scheme, new Set());
      applyClicks.get(e.scheme).add(e.a);
      applyUsers.add(e.a);
    }
    if (e.type === 'status') statusLatest.set(e.a + '|' + e.scheme, e.status);
  });

  const completed = latestComplete.size;
  let totalValue = 0;
  let totalFlags = 0;
  const flagCounts = new Map(); // scheme -> {likely, possible, check, receiving}
  latestComplete.forEach((e) => {
    totalValue += e.value || 0;
    (e.flags || []).forEach((f) => {
      if (f.t !== 'receiving') totalFlags += f.t === 'check' ? 0 : 1;
      if (!flagCounts.has(f.s)) flagCounts.set(f.s, { likely: 0, possible: 0, check: 0, receiving: 0 });
      flagCounts.get(f.s)[f.t] += 1;
    });
  });

  const applying = new Map();
  const receivingNew = new Map();
  statusLatest.forEach((status, key) => {
    const scheme = key.split('|')[1];
    if (status === 'applying') applying.set(scheme, (applying.get(scheme) || 0) + 1);
    if (status === 'receiving') receivingNew.set(scheme, (receivingNew.get(scheme) || 0) + 1);
  });

  const names = {};
  Rules.SCHEMES.forEach((s) => { names[s.id] = s.name; });
  const schemes = Array.from(new Set([...flagCounts.keys(), ...applyClicks.keys()])).map((id) => {
    const f = flagCounts.get(id) || { likely: 0, possible: 0, check: 0, receiving: 0 };
    return {
      id, name: names[id] || id,
      missed: f.likely + f.possible,
      likely: f.likely, possible: f.possible, check: f.check, alreadyReceiving: f.receiving,
      applyClicks: applyClicks.has(id) ? applyClicks.get(id).size : 0,
      markedApplying: applying.get(id) || 0,
      markedReceiving: receivingNew.get(id) || 0
    };
  }).sort((a, b) => b.missed - a.missed);

  return {
    started: started.size,
    completed,
    completionRate: started.size ? completed / started.size : 0,
    avgMissedPerHousehold: completed ? totalFlags / completed : 0,
    fixedValueIdentified: totalValue,
    usersClickedApply: applyUsers.size,
    applyRate: completed ? applyUsers.size / completed : 0,
    paywallViews: paywall.size,
    checkoutStarts: checkout.size,
    purchases,
    conversion: paywall.size ? purchases / paywall.size : 0,
    schemes
  };
}

// ---------------------------------------------------------------------------
// Dashboard (Basic auth: user = org code or "admin")
// ---------------------------------------------------------------------------
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    if (user === 'admin' && ADMIN_KEY && safeEqual(pass, ADMIN_KEY)) { req.scope = '*'; return next(); }
    if (ORG_KEYS[user] && safeEqual(pass, ORG_KEYS[user])) { req.scope = user; return next(); }
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="WhatCanIClaim partner dashboard"');
  res.status(401).send('Authentication required');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function sup(nv) { return nv > 0 && nv < SMALL_NUMBER ? '&lt;' + SMALL_NUMBER : String(nv); }
function pct(x) { return Math.round(x * 100) + '%'; }
function dateParam(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; }

function resolveOrg(req) {
  if (req.scope !== '*') return req.scope;
  const q = typeof req.query.org === 'string' ? req.query.org : '*';
  return q === '*' ? '*' : cleanOrg(q);
}

app.get('/dashboard', auth, (req, res) => {
  const org = resolveOrg(req);
  const from = dateParam(req.query.from);
  const to = dateParam(req.query.to);
  const a = aggregate(org, from, to);
  const tooFew = a.completed < SMALL_NUMBER;
  const rows = a.schemes.map((s) => '<tr><td>' + esc(s.name) + '</td><td>' + sup(s.missed) + '</td><td>' + sup(s.likely) +
    '</td><td>' + sup(s.possible) + '</td><td>' + sup(s.alreadyReceiving) + '</td><td>' + sup(s.applyClicks) +
    '</td><td>' + sup(s.markedApplying) + '</td><td>' + sup(s.markedReceiving) + '</td></tr>').join('');
  const orgs = req.scope === '*'
    ? '<label>Organisation <select name="org"><option value="*">All</option>' +
      Array.from(new Set(loadEvents().map((e) => e.org))).sort().map((o) =>
        '<option value="' + esc(o) + '"' + (o === org ? ' selected' : '') + '>' + esc(o) + '</option>').join('') +
      '</select></label>'
    : '';
  const q = new URLSearchParams({ org, from, to }).toString();
  res.send(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Partner dashboard - WhatCanIClaim?</title><link rel="stylesheet" href="/styles.css"></head>
<body class="dash"><header class="top"><span class="brand">WhatCanIClaim?</span><span class="muted">Partner dashboard - ${esc(org === '*' ? 'all organisations' : org)}</span></header>
<main class="wrap">
<form class="filters" method="get">${orgs}
<label>From <input type="date" name="from" value="${esc(from)}"></label>
<label>To <input type="date" name="to" value="${esc(to)}"></label>
<button class="btn" type="submit">Update</button> <a class="btn ghost" href="/dashboard.csv?${esc(q)}">Download CSV</a></form>
${tooFew ? '<p class="notice">Fewer than ' + SMALL_NUMBER + ' completed checks in this period, so figures are hidden to protect anonymity.</p>' : `
<div class="kpis">
<div class="kpi"><b>${a.started}</b><span>Started a check</span></div>
<div class="kpi"><b>${a.completed}</b><span>Completed (${pct(a.completionRate)})</span></div>
<div class="kpi"><b>${a.avgMissedPerHousehold.toFixed(1)}</b><span>Likely or possible schemes missed per household</span></div>
<div class="kpi"><b>${Rules.money(a.fixedValueIdentified)}</b><span>Fixed-value support identified (a year)</span></div>
<div class="kpi"><b>${a.usersClickedApply}</b><span>Went to an application (${pct(a.applyRate)})</span></div>
</div>
${req.scope === '*' ? `<h2>Paid unlocks</h2><div class="kpis">
<div class="kpi"><b>${a.paywallViews}</b><span>Saw the unlock offer</span></div>
<div class="kpi"><b>${a.checkoutStarts}</b><span>Started checkout</span></div>
<div class="kpi"><b>${a.purchases}</b><span>Paid (${pct(a.conversion)} of offers)</span></div>
</div>` : ''}
<p class="muted small">Value only includes fixed-amount items (e.g. Carer's Allowance, Child Benefit, Warm Home Discount). Means-tested benefits such as Universal Credit and Pension Credit are counted as schemes but not valued. Counts under ${SMALL_NUMBER} are shown as &lt;${SMALL_NUMBER}.</p>
<div class="tablewrap"><table><thead><tr><th>Scheme</th><th>Missed (likely + possible)</th><th>Likely</th><th>Possible</th><th>Already receiving</th><th>Clicked apply</th><th>Marked applying</th><th>Marked receiving</th></tr></thead>
<tbody>${rows || '<tr><td colspan="8">No data yet</td></tr>'}</tbody></table></div>`}
<p class="muted small">No names, contact details, postcodes, incomes or health information are collected. Each device has a random ID so repeat visits are not double-counted.</p>
</main></body></html>`);
});

app.get('/dashboard.csv', auth, (req, res) => {
  const org = resolveOrg(req);
  const a = aggregate(org, dateParam(req.query.from), dateParam(req.query.to));
  if (a.completed < SMALL_NUMBER) return res.status(403).send('Too few completed checks to export.');
  const s = (nv) => (nv > 0 && nv < SMALL_NUMBER ? '<' + SMALL_NUMBER : String(nv));
  const lines = ['scheme,missed,likely,possible,already_receiving,apply_clicks,marked_applying,marked_receiving'];
  a.schemes.forEach((r) => lines.push(['"' + r.name.replace(/"/g, '""') + '"', s(r.missed), s(r.likely), s(r.possible),
    s(r.alreadyReceiving), s(r.applyClicks), s(r.markedApplying), s(r.markedReceiving)].join(',')));
  lines.push('');
  lines.push('started,' + a.started);
  lines.push('completed,' + a.completed);
  lines.push('fixed_value_identified_gbp,' + a.fixedValueIdentified);
  lines.push('users_clicked_apply,' + a.usersClickedApply);
  if (req.scope === '*') { lines.push('paywall_views,' + a.paywallViews); lines.push('checkout_starts,' + a.checkoutStarts); lines.push('purchases,' + a.purchases); }
  res.type('text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="whatcaniclaim-' + (org === '*' ? 'all' : org) + '.csv"');
  res.send(lines.join('\n'));
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  loadPriceDisplay().finally(() => {
    app.listen(PORT, () => {
      console.log('WhatCanIClaim? running on port ' + PORT + ' (rules reviewed ' + Rules.RATES.reviewed + ')');
      if (!paymentsEnabled()) console.warn('WARNING: Stripe not configured - the full app is FREE for everyone until STRIPE_SECRET_KEY and STRIPE_PRICE_ID are set.');
      if (paymentsEnabled() && !WEBHOOK_SECRET) console.warn('WARNING: STRIPE_WEBHOOK_SECRET not set - payments only unlock if the buyer returns to the site.');
    });
  });
}

module.exports = { app, aggregate, setStripe, _licences: () => licences };
