# Income-Calculator

Single-page dashboard deployed at <https://vikramgill02.github.io/Income-Calculator/>. Two tabs:

- **Dashboard** — year-to-date income view. Shows gross / net / 403(b) / taxes-and-other totals, a pie chart of income split by employer, per-employer cards (CCMC, NorthBay, Sutter) with logos, and a full paystub table.
- **Pay Calc** — estimate a future paycheck from days/hours at Sutter and NorthBay.

Paystub data lives in [`paystubs.json`](./paystubs.json). Each entry:

```json
{
  "employer": "CCMC",
  "pay_date": "2026-01-15",
  "gross": 4304.98,
  "net": 2710.81,
  "retirement_403b": 344.40
}
```

Order in the array drives the order shown in the table.
