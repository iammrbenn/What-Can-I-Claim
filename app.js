/*
 * WhatCanIClaim? - front end (vanilla JS, no build step)
 * Answers and wallet are stored in localStorage on the user's device only.
 * Pure ASCII file - symbols use \u escapes.
 */
(function () {
  'use strict';

  var R = window.WCIRules;
  var GBP = '\u00A3';
  var KEYS = { profile: 'wci.profile.v1', wallet: 'wci.wallet.v1', anon: 'wci.anon', org: 'wci.org', step: 'wci.step', licence: 'wci.licence' };
  var app = document.getElementById('app');

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  function load(k, d) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
  }
  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode - keep in memory */ }
  }
  function forget() {
    Object.keys(KEYS).forEach(function (k) { if (k !== 'org' && k !== 'licence' && k !== 'anon') { try { localStorage.removeItem(KEYS[k]); } catch (e) {} } });
  }

  var profile = load(KEYS.profile, {});
  var wallet = load(KEYS.wallet, {}); // { schemeId: { status, renewal, updated } }
  var org = load(KEYS.org, 'public');
  var anon = load(KEYS.anon, null);
  var licence = load(KEYS.licence, null); // unlock code string
  var config = { payEnabled: false, priceDisplay: GBP + '4.99', sponsored: false };

  function unlocked() {
    if (!config.payEnabled) return true; // payments not set up yet - app is free
    return !!(config.sponsored || licence);
  }

  (function initIds() {
    var q = new URLSearchParams(location.search).get('org');
    if (q && /^[a-z0-9-]{1,32}$/.test(q)) { org = q; save(KEYS.org, org); }
    if (!anon) {
      var b = new Uint8Array(12);
      crypto.getRandomValues(b);
      anon = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      save(KEYS.anon, anon);
    }
  })();

  // ---------------------------------------------------------------------------
  // Anonymous events (never includes answers)
  // ---------------------------------------------------------------------------
  function track(type, extra) {
    var body = JSON.stringify({ anon: anon, org: org, events: [Object.assign({ type: type }, extra || {})] });
    try {
      fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true })
        .catch(function () {});
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { var x = parseFloat(v); return isFinite(x) ? x : 0; }
  function couple(p) { return R._internal.isCouple(p); }
  function working(w) { return R._internal.working(w); }
  function kidsAges(p) { return Array.isArray(p.kids) ? p.kids.map(num) : []; }
  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

  // ---------------------------------------------------------------------------
  // Questions
  // ---------------------------------------------------------------------------
  var Q = [
    { id: 'postcode', type: 'text', label: 'What is your postcode?', help: 'We use it to find your council and local schemes. It stays on this device.', placeholder: 'e.g. NG1 5DT', autocomplete: 'postal-code',
      validate: function (v) { return /^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$/i.test(String(v || '').trim()) ? null : 'Enter a full UK postcode'; } },
    { id: 'country', type: 'choice', label: 'Which part of the UK do you live in?', help: 'We could not look up your postcode automatically.',
      options: [['England', 'England'], ['Wales', 'Wales'], ['Scotland', 'Scotland'], ['Northern Ireland', 'Northern Ireland']],
      show: function (p) { return !!p.lookupFailed; } },
    { id: 'region', type: 'choice', label: 'Which region of England?', help: 'This helps us estimate typical rents in your area.',
      options: R.REGIONS.map(function (r) { return [r, r]; }),
      show: function (p) { return !!p.lookupFailed && p.country === 'England'; } },
    { id: 'age', type: 'number', label: 'How old are you?', min: 16, max: 120 },
    { id: 'relationship', type: 'choice', label: 'Do you live with a partner?',
      options: [['single', 'No'], ['married', 'Yes - we are married or in a civil partnership'], ['cohabiting', 'Yes - we live together but are not married']] },
    { id: 'partnerAge', type: 'number', label: 'How old is your partner?', min: 16, max: 120, show: couple },
    { id: 'kidsCount', type: 'number', label: 'How many children live with you?', help: 'Include young people up to 19 who are still in school or college. Enter 0 if none.', min: 0, max: 12 },
    { id: 'kids', type: 'ages', label: 'How old are they?', help: 'Enter 0 for a baby under 1.', show: function (p) { return num(p.kidsCount) > 0; } },
    { id: 'childDisabled', type: 'yesno', label: 'Does any child have a disability, long-term illness or extra care needs?', show: function (p) { return num(p.kidsCount) > 0; } },
    { id: 'pregnant', type: 'yesno', label: 'Is anyone in your household pregnant?', show: function (p) { return num(p.age) < 56 || (couple(p) && num(p.partnerAge) < 56); } },
    { id: 'otherAdults', type: 'number', label: 'How many other adults (18 or over) live with you?', help: 'Do not count your partner. Include grown-up children, lodgers or relatives. Enter 0 if none.', min: 0, max: 10 },
    { id: 'youWork', type: 'choice', label: 'What is your work situation?', options: [['none', 'Not working'], ['employed', 'Employed'], ['self', 'Self-employed'], ['retired', 'Retired']] },
    { id: 'youNet', type: 'money', label: 'What is your take-home pay each month?', help: 'After tax and National Insurance. A rough figure is fine.', show: function (p) { return working(p.youWork); } },
    { id: 'partnerWork', type: 'choice', label: "What is your partner's work situation?", options: [['none', 'Not working'], ['employed', 'Employed'], ['self', 'Self-employed'], ['retired', 'Retired']], show: couple },
    { id: 'partnerNet', type: 'money', label: "What is your partner's take-home pay each month?", help: 'After tax and National Insurance. A rough figure is fine.', show: function (p) { return couple(p) && working(p.partnerWork); } },
    { id: 'otherIncome', type: 'money', label: 'Any other regular income each month?', help: 'State Pension, work or private pensions, maintenance, rent from lodgers. Do not include benefits. Enter 0 if none.' },
    { id: 'highEarner', type: 'choice', label: 'Does anyone in your household earn over ' + GBP + '60,000 a year before tax?',
      options: [['no', 'No'], ['60to80', 'Yes - ' + GBP + '60,000 to ' + GBP + '80,000'], ['80to100', 'Yes - ' + GBP + '80,000 to ' + GBP + '100,000'], ['over100', 'Yes - over ' + GBP + '100,000']],
      show: function (p) { return num(p.kidsCount) > 0 && (num(p.youNet) + num(p.partnerNet)) > 2500; } },
    { id: 'housing', type: 'choice', label: 'What is your housing situation?',
      options: [['social', 'Renting from the council or a housing association'], ['private', 'Renting from a private landlord'], ['mortgage', 'Own with a mortgage'], ['owned', 'Own outright'], ['family', 'Living with family or friends and not paying Council Tax']] },
    { id: 'rent', type: 'money', label: 'How much is your rent each month?', help: 'The full rent, even if benefits pay some of it.', show: function (p) { return p.housing === 'social' || p.housing === 'private'; } },
    { id: 'ctAnnual', type: 'money', optional: true, label: 'Roughly how much is your Council Tax bill for the year?', help: 'Optional - it helps us value discounts. Leave blank if you are not sure.', show: function (p) { return p.housing && p.housing !== 'family'; } },
    { id: 'water', type: 'choice', label: 'Who supplies your water?', help: 'It is on your water bill. Pick "Not sure" if you do not know.',
      options: R.WATER_COMPANIES.map(function (w) { return [w[0], w[1]]; }).concat([['unsure', 'Not sure']]), show: function (p) { return p.housing && p.housing !== 'family'; } },
    { id: 'savings', type: 'choice', label: 'How much do you (and your partner) have in savings?', help: 'Include bank accounts, ISAs and shares. Do not include your home or pension pots.',
      options: [['under6', 'Under ' + GBP + '6,000'], ['6to16', GBP + '6,000 to ' + GBP + '16,000'], ['over16', 'Over ' + GBP + '16,000']] },
    { id: 'caring', type: 'choice', label: 'Do you look after someone who is ill, disabled or elderly?', help: 'Unpaid care, for example for a family member. Do not count normal care for a child without extra needs.',
      options: [['none', 'No'], ['under20', 'Yes - under 20 hours a week'], ['20to34', 'Yes - 20 to 34 hours a week'], ['35plus', 'Yes - 35 hours a week or more']] },
    { id: 'caredBenefit', type: 'choice', label: 'Does the person you care for get a disability benefit?', help: 'For example PIP daily living, Attendance Allowance, or DLA middle or higher care rate.',
      options: [['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']], show: function (p) { return p.caring === '20to34' || p.caring === '35plus'; } },
    { id: 'health', type: 'multi', label: 'Does anyone have a long-term illness, disability or mental health condition that affects day-to-day life?', help: 'This stays on your device. It helps us find disability and health cost support.',
      options: [['you', 'Me'], ['partner', 'My partner', couple], ['child', 'A child']], none: 'No one' },
    { id: 'mobility', type: 'yesno', label: 'Does it make walking or getting around difficult?', show: function (p) { return Array.isArray(p.health) && p.health.length > 0; } },
    { id: 'childcareCost', type: 'money', label: 'How much do you pay for childcare each month?', help: 'Nursery, childminder, breakfast or after-school clubs. Enter 0 if none.',
      show: function (p) { return kidsAges(p).some(function (a) { return a < 15; }); } },
    { id: 'receiving', type: 'multi', label: 'Which of these does anyone in your household already get?', help: 'Tick all that apply.', options: R.RECEIVING_BENEFITS, none: 'None of these' },
    { id: 'have', type: 'multi', label: 'Do you already have any of these?', help: 'Tick all that apply.', options: R.RECEIVING_OTHER, none: 'None of these' }
  ];

  function visible(p) { return Q.filter(function (q) { return !q.show || q.show(p); }); }
  function qIndex(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return i; return -1; }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------
  function viewWelcome() {
    var started = Object.keys(profile).length > 0;
    app.innerHTML =
      '<section class="hero">' +
      '<h1>Find the money and support you might be missing</h1>' +
      '<p class="lead">Answer about 20 quick questions. We check benefits, Council Tax help, childcare support, NHS costs, energy and water discounts, travel concessions and local grants - and show you how to claim.</p>' +
      '<ul class="ticks"><li>' + (unlocked() ? 'Takes about 5 minutes' : 'Free to check - see what you could be missing before you pay anything') + '</li><li>Your answers stay on this device</li><li>Every result links to the official source</li></ul>' +
      '<div class="actions"><button class="btn big" id="go">' + (started ? 'Continue my check' : 'Start my check') + '</button>' +
      (started ? '<button class="btn ghost" id="restart">Start again</button>' : '') + '</div>' +
      '<p class="muted small">Covers everyone in England, with local council support included.</p>' +
      '</section>';
    document.getElementById('go').onclick = function () {
      if (!started) track('start');
      var step = load(KEYS.step, null);
      viewQuestion(step || Q[0].id);
    };
    var r = document.getElementById('restart');
    if (r) r.onclick = function () { profile = {}; save(KEYS.profile, profile); save(KEYS.step, null); track('start'); viewQuestion(Q[0].id); };
  }

  function viewQuestion(id) {
    var list = visible(profile);
    var i = qIndex(list, id);
    if (i === -1) i = 0;
    var q = list[i];
    save(KEYS.step, q.id);
    var progress = Math.round((i / list.length) * 100);
    var v = profile[q.id];
    var body = '';

    if (q.type === 'text') {
      body = '<input class="input" id="f" type="text" autocomplete="' + (q.autocomplete || 'off') + '" placeholder="' + esc(q.placeholder || '') + '" value="' + esc(v || '') + '">';
    } else if (q.type === 'number') {
      body = '<input class="input short" id="f" type="number" inputmode="numeric" min="' + q.min + '" max="' + q.max + '" value="' + esc(v == null ? '' : v) + '">';
    } else if (q.type === 'money') {
      body = '<div class="money"><span>' + GBP + '</span><input class="input short" id="f" type="number" inputmode="decimal" min="0" step="1" value="' + esc(v == null ? '' : v) + '"></div>';
    } else if (q.type === 'choice' || q.type === 'yesno') {
      var opts = q.type === 'yesno' ? [['yes', 'Yes'], ['no', 'No']] : q.options;
      body = '<div class="choices">' + opts.map(function (o) {
        return '<button type="button" class="choice' + (v === o[0] ? ' on' : '') + '" data-v="' + esc(o[0]) + '">' + esc(o[1]) + '</button>';
      }).join('') + '</div>';
    } else if (q.type === 'multi') {
      var sel = Array.isArray(v) ? v : [];
      body = '<div class="checks">' + q.options.filter(function (o) { return !o[2] || o[2](profile); }).map(function (o) {
        return '<label class="check"><input type="checkbox" value="' + esc(o[0]) + '"' + (sel.indexOf(o[0]) !== -1 ? ' checked' : '') + '> <span>' + esc(o[1]) + '</span></label>';
      }).join('') +
        '<label class="check none"><input type="checkbox" value="__none"' + (Array.isArray(v) && v.length === 0 ? ' checked' : '') + '> <span>' + esc(q.none) + '</span></label></div>';
    } else if (q.type === 'ages') {
      var count = Math.min(12, Math.max(1, num(profile.kidsCount)));
      var ages = Array.isArray(v) ? v : [];
      var inputs = '';
      for (var k = 0; k < count; k++) {
        inputs += '<label class="age">Child ' + (k + 1) + ' <input class="input tiny" type="number" inputmode="numeric" min="0" max="19" data-k="' + k + '" value="' + esc(ages[k] == null ? '' : ages[k]) + '"></label>';
      }
      body = '<div class="ages">' + inputs + '</div>';
    }

    var auto = q.type === 'choice' || q.type === 'yesno';
    app.innerHTML =
      '<section class="card q">' +
      '<div class="progress" aria-hidden="true"><div></div></div>' +
      '<p class="muted small">Question ' + (i + 1) + ' of ' + list.length + '</p>' +
      '<h2 id="ql">' + esc(q.label) + '</h2>' +
      (q.help ? '<p class="help">' + esc(q.help) + '</p>' : '') +
      '<div class="field" role="group" aria-labelledby="ql">' + body + '</div>' +
      '<p class="error" id="err" role="alert"></p>' +
      '<div class="actions">' +
      (i > 0 ? '<button type="button" class="btn ghost" id="back">Back</button>' : '<button type="button" class="btn ghost" id="home">Back</button>') +
      (auto ? '' : '<button type="button" class="btn" id="next">Continue</button>') +
      '</div></section>';

    // progress bar width is set via the CSSOM (CSP blocks inline style attributes)
    app.querySelector('.progress > div').style.width = progress + '%';

    var err = document.getElementById('err');
    function fail(msg) { err.textContent = msg; }

    function commit(val) {
      profile[q.id] = val;
      if (q.id === 'country' && val !== 'England') { save(KEYS.profile, profile); return viewNotEngland(); }
      if (q.id === 'relationship' && !couple(profile)) { delete profile.partnerAge; delete profile.partnerWork; delete profile.partnerNet; }
      if (q.id === 'kidsCount' && num(val) === 0) { delete profile.kids; delete profile.childDisabled; delete profile.childcareCost; }
      save(KEYS.profile, profile);
      next();
    }
    function next() {
      var l2 = visible(profile);
      var j = qIndex(l2, q.id);
      if (j + 1 < l2.length) viewQuestion(l2[j + 1].id);
      else finish();
    }

    if (q.id === 'postcode') {
      // postcode needs a lookup before moving on
      document.getElementById('next').onclick = function () {
        var pc = document.getElementById('f').value.trim().toUpperCase();
        var bad = q.validate(pc);
        if (bad) return fail(bad);
        var btn = document.getElementById('next');
        btn.disabled = true; btn.textContent = 'Checking...';
        lookupPostcode(pc).then(function (res) {
          profile.postcode = pc;
          if (res) {
            profile.district = res.admin_district;
            profile.county = res.admin_county || null; // null means a unitary council
            profile.region = res.region || null;
            profile.country = res.country;
            profile.lookupFailed = false;
          } else {
            profile.lookupFailed = true;
            delete profile.district; delete profile.county;
          }
          save(KEYS.profile, profile);
          if (profile.country && profile.country !== 'England') return viewNotEngland();
          next();
        });
      };
    } else if (auto) {
      Array.prototype.forEach.call(app.querySelectorAll('.choice'), function (b) {
        b.onclick = function () { commit(b.getAttribute('data-v')); };
      });
    } else {
      document.getElementById('next').onclick = function () {
        if (q.type === 'number' || q.type === 'money') {
          var raw = document.getElementById('f').value;
          if (raw === '' && q.optional) { delete profile[q.id]; save(KEYS.profile, profile); return next(); }
          if (raw === '') return fail('Please enter a number' + (q.type === 'money' ? ' (0 if none)' : ''));
          var x = num(raw);
          if (x < 0) return fail('Please enter a positive number');
          if (q.min != null && x < q.min) return fail('Please enter a number of at least ' + q.min);
          if (q.max != null && x > q.max) return fail('Please enter a number no more than ' + q.max);
          return commit(x);
        }
        if (q.type === 'multi') {
          var boxes = app.querySelectorAll('.checks input:checked');
          var vals = Array.prototype.map.call(boxes, function (b) { return b.value; }).filter(function (x) { return x !== '__none'; });
          if (!boxes.length) return fail('Tick at least one option, or "' + q.none + '"');
          return commit(vals);
        }
        if (q.type === 'ages') {
          var agesOut = [];
          var ok = true;
          Array.prototype.forEach.call(app.querySelectorAll('.ages input'), function (inp) {
            if (inp.value === '' || num(inp.value) < 0 || num(inp.value) > 19) ok = false;
            agesOut.push(Math.floor(num(inp.value)));
          });
          if (!ok) return fail('Enter an age from 0 to 19 for each child');
          return commit(agesOut);
        }
      };
      // "none" is exclusive in multi-selects
      if (q.type === 'multi') {
        Array.prototype.forEach.call(app.querySelectorAll('.checks input'), function (b) {
          b.onchange = function () {
            if (!b.checked) return;
            Array.prototype.forEach.call(app.querySelectorAll('.checks input'), function (o) {
              if (o !== b && (b.value === '__none' || o.value === '__none')) o.checked = false;
            });
          };
        });
      }
      var f = document.getElementById('f');
      if (f) {
        f.focus();
        f.onkeydown = function (e) { if (e.key === 'Enter') document.getElementById('next').click(); };
      }
    }

    var back = document.getElementById('back');
    if (back) back.onclick = function () { viewQuestion(list[i - 1].id); };
    var home = document.getElementById('home');
    if (home) home.onclick = viewWelcome;
    window.scrollTo(0, 0);
  }

  function viewNotEngland() {
    var c = esc(profile.country || 'your area');
    app.innerHTML = '<section class="card"><h2>WhatCanIClaim? covers England only for now</h2>' +
      '<p>Benefits, Council Tax support, free school meals and many other schemes work differently in ' + c + ', so our results would not be accurate for you. We have not asked you to pay anything.</p>' +
      '<p>For a free check that covers ' + c + ', try <a href="https://benefits-calculator.turn2us.org.uk/" target="_blank" rel="noopener">Turn2us</a> or <a href="https://www.citizensadvice.org.uk/" target="_blank" rel="noopener">Citizens Advice</a>.</p>' +
      '<div class="actions"><button class="btn ghost" id="fix">I live in England - change my postcode</button></div></section>';
    document.getElementById('fix').onclick = function () { delete profile.country; delete profile.lookupFailed; save(KEYS.profile, profile); viewQuestion('postcode'); };
    window.scrollTo(0, 0);
  }

  function lookupPostcode(pc) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 6000);
    return fetch('https://api.postcodes.io/postcodes/' + encodeURIComponent(pc.replace(/\s+/g, '')), ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { clearTimeout(timer); return j && j.result ? j.result : null; })
      .catch(function () { clearTimeout(timer); return null; });
  }

  function finish() {
    profile.completed = true;
    save(KEYS.profile, profile);
    save(KEYS.step, null);
    var out = R.evaluate(profile);
    track('complete', {
      value: out.summary.likelyValue,
      flags: out.results.map(function (r) { return { s: r.id, t: r.tier }; })
    });
    viewResults();
  }

  // ---------------------------------------------------------------------------
  // Results
  // ---------------------------------------------------------------------------
  var TIER_INFO = {
    likely: { title: 'Looks likely', blurb: 'Based on your answers, you are likely to qualify.' },
    possible: { title: 'Possible', blurb: 'You may qualify - it depends on details we have not asked about.' },
    check: { title: 'Worth checking', blurb: 'Lower confidence, or only useful in some situations.' },
    receiving: { title: 'You already get', blurb: 'Keep these in your wallet to track renewals.' }
  };
  var STATUS = [['none', 'Not started'], ['applying', 'Applied'], ['receiving', 'Getting it'], ['not_eligible', 'Not eligible']];

  function statusOf(id, tier) {
    var w = wallet[id];
    if (w && w.status) return w.status;
    return tier === 'receiving' ? 'receiving' : 'none';
  }

  function card(r) {
    var st = statusOf(r.id, r.tier);
    var w = wallet[r.id] || {};
    return '<article class="result t-' + r.tier + '" data-id="' + esc(r.id) + '">' +
      '<div class="rhead"><span class="cat">' + esc(r.category) + '</span>' +
      (r.value ? '<span class="val">' + R.money(r.value) + ' a year</span>' : '') + '</div>' +
      '<h3>' + esc(r.name) + '</h3>' +
      '<p class="vlabel">' + esc(r.valueLabel) + '</p>' +
      '<ul class="why">' + r.why.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      '<details><summary>What you need and how to apply</summary>' +
      '<p><strong>You will need:</strong></p><ul>' + r.evidence.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      '<p>' + esc(r.how) + '</p>' +
      '<p class="muted small">Rules checked ' + esc(r.reviewed) + '. <a href="' + esc(r.sourceUrl) + '" target="_blank" rel="noopener">Official source</a></p>' +
      '</details>' +
      '<div class="ractions">' +
      (r.tier !== 'receiving' ? '<a class="btn" data-apply="' + esc(r.id) + '" href="' + esc(r.applyUrl) + '" target="_blank" rel="noopener">How to apply</a>' : '') +
      '<label class="status">Status <select data-status="' + esc(r.id) + '">' +
      STATUS.map(function (s) { return '<option value="' + s[0] + '"' + (s[0] === st ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') +
      '</select></label>' +
      '<label class="status renew' + (st === 'receiving' || st === 'applying' ? '' : ' hidden') + '">' + (st === 'applying' ? 'Chase by' : 'Renews') +
      ' <input type="date" data-renew="' + esc(r.id) + '" value="' + esc(w.renewal || '') + '"></label>' +
      '</div></article>';
  }

  function headline(s) {
    var total = s.likely + s.possible;
    if (s.likelyValue > 0) {
      return '<h1 class="big">You could be missing around <span class="money-big">' + R.money(s.likelyValue) + '</span> a year</h1>' +
        '<p class="lead">from ' + s.likely + ' thing' + (s.likely === 1 ? '' : 's') + ' that look likely for you, plus ' + s.possible + ' more that are possible.</p>' +
        '<p class="muted small">This figure only counts fixed amounts. Means-tested benefits like Universal Credit, Pension Credit and Council Tax Reduction are not included, and could be worth much more.</p>';
    }
    if (total > 0) {
      return '<h1 class="big">We found ' + total + ' thing' + (total === 1 ? '' : 's') + ' you may be missing</h1>' +
        '<p class="lead">' + s.likely + ' look likely and ' + s.possible + ' are possible. Some are means-tested, so the amount depends on a full calculation.</p>';
    }
    return '<h1 class="big">You seem to be getting what you are entitled to</h1><p class="lead">We did not find anything obvious you are missing. There may still be things worth checking below.</p>';
  }

  function viewResults() {
    if (!profile.completed) return viewWelcome();
    var out = R.evaluate(profile);
    var s = out.summary;
    if (!unlocked()) return viewPreview(out);
    var html = '<section class="summary">' + headline(s);
    if (!s.inEngland) {
      html += '<p class="notice">You live in ' + esc(profile.country) + '. These results use the rules for England, and many schemes work differently there, so check each one carefully.</p>';
    } else if (s.council) {
      html += '<p class="muted small">Your council: ' + esc(s.council) + (profile.county ? ' (and ' + esc(profile.county) + ' County Council)' : '') + '.</p>';
    }
    if (out.ctx.ucTier || out.ctx.pcTier) {
      html += '<p class="notice">Before you claim ' + (out.ctx.pcTier ? 'Pension Credit' : 'Universal Credit') +
        ', get an exact figure from a free calculator like <a href="https://www.entitledto.co.uk/" target="_blank" rel="noopener">entitledto</a> or <a href="https://benefits-calculator.turn2us.org.uk/" target="_blank" rel="noopener">Turn2us</a>. ' +
        'Claiming one benefit can unlock several others below.</p>';
    }
    html += '<div class="actions"><button class="btn ghost" id="edit">Change my answers</button><button class="btn ghost" id="walletbtn">Open my wallet</button></div></section>';

    ['likely', 'possible', 'check', 'receiving'].forEach(function (t) {
      var items = out.results.filter(function (r) { return r.tier === t; });
      if (!items.length) return;
      html += '<section class="tier"><h2>' + TIER_INFO[t].title + ' <span class="count">' + items.length + '</span></h2>' +
        '<p class="muted">' + TIER_INFO[t].blurb + '</p>' + items.map(card).join('') + '</section>';
    });
    if (licence) html += '<section class="card small"><p><strong>Your unlock code:</strong> <code class="code">' + esc(licence) + '</code><br><span class="muted">Keep it to unlock the app on another device. It is also on your payment receipt.</span></p></section>';
    html += '<section class="card small"><p><strong>Your answers stay on this device.</strong> Come back any time on this device to update them - we will re-check your results.</p>' +
      '<button class="btn danger ghost" id="forget">Delete my answers</button></section>';
    app.innerHTML = html;
    bindResultEvents();
    document.getElementById('edit').onclick = function () { viewQuestion(Q[0].id); };
    document.getElementById('walletbtn').onclick = viewWallet;
    window.scrollTo(0, 0);
  }

  function bindResultEvents() {
    Array.prototype.forEach.call(app.querySelectorAll('[data-apply]'), function (a) {
      a.addEventListener('click', function () {
        var id = a.getAttribute('data-apply');
        track('apply_click', { scheme: id });
        if (!wallet[id] || wallet[id].status === 'none') {
          wallet[id] = Object.assign(wallet[id] || {}, { clicked: new Date().toISOString().slice(0, 10) });
          save(KEYS.wallet, wallet);
        }
      });
    });
    Array.prototype.forEach.call(app.querySelectorAll('[data-status]'), function (sel) {
      sel.onchange = function () {
        var id = sel.getAttribute('data-status');
        wallet[id] = Object.assign(wallet[id] || {}, { status: sel.value, updated: new Date().toISOString().slice(0, 10) });
        save(KEYS.wallet, wallet);
        track('status', { scheme: id, status: sel.value });
        var renew = sel.closest('.result').querySelector('.renew');
        var show = sel.value === 'receiving' || sel.value === 'applying';
        renew.classList.toggle('hidden', !show);
        renew.firstChild.textContent = sel.value === 'applying' ? 'Chase by ' : 'Renews ';
      };
    });
    Array.prototype.forEach.call(app.querySelectorAll('[data-renew]'), function (inp) {
      inp.onchange = function () {
        var id = inp.getAttribute('data-renew');
        wallet[id] = Object.assign(wallet[id] || {}, { renewal: inp.value });
        save(KEYS.wallet, wallet);
      };
    });
    var f = document.getElementById('forget');
    if (f) f.onclick = function () {
      if (!window.confirm('Delete all your answers and wallet from this device?')) return;
      forget(); profile = {}; wallet = {}; viewWelcome();
    };
  }

  // ---------------------------------------------------------------------------
  // Wallet
  // ---------------------------------------------------------------------------
  function daysSince(d) { return d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : 0; }

  function viewWallet() {
    if (!profile.completed) {
      app.innerHTML = '<section class="card"><h2>Your Entitlement Wallet</h2><p>Complete a check first. Your wallet then tracks what you get, what you have applied for, and when things need renewing.</p><button class="btn" id="go">Start my check</button></section>';
      document.getElementById('go').onclick = function () { track('start'); viewQuestion(Q[0].id); };
      return;
    }
    if (!unlocked()) return viewPreview(R.evaluate(profile));
    var out = R.evaluate(profile);
    var byId = {};
    out.results.forEach(function (r) { byId[r.id] = r; });
    var groups = { receiving: [], applying: [], todo: [] };
    out.results.forEach(function (r) {
      var st = statusOf(r.id, r.tier);
      if (st === 'receiving') groups.receiving.push(r);
      else if (st === 'applying') groups.applying.push(r);
      else if (st === 'none' && (r.tier === 'likely' || r.tier === 'possible')) groups.todo.push(r);
    });
    var receivingValue = groups.receiving.reduce(function (t, r) { return t + (r.value || 0); }, 0);

    var reminders = [];
    groups.applying.forEach(function (r) {
      var w = wallet[r.id] || {};
      if (w.updated && daysSince(w.updated) >= 30) reminders.push('You applied for ' + r.name + ' ' + daysSince(w.updated) + ' days ago. Have you heard back?');
    });
    Object.keys(wallet).forEach(function (id) {
      var w = wallet[id];
      if (!w.renewal || !byId[id]) return;
      var days = -daysSince(w.renewal);
      if (days >= 0 && days <= 45) reminders.push(byId[id].name + (w.status === 'applying' ? ' - chase by ' : ' renews on ') + w.renewal + ' (' + days + ' days).');
    });

    function row(r) {
      var w = wallet[r.id] || {};
      return '<li class="wrow"><div><strong>' + esc(r.name) + '</strong><span class="muted small">' + esc(r.valueLabel) + '</span>' +
        (w.renewal ? '<span class="small">' + (w.status === 'applying' ? 'Chase by ' : 'Renews ') + esc(w.renewal) + '</span>' : '') + '</div>' +
        '<div class="wbtns">' + (w.renewal ? '<button class="btn ghost small" data-ics="' + esc(r.id) + '">Add to calendar</button>' : '') +
        (r.tier !== 'receiving' ? '<a class="btn small" data-apply="' + esc(r.id) + '" href="' + esc(r.applyUrl) + '" target="_blank" rel="noopener">Apply</a>' : '') + '</div></li>';
    }

    var html = '<section class="summary"><h1 class="big">Your Entitlement Wallet</h1>' +
      '<div class="kpis"><div class="kpi"><b>' + groups.receiving.length + '</b><span>Getting</span></div>' +
      '<div class="kpi"><b>' + groups.applying.length + '</b><span>Applied for</span></div>' +
      '<div class="kpi"><b>' + groups.todo.length + '</b><span>Still to claim</span></div>' +
      (receivingValue ? '<div class="kpi"><b>' + R.money(receivingValue) + '</b><span>Fixed-value support a year</span></div>' : '') + '</div></section>';
    if (reminders.length) html += '<section class="card remind"><h2>Reminders</h2><ul>' + reminders.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>';
    html += '<section class="card"><h2>Still to claim</h2>' + (groups.todo.length ? '<ul class="wlist">' + groups.todo.map(row).join('') + '</ul>' : '<p class="muted">Nothing outstanding.</p>') + '</section>';
    html += '<section class="card"><h2>Applied for</h2>' + (groups.applying.length ? '<ul class="wlist">' + groups.applying.map(row).join('') + '</ul>' : '<p class="muted">Set a result to "Applied" to track it here.</p>') + '</section>';
    html += '<section class="card"><h2>Getting</h2>' + (groups.receiving.length ? '<ul class="wlist">' + groups.receiving.map(row).join('') + '</ul>' : '<p class="muted">Nothing yet.</p>') + '</section>';
    html += '<section class="card small"><p><strong>Had a change?</strong> A new baby, job change, move, retirement or becoming a carer can change what you get. Update your answers and we will re-check.</p>' +
      '<div class="actions"><button class="btn" id="edit">Update my answers</button><button class="btn ghost" id="res">See all results</button><button class="btn danger ghost" id="forget">Delete my answers</button></div></section>';
    app.innerHTML = html;
    bindResultEvents();
    Array.prototype.forEach.call(app.querySelectorAll('[data-ics]'), function (b) {
      b.onclick = function () { downloadIcs(byId[b.getAttribute('data-ics')], wallet[b.getAttribute('data-ics')]); };
    });
    document.getElementById('edit').onclick = function () { viewQuestion(Q[0].id); };
    document.getElementById('res').onclick = viewResults;
    window.scrollTo(0, 0);
  }

  function downloadIcs(r, w) {
    if (!r || !w || !w.renewal) return;
    var d = w.renewal.replace(/-/g, '');
    var stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    var title = (w.status === 'applying' ? 'Chase application: ' : 'Renew: ') + r.name;
    var ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WhatCanIClaim//Wallet//EN', 'BEGIN:VEVENT',
      'UID:' + r.id + '-' + d + '@whatcaniclaim', 'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + d, 'SUMMARY:' + title.replace(/[,;]/g, ' '),
      'DESCRIPTION:' + ('Official info: ' + r.sourceUrl).replace(/[,;]/g, ' '),
      'BEGIN:VALARM', 'TRIGGER:-P7D', 'ACTION:DISPLAY', 'DESCRIPTION:' + title.replace(/[,;]/g, ' '), 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'
    ].join('\r\n');
    var blob = new Blob([ics], { type: 'text/calendar' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.id + '-reminder.ics';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------------------------------------------------------------------------
  // Free preview + one-off unlock
  // ---------------------------------------------------------------------------
  function lockedRow(r) {
    return '<li class="lrow t-' + r.tier + '"><span class="cat">' + esc(r.category) + '</span>' +
      '<span class="lname" aria-label="Hidden until unlocked">' + '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + '</span>' +
      (r.value ? '<span class="val">' + R.money(r.value) + ' a year</span>' : '') + '</li>';
  }

  function viewPreview(out, notice) {
    var s = out.summary;
    var found = out.results.filter(function (r) { return r.tier !== 'receiving'; });
    var teaser = found.filter(function (r) { return r.tier === 'likely'; })[0] || found[0];
    var rest = found.filter(function (r) { return r !== teaser; });
    var html = '<section class="summary">' + headline(s) + '</section>';
    if (notice) html += '<p class="notice">' + esc(notice) + '</p>';
    if (teaser) {
      html += '<section class="tier"><h2>Here is one we found for you</h2>' + card(teaser) + '</section>';
    }
    if (rest.length) {
      html += '<section class="tier"><h2>' + rest.length + ' more waiting <span class="count">locked</span></h2>' +
        '<ul class="locked">' + rest.map(lockedRow).join('') + '</ul></section>';
    }
    html += paywallHtml(found.length);
    html += '<section class="card small"><div class="actions"><button class="btn ghost" id="edit">Change my answers</button><button class="btn danger ghost" id="forget">Delete my answers</button></div></section>';
    app.innerHTML = html;
    bindResultEvents();
    bindPaywall();
    document.getElementById('edit').onclick = function () { viewQuestion(Q[0].id); };
    track('paywall_view');
    window.scrollTo(0, 0);
  }

  function paywallHtml(n) {
    return '<section class="card paywall" id="paywall">' +
      '<h2>Unlock everything for ' + esc(config.priceDisplay) + ', once</h2>' +
      '<ul class="ticks">' +
      '<li>See all ' + n + ' result' + (n === 1 ? '' : 's') + ', with why you qualify, what evidence you need and how to apply</li>' +
      '<li>Your Entitlement Wallet: track claims, renewals and calendar reminders</li>' +
      '<li>Re-check free for life whenever your circumstances change</li>' +
      '<li>No subscription. Pay once.</li></ul>' +
      '<label class="consent"><input type="checkbox" id="consent"> <span>I want access straight away and understand that my 14-day right to cancel ends once access starts.</span></label>' +
      '<p class="error" id="payerr" role="alert"></p>' +
      '<div class="actions"><button class="btn big" id="pay">Unlock for ' + esc(config.priceDisplay) + '</button></div>' +
      '<p class="muted small">Secure payment by Stripe. Your answers are never sent with your payment.</p>' +
      '<details class="restore"><summary>Already paid? Enter your unlock code</summary>' +
      '<div class="restorebox"><input class="input" id="codein" placeholder="WCI-XXXXX-XXXXX" autocomplete="off" autocapitalize="characters">' +
      '<button class="btn ghost" id="redeem">Unlock</button></div><p class="error" id="coderr" role="alert"></p></details>' +
      '</section>';
  }

  function bindPaywall() {
    var pay = document.getElementById('pay');
    if (pay) pay.onclick = function () {
      var err = document.getElementById('payerr');
      if (!document.getElementById('consent').checked) { err.textContent = 'Please tick the box to confirm.'; return; }
      pay.disabled = true; pay.textContent = 'Opening secure checkout...';
      track('checkout_start');
      fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anon: anon, org: org, consent: true }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.url) { location.href = j.url; return; }
          throw new Error(j && j.error ? j.error : 'Could not start payment.');
        })
        .catch(function (e) { err.textContent = e.message || 'Could not start payment.'; pay.disabled = false; pay.textContent = 'Unlock for ' + config.priceDisplay; });
    };
    var redeem = document.getElementById('redeem');
    if (redeem) redeem.onclick = function () {
      var cerr = document.getElementById('coderr');
      var code = document.getElementById('codein').value.trim().toUpperCase();
      if (!/^WCI-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(code)) { cerr.textContent = 'Codes look like WCI-ABCDE-23456.'; return; }
      redeem.disabled = true;
      verifyCode(code).then(function (j) {
        redeem.disabled = false;
        if (j.ok) { licence = j.code; save(KEYS.licence, licence); viewResults(); }
        else cerr.textContent = j.error || 'That code did not work.';
      });
    };
  }

  function verifyCode(code) {
    return fetch('/api/licence/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code, anon: anon }) })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: 'Could not reach the server. Check your connection.' }; });
  }

  function confirmPayment(sessionId, tries) {
    return fetch('/api/checkout/confirm?session_id=' + encodeURIComponent(sessionId))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok && j.code) return j.code;
        if (j.pending && tries < 5) return new Promise(function (res) { setTimeout(res, 2000); }).then(function () { return confirmPayment(sessionId, tries + 1); });
        return null;
      })
      .catch(function () { return null; });
  }

  // ---------------------------------------------------------------------------
  // Nav + boot
  // ---------------------------------------------------------------------------
  document.getElementById('nav-check').onclick = function () { profile.completed ? viewResults() : viewWelcome(); };
  document.getElementById('nav-wallet').onclick = viewWallet;
  document.getElementById('brand').onclick = function (e) { e.preventDefault(); viewWelcome(); };

  function route() {
    if (location.pathname === '/wallet') viewWallet();
    else if (profile.completed) viewResults();
    else viewWelcome();
  }

  function boot() {
    var params = new URLSearchParams(location.search);
    var paid = params.get('paid');
    var cancelled = params.get('cancelled');
    if (paid || cancelled) history.replaceState(null, '', '/');
    if (paid) {
      app.innerHTML = '<section class="card"><h2>Confirming your payment...</h2><p class="muted">This only takes a moment.</p></section>';
      return confirmPayment(paid, 0).then(function (code) {
        if (code) {
          licence = code; save(KEYS.licence, licence);
          if (profile.completed) viewResults(); else viewWelcome();
          app.insertBefore(el('<p class="notice">Payment received - thank you. Everything is unlocked. Your unlock code is <strong>' + esc(code) + '</strong> (also on your receipt).</p>'), app.firstChild);
        } else {
          app.innerHTML = '<section class="card"><h2>We could not confirm your payment yet</h2><p>If you were charged, use the unlock code on your Stripe receipt email under "Already paid?". Or refresh this page in a minute.</p><button class="btn" id="back">Back to my results</button></section>';
          document.getElementById('back').onclick = route;
        }
      });
    }
    if (cancelled && profile.completed && !unlocked()) return viewPreview(R.evaluate(profile), 'Payment cancelled - you have not been charged.');
    route();
  }

  fetch('/api/config?org=' + encodeURIComponent(org))
    .then(function (r) { return r.json(); })
    .then(function (c) { if (c) config = c; })
    .catch(function () { /* offline: fall back to defaults */ })
    .then(function () {
      // re-check a stored code quietly (handles revoked/refunded codes)
      if (licence && config.payEnabled) {
        verifyCode(licence).then(function (j) { if (j && j.ok === false && j.error && /not recognised/.test(j.error)) { licence = null; save(KEYS.licence, null); route(); } });
      }
      boot();
    });
})();
