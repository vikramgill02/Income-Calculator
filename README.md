# Income-Calculator

Single-page app deployed at <https://vikramgill02.github.io/Income-Calculator/>. Four tabs:

- **Pay Calc** — estimate a Sutter biweekly paycheck from Week 1 / Week 2 hours. OT applies per week (first 40 hrs at base, anything over at 1.5×). Toggle for the blended night + weekend differential rate.
- **Dashboard** — year-to-date income. Gross / net / 403(b) / taxes, pie chart by employer, per-employer cards with logos, monthly bar chart with projections, and a filterable paystub table. Data lives in [`paystubs.json`](./paystubs.json).
- **Cards** — credit card credits & perks checklist for Amex Platinum, Amex Gold, and Capital One Venture X. Data lives in [`cards.json`](./cards.json).
- **Property** — rental deal analyzer, full-width. *Deal* sizes up a purchase (cash needed, monthly cash flow, cash-on-cash ROI, DSCR) with a price slider and donuts for where the rent goes and what you wire at closing; *Projections* compounds rent, expenses and appreciation over 3 / 5 / 10 years and charts where the return actually comes from. Deals sync across devices once Supabase is configured — see below.

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

**Monthly expenses.** Split into two groups. Management fee, repairs &
maintenance, capital expenditures and vacancy are percentages of rent, entered
directly at the top of the card with the resulting dollar figures beneath.
Property tax (county rate × price ÷ 12), insurance, HOA, utilities and lawyer
are flat dollar amounts.

Repairs & maintenance and capital expenditures are deliberately separate lines:
R&M is ongoing small work, capex is the reserve for big replacements. R&M
defaults to 0% so it never silently changes a saved deal — set it yourself.
A recently renovated property justifies a later replacement date, not a zero
capex line.

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
