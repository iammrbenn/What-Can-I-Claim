/*
 * WhatCanIClaim? - eligibility screening rules (MVP, England / Nottinghamshire pilot)
 *
 * Shared by the browser (window.WCIRules) and Node (require('./rules')).
 * This is a SCREENING engine, not a benefits calculator. It sorts schemes into
 * likely / possible / worth checking and links to the official source.
 * Only fixed-value items carry a money figure.
 *
 * RATES LAST REVIEWED: 22 Sep 2026 (tax year 2026/27). Review every April and
 * whenever a scheme changes. Each scheme has its own `reviewed` date.
 *
 * Keep this file pure ASCII (use \u escapes for symbols).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WCIRules = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var GBP = '\u00A3';

  // ---------------------------------------------------------------------------
  // Rates and thresholds (2026/27). Sources noted beside each.
  // ---------------------------------------------------------------------------
  var C = {
    taxYear: '2026/27',
    reviewed: '2026-09-22',
    statePensionAge: 66, // rising to 67 from 2026-2028 - edge cases flagged as "possible"
    ca: { weekly: 86.45, earningsLimit: 204 }, // DWP benefit rates 2026/27
    cb: { eldest: 27.05, additional: 17.9 }, // HMRC rates 2026/27
    pc: { single: 238.0, couple: 363.25 }, // DWP benefit rates 2026/27
    aa: { lower: 76.7, higher: 114.6 },
    pipDaily: { standard: 76.7, enhanced: 114.6 },
    uc: {
      singleU25: 338.58,
      single: 424.9,
      couple: 666.97,
      childApprox: 300, // SCREENING APPROXIMATION ONLY - not a published rate
      carerApprox: 205, // SCREENING APPROXIMATION ONLY
      housingCapPrivateApprox: 750, // crude proxy for Nottingham LHA - screening only
      workAllowanceHigher: 710,
      workAllowanceLower: 427,
      taper: 0.55,
      capitalLower: 6000,
      capitalUpper: 16000
    },
    nhs: { ucEarnings: 435, ucEarningsChildOrLcw: 935, capital: 16000 }, // NHSBSA HC11 Apr 2026
    healthyStart: { pregnancyWeekly: 4.65, under1Weekly: 9.3, oneToFourWeekly: 4.65, earningsMonthly: 408 }, // NHSBSA Apr 2026
    fsmPerChild: 495, // DfE estimate of annual saving per child
    ssmg: 500,
    whd: 150, // Warm Home Discount 2026/27; qualifying date 23 Aug 2026
    whdQualifyingDate: '23 August 2026',
    tfc: { capPerChild: 2000, capDisabled: 4000, minMonthlyEarnings: 850, topUpRate: 0.2 },
    funded2yoEarningsAnnual: 15400,
    marriageAllowance: 252,
    personalAllowance: 12570,
    basicRateLimit: 50270,
    bigDifference: { incomeLimit: 24454, upTo: 411 }, // Severn Trent
    crfCountyIncomeLimit: 35000 // Nottinghamshire County Crisis and Resilience Fund
  };

  var NOTTS_DISTRICTS = [
    'Nottingham',
    'Ashfield',
    'Bassetlaw',
    'Broxtowe',
    'Gedling',
    'Mansfield',
    'Newark and Sherwood',
    'Rushcliffe'
  ];

  // IDs a user can say they already get (used by the questionnaire too)
  var RECEIVING_BENEFITS = [
    ['uc', 'Universal Credit'],
    ['pc', 'Pension Credit'],
    ['sp', 'State Pension'],
    ['hb', 'Housing Benefit'],
    ['ctr', 'Council Tax Reduction / Support'],
    ['cb', 'Child Benefit'],
    ['ca', "Carer's Allowance"],
    ['pip', 'Personal Independence Payment (PIP)'],
    ['aa', 'Attendance Allowance'],
    ['dla', 'Disability Living Allowance (DLA)'],
    ['esa', 'Employment and Support Allowance (ESA)'],
    ['jsa', "Jobseeker's Allowance (JSA)"]
  ];
  var RECEIVING_OTHER = [
    ['spd', 'Council Tax single person discount'],
    ['tfc', 'Tax-Free Childcare'],
    ['childcarehours', 'Free childcare hours'],
    ['fsm', 'Free school meals'],
    ['healthystart', 'Healthy Start card'],
    ['nhscert', 'NHS exemption or HC2/HC3 certificate'],
    ['socialtariff', 'Broadband or mobile social tariff'],
    ['bigdiff', 'Water bill discount (e.g. Big Difference)'],
    ['psr', 'Priority Services Register'],
    ['buspass', 'Free bus pass'],
    ['railcard', 'Railcard'],
    ['bluebadge', 'Blue Badge'],
    ['marriage', 'Marriage Allowance'],
    ['help2save', 'Help to Save account']
  ];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function n(v) {
    var x = typeof v === 'string' ? parseFloat(v) : v;
    return typeof x === 'number' && isFinite(x) ? x : 0;
  }
  function has(p, id) {
    return (Array.isArray(p.receiving) && p.receiving.indexOf(id) !== -1) ||
      (Array.isArray(p.have) && p.have.indexOf(id) !== -1);
  }
  function isCouple(p) { return p.relationship === 'married' || p.relationship === 'cohabiting'; }
  function working(w) { return w === 'employed' || w === 'self'; }
  function spa(age) { return n(age) >= C.statePensionAge; }
  function pensionHousehold(p) { return isCouple(p) ? spa(p.age) && spa(p.partnerAge) : spa(p.age); }
  function anyPensionAge(p) { return spa(p.age) || (isCouple(p) && spa(p.partnerAge)); }
  function kids(p) {
    return (Array.isArray(p.kids) ? p.kids : []).map(n).filter(function (a) { return a >= 0 && a <= 19; });
  }
  function kidsWhere(p, fn) { return kids(p).filter(fn); }
  function youEarn(p) { return working(p.youWork) ? n(p.youNet) : 0; }
  function partnerEarn(p) { return isCouple(p) && working(p.partnerWork) ? n(p.partnerNet) : 0; }
  function earningsMonthly(p) { return youEarn(p) + partnerEarn(p); }
  function householdNetMonthly(p) { return earningsMonthly(p) + n(p.otherIncome); }
  function renting(p) { return p.housing === 'social' || p.housing === 'private'; }
  function liable(p) { return !!p.housing && p.housing !== 'family'; }
  function healthList(p) { return Array.isArray(p.health) ? p.health : []; }
  function healthAny(p) { return healthList(p).length > 0; }
  function adultHealth(p) { return healthList(p).indexOf('you') !== -1 || healthList(p).indexOf('partner') !== -1; }
  function childHealth(p) { return healthList(p).indexOf('child') !== -1 || p.childDisabled === 'yes'; }
  function inNotts(p) { return NOTTS_DISTRICTS.indexOf(p.district) !== -1; }
  function isCity(p) { return p.district === 'Nottingham'; }
  function caring35(p) { return p.caring === '35plus'; }
  function caring20(p) { return p.caring === '20to34' || p.caring === '35plus'; }
  function allAdultsWorking(p) {
    if (!working(p.youWork)) return false;
    if (isCouple(p) && !working(p.partnerWork)) return false;
    return true;
  }
  function onMeansTested(p) {
    return ['uc', 'pc', 'hb', 'esa', 'jsa'].some(function (id) { return has(p, id); });
  }
  function onDisabilityBenefit(p) { return has(p, 'pip') || has(p, 'dla') || has(p, 'aa'); }
  function money(v) { return GBP + Math.round(v).toLocaleString('en-GB'); }
  function down(t) { return t === 'likely' ? 'possible' : 'check'; }

  // Rough Universal Credit screen. NOT shown to users as a figure.
  function ucScreen(p) {
    if (pensionHousehold(p)) return null; // Pension Credit route instead
    if (p.savings === 'over16') return -9999;
    var U = C.uc;
    var std = isCouple(p) ? U.couple : (n(p.age) < 25 ? U.singleU25 : U.single);
    var children = kidsWhere(p, function (a) { return a <= 19; }).length;
    var housing = 0;
    if (p.housing === 'social') housing = n(p.rent);
    if (p.housing === 'private') housing = Math.min(n(p.rent), U.housingCapPrivateApprox);
    var carer = caring35(p) && p.caredBenefit !== 'no' ? U.carerApprox : 0;
    var max = std + children * U.childApprox + housing + carer;
    var wa = 0;
    if (children > 0 || adultHealth(p)) wa = housing > 0 ? U.workAllowanceLower : U.workAllowanceHigher;
    var earn = earningsMonthly(p);
    var taper = Math.max(0, earn - wa) * U.taper;
    var unearned = n(p.otherIncome) + (has(p, 'ca') ? C.ca.weekly * 52 / 12 : 0);
    var tariff = p.savings === '6to16' ? ((11000 - U.capitalLower) / 250) * 4.35 : 0;
    return max - taper - unearned - tariff;
  }

  function pcScreen(p) {
    if (!pensionHousehold(p)) return null;
    var weekly = householdNetMonthly(p) * 12 / 52;
    var g = isCouple(p) ? C.pc.couple : C.pc.single;
    var tier = null;
    if (weekly < g) tier = 'likely';
    else if (weekly < g + 60) tier = 'possible';
    else if ((adultHealth(p) || caring35(p)) && weekly < g + 130) tier = 'check';
    if (tier && p.savings === 'over16') tier = down(tier);
    return tier;
  }

  function buildCtx(p) {
    var uc = ucScreen(p);
    var ucTier = null;
    if (uc !== null && !has(p, 'uc')) {
      if (uc > 150) ucTier = 'likely';
      else if (uc > 0) ucTier = 'possible';
      else if (uc > -150) ucTier = 'check';
    }
    var pcTier = has(p, 'pc') ? null : pcScreen(p);
    return { ucEstimate: uc, ucTier: ucTier, pcTier: pcTier };
  }

  // Many schemes are "passported" from a means-tested benefit.
  function gate(p, ctx) {
    if (onMeansTested(p)) return { tier: 'likely', why: 'You already get a qualifying benefit.' };
    if (ctx.ucTier === 'likely' || ctx.ucTier === 'possible') {
      return { tier: 'possible', why: 'You would qualify through Universal Credit, which you may be able to claim.' };
    }
    if (ctx.pcTier === 'likely' || ctx.pcTier === 'possible') {
      return { tier: 'possible', why: 'You would qualify through Pension Credit, which you may be able to claim.' };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Schemes
  // Each check(p, ctx) returns null or { tier, why: [], value?, valueLabel? }
  // tier: 'likely' | 'possible' | 'check'
  // ---------------------------------------------------------------------------
  var S = [];
  function scheme(def) { S.push(def); }

  // ---------------- Core benefits ----------------
  scheme({
    id: 'uc', holds: 'uc', name: 'Universal Credit', category: 'Benefits',
    valueLabel: 'Monthly payment - amount depends on your circumstances',
    evidence: ['National Insurance number', 'Bank details', 'Tenancy agreement and rent amount', 'Payslips or earnings', 'Savings details', 'Childcare costs if any'],
    how: 'Get an accurate figure from a full benefits calculator first, then claim online. You will need to verify your identity and attend a Jobcentre appointment.',
    applyUrl: 'https://www.gov.uk/universal-credit/how-to-claim',
    sourceUrl: 'https://www.gov.uk/universal-credit/eligibility',
    reviewed: '2026-09-22',
    check: function (p, ctx) {
      if (!ctx.ucTier) return null;
      var why = ['Your household income and costs suggest you may be under the Universal Credit limit.'];
      if (kids(p).length) why.push('You have children, which increases the maximum award.');
      if (renting(p)) why.push('Universal Credit can include help with your rent.');
      if (adultHealth(p)) why.push('A health condition may add an extra amount or a higher work allowance.');
      if (caring35(p)) why.push('Caring 35+ hours a week can add a carer amount.');
      why.push('Check with a full calculator before claiming - a claim can end some older benefits.');
      return { tier: ctx.ucTier, why: why };
    }
  });

  scheme({
    id: 'pc', holds: 'pc', name: 'Pension Credit', category: 'Benefits',
    valueLabel: 'Tops up weekly income - and unlocks other help',
    evidence: ['National Insurance number', 'Bank details', 'Income: State Pension, other pensions, earnings', 'Savings and investments', 'Housing costs'],
    how: 'Claim online or call the Pension Credit claim line on 0800 99 1234. It can be backdated up to 3 months.',
    applyUrl: 'https://www.gov.uk/pension-credit/how-to-claim',
    sourceUrl: 'https://www.gov.uk/pension-credit/eligibility',
    reviewed: '2026-09-22',
    check: function (p, ctx) {
      if (!ctx.pcTier) return null;
      var g = isCouple(p) ? C.pc.couple : C.pc.single;
      var why = ['Your weekly income looks close to or below the Pension Credit level of ' + money(g) + ' a week (' + C.taxYear + ').'];
      why.push('Even a small award unlocks Housing Benefit, full Council Tax Reduction, Warm Home Discount, NHS dental help and a free TV licence if 75+.');
      if (p.savings === 'over16') why.push('Savings over ' + GBP + '10,000 reduce the award, but do not stop you claiming.');
      if (adultHealth(p) || caring35(p)) why.push('Disability or caring can add extra amounts on top.');
      return { tier: ctx.pcTier, why: why };
    }
  });

  scheme({
    id: 'aa', holds: 'aa', name: 'Attendance Allowance', category: 'Disability',
    valueLabel: GBP + C.aa.lower.toFixed(2) + ' or ' + GBP + C.aa.higher.toFixed(2) + ' a week - not means-tested',
    evidence: ['Details of your condition and how it affects you', 'GP or specialist details', 'Medication list'],
    how: 'Download or request the claim form. Describe your worst days and the help you need, not just what you manage.',
    applyUrl: 'https://www.gov.uk/attendance-allowance/how-to-claim',
    sourceUrl: 'https://www.gov.uk/attendance-allowance/eligibility',
    reviewed: '2026-09-22',
    check: function (p) {
      if (!spa(p.age) || healthList(p).indexOf('you') === -1) return null;
      if (has(p, 'pip') || has(p, 'dla')) return null;
      return { tier: 'possible', why: ['You are over State Pension age and have a condition that affects daily life.', 'Income and savings do not matter.', 'Getting it can also increase Pension Credit and Housing Benefit.'] };
    }
  });

  scheme({
    id: 'pip', holds: 'pip', name: 'Personal Independence Payment (PIP)', category: 'Disability',
    valueLabel: 'Daily living ' + GBP + C.pipDaily.standard.toFixed(2) + ' - ' + GBP + C.pipDaily.enhanced.toFixed(2) + ' a week, plus possible mobility part - not means-tested',
    evidence: ['Details of your condition and treatment', 'GP and specialist details', 'Medical letters and care plans'],
    how: 'Start the claim by phone, then complete the "How your disability affects you" form. An assessment usually follows.',
    applyUrl: 'https://www.gov.uk/pip/how-to-claim',
    sourceUrl: 'https://www.gov.uk/pip/eligibility',
    reviewed: '2026-09-22',
    check: function (p) {
      var why = [];
      if (healthList(p).indexOf('you') !== -1 && !spa(p.age) && n(p.age) >= 16 && !has(p, 'pip') && !has(p, 'dla')) {
        why.push('You are working age and have a condition that affects daily life or getting around.');
      }
      if (isCouple(p) && healthList(p).indexOf('partner') !== -1 && !spa(p.partnerAge)) {
        why.push('Your partner may be able to claim for their condition.');
      }
      if (!why.length) return null;
      why.push('It is not affected by income, savings or working.');
      return { tier: 'possible', why: why };
    }
  });

  scheme({
    id: 'dlachild', holds: 'dla', name: 'Disability Living Allowance for children', category: 'Disability',
    valueLabel: 'Weekly payment, not means-tested - can also unlock carer support',
    evidence: ['Child\'s diagnosis or medical letters', 'School or nursery reports', 'Care needs diary'],
    how: 'Request or download the DLA for children claim form. Keep a diary of extra care your child needs compared with other children their age.',
    applyUrl: 'https://www.gov.uk/disability-living-allowance-children/how-to-claim',
    sourceUrl: 'https://www.gov.uk/disability-living-allowance-children',
    reviewed: '2026-09-22',
    check: function (p) {
      if (!childHealth(p) || has(p, 'dla')) return null;
      if (!kidsWhere(p, function (a) { return a < 16; }).length) return null;
      return { tier: 'possible', why: ['A child under 16 has a disability or extra care needs.', 'Income and savings do not matter.', 'An award can unlock Carer\'s Allowance and extra Universal Credit.'] };
    }
  });

  // ---------------- Carers ----------------
  scheme({
    id: 'ca', holds: 'ca', name: "Carer's Allowance", category: 'Carers',
    valueLabel: GBP + C.ca.weekly.toFixed(2) + ' a week',
    evidence: ['Your National Insurance number', 'Bank details', 'Cared-for person\'s NI number and their disability benefit', 'Payslips if working'],
    how: 'Claim online. It can be backdated up to 3 months. It can affect the benefits of the person you care for, so check first.',
    applyUrl: 'https://www.gov.uk/carers-allowance/how-to-claim',
    sourceUrl: 'https://www.gov.uk/carers-allowance/eligibility',
    reviewed: '2026-09-22',
    check: function (p) {
      if (!caring35(p) || has(p, 'ca') || n(p.age) < 16) return null;
      var weeklyEarn = youEarn(p) * 12 / 52;
      if (weeklyEarn > C.ca.earningsLimit) {
        return { tier: 'check', why: ['You care 35+ hours a week but your take-home pay looks over the ' + money(C.ca.earningsLimit) + ' a week limit.', 'Some pension contributions and care costs can be deducted - worth checking.'] };
      }
      var why = ['You care for someone 35 hours a week or more.', 'Your earnings look under the ' + money(C.ca.earningsLimit) + ' a week limit.'];
      if (has(p, 'sp')) {
        return { tier: 'check', why: why.concat(['You get State Pension, so you may not be paid it - but "underlying entitlement" can increase Pension Credit and Council Tax Reduction.']) };
      }
      var tier = p.caredBenefit === 'yes' ? 'likely' : 'possible';
      if (p.caredBenefit === 'no') {
        return { tier: 'check', why: why.concat(['The person you care for needs a qualifying disability benefit first - they may be able to claim one.']) };
      }
      if (p.caredBenefit === 'unsure') why.push('Check that the person you care for gets a qualifying disability benefit.');
      return { tier: tier, why: why, value: tier === 'likely' ? C.ca.weekly * 52 : null };
    }
  });

  scheme({
    id: 'carerscredit', holds: null, name: "Carer's Credit", category: 'Carers',
    valueLabel: 'Protects your State Pension - no cash payment',
    evidence: ['Your National Insurance number', 'Details of the person you care for'],
    how: 'Apply using the Carer\'s Credit form. It fills gaps in your National Insurance record.',
    applyUrl: 'https://www.gov.uk/carers-credit/how-to-claim',
    sourceUrl: 'https://www.gov.uk/carers-credit',
    reviewed: '2026-09-22',
    check: function (p) {
      if (!caring20(p) || has(p, 'ca') || spa(p.age)) return null;
      return { tier: 'possible', why: ['You care for someone at least 20 hours a week.', 'It protects your State Pension if you are not paying National Insurance.'] };
    }
  });

  // ---------------- Children & childcare ----------------
  scheme({
    id: 'cb', holds: 'cb', name: 'Child Benefit', category: 'Children & childcare',
    valueLabel: GBP + C.cb.eldest.toFixed(2) + ' a week for the eldest, ' + GBP + C.cb.additional.toFixed(2) + ' for each other child',
    evidence: ['Child\'s birth certificate', 'Your National Insurance number', 'Bank details'],
    how: 'Claim online or through the HMRC app. It can be backdated 3 months.',
    applyUrl: 'https://www.gov.uk/child-benefit/how-to-claim',
    sourceUrl: 'https://www.gov.uk/child-benefit',
    reviewed: '2026-09-22',
    check: function (p) {
      if (has(p, 'cb')) return null;
      var under16 = kidsWhere(p, function (a) { return a < 16; }).length;
      var older = kidsWhere(p, function (a) { return a >= 16; }).length;
      if (!under16 && !older) return null;
      var count = under16 + older;
      var value = (C.cb.eldest + Math.max(0, count - 1) * C.cb.additional) * 52;
      var why = ['You have ' + count + ' child' + (count > 1 ? 'ren' : '') + ' living with you and are not claiming Child Benefit.'];
      if (older) why.push('Children aged 16-19 count only if in approved full-time education or training.');
      if (p.highEarner === 'over100' || p.highEarner === '80to100') {
        return { tier: 'check', why: why.concat(['A high earner would have to pay it all back through tax - but claiming still protects the other parent\'s State Pension. You can opt out of payments.']) };
      }
      if (p.highEarner === '60to80') why.push('Someone earns over ' + GBP + '60,000 so some of it would be repaid through tax.');
      return { tier: under16 ? 'likely' : 'possible', why: why, value: p.highEarner === '60to80' ? null : value };
    }
  });

  scheme({
    id: 'tfc', holds: 'tfc', name: 'Tax-Free Childcare', category: 'Children & childcare',
    valueLabel: 'Government adds ' + GBP + '2 for every ' + GBP + '8 you pay - up to ' + money(C.tfc.capPerChild) + ' a year per child',
    evidence: ['National Insurance numbers', 'Details of your childcare provider', 'Expected earnings for the next 3 months'],
    how: 'Apply online through your childcare account. You must reconfirm your details every 3 months.',
    applyUrl: 'https://www.gov.uk/apply-for-tax-free-childcare',
    sourceUrl: 'https://www.gov.uk/tax-free-childcare',
    reviewed: '2026-09-22',
    check: function (p, ctx) {
      if (has(p, 'tfc')) return null;
      var eligibleKids = kidsWhere(p, function (a) { return a < 12 || (childHealth(p) && a < 17); }).length;
      if (!eligibleKids || !allAdultsWorking(p) || p.highEarner === 'over100') return null;
      var lowEarner = youEarn(p) < C.tfc.minMonthlyEarnings || (isCouple(p) && partnerEarn(p) < C.tfc.minMonthlyEarnings);
      var why = ['You work and have children under 12 (or under 17 if disabled).'];
      if (has(p, 'uc') || ctx.ucTier === 'likely') {
        return { tier: 'check', why: why.concat(['You cannot get this and Universal Credit at the same time. Universal Credit childcare usually pays more for lower earners - compare both.']) };
      }
      var tier = lowEarner ? 'possible' : 'likely';
      if (lowEarner) why.push('Each parent must expect to earn at least 16 hours a week at the minimum wage - check yours.');
      var cost = n(p.childcareCost);
      if (cost <= 0) {
        return { tier: 'check', why: why.concat(['Only useful if you pay for registered childcare, including holiday clubs.']) };
      }
      var value = Math.min(cost * 12 * C.tfc.topUpRate, eligibleKids * C.tfc.capPerChild);
      return { tier: tier, why: why.concat(['You pay about ' + money(cost) + ' a month for childcare.']), value: tier === 'likely' ? value : null };
    }
  });

  scheme({
    id: 'ucchildcare', holds: null, name: 'Universal Credit childcare costs', category: 'Children & childcare',
    valueLabel: 'Up to 85% of childcare costs paid back',
    evidence: ['Childcare invoices and receipts', 'Provider\'s Ofsted registration number'],
    how: 'Report your childcare costs in your Universal Credit journal. Upfront costs can sometimes be paid in advance.',
    applyUrl: 'https://www.gov.uk/help-with-childcare-costs/universal-credit',
    sourceUrl: 'https://www.gov.uk/help-with-childcare-costs/universal-credit',
    reviewed: '2026-09-22',
    check: function (p, ctx) {
      if (n(p.childcareCost) <= 0 || !kidsWhere(p, function (a) { return a < 17; }).length) return null;
      if (!allAdultsWorking(p)) return null;
      if (has(p, 'uc')) return { tier: 'likely', why: ['You get Universal Credit, work, and pay for childcare.', 'Make sure you report every invoice - many people miss this.'] };
      if (ctx.ucTier === 'likely' || ctx.ucTier === 'possible') return { tier: 'possible', why: ['If you claim Universal Credit, it can pay up to 85% of your childcare costs.'] };
      return null;
    }
  });

  scheme({
    id: 'childcarehours', holds: 'childcarehours', name: 'Free childcare hours', category: 'Children & childcare',
    valueLabel: 'Up to 30 hours a week in term time - worth thousands a year',
    evidence: ['National Insurance numbers', 'Child\'s date of birth', 'Expected earnings (for working-parent hours)'],
    how: 'For working-parent hours, apply online for a code and give it to your nursery. Reconfirm every 3 months. For 15 universal hours, ask your provider directly.',
    applyUrl: 'https://www.gov.uk/check-eligible-free-childcare-if-youre-working',
    sourceUrl: 'https://www.gov.uk/help-with-childcare-costs/free-childcare-and-education-for-2-to-4-year-olds',
    reviewed: '2026-09-22',
    check: function (p) {
      if (has(p, 'childcarehours')) return null;
      var preschool = kidsWhere(p, function (a) { return a <= 4; });
      if (!preschool.length) return null;
      var why = [];
      var tier = null;
      var working = allAdultsWorking(p) && p.highEarner !== 'over100';
      if (working) { why.push('Working parents can get 30 hours a week from 9 months old until school.'); tier = 'likely'; }
      if (preschool.some(function (a) { return a === 3 || a === 4; })) { why.push('All 3 and 4 year olds get 15 hours a week, whatever your income.'); tier = 'likely'; }
      if (preschool.indexOf(2) !== -1 && !working) {
        if (has(p, 'uc') && earningsMonthly(p) * 12 <= C.funded2yoEarningsAnnual) { why.push('2 year olds get 15 hours if you get Universal Credit with earnings under ' + money(C.funded2yoEarningsAnnual) + ' a year.'); tier = 'likely'; }
        else if (childHealth(p) || onMeansTested(p)) { why.push('Some 2 year olds qualify through benefits or disability - check with the council.'); tier = tier || 'possible'; }
      }
      if (!tier) return null;
      return { tier: tier, why: why };
    }
  });

  scheme({
    id: 'fsm', holds: 'fsm', name: 'Free school meals', category: 'Children & childcare',
    valueLabel: 'About ' + money(C.fsmPerChild) + ' a year per child',
    evidence: ['Your National Insurance number', 'Child\'s name and date of birth'],
    how: 'Apply through your council. From September 2026, every child in a Universal Credit household in England qualifies - but you still need to apply.',
    applyUrl: 'https://www.gov.uk/apply-free-school-meals',
    sourceUrl: 'https://www.gov.uk/apply-free-school-meals',
    reviewed: '2026-09-22',
    check: function (p, ctx) {
      if (has(p, 'fsm')) return null;
      var school = kidsWhere(p, function (a) { return a >= 4 && a <= 18; });
      if (!school.length) return null;
      var older = kidsWhere(p, function (a) { return a >= 7 && a <= 18; }).length;
      var g = gate(p, ctx);
      if (!g) return null;
      var why = [g.why, 'You have school-age children.'];
      if (school.length > older) why.push('Infants (reception to year 2) already get free meals - registering still gets the school extra funding.');
      return { tier: g.tier, why: why, value: g.tier === 'likely' && older ? older * C.fsmPerChild : null };
    }
  });

  scheme({
    id: 'healthystart', holds: 'healthystart', name: 'Healthy Start card', category: 'Children & childcare',
    valueLabel: GBP + C.healthyStart.oneToFourWeekly.toFixed(2) + ' - ' + GBP + C.healthyStart.under1Weekly.toFixed(2) + ' a week for milk, fruit, veg and formula',
    evidence: ['National Insurance number', 'Due date or child\'s date of birth', 'Proof of Universal Credit or Pension Credit'],
    how: 'Apply online on the NHS Healthy Start website. The card is topped up every 4 weeks.',
    applyUrl: 'https://www.healthystart.nhs.uk/how-to-apply/',
    sourceUrl: 'https://www.healthystart.nhs.uk/',
    reviewed: '2026-09-22',
    check: function (p, ctx) {
      if (has(p, 'healthystart')) return null;
      var under1 = kidsWhere(p, function (a) { return a < 1; }).length;
      var oneToFour = kidsWhere(p, function (a) { return a >= 1 && a < 4; }).length;
      var pregnant = p.pregnant === 'yes';
      if (!under1 && !oneToFour && !pregnant) return null;
      var H = C.healthyStart;
      var value = (under1 * H.under1Weekly + oneToFour * H.oneToFourWeekly) * 52 + (pregnant ? H.pregnancyWeekly * 26 : 0);
      if ((has(p, 'uc') && earningsMonthly(p) <= H.earningsMonthly) || has(p, 'pc')) {
        return { tier: 'likely', why: ['You are pregnant or have a child under 4.', 'You get a qualifying benefit with earnings under ' + money(H.earningsMonthly) + ' a month.'], value: value };
      }
      if (has(p, 'uc')) return { tier: 'check', why: ['You get Universal Credit, but family take-home pay must be ' + money(H.earningsMonthly) + ' a month or less.'] };
      if (ctx.ucTier === 'likely' && earningsMonthly(p) <= H.earningsMonthly) return { tier: 'possible', why: ['If you claim Universal Credit, you would qualify.'] };
      return null;
    }
  });

  scheme({
    id: 'ssmg', holds: null, name: 'Sure Start Maternity Grant', category: 'Children & childcare',
    valueLabel: money(C.ssmg) + ' one-off payment',
    evidence: ['Proof of benefit', 'Midwife or doctor confirmation (MATB1)'],
    how: 'Claim from 11 weeks before the due date until the baby is 6 months old. You do not have to pay it back.',
    applyUrl: 'https://www.gov.uk/sure-start-maternity-grant/how-to-claim',
    sourceUrl: 'https://www.gov.uk/sure-start-maternity-grant',
    reviewed: '2026-09-22',
    check: function (p, ctx) {
      var baby = kidsWhere(p, function (a) { return a < 1; }).length;
      if (p.pregnant !== 'yes' && !baby) return null;
      var otherUnder16 = kidsWhere(p, function (a) { return a < 16; }).length - baby;
      var g = gate(p, ctx);
      if (!g) return null;
      var why = [g.why];
      var tier = g.tier;
      if (otherUnder16 > 0) { why.push('Usually only for the first child - but you may qualify for twins or triplets.'); tier = 'check'; }
      else why.push('This looks like your first child under 16.');
      if (baby && p.pregnant !== 'yes') why.push('You must claim before your baby is 6 months old.');
      return { tier: tier, why: why, value: tier === 'likely' ? C.ssmg : null };
    }
  });

  // ---------------- Health costs ----------------
  scheme({
    id: 'nhsbenefit', holds: 'nhscert', name: 'Free NHS prescriptions, dental and glasses (through benefits)', category: 'Health costs',
    valueLabel: 'Free prescriptions, NHS dental, eye tests, glasses vouchers and travel to hospital',
    evidence: ['Universal Credit statement showing earnings, or Pension Credit letter'],
    how: 'No application needed - tick the right box when you collect a prescription or see a dentist. Keep your latest statement in case of checks, because penalty charges are issued if you claim wrongly.',
    applyUrl: 'https://www.nhsbsa.nhs.uk/check-if-youre-eligible-help',
    sourceUrl: 'https://www.nhs.uk/nhs-services/help-with-health-costs/',
    reviewed: '2026-09-22',
    check: function (p) {
      if (has(p, 'nhscert')) return null;
      if (has(p, 'pc')) return { tier: 'likely', why: ['Pension Credit guarantee credit gives full help with health costs.'] };
      if (has(p, 'esa') || has(p, 'jsa')) return { tier: 'likely', why: ['Income-related ESA or JSA gives full help with health costs.'] };
      if (has(p, 'uc')) {
        var limit = (kids(p).length || adultHealth(p)) ? C.nhs.ucEarningsChildOrLcw : C.nhs.ucEarnings;
        if (earningsMonthly(p) <= limit) return { tier: 'likely', why: ['You get Universal Credit with take-home earnings of ' + money(limit) + ' or less in the last assessment period.'] };
        return { tier: 'check', why: ['You get Universal Credit, but your earnings may be over the ' + money(limit) + ' limit - check each month before ticking the box.'] };
      }
      return null;
    }
  });

  scheme({
    id: 'lis', holds: 'nhscert', name: 'NHS Low Income Scheme (HC2/HC3 certificate)', category: 'Health costs',
    valueLabel: 'Full or partial help with prescriptions, dental, glasses and travel',
    evidence: ['Income details for everyone in the household', 'Savings details', 'Rent or mortgage details'],
    how: 'Apply online with form HC1. Certificates usually last 6 months to 5 years.',
    applyUrl: 'https://www.nhsbsa.nhs.uk/nhs-low-income-scheme',
    sourceUrl: 'https://www.nhs.uk/nhs-services/help-with-health-costs/nhs-low-income-scheme-lis/',
    reviewed: '2026-09-22',
    check: function (p) {
      if (has(p, 'nhscert') || onMeansTested(p) || p.savings === 'over16') return null;
      var base = (isCouple(p) ? 1400 : 900) + kids(p).length * 300 + (renting(p) || p.housing === 'mortgage' ? n(p.rent) : 0);
      var inc = householdNetMonthly(p);
      if (inc <= base) return { tier: 'possible', why: ['Your income looks low compared with your household needs.', 'You have under ' + money(C.nhs.capital) + ' in savings.'] };
      if (inc <= base + 500) return { tier: 'check', why: ['You may get partial help (HC3) with health costs.'] };
      return null;
    }
  });

  scheme({
    id: 'maternityex', holds: 'nhscert', name: 'Maternity exemption certificate', category: 'Health costs',
    valueLabel: 'Free prescriptions and NHS dental until 12 months after birth',
    evidence: ['Midwife, GP or health visitor to countersign form FW8'],
    how: 'Ask your midwife, GP or health visitor for the application. It lasts until 12 months after the due date or birth.',
    applyUrl: 'https://www.nhsbsa.nhs.uk/exemption-certificates/maternity-exemption-certificates',
    sourceUrl: 'https://www.nhsbsa.nhs.uk/exemption-certificates/maternity-exemption-certificates',
    reviewed: '2026-09-22',
    check: function (p) {
      var baby = kidsWhere(p, function (a) { return a < 1; }).length;
      if (p.pregnant !== 'yes' && !baby) return null;
      return { tier: 'likely', why: ['Anyone pregnant or with a baby under 12 months gets free prescriptions and NHS dental care, whatever their income.'] };
    }
  });

  scheme({
    id: 'ppc', holds: null, name: 'Prescription prepayment certificate or medical exemption', category: 'Health costs',
    valueLabel: 'Caps prescription costs - or makes them free for some conditions',
    evidence: ['A list of your regular prescriptions'],
    how: 'If you have diabetes on medication, epilepsy, cancer, an underactive thyroid or certain other conditions, ask your GP about a medical exemption. Otherwise a prepayment certificate saves money if you need more than a few items a year.',
    applyUrl: 'https://www.nhsbsa.nhs.uk/help-nhs-prescription-costs/prescription-prepayment-certificates-ppcs',
    sourceUrl: 'https://www.nhsbsa.nhs.uk/exemption-certificates/medical-exemption-certificates',
    reviewed: '2026-09-22',
    check: function (p) {
      if (!adultHealth(p) || has(p, 'nhscert') || onMeansTested(p)) return null;
      if (n(p.age) >= 60 && (!isCouple(p) || n(p.partnerAge) >= 60)) return null;
      return { tier: 'check', why: ['An adult in your home has a long-term condition and may pay for regular prescriptions.', 'Prescriptions are already free at 60 and over.'] };
    }
  });

  // ---------------- Council Tax ----------------
  scheme({
    id: 'ctr', holds: 'ctr', name: 'Council Tax Reduction', category: 'Council Tax',
    valueLabel: 'Up to 100% off your Council Tax bill - depends on your council\'s scheme',
    evidence: ['Council Tax account number', 'Proof of income and benefits', 'Savings details', 'Details of other adults in the home'],
    how: 'Apply to your district or city council. Apply even while waiting for a Universal Credit or Pension Credit decision - it is not automatic.',
    applyUrl: 'https://www.gov.uk/apply-council-tax-reduction',
    sourceUrl: 'https://www.gov.uk/council-tax-reduction',
    reviewed: '2026-09-22',
    check: function (p, ctx) {
      if (!liable(p) || has(p, 'ctr')) return null;
      var why = [];
      if (p.district && inNotts(p)) why.push('Your council (' + p.district + ') runs its own scheme.');
      if (has(p, 'pc')) return { tier: 'likely', why: ['Pension Credit guarantee credit usually means no Council Tax to pay.'].concat(why) };
      if (onMeansTested(p)) return { tier: 'likely', why: ['You get a means-tested benefit, which usually qualifies you.'].concat(why) };
      if (p.savings === 'over16') return null;
      if (ctx.ucTier === 'likely' || ctx.pcTier === 'likely') return { tier: 'possible', why: ['Your income looks low enough to qualify.'].concat(why) };
      var limit = (isCouple(p) ? 2200 : 1600) + kids(p).length * 300;
      if (householdNetMonthly(p) < limit) return { tier: 'check', why: ['Your income may be low enough for some reduction.'].concat(why) };
      return null;
    }
  });

  scheme({
    id: 'spd', holds: 'spd', name: 'Council Tax single person discount', category: 'Council Tax',
    valueLabel: '25% off your Council Tax bill',
    evidence: ['Council Tax account number', 'Date you started living alone as the only adult'],
    how: 'Apply to your council online. It can often be backdated to when you became the only adult.',
    applyUrl: 'https://www.gov.uk/apply-for-council-tax-discount',
    sourceUrl: 'https://www.gov.uk/council-tax/discounts-for-people-who-live-alone',
    reviewed: '2026-09-22',
    check: function (p) {
      if (!liable(p) || has(p, 'spd') || isCouple(p) || n(p.otherAdults) > 0) return null;
      var ct = n(p.ctAnnual);
      var why = ['You are the only adult in your home.', 'Income and savings do not matter.'];
      if (has(p, 'ctr')) why.push('If you already get full Council Tax Reduction, this may already be applied.');
      return { tier: 'likely', why: why, value: ct > 0 && !has(p, 'ctr') ? ct * 0.25 : null };
    }
  });

  scheme({
    id: 'ctdisregard', holds: null, name: 'Council Tax discounts for carers and disability', category: 'Council Tax',
    valueLabel: 'A lower band, or some adults not counted for Council Tax',
    evidence: ['Details of the disability or care arrangement', 'Details of any adaptations to your home'],
    how: 'Ask your council about the disabled band reduction and carer or "severe mental impairment" disregards.',
    applyUrl: 'https://www.gov.uk/council-tax/discounts-for-disabled-people',
    sourceUrl: 'https://www.gov.uk/council-tax/discounts-for-disabled-people',
    reviewed: '2026-09-22',
    check: function (p) {
      if (!liable(p)) return null;
      if (healthAny(p) || caring35(p)) {
        return { tier: 'check', why: ['Someone in your home has a disability or you provide substantial care.', 'You may get a lower band if your home has been adapted, or some adults may not count.'] };
      }
      return null;
    }
  });

  // ---------------- Energy, water, broadband ----------------
  scheme({
    id: 'whd', holds: 'whd', name: 'Warm Home Discount', category: 'Energy & water',
    valueLabel: money(C.whd) + ' off your electricity bill each winter',
    evidence: ['Electricity account in your or your partner\'s name'],
    how: 'Usually automatic from October to March. If you qualify but have not had it by early 2027, call the Warm Home Discount helpline or your supplier.',
    applyUrl: 'https://www.gov.uk/the-warm-home-discount-scheme',
    sourceUrl: 'https://www.gov.uk/the-warm-home-discount-scheme',
    reviewed: '2026-09-22',
    check: function (p, ctx) {
      if (p.housing === 'family') return null;
      var qual = has(p, 'uc') || has(p, 'pc') || has(p, 'hb') || has(p, 'esa');
      if (qual) return { tier: 'likely', why: ['You get a qualifying benefit.', 'You need to have been on it on ' + C.whdQualifyingDate + ' and named on the electricity bill.'], value: C.whd };
      var g = gate(p, ctx);
      if (!g) return null;
      return { tier: 'check', why: ['This winter\'s qualifying date (' + C.whdQualifyingDate + ') has passed - claiming Universal Credit or Pension Credit now means you should get it next winter.'] };
    }
  });

  scheme({
    id: 'bigdiff', holds: 'bigdiff', name: 'Severn Trent Big Difference Scheme', category: 'Energy & water',
    valueLabel: 'Up to ' + money(C.bigDifference.upTo) + ' off your yearly water bill',
    evidence: ['Water account number', 'Proof of household income (payslips, benefit letters)'],
    how: 'Apply online to Severn Trent. You need to reapply every year.',
    applyUrl: 'https://www.stwater.co.uk/help-and-contact/help-with-paying-your-bill/big-difference-scheme/',
    sourceUrl: 'https://www.stwater.co.uk/help-and-contact/help-with-paying-your-bill/big-difference-scheme/',
    reviewed: '2026-09-22',
    check: function (p) {
      if (!liable(p) || has(p, 'bigdiff')) return null;
      if (!(p.water === 'severn' || (p.water === 'unsure' && inNotts(p)))) return null;
      var annual = householdNetMonthly(p) * 12;
      var why = [];
      if (p.water === 'unsure') why.push('Severn Trent supplies most of Nottinghamshire - check your water bill.');
      if (annual < C.bigDifference.incomeLimit) return { tier: 'possible', why: ['Your household income looks under ' + money(C.bigDifference.incomeLimit) + ' a year.'].concat(why) };
      if (kids(p).length && annual < C.bigDifference.incomeLimit + kids(p).length * 3000) return { tier: 'check', why: ['Households with children get a higher income allowance.'].concat(why) };
      return null;
    }
  });

  scheme({
    id: 'watersure', holds: null, name: 'WaterSure Plus / other water bill help', category: 'Energy & water',
    valueLabel: 'Caps a metered water bill',
    evidence: ['Water account number', 'Proof of benefit', 'Medical evidence if a condition needs extra water'],
    how: 'Ask your water company. You need a water meter (or to have applied for one) and a means-tested benefit, plus 3+ children or a medical condition that uses extra water.',
    applyUrl: 'https://www.stwater.co.uk/help-and-contact/help-with-paying-your-bill/',
    sourceUrl: 'https://www.ofwat.gov.uk/',
    reviewed: '2026-09-22',
    check: function (p) {
      if (!liable(p) || !onMeansTested(p)) return null;
      var many = kidsWhere(p, function (a) { return a < 19; }).length >= 3;
      if (!many && !healthAny(p)) return null;
      var why = [many ? 'You have 3 or more children and get a means-tested benefit.' : 'Someone has a health condition and you get a means-tested benefit.'];
      if (p.water === 'anglian') why.push('Anglian Water runs its own WaterSure and social tariff - apply to them.');
      return { tier: 'check', why: why };
    }
  });

  scheme({
    id: 'socialtariff', holds: 'socialtariff', name: 'Broadband and mobile social tariffs', category: 'Energy & water',
    valueLabel: 'Cheaper broadband or mobile - often ' + GBP + '100-' + GBP + '200 a year saved',
    evidence: ['Proof of benefit (usually checked automatically with DWP)'],
    how: 'Ask your current provider for their social tariff. There is usually no exit fee to switch to it.',
    applyUrl: 'https://www.ofcom.org.uk/phones-and-broadband/saving-money/social-tariffs',
    sourceUrl: 'https://www.ofcom.org.uk/phones-and-broadband/saving-money/social-tariffs',
    reviewed: '2026-09-22',
    check: function (p, ctx) {
      if (has(p, 'socialtariff')) return null;
      if (onMeansTested(p)) return { tier: 'likely', why: ['You get a benefit that most providers accept for social tariffs.'] };
      if (has(p, 'pip') || has(p, 'aa') || has(p, 'dla')) return { tier: 'possible', why: ['Some providers accept disability benefits.'] };
      var g = gate(p, ctx);
      return g ? { tier: 'check', why: [g.why] } : null;
    }
  });

  scheme({
    id: 'psr', holds: 'psr', name: 'Priority Services Register', category: 'Energy & water',
    valueLabel: 'Free extra support from energy and water companies',
    evidence: ['None - just tell your supplier'],
    how: 'Contact your energy supplier, network operator and water company. You get advance notice of power cuts, priority support and password schemes.',
    applyUrl: 'https://www.ofgem.gov.uk/information-consumers/energy-advice-households/getting-extra-help-priority-services-register',
    sourceUrl: 'https://www.ofgem.gov.uk/information-consumers/energy-advice-households/getting-extra-help-priority-services-register',
    reviewed: '2026-09-22',
    check: function (p) {
      if (has(p, 'psr') || p.housing === 'family') return null;
      var why = [];
      if (anyPensionAge(p)) why.push('Someone in your home is over State Pension age.');
      if (healthAny(p)) why.push('Someone has a long-term condition or disability.');
      if (kidsWhere(p, function (a) { return a < 5; }).length) why.push('You have a child under 5.');
      if (p.pregnant === 'yes') why.push('Someone is pregnant.');
      return why.length ? { tier: 'likely', why: why } : null;
    }
  });

  scheme({
    id: 'energygrant', holds: null, name: 'Energy debt and efficiency help', category: 'Energy & water',
    valueLabel: 'Grants to clear energy debt; free home energy improvements',
    evidence: ['Recent energy bills', 'Income and outgoings'],
    how: 'Nottingham Energy Partnership gives free local advice. The British Gas Energy Trust offers help to people with any supplier, usually through an adviser.',
    applyUrl: 'https://www.nottenergy.com/',
    sourceUrl: 'https://www.britishgasenergytrust.org.uk/',
    reviewed: '2026-09-22',
    check: function (p, ctx) {
      if (p.housing === 'family') return null;
      if (!(onMeansTested(p) || gate(p, ctx) || (p.savings === 'under6' && householdNetMonthly(p) < 1800))) return null;
      return { tier: 'check', why: ['Your income suggests you could get help with energy debt or free insulation and heating upgrades.'] };
    }
  });

  // ---------------- Travel ----------------
  scheme({
    id: 'buspass', holds: 'buspass', name: 'Free bus pass', category: 'Travel',
    valueLabel: 'Free off-peak local bus travel across England',
    evidence: ['Proof of age or disability', 'Proof of address', 'A passport-style photo'],
    how: isCityNote(),
    applyUrl: 'https://www.gov.uk/apply-for-elderly-person-bus-pass',
    sourceUrl: 'https://www.gov.uk/apply-for-elderly-person-bus-pass',
    reviewed: '2026-09-22',
    check: function (p) {
      if (has(p, 'buspass')) return null;
      if (spa(p.age)) return { tier: 'likely', why: ['You are over State Pension age.'], applyUrl: 'https://www.gov.uk/apply-for-elderly-person-bus-pass' };
      if (adultHealth(p) && (p.mobility === 'yes' || has(p, 'pip') || has(p, 'dla'))) {
        return { tier: 'possible', why: ['A disability or mobility difficulty may qualify you for a disabled person\'s bus pass.'], applyUrl: 'https://www.gov.uk/apply-for-disabled-bus-pass' };
      }
      return null;
    }
  });
  function isCityNote() {
    return 'Apply to your council: Nottingham City Council if you live in the city, Nottinghamshire County Council if you live in the county. In Nottingham, some passes also cover trams.';
  }

  scheme({
    id: 'bluebadge', holds: 'bluebadge', name: 'Blue Badge', category: 'Travel',
    valueLabel: 'Park closer, often free, in disabled bays',
    evidence: ['Proof of identity and address', 'Photo', 'Benefit letter or medical details'],
    how: 'Apply online to your council. Some people qualify automatically through PIP or DLA mobility awards.',
    applyUrl: 'https://www.gov.uk/apply-blue-badge',
    sourceUrl: 'https://www.gov.uk/government/publications/blue-badge-can-i-get-one',
    reviewed: '2026-09-22',
    check: function (p) {
      if (has(p, 'bluebadge') || !healthAny(p)) return null;
      if (p.mobility !== 'yes') return null;
      return { tier: 'possible', why: ['Someone in your home has difficulty walking or getting around.', 'Hidden conditions can also qualify.'] };
    }
  });

  scheme({
    id: 'railcard', holds: 'railcard', name: 'Railcard', category: 'Travel',
    valueLabel: '1/3 off most rail fares',
    evidence: ['Proof of age or eligibility'],
    how: 'Buy online. It usually pays for itself after one or two journeys.',
    applyUrl: 'https://www.railcard.co.uk/',
    sourceUrl: 'https://www.railcard.co.uk/',
    reviewed: '2026-09-22',
    check: function (p) {
      if (has(p, 'railcard')) return null;
      var why = [];
      var age = n(p.age);
      if (age >= 60) why.push('Senior Railcard: you are 60 or over.');
      else if (age >= 16 && age <= 25) why.push('16-25 Railcard: you are 16-25.');
      else if (age >= 26 && age <= 30) why.push('26-30 Railcard: you are 26-30.');
      if (has(p, 'pip') || has(p, 'dla') || has(p, 'aa') || (healthAny(p) && p.mobility === 'yes')) why.push('Disabled Persons Railcard: 1/3 off for you and a companion.');
      if (kidsWhere(p, function (a) { return a >= 5 && a <= 15; }).length) why.push('Family & Friends Railcard: 1/3 off adults and 60% off children.');
      return why.length ? { tier: 'check', why: why } : null;
    }
  });

  // ---------------- Tax & savings ----------------
  scheme({
    id: 'marriage', holds: 'marriage', name: 'Marriage Allowance', category: 'Tax',
    valueLabel: 'Up to ' + money(C.marriageAllowance) + ' a year less tax',
    evidence: ['Both National Insurance numbers', 'Proof of identity for the lower earner'],
    how: 'The lower earner applies online. It can be backdated up to 4 tax years.',
    applyUrl: 'https://www.gov.uk/apply-marriage-allowance',
    sourceUrl: 'https://www.gov.uk/marriage-allowance',
    reviewed: '2026-09-22',
    check: function (p) {
      if (p.relationship !== 'married' || has(p, 'marriage')) return null;
      var a = youEarn(p) * 12 + n(p.otherIncome) * 12;
      var b = partnerEarn(p) * 12;
      var low = Math.min(a, b), high = Math.max(a, b);
      // net income used as a proxy for gross at these levels
      if (low < C.personalAllowance && high >= C.personalAllowance && high < 42000) {
        return { tier: 'likely', why: ['One of you earns under the ' + money(C.personalAllowance) + ' Personal Allowance and the other pays basic rate tax.', 'You may also be able to backdate it for up to 4 years.'], value: C.marriageAllowance };
      }
      return null;
    }
  });

  scheme({
    id: 'help2save', holds: 'help2save', name: 'Help to Save', category: 'Tax',
    valueLabel: '50% government bonus on savings - up to ' + GBP + '1,200 over 4 years',
    evidence: ['Government Gateway account', 'Universal Credit in payment'],
    how: 'Open an account online. Save up to ' + GBP + '50 a month and get a 50% bonus after 2 and 4 years.',
    applyUrl: 'https://www.gov.uk/get-help-savings-low-income',
    sourceUrl: 'https://www.gov.uk/get-help-savings-low-income',
    reviewed: '2026-09-22',
    check: function (p) {
      if (has(p, 'help2save') || !has(p, 'uc') || earningsMonthly(p) <= 0) return null;
      return { tier: 'likely', why: ['You work and get Universal Credit.', 'Even ' + GBP + '5 a month earns a 50% bonus.'] };
    }
  });

  // ---------------- Local and grants ----------------
  scheme({
    id: 'crf', holds: null, name: 'Emergency help from your council (Crisis and Resilience Fund)', category: 'Local & grants',
    valueLabel: 'One-off help with food, energy, clothing or essential appliances in a crisis',
    evidence: ['Proof of identity and address', 'Two months of bank statements (county)'],
    how: 'Only for an immediate financial crisis. The fund is run separately by Nottingham City Council and Nottinghamshire County Council.',
    applyUrl: 'https://www.nottinghamshire.gov.uk/business-community/cost-of-living-support/crisis-and-resilience-fund/apply-for-emergency-support',
    sourceUrl: 'https://www.nottinghamshire.gov.uk/business-community/cost-of-living-support/crf',
    reviewed: '2026-09-22',
    check: function (p) {
      if (!inNotts(p)) return null;
      if (isCity(p)) {
        if (!onMeansTested(p) && householdNetMonthly(p) > 2500) return null;
        return { tier: 'check', why: ['You live in Nottingham City. If you are in an emergency, the council can help with crisis payments and advice.'], applyUrl: 'https://www.nottinghamcity.gov.uk/information-for-residents/benefits/crisis-and-resilience-fund/i-need-help-now/', sourceUrl: 'https://www.nottinghamcity.gov.uk/information-for-residents/benefits/crisis-and-resilience-fund/' };
      }
      if (householdNetMonthly(p) * 12 >= C.crfCountyIncomeLimit) return null;
      return { tier: 'check', why: ['You live in Nottinghamshire with household income under ' + money(C.crfCountyIncomeLimit) + '.', 'Only if you have had a financial crisis in the last month. Up to 2 applications a year.'] };
    }
  });

  scheme({
    id: 'dhp', holds: null, name: 'Discretionary Housing Payment', category: 'Local & grants',
    valueLabel: 'Help to cover a rent shortfall',
    evidence: ['Tenancy agreement', 'Benefit award showing housing help', 'Income and spending details'],
    how: 'Apply to your district or city council if your housing help does not cover your rent.',
    applyUrl: 'https://www.gov.uk/find-local-council',
    sourceUrl: 'https://www.gov.uk/government/collections/discretionary-housing-payments-guidance',
    reviewed: '2026-09-22',
    check: function (p) {
      if (!renting(p) || !(has(p, 'uc') || has(p, 'hb'))) return null;
      if (p.housing === 'private' && n(p.rent) > C.uc.housingCapPrivateApprox) {
        return { tier: 'possible', why: ['You rent privately and your rent may be higher than the housing help you get.'] };
      }
      return { tier: 'check', why: ['If your benefit does not cover your full rent, the council may top it up.'] };
    }
  });

  scheme({
    id: 'familyfund', holds: null, name: 'Family Fund grant', category: 'Local & grants',
    valueLabel: 'Grants for families raising a disabled or seriously ill child',
    evidence: ['Details of your child\'s condition', 'Proof of benefit or income'],
    how: 'Apply online. Grants can cover things like appliances, sensory toys, laptops and breaks.',
    applyUrl: 'https://www.familyfund.org.uk/',
    sourceUrl: 'https://www.familyfund.org.uk/',
    reviewed: '2026-09-22',
    check: function (p, ctx) {
      if (!childHealth(p) || !kidsWhere(p, function (a) { return a < 18; }).length) return null;
      var low = onMeansTested(p) || gate(p, ctx) || householdNetMonthly(p) * 12 < 27000;
      return low ? { tier: 'possible', why: ['You have a child with a disability or serious illness and a low household income.'] } : null;
    }
  });

  scheme({
    id: 'grants', holds: null, name: 'Charity grants search', category: 'Local & grants',
    valueLabel: 'Hundreds of charitable funds for specific jobs, illnesses and situations',
    evidence: ['Depends on the fund'],
    how: 'Search the Turn2us grants database using your job history, health and situation. Many funds are for former workers in particular trades.',
    applyUrl: 'https://grants-search.turn2us.org.uk/',
    sourceUrl: 'https://www.turn2us.org.uk/',
    reviewed: '2026-09-22',
    check: function (p, ctx) {
      if (!(onMeansTested(p) || gate(p, ctx) || householdNetMonthly(p) < 2000)) return null;
      return { tier: 'check', why: ['Your income suggests you could be eligible for charitable grants.'] };
    }
  });

  // ---------------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------------
  var TIER_ORDER = { likely: 0, possible: 1, check: 2, receiving: 3 };

  function evaluate(profile) {
    var p = profile || {};
    var ctx = buildCtx(p);
    var results = [];
    var seenHolds = {};
    S.forEach(function (s) {
      var out;
      try { out = s.check(p, ctx); } catch (e) { out = null; }
      var base = {
        id: s.id,
        name: s.name,
        category: s.category,
        valueLabel: s.valueLabel,
        evidence: s.evidence,
        how: s.how,
        applyUrl: s.applyUrl,
        sourceUrl: s.sourceUrl,
        reviewed: s.reviewed
      };
      if (s.holds && has(p, s.holds) && !seenHolds[s.holds]) {
        seenHolds[s.holds] = true;
        results.push(Object.assign(base, { tier: 'receiving', why: ['You told us you already get this.'], value: null }));
        return;
      }
      if (!out) return;
      results.push(Object.assign(base, {
        tier: out.tier,
        why: out.why || [],
        value: typeof out.value === 'number' && out.value > 0 ? Math.round(out.value) : null,
        applyUrl: out.applyUrl || s.applyUrl,
        sourceUrl: out.sourceUrl || s.sourceUrl
      }));
    });
    results.sort(function (a, b) {
      var t = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
      if (t) return t;
      return (b.value || 0) - (a.value || 0);
    });
    var likely = results.filter(function (r) { return r.tier === 'likely'; });
    var possible = results.filter(function (r) { return r.tier === 'possible'; });
    var check = results.filter(function (r) { return r.tier === 'check'; });
    var receiving = results.filter(function (r) { return r.tier === 'receiving'; });
    var sum = function (arr) { return arr.reduce(function (t, r) { return t + (r.value || 0); }, 0); };
    return {
      results: results,
      summary: {
        likely: likely.length,
        possible: possible.length,
        check: check.length,
        receiving: receiving.length,
        likelyValue: sum(likely),
        possibleValue: sum(possible),
        inNotts: inNotts(p)
      },
      ctx: { ucTier: ctx.ucTier, pcTier: ctx.pcTier }
    };
  }

  return {
    RATES: C,
    NOTTS_DISTRICTS: NOTTS_DISTRICTS,
    RECEIVING_BENEFITS: RECEIVING_BENEFITS,
    RECEIVING_OTHER: RECEIVING_OTHER,
    SCHEME_IDS: S.map(function (s) { return s.id; }),
    SCHEMES: S,
    evaluate: evaluate,
    money: money,
    _internal: { ucScreen: ucScreen, pcScreen: pcScreen, isCouple: isCouple, working: working }
  };
});
