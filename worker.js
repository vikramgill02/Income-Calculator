// Password gate in front of the static site. The password lives in the
// PASSWORD secret on the Cloudflare Worker, never in this repo. Without it
// set, every request is refused, so the site can't be exposed by accident.

const COOKIE = "ic_auth";
const ONE_YEAR = 60 * 60 * 24 * 365;

async function tokenFor(password) {
  const bytes = new TextEncoder().encode("income-calculator:" + password);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function loginPage(error) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#08080a" />
<title>Locked</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #08080a; color: #f4f4f5; font: 16px system-ui, -apple-system, sans-serif; }
  form { width: min(320px, calc(100vw - 32px)); display: grid; gap: 12px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  input, button { font: inherit; padding: 12px 14px; border-radius: 10px; border: 1px solid #27272a; }
  input { background: #18181b; color: inherit; }
  button { background: #f4f4f5; color: #08080a; font-weight: 600; border: 0; cursor: pointer; }
  p { margin: 0; color: #f87171; font-size: 14px; }
</style>
</head><body>
<form method="POST" action="/__login">
  <h1>Enter password</h1>
  <input type="password" name="password" autocomplete="current-password" autofocus required />
  ${error ? `<p>${error}</p>` : ""}
  <button type="submit">Unlock</button>
</form>
</body></html>`;
}

function html(body, status) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/* ─── Net worth ───
   The page calls /api/networth. Everything secret (the YNAB key) stays here
   on the server; the browser only ever sees the resulting balances. */

const HISTORY_KEY = "history";

const todayPacific = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

async function loadPlan(env, origin) {
  const res = await env.ASSETS.fetch(new Request(origin + "/networth.json"));
  if (!res.ok) throw new Error("networth.json missing");
  return res.json();
}

// Latest price per symbol from Yahoo Finance's public chart endpoint. Any
// symbol that fails just keeps the price from the last Fidelity export.
async function fetchPrices(symbols) {
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`,
        { headers: { "User-Agent": "Mozilla/5.0 (income-calculator)" }, cf: { cacheTtl: 900 } },
      );
      if (!res.ok) return;
      const meta = (await res.json())?.chart?.result?.[0]?.meta;
      if (meta && Number.isFinite(meta.regularMarketPrice)) {
        out[sym] = { price: meta.regularMarketPrice, time: meta.regularMarketTime * 1000 };
      }
    } catch {}
  }));
  return out;
}

// Balances from YNAB. The key is a Worker variable, read only here.
async function fetchYnab(env) {
  if (!env.YNABKEY) return { ok: false, error: "YNABKEY not set" };
  try {
    const res = await fetch("https://api.ynab.com/v1/budgets/last-used/accounts", {
      headers: { Authorization: `Bearer ${env.YNABKEY}` },
    });
    if (!res.ok) return { ok: false, error: `YNAB returned ${res.status}` };
    const accounts = ((await res.json())?.data?.accounts || [])
      .filter((a) => !a.closed && !a.deleted)
      .map((a) => ({ name: a.name, type: a.type, balance: a.balance / 1000 }));
    return { ok: true, accounts };
  } catch (e) {
    return { ok: false, error: "Could not reach YNAB" };
  }
}

async function buildNetWorth(env, origin) {
  const plan = await loadPlan(env, origin);
  const symbols = [...new Set(plan.accounts.flatMap((a) => a.holdings.map((h) => h.symbol)))];
  const [prices, ynab] = await Promise.all([fetchPrices(symbols), fetchYnab(env)]);

  const accounts = plan.accounts.map((a) => {
    const holdings = a.holdings.map((h) => {
      const live = prices[h.symbol];
      const price = live ? live.price : h.price;
      return { ...h, price, live: Boolean(live), priceTime: live?.time || null, value: h.shares * price };
    });
    const invested = holdings.reduce((s, h) => s + h.value, 0);
    const cost = holdings.reduce((s, h) => s + (h.cost || 0), 0);
    const pending = a.pending?.amount || 0;
    return { ...a, holdings, value: invested + (a.cash || 0) + pending, gain: invested - cost };
  });

  // Skip YNAB accounts already counted from Fidelity (the CMA is the CRNA Fund).
  const types = plan.ynab || {};
  const skip = new Set(types.exclude_names || []);
  const ynabAccounts = ynab.ok ? ynab.accounts.filter((a) => !skip.has(a.name)) : [];
  const cashAccounts = ynabAccounts.filter((a) => (types.cash_types || []).includes(a.type));
  const cardAccounts = ynabAccounts.filter((a) => (types.card_types || []).includes(a.type));

  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  const cash = sum(cashAccounts, (a) => a.balance);
  const cards = -sum(cardAccounts, (a) => a.balance); // YNAB stores debt as negative
  const investments = sum(accounts, (a) => a.value);
  const liquidInvest = sum(accounts.filter((a) => a.kind === "liquid"), (a) => a.value);
  const loans = sum(plan.loans || [], (l) => l.balance);

  const totals = {
    cash,
    cards,
    investments,
    liquid: cash + liquidInvest,
    loans,
    netWorth: cash + investments - cards - loans,
  };

  return {
    generatedAt: Date.now(),
    asOf: plan.as_of,
    milestones: plan.milestones || [],
    accounts,
    loans: plan.loans || [],
    loansAsOf: plan.loans_as_of,
    ynab: { ok: ynab.ok, error: ynab.error || null },
    totals,
  };
}

async function readHistory(env) {
  if (!env.HISTORY) return [];
  return (await env.HISTORY.get(HISTORY_KEY, "json")) || [];
}

// One point per Pacific day; a later run on the same day replaces it.
async function recordSnapshot(env, data) {
  if (!env.HISTORY) return readHistory(env);
  const t = data.totals;
  const point = {
    date: todayPacific(),
    netWorth: Math.round(t.netWorth),
    liquid: Math.round(t.liquid),
    investments: Math.round(t.investments),
    cash: Math.round(t.cash),
    debt: Math.round(t.cards + t.loans),
    ynab: data.ynab.ok,
  };
  const history = (await readHistory(env)).filter((p) => p.date !== point.date);
  history.push(point);
  history.sort((a, b) => a.date.localeCompare(b.date));
  await env.HISTORY.put(HISTORY_KEY, JSON.stringify(history));
  return history;
}

async function netWorthResponse(request, env) {
  const url = new URL(request.url);
  const data = await buildNetWorth(env, url.origin);
  let history = await readHistory(env);
  // Make sure today has a point even before the nightly run, as long as
  // YNAB answered (otherwise the day's cash would read as $0).
  if (data.ynab.ok && !history.some((p) => p.date === todayPacific())) {
    history = await recordSnapshot(env, data);
  }
  return new Response(JSON.stringify({ ...data, history, historyEnabled: Boolean(env.HISTORY) }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/* ─── Card credits (temporary lookup) ───
   Lists inflows on credit-card accounts from YNAB — statement credits and
   refunds, not card payments — so matching rules for the Cards tab can be
   written against the real payee names. Behind the password like
   everything else. */

const escapeHtml = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function cardCreditsPage(env) {
  if (!env.YNABKEY) return html("<p style='font-family:system-ui;padding:24px'>YNABKEY is not set.</p>", 503);
  const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const headers = { Authorization: `Bearer ${env.YNABKEY}` };
  const [accRes, txRes] = await Promise.all([
    fetch("https://api.ynab.com/v1/budgets/last-used/accounts", { headers }),
    fetch(`https://api.ynab.com/v1/budgets/last-used/transactions?since_date=${since}`, { headers }),
  ]);
  if (!accRes.ok || !txRes.ok) return html(`<p style='font-family:system-ui;padding:24px'>YNAB returned ${accRes.status}/${txRes.status}.</p>`, 502);
  const cards = new Map(((await accRes.json()).data.accounts || [])
    .filter((a) => a.type === "creditCard" && !a.deleted)
    .map((a) => [a.id, a.name]));
  const rows = ((await txRes.json()).data.transactions || [])
    .filter((t) => cards.has(t.account_id) && t.amount > 0 && !t.transfer_account_id && !t.deleted)
    .sort((a, b) => b.date.localeCompare(a.date));

  const body = rows.map((t) => `<tr>
    <td>${escapeHtml(t.date)}</td>
    <td>${escapeHtml(cards.get(t.account_id))}</td>
    <td>${escapeHtml(t.payee_name)}</td>
    <td>${escapeHtml(t.import_payee_name_original || t.import_payee_name)}</td>
    <td>${escapeHtml(t.memo)}</td>
    <td class="n">$${(t.amount / 1000).toFixed(2)}</td></tr>`).join("");

  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" />
<title>Card credits</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 20px 16px 40px; background: #0c0b0a; color: #ece5d8; font: 13px/1.4 system-ui, -apple-system, sans-serif; }
  h1 { font: 500 26px Georgia, serif; margin: 0 0 4px; }
  p { color: #9b9386; margin: 0 0 16px; }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; min-width: 720px; width: 100%; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid rgba(240,228,208,0.08); vertical-align: top; }
  th { color: #c9a96e; font-weight: 500; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; }
  td.n { text-align: right; color: #93c4a2; white-space: nowrap; }
</style></head><body>
<h1>Card credits</h1>
<p>${rows.length} credits &amp; refunds on ${[...cards.values()].map(escapeHtml).join(", ")} since ${since}. Card payments are left out.</p>
<div class="wrap"><table><thead><tr><th>Date</th><th>Card</th><th>Payee</th><th>Bank's original name</th><th>Memo</th><th>Amount</th></tr></thead>
<tbody>${body || "<tr><td colspan='6'>No credits found.</td></tr>"}</tbody></table></div>
</body></html>`, 200);
}

export default {
  async scheduled(event, env, ctx) {
    // Cron requests have no origin; ASSETS only needs some absolute URL.
    const data = await buildNetWorth(env, "https://dashboard.local");
    if (data.ynab.ok) await recordSnapshot(env, data);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
    }

    if (!env.PASSWORD) {
      return html("<p style='font-family:system-ui;padding:24px'>Site locked: no password is set yet.</p>", 503);
    }

    const expected = await tokenFor(env.PASSWORD);

    if (url.pathname === "/__login" && request.method === "POST") {
      const form = await request.formData();
      const attempt = String(form.get("password") || "");
      if ((await tokenFor(attempt)) !== expected) {
        // Slow down guessing.
        await new Promise((r) => setTimeout(r, 1500));
        return html(loginPage("Wrong password."), 401);
      }
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": `${COOKIE}=${expected}; Max-Age=${ONE_YEAR}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }

    if (readCookie(request, COOKIE) !== expected) {
      return html(loginPage(""), 401);
    }

    if (url.pathname === "/card-credits") {
      try {
        return await cardCreditsPage(env);
      } catch (e) {
        return html(`<p style='font-family:system-ui;padding:24px'>Error: ${escapeHtml(e.message || e)}</p>`, 500);
      }
    }

    if (url.pathname === "/api/networth") {
      try {
        return await netWorthResponse(request, env);
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
    return out;
  },
};
