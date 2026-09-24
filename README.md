# WhatCanIClaim? - MVP (England)

A mobile web app with a **one-off paid unlock**. It screens a household for benefits, discounts, grants and local support it may be missing, links each result to the official source, and tracks claims in an Entitlement Wallet. Partner organisations get an anonymised dashboard.

## What's in it

| File | What it does |
|---|---|
| `rules.js` | The rules engine, covering 37 schemes, for all of England. It holds every rate and threshold and runs in both the browser and Node. **This is the file you maintain.** |
| `server.js` | Express server with static hosting, anonymous event collection and the partner dashboard |
| `public/index.html`, `app.js`, `styles.css` | The app: branching questions, then results, then the wallet |
| `public/privacy.html`, `public/terms.html` | Privacy notice and terms. **Fill in the [OPERATOR] placeholders before you take payments.** |
| `test/` | 21 tests: rules personas, the server, and payments with a fake Stripe (`npm test`) |

## Coverage: all of England

- **Postcode lookup:** the postcode finds the user's council, county (in two-tier areas) and region through postcodes.io. If the lookup fails, the user picks their country and region instead.
- **Outside England:** Scotland, Wales and Northern Ireland get a polite "England only for now" screen, which points to Turn2us and Citizens Advice. They are never shown the paywall.
- **Council-run schemes:**
  - Council Tax Reduction and the single person discount name the user's council.
  - The Crisis and Resilience Fund (which replaced the Household Support Fund in April 2026) names the county or unitary council that runs it.
  - Housing Payments (which are replacing Discretionary Housing Payments) are covered too.
  - All of these link to the GOV.UK council finder.
- **Rent screen:** the rough Universal Credit check uses a regional rent cap (`LHA_BY_REGION` in `rules.js`), so a London renter isn't screened like one in the North East.
- **Water:** the user picks from all 11 major English water companies. The result links to that company's website, or to the Consumer Council for Water list if they're not sure. Severn Trent customers still get the specific Big Difference scheme.
- **Adding council deep links:** add the council to `LOCAL_OVERRIDES` in `rules.js`. Nottingham City and Nottinghamshire County are already in there as examples. Do this for each partner you sign.

## How the one-off fee works

1. **The check is free.** The user answers the questions and sees the headline figure, the tier counts, **one full result** as a teaser, and the category and value of every other result, with the names hidden.
2. **Consent.** Before paying, the user ticks a box: "I want access straight away and understand that my 14-day right to cancel ends once access starts." UK law (the Consumer Contracts Regulations 2013) requires this for digital content. Without it, buyers can claim a refund within 14 days.
3. **Checkout.** Stripe Checkout takes a one-time payment. Promotion codes are enabled, so you can run discounts.
4. **Unlock code.** The server creates a code like `WCI-R2LMR-SW3NS`. The user sees it on screen, and it's printed on their Stripe receipt email.
5. **Unlocking.** Payment unlocks when Stripe redirects the buyer back to the site. The **webhook** also unlocks it, so a buyer who closes the tab still gets access.
6. **Other devices.** The user enters the code under "Already paid?". Each code works on up to 5 devices.
7. **Partner links (`?org=code` for any org in `ORG_KEYS`) skip the fee entirely.** That's your B2B route.
8. **If Stripe isn't configured,** the whole app is free. The server logs a warning at startup so this can't happen silently.

**Refunds:** refund in Stripe, then remove the code from `/data/licences.json`.

**Honest limitation:** the paywall is enforced in the browser, because the rules run on the device to keep answers private. A technical user could get around it. At this price that's an acceptable trade for not storing anyone's income or health data.

## Stripe setup

1. In Stripe, create a Product called "WhatCanIClaim? lifetime unlock" with a **one-time** price, for example £4.99. Copy the `price_...` ID.
2. Under Settings, then Emails, turn on **successful payment receipts**. This is what puts the unlock code in the buyer's inbox.
3. Under Developers, then Webhooks, add an endpoint `https://yourdomain/api/stripe/webhook` with the events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Copy the signing secret (`whsec_...`).
4. Add these Railway variables: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, and optionally `PUBLIC_URL`.
5. Test end to end with test keys and card `4242 4242 4242 4242` before switching to live keys.

The admin dashboard now shows the paid funnel: who saw the offer, who started checkout, and who paid, with the conversion rate.

## Privacy design (put this in your DPIA)

- **Answers never leave the device.** The questions, the screening and the wallet all run in the browser and are saved in localStorage. The server never receives income, health, caring or postcode data.
- The postcode goes only to postcodes.io, to find the council. If the lookup fails, the user picks their council manually.
- The server stores only anonymous events. Each one has a random device ID, the org code, the date (day only), which schemes were flagged, apply clicks and wallet statuses.
- Dashboards hide any count under 5, and show no figures at all until 5 checks are complete.

This keeps special category data off your servers. You still need ICO registration and a DPIA before the pilot.

## Run locally

```
npm install
npm start          # http://localhost:3000
npm test
```

## Deploy on Railway

1. Push the folder to a GitHub repo (use your usual delete-and-upload method).
2. In Railway, create a New Project, choose Deploy from GitHub, and pick the repo. It detects Node and runs `npm start`.
3. **Add a Volume** mounted at `/data`. Without one, event data is wiped on every deploy.
4. Set these variables:
   - `DATA_DIR=/data`
   - `ADMIN_KEY=<long random string>`: sign in to `/dashboard` as user `admin`
   - `ORG_KEYS={"acme-ha":"<password>"}`: one login per pilot partner. The username is the org code.
5. Generate a domain under Settings, then Networking.

## Pilot partner links

Give each partner a link with their code, for example `https://yourdomain/?org=nch`. The code is remembered on the device, so all that user's activity counts towards that partner. Partners sign in at `/dashboard` with their org code and password. They see:
- checks started and completed
- missed schemes per household
- the fixed value identified
- click-through to apply
- a breakdown for each scheme

They can also download a CSV.

## How results work

- **Tiers:** "Looks likely", "Possible", "Worth checking" and "You already get".
- **Headline £ figure:** only counts **fixed-value items** that look likely, such as Carer's Allowance, Child Benefit, the single person discount, Free School Meals, Healthy Start, the Warm Home Discount, the Sure Start Maternity Grant, Marriage Allowance and Tax-Free Childcare.
- **Means-tested benefits (UC, Pension Credit, Council Tax Reduction):** flagged but never given a figure. The user is sent to entitledto or Turn2us for an exact calculation.
- **UC screen:** the rough UC estimate in `ucScreen()` only decides the tier and is never shown to the user. Its child and carer amounts are labelled approximations.
- **Passporting:** if someone doesn't get UC or Pension Credit but looks eligible, schemes that depend on those benefits (FSM, WHD, NHS costs, social tariffs and similar) show as "Possible, through Universal Credit". That shows the unlock chain.

## Maintenance (the real cost)

- **Every April:** update the `C` block at the top of `rules.js` and run `npm test`. The tests assert some rates, so update those too.
- **Each scheme** has a `reviewed` date that users see. Update it whenever you check the scheme.
- **Watch these:**
  - Warm Home Discount qualifying date (set each summer)
  - Healthy Start values
  - Big Difference income limit
  - the council links in `LOCAL_OVERRIDES`
  - state pension age, which is moving from 66 to 67 between 2026 and 2028

## Known MVP limits

- There is no login. Answers and the wallet live on one device. The unlock code is what moves a purchase between devices, but answers don't move with it.
- Reminders are in-app, with a calendar (.ics) download. There are no emails.
- The results are screening only, not calculations. Self-employed income, students, mixed-age couples on the UC/PC boundary, immigration conditions and Council Tax band details are simplified.
