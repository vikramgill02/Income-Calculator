# Income-Calculator

Single-page app deployed at <https://vikramgill02.github.io/Income-Calculator/>. Three tabs:

- **Pay Calc** — estimate a Sutter biweekly paycheck from Week 1 / Week 2 hours. OT applies per week (first 40 hrs at base, anything over at 1.5×). Toggle for the blended night + weekend differential rate.
- **Dashboard** — year-to-date income. Gross / net / 403(b) / taxes, pie chart by employer, per-employer cards with logos, monthly bar chart with projections, and a filterable paystub table. Data lives in [`paystubs.json`](./paystubs.json).
- **Cards** — credit card credits & perks checklist for Amex Platinum, Amex Gold, and Capital One Venture X. Data lives in [`cards.json`](./cards.json).

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
