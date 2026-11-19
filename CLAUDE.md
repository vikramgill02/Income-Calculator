# Notes for Claude

## When Vikram sends a Fidelity positions CSV

1. **Update `networth.json`.** Set `as_of` to the export date. For each account, copy the shares, last price and cost basis (current value − total gain $).
2. **CMA cash (`CRNA Fund`):** don't trust the SPAXX line in the export. It can still include money that has already bought other holdings (the account's "% of account" figures add up to more than 100% when this happens). Cash = the account total Vikram gives you − the value of the other holdings. Ask him for the total if he hasn't given it.
3. **Pending transfers:** if money in a `pending` entry has arrived and been invested, remove the entry. The worker adds `pending.amount` to the account's value, so keeping it counts that money twice.
4. **Reconcile the YNAB tracking accounts** in "Vikram's Budget": `Roth IRA` and `403(b)`. For each, add one transaction dated the export date, using the existing payee "Reconciliation Balance Adjustment" (by `payee_id`; YNAB rejects that name as `payee_name`). The amount is the Fidelity account total − the YNAB balance. Mark it `reconciled` and approved, with the memo "Match Fidelity positions <date>". The dashboard doesn't read these two accounts. This only keeps YNAB's own net worth accurate.
5. Commit and push to `main`. Cloudflare deploys from `main`.

## Gotchas

- `ynab.exclude_names` in `networth.json` must match the CMA's exact name in YNAB (currently `CMA (6293)`). If the name doesn't match, the CMA is counted twice: once as YNAB cash and once as the CRNA Fund.
- Sign-in lasts 5 minutes without use (`SESSION_TTL` in `worker.js`; the idle timer in `index.html` and `IDLE_CLIENT` in `worker.js` must match). Changing `PASSWORD` signs out every device and cancels Face ID sign-ins in progress; registered Face ID devices keep working. The keypad PIN is the `Vik_key` Worker secret (capital V; names are case-sensitive); only the password (not the PIN or Face ID) allows adding a Face ID device.
