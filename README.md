# Income-Calculator

Two small tools, one repo, both deployable as a static site (e.g. GitHub Pages).

- **`index.html`** — Pay Calculator. Estimate a future paycheck from days/hours worked at Sutter and NorthBay.
- **`ytd.html`** — YTD Gross Income tracker. Add a row per paystub as you receive them; see year-to-date gross, broken down by employer, plus running 403(b) total.

## YTD Tracker

### Data

Paystubs live in [`paystubs.json`](./paystubs.json):

```json
{
  "year": 2026,
  "paystubs": [
    { "employer": "Sutter",   "gross": 4582.40, "retirement_403b": 250.00 },
    { "employer": "NorthBay", "gross": 1398.40, "retirement_403b": 0 }
  ]
}
```

Fields per paystub:

| field             | type    | notes                                            |
| ----------------- | ------- | ------------------------------------------------ |
| `employer`        | string  | `"Sutter"` or `"NorthBay"` (others render too)   |
| `gross`           | number  | Gross pay for the period                         |
| `retirement_403b` | number  | 403(b) contribution for the period (0 if none)   |

Order in the array is the order shown in the UI (`#1`, `#2`, …).

### Adding a paystub

Two ways:

1. **In the browser** — open `ytd.html`, fill in employer / gross / 403(b), hit **+ Add**. The new stub is held in memory. When you're done, click **Download JSON** (or **Copy JSON**) and replace `paystubs.json` in the repo, then commit. *Browser edits are not persisted to the repo automatically — you must export and commit.*

2. **Directly in the file** — edit `paystubs.json` in your editor and commit. The UI will pick it up on next load.
