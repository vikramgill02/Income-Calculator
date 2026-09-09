# Income-Calculator

Single-page app deployed at <https://vikramgill02.github.io/Income-Calculator/>. Four tabs:

- **Pay Calc** — estimate a Sutter biweekly paycheck from Week 1 / Week 2 hours. OT applies per week (first 40 hrs at base, anything over at 1.5×). Toggle for the blended night + weekend differential rate.
- **Dashboard** — year-to-date income. Gross / net / 403(b) / taxes, pie chart by employer, per-employer cards with logos, monthly bar chart with projections, and a filterable paystub table. Data lives in [`paystubs.json`](./paystubs.json).
- **Cards** — credit card credits & perks checklist for Amex Platinum, Amex Gold, and Capital One Venture X. Data lives in [`cards.json`](./cards.json).
- **Property** — rental deal analyzer. *Deal* sizes up a purchase (cash needed, monthly cash flow, cash-on-cash ROI, DSCR); *Projections* compounds rent, expenses and appreciation over 3 / 5 / 10 years. Deals sync across devices once Supabase is configured — see below.

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
      "cadence": "monthly", "per": 7, "detail": "..." }
  ],
  "perks": ["4x points at restaurants worldwide (first $50k/yr)"]
}
```

`cadence` is one of `monthly`, `quarterly`, `semiannual`, `annual`, `multiyear`. `value` is the annual total; `per` is the amount available each period. Benefit checkboxes are stored in the viewer's browser (`localStorage`) and reset automatically when a period rolls over.

## Property tab — how the numbers are calculated

Inputs only; nothing is stored, so a deal resets when you leave the tab.

**Mortgage.** 30-year fixed. `P&I = L·r(1+r)^360 / ((1+r)^360 − 1)`, where `r` is the
monthly rate. A 0% loan amortizes straight-line (`L / 360`) rather than costing
nothing. PMI is not modelled — below 20% down the payment is understated.

**Monthly expenses.** Property tax (county rate × price ÷ 12), insurance, HOA,
utilities and lawyer are flat dollar amounts; management fee, capital
expenditures and vacancy are percentages of rent, editable under *Edit rates*.

**Cash-on-cash ROI** = annual cash flow ÷ (down payment + closing + misc + rehab).

**DSCR** = NOI ÷ P&I, where NOI subtracts every operating expense including capex
and vacancy. This runs stricter than the `rent ÷ PITIA` most DSCR lenders
underwrite on — at the default inputs it reads 1.73 where a lender would see
1.92 — so treat ≥1.25 here as comfortable rather than as a quote.

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

## Property tab — saved deals

The in-progress deal is cached in the browser (`localStorage`), so switching
tabs or reloading never loses it. Named deals sync across devices through
Supabase, which is off until two values are filled in near the top of the
`Property cloud sync` block in [`index.html`](./index.html):

```js
const SUPABASE_URL = "";
const SUPABASE_ANON_KEY = "";
```

Left blank, the tab works exactly as before with no sign-in prompt and no
cloud saving. To turn syncing on:

1. Create a free project at [supabase.com](https://supabase.com).
2. Run [`supabase-setup.sql`](./supabase-setup.sql) in **SQL Editor → New query**.
3. Copy the **Project URL** and the **anon / public** key from
   **Project Settings → API** into the two constants above.

The anon key is designed to be published; Row Level Security is what confines
each account to its own rows. Never paste the `service_role` key here — it
bypasses those policies.
