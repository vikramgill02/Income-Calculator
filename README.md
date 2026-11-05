<p align="center"><img src="logos/gill-co-banner.png" alt="Gill &amp; Co." width="520" /></p>

# Income-Calculator

Single-page app deployed on Cloudflare Workers at <https://dashboard.vikramgill101.workers.dev/>, behind a password (see [Hosting & password](#hosting--password)). Four tabs, in this order (opens on Net Worth, and the Gill & Co. logo in the top-left goes back there); Pay Calc, Property, Travel and PTO live under Tools. Phones get a bottom tab bar; each tab splits into sections with its own sub-tabs.

Every page and sub-tab has its own address, so the back button, refresh, bookmarks and home-screen shortcuts all land where you expect:

| Page | Addresses |
| --- | --- |
| Net Worth | `/` · `/networth/accounts` · `/networth/loans` |
| Dashboard | `/dashboard` · `/dashboard/employers` · `/dashboard/monthly` · `/dashboard/paystubs` |
| Pay Calc (in Tools) | `/pay` |
| Cards | `/cards` · `/cards/<card id from cards.json>` (e.g. `/cards/amex-gold`) |
| Tools | `/tools` (a list of misc tools) |
| Property (in Tools) | `/property` · `/property/projections` |
| Travel (in Tools) | `/travel` |
| PTO (in Tools) | `/pto` · `/pto/calendar` |

It is still one `index.html`: `not_found_handling: "single-page-application"` in `wrangler.jsonc` serves it for any address that isn't a file, and the app picks the page from the URL. HTML is sent with `Cache-Control: no-cache` so a new deploy shows up immediately. An unknown page goes to `/`; an unknown sub-tab shows that page's first one. Asset paths in `index.html` are absolute (`/logos/…`, `/cards.json`) so they load from any address.

- **Net Worth** — the landing tab, in three sub-tabs. *Overview*: a donut of where your money sits — hover a slice (or tap it on a phone) to see that account's balance, holdings and pending transfers; otherwise *At a glance* reads like a statement: cash and investments (total assets), consumer debt (credit cards) and student debt (total debt), and net worth as the double-ruled bottom line, with liquid underneath. *Accounts*: YNAB cash and credit-card totals plus each Fidelity account's holdings, priced live. *Loans*: student loans by interest rate.
- **Dashboard** — year-to-date income in four sub-tabs: *Overview* (gross / taxes / net / 403(b) and the year-end projection), *Employers* (split by employer with logos), *Monthly* (bar chart with projections) and *Paystubs* (filterable table). Data lives in [`paystubs.json`](./paystubs.json).
- **Pay Calc** (under Tools) — estimate a Sutter biweekly paycheck from Week 1 / Week 2 hours. Uses the straight day-shift rate of $78.31/hr with no shift differentials, so the estimate reflects pay you can count on. OT applies per week: first 40 hrs at base, anything over at 1.5× (~$117.47/hr).
- **Cards** — credit card credits & perks for Amex Platinum, Amex Gold, and Capital One Venture X: a *Claim now* list of open credits by deadline, then one sub-tab per card. Card and benefit definitions live in [`cards.json`](./cards.json); which credits you've used lives in Supabase and fills in from YNAB on its own — see [Card claims](#card-claims).
- **Tools** — a small page listing tools that don't need their own tab: Pay Calc, Property, Travel and PTO.
- **Property** (under Tools) — rental deal analyzer, full-width. *Deal* sizes up a purchase (cash needed, monthly cash flow, cash-on-cash ROI) with a price slider and donuts for where the rent goes and what you wire at closing; *Projections* compounds rent, expenses and appreciation over 3 / 5 / 10 years and charts where the return actually comes from. *Listing lookup* at the top takes a Zillow link (or a ZIP): it fills in a conservative county property tax rate and lists Section 8 Fair Market Rents by bedroom count to pick from — see [Listing lookup](#listing-lookup). Under the Deal inputs, *Market notes* lists target markets with a few bullets each (edit `MARKET_NOTES` in `index.html`). Deals sync across devices once Supabase is configured — see below.

Branded **Gill & Co.** The look is a dark charcoal and champagne-gold theme: Cormorant Garamond headings, Inter for numbers and UI.

- **Travel** (under Tools) — a globe that turns on its own with every country you've been to in green and the bucket list in gold; white dots are the cities. Drag to turn it; pinch, scroll or use the + / − buttons to zoom (up to 12×; it stops spinning while zoomed, and past 2× the finer 1:50m map loads so small countries and islands show). Tap a country (on the globe or in the list) to stop the spin, swing it round to face you and show its cities. Above it: countries out of 195, share of the world, continents and cities. Data lives in [`travel.json`](./travel.json); the map (d3-geo + world-atlas 110m) loads from jsDelivr only when the page opens.

- **PTO** (under Tools) — running Sutter PTO balance check by check, and a calendar of your work schedule (live from Google Calendar) where highlighting days shows the PTO they'd use. See [PTO tracker](#pto-tracker).

## Listing lookup

Paste a Zillow home link (or a ZIP) into *Listing lookup* on the Property page. The ZIP is read out of the link itself (`…/homedetails/737-McLain-St-Pittsburgh-PA-15210/…_zpid/`); Zillow is never fetched, so the price is still typed by hand. `worker.js` answers `/api/lookup?zip=…` with:

- **Property tax** — Census ACS 5-year median real-estate taxes paid ÷ median home value, for the ZIP and for its county; the **higher** of the two fills *County Property Tax*. It reflects what current owners pay, so a recent sale (or a state that taxes rentals higher, like Indiana's 2% cap) can still come in above it.
- **Rent** — HUD Fair Market Rents (the Section 8 figures) by bedroom count: the Small Area FMR for that ZIP where HUD publishes one, otherwise the metro/county FMR. *Use* sets Monthly Rent; *+ Add* adds to it, for totalling a duplex's units. FMRs sit near the 40th percentile of local rents, so read them as a floor.

Two free keys, added in Cloudflare as **Workers & Pages → dashboard → Settings → Variables and Secrets → Add → Secret**:

| Secret | Get it from |
| --- | --- |
| `CENSUS_KEY` | <https://api.census.gov/data/key_signup.html> (emailed instantly) |
| `HUD_TOKEN` | <https://www.huduser.gov/portal/dataset/fmr-api.html> → sign up → *Create New Token* |

Without `HUD_TOKEN` the tax still works at ZIP level only (the county comes from HUD's ZIP crosswalk) and rents show an error; without `CENSUS_KEY` only rents work. The lookup is saved with the deal.

## PTO tracker

The page starts from [`pto.json`](./pto.json); after the first **Save** it reads and writes one row (`id = 'main'`) in the Supabase table `pto_plan` through `/api/pto`, and `pto.json` is only the fallback.

**Rules** (`rules` in the plan): each PTO night is −12 hrs on the day it's worked; every other Wednesday from `first_payday` adds +7.2 (0.1 per paid hour, capped at 80 hrs → 8.0 max; a different amount for one check goes in `checks`); the balance may go down to −24. On a day with both, the check posts before that night's PTO. Booked PTO lives in `trips`.

- **Overview** — the balance chart and **Every check**: one row per payday with hours earned, PTO used since the previous check (and which trip), and the balance right after the check. **Kronos balance** takes what Kronos or a stub shows and resets the running total from that day; on a payday it counts as the balance right after that check.
- **Calendar** (`/pto/calendar`) — 8 weeks at a time by default (Sunday to Saturday, the arrows page 8 weeks), or a month; the choice is remembered on each device. In 8 weeks, a gold line steps along each month boundary and every other month is tinted. CVICU shifts in blue (Google Calendar's Peacock, like the BSN calendar), paydays with the hours they add (+7.2) in green, booked PTO in gold, and the balance at the end of each day. Tap days to highlight them: each highlighted work night counts 12 hrs, days off count 0, and the side panel shows the balance after, the lowest point from then on, whether it stays above −24, and how many more nights would fit. Highlighting is a preview only; nothing is saved.

### Work schedule sync

`/api/shifts` (in `worker.js`, parsed by `ical.js`) reads the BSN Google Calendar live through its secret iCal address and returns only the shifts: timed events whose title has "shift" in it (CVICU Shift, OT Shift, [SWAP] …), not all-day "Request shift" reminders. Repeating events, skipped dates and moved or cancelled single shifts are handled. Nothing else from that calendar leaves the Worker.

To connect it:

1. In Google Calendar on the web, signed in as the BSN calendar's owner: **Settings → Settings for my calendars → BSN Calendar → Integrate calendar → Secret address in iCal format**. Copy it.
2. In Cloudflare: **Workers & Pages → dashboard → Settings → Variables and Secrets → Add**, type **Secret**, name `BSN_ICAL`, paste the address, **Deploy**.

The address is a key to the whole calendar: keep it out of the repo and chat. Resetting it in Google breaks the sync until the secret is updated. Without the secret the page falls back to [`shifts.json`](./shifts.json), a copy taken on its `pulled` date, and says so at the top.

## Hosting & password

Cloudflare builds and deploys the site on every push to `main`. `worker.js` sits in front of every file and shows a password page; a correct password sets a cookie that keeps that device unlocked for a year. After unlocking you land on the address you originally opened. The only files served without the password are the app icons (`favicon.png`, `apple-touch-icon.png`, `icon.png`, `icon-192.png`), `manifest.json` and the wordmark (`logos/gill-co-wordmark.png`, shown on the password page), because browsers and iOS fetch the icons without the cookie; they hold just the logo, the G&C mark and the app name. The password is the `PASSWORD` secret on the `dashboard` Worker (Settings → Variables and Secrets) — it is never stored in this repo. If the secret is missing, the site refuses every request.

- `wrangler.jsonc` — Worker config. `name` must match the Worker's name in Cloudflare.
- `.assetsignore` — files that are never served (the worker code and `ical.js`, config, this README, the SQL).
- Changing the password logs out every device.
- **Is my change live?** Open `/api/version` on the site. Its `id` should match the top Version ID on the Worker's *Deployments* tab.
- **Before pushing,** run `bash tests/smoke.sh`. It starts the site in Cloudflare's local runtime (`wrangler dev`) and checks every page address, the data files, that private files aren't served, and the password gate.

### Net Worth tab

`/api/networth` (in `worker.js`, behind the password) builds the numbers on each visit:

- **Fidelity** — shares in `networth.json` × the latest price from Yahoo Finance. A symbol whose price can't be fetched falls back to the price from the last Fidelity CSV export.
- **YNAB** — reads account balances with the `YNABKEY` Worker variable (a YNAB personal access token). Only checking/savings/cash and credit-card accounts are used, and accounts listed in `ynab.exclude_names` (the Fidelity CMA, which is the CRNA Fund) are skipped so nothing is counted twice. The key never reaches the browser.
- **History** — a nightly cron (07:00 UTC) saves one point per day to the `HISTORY` KV namespace, which Cloudflare creates automatically on first deploy.

To update holdings after a trade or deposit, export *Positions* from Fidelity as CSV and update the `accounts` in `networth.json`. Update `loans` from the loan servicer's balances.

## Data files

### `paystubs.json`

```json
{
  "employer": "Sutter",
  "pay_date": "2026-08-21",
  "gross": 6674.79,
  "net": 3456.77,
  "retirement_403b": 867.73
}
```

Only pre-tax 403(b) is tracked; Roth/after-tax contributions are excluded. A `projection` block drives the year-end forecast and the dashed bars on the monthly chart.

### `cards.json`

```json
{
  "id": "amex-gold",
  "name": "Amex Gold",
  "annual_fee": 325,
  "benefits": [
    { "id": "gold-dunkin", "name": "Dunkin' Credit", "value": 84,
      "cadence": "monthly", "per": 7, "detail": "...",
      "match": "AMEX Dunkin' Credit" }
  ],
  "perks": ["4x points at restaurants worldwide (first $50k/yr)"]
}
```

`cadence` is one of `monthly`, `quarterly`, `semiannual`, `annual`, `multiyear`. `value` is the annual total; `per` is the amount available each period. `auto: true` counts every period that has come round as used (charges the card reimburses on its own, like Disney+). `match` is text from the bank's own name for the statement credit, as it shows in YNAB; leave it out for credits that never post as one (Uber Cash). Which periods are used is **not** stored here — see below.

### `travel.json`

```json
{ "visited": [{ "name": "Japan", "flag": "🇯🇵", "iso": "392", "continent": "Asia", "note": "",
                "cities": [{ "name": "Tokyo", "at": [139.69, 35.68] }] }],
  "bucket":  [{ "name": "Namibia", "flag": "🇳🇦", "iso": "516", "continent": "Africa",
                "plans": ["Rent a 4x4 truck and drive to Deadvlei"] }] }
```

`iso` is the country's ISO 3166 numeric code (it's how the globe finds the shape to colour). `at` is `[longitude, latitude]` for the city dot; leave it out and the city is listed but not dotted. Moving a country from `bucket` to `visited` is all it takes to colour it in.

## Card claims

Which credits you've used is stored in Supabase, in the `card_claims` table: one row per benefit per period (`2026-03`, `2026-Q4`, `2026-H1`, `2026`, or `once`), with `claimed` true or false. The site password is the only login: once a device is unlocked it can mark credits.

- **Edit, then Save.** The page is view-only until you tap **Edit**. Then tap any month/quarter chip to flip it, or *Used* on the *Claim now* list. Changes are staged (dashed gold ring) and only saved when you tap **Save** in the bar at the bottom; **Cancel** drops them. Leaving the page with unsaved changes asks first. Saved changes show on every device.
- **Refresh** re-pulls credits from YNAB and reloads, without leaving the page.
- **YNAB fills it in.** `/api/claims` (in `worker.js`) reads statement credits on credit-card accounts in YNAB for this year and last. When a credit's bank wording contains a benefit's `match` text, that period is marked used and the amount recorded. This runs each time Cards loads and nightly from the cron, which also keeps the free Supabase project from pausing.
- **Un-marking sticks.** Tapping a used period off saves `claimed = false`, so a YNAB credit won't mark it again.
- **Read-only fallback.** If the database can't be reached, the page still shows what YNAB found, says *Read-only*, and taps are off.
- **Asking Claude.** With the Supabase connector, Claude can answer questions straight from this table (e.g. "which credits did I leave unused in Q3?").

## Property tab — how the numbers are calculated

Inputs only; nothing is stored, so a deal resets when you leave the tab.

**Mortgage.** 30-year fixed. `P&I = L·r(1+r)^360 / ((1+r)^360 − 1)`, where `r` is the
monthly rate. A 0% loan amortizes straight-line (`L / 360`) rather than costing
nothing. PMI is not modelled — below 20% down the payment is understated.

**Monthly expenses.** Split into two groups. Management fee, repairs &
maintenance, capital expenditures and vacancy are percentages of rent, entered
directly at the top of the card with the resulting dollar figures beneath.
Property tax (county rate × price ÷ 12), insurance, HOA, utilities and lawyer
are flat dollar amounts.

Repairs & maintenance and capital expenditures are deliberately separate lines:
R&M is ongoing small work, capex is the reserve for big replacements. R&M
defaults to 3%. A new deal starts with sale price and rent at 0 and county
property tax and insurance blank (the price slider appears once there's a price).
All the inputs sit in one band of four cards (purchase, mortgage, % of rent,
fixed costs) under the listing lookup, each showing its dollar figures inline,
with the results, charts and market notes below.
A recently renovated property justifies a later replacement date, not a zero
capex line.

**Cash-on-cash ROI** = annual cash flow ÷ (down payment + closing + misc + rehab).

**Projections.** Rent and the rent-linked expenses grow at the rent-growth rate;
tax, insurance, HOA and utilities grow at the expense-inflation rate; the
mortgage payment is fixed. Over an N-year hold:

```
total gain = cumulative rent profit + appreciation + principal paid down
total return = total gain ÷ cash invested
annualized   = (1 + total return)^(1/N) − 1
```

Appreciation compounds on the purchase price (not on after-repair value), and
gains are **before selling costs and taxes** — so the total return is a
hold-value figure, not a net-of-sale one. Annualized return shows `—` when a
deal loses more than the cash put in, since a compound rate is undefined there.

## Supabase setup

Card claims and saved deals live in the Supabase project `Income-Calculator`. Only `worker.js` talks to it, so the browser never holds a database key:

- **`SupabaseKey`** — a secret on the `dashboard` Worker (Settings → Variables and Secrets). Copy it from Supabase → Project Settings → API Keys → *Secret keys* (an older `service_role` key works too; the name `SUPABASE_SECRET_KEY` is also accepted). Without it, Cards is read-only and saved deals are off.
- The tables have row-level security on, no policies, and no grants for the public roles, so the publishable/anon key can't read or write them. The secret key bypasses that, which is why it stays on the Worker.
- To rebuild from scratch, run [`supabase-setup.sql`](./supabase-setup.sql) in **SQL Editor → New query**. The project URL is set at the top of the *Cloud data* section in `worker.js`.

## Property tab — saved deals

The in-progress deal is cached in the browser (`localStorage`), so switching
tabs or reloading never loses it. Named deals sync across devices through
Supabase (`/api/deals` in `worker.js`), behind the same site password.

## Property tab — reading the charts

**Where the rent goes** and **Cash to close** are donuts; hovering a slice breaks
it into its component lines. Slices drop out when a cost is zero, so the hues are
validated with `--pairs all` (order-independent) rather than only as drawn —
worst CVD ΔE 6.9 sits in the 6–8 floor band, which is why every slice also carries
a legend entry, a dollar value and a percentage. Colour is never the only encoding.

**Where the return comes from** stacks each year's cumulative gain by source —
rent profit, appreciation, principal paydown — above a second panel showing the
annualized return you'd have realised selling at the end of that year. They are
two panels sharing one x-axis rather than one chart with two y-scales, so the
dollar and percentage series are never visually compared against each other.

The split matters when judging a deal: rent profit is cash already banked, while
appreciation and paydown are equity locked in the property until sale or
refinance. A return leaning mostly on appreciation is a forecast, not income.

### Which number should clear 10%?

Cash-on-cash and annualized total return measure different things and don't share
a benchmark. **Cash-on-cash** counts only cash reaching your account. The
**annualized total return** adds appreciation and principal paydown, so ~10% is the
natural bar there — it's roughly what a broad stock index returns, which is the real
opportunity cost of the down payment.

A 4–6% cash-on-cash on a stabilized, capex-complete property is defensible: less
execution risk earns a lower premium. But that range is close to what cash pays
risk-free, so it only holds up if appreciation and paydown carry the rest — the
least predictable part of the return. Note also that "capex is already done"
argues for a later replacement date, not a zero capex line.
