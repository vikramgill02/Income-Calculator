// Password gate in front of the static site. The password lives in the
// PASSWORD secret on the Cloudflare Worker, never in this repo. Without it
// set, every request is refused, so the site can't be exposed by accident.

const COOKIE = "ic_auth";
const PUBLIC_FILES = new Set(["/favicon.png", "/apple-touch-icon.png", "/icon.png", "/icon-192.png", "/manifest.json",
  "/logos/gill-co-wordmark.png"]);
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

// Where to send someone after they unlock: only a path on this site.
function safeNext(value) {
  const v = String(value || "");
  return v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/__login") ? v : "/";
}

const escapeAttr = (v) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function loginPage(error, next = "/") {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#f6f1e7" />
<title>Gill &amp; Co.</title>
<link rel="icon" type="image/png" href="/favicon.png" />
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #f6f1e7; color: #1f3a2e; font: 16px system-ui, -apple-system, sans-serif; }
  form { width: min(320px, calc(100vw - 32px)); display: grid; gap: 12px; }
  .logo { display: block; width: 210px; height: auto; margin: 0 auto 18px; }
  h1 { font-size: 15px; font-weight: 500; margin: 0 0 2px; color: #66706a; text-align: center; }
  input, button { font: inherit; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(31,58,46,0.22); }
  input { background: #fffdf8; color: inherit; }
  input:focus { outline: 2px solid rgba(31,58,46,0.35); outline-offset: 1px; }
  button { background: #1f3a2e; color: #f6f1e7; font-weight: 600; border: 0; cursor: pointer; }
  p { margin: 0; color: #b5483b; font-size: 14px; }
</style>
</head><body>
<form method="POST" action="/__login">
  <input type="hidden" name="next" value="${escapeAttr(next)}" />
  <img class="logo" src="/logos/gill-co-wordmark.png" alt="Gill &amp; Co." />
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

/* ─── Cloud data (Supabase) ───
   Card claims and saved property deals live in Supabase. Only this worker
   talks to it, with the SupabaseKey secret (Worker → Settings →
   Variables and Secrets), so the site password is the one login for
   everything. The tables have row-level security on and no policies, so the
   public key can't read or write them at all; only the secret key can. */

const SUPABASE_URL = "https://czysubahmllgjhfgehni.supabase.co";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

// The Worker secret holding Supabase's secret key. Either name works.
const supabaseKey = (env) => env.SupabaseKey || env.SUPABASE_SECRET_KEY || "";
const NO_KEY = "The SupabaseKey secret is not set on the Worker";

async function supabase(env, path, { method = "GET", body, prefer } = {}) {
  const key = supabaseKey(env);
  // New sb_secret_ keys go on `apikey` only; an older service_role key is a
  // JWT and also goes on Authorization.
  const headers = { apikey: key, "Content-Type": "application/json", "User-Agent": "gill-co-worker" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function readJson(request) {
  if (!(request.headers.get("Content-Type") || "").includes("application/json")) return null;
  try { return await request.json(); } catch { return null; }
}

/* ─── Card claims ───
   One row per benefit per period ("2026-03", "2026-Q4", "2026-H1", "2026",
   "once"). claimed = false means un-marked by hand, which stops a YNAB credit
   from marking that period again.

   YNAB statement credits on card accounts whose bank wording contains a
   benefit's `match` text (cards.json) are written in as claimed. That runs
   every time the Cards page loads and nightly from the cron, so the page is
   current before you open it. */

async function loadCards(env, origin) {
  const res = await env.ASSETS.fetch(new Request(origin + "/cards.json"));
  if (!res.ok) throw new Error("cards.json missing");
  return (await res.json()).cards || [];
}

// Inflows on credit-card accounts this year and last (so January still sees
// December), minus card payments.
async function fetchCardCredits(env) {
  if (!env.YNABKEY) return { ok: false, error: "YNABKEY not set", credits: [] };
  try {
    const since = `${new Date().getUTCFullYear() - 1}-01-01`;
    const headers = { Authorization: `Bearer ${env.YNABKEY}` };
    const [accRes, txRes] = await Promise.all([
      fetch("https://api.ynab.com/v1/budgets/last-used/accounts", { headers }),
      fetch(`https://api.ynab.com/v1/budgets/last-used/transactions?since_date=${since}`, { headers }),
    ]);
    if (!accRes.ok || !txRes.ok) return { ok: false, error: `YNAB returned ${accRes.status}/${txRes.status}`, credits: [] };
    const cardAccounts = new Set(((await accRes.json())?.data?.accounts || [])
      .filter((a) => a.type === "creditCard" && !a.deleted).map((a) => a.id));
    const credits = ((await txRes.json())?.data?.transactions || [])
      .filter((t) => cardAccounts.has(t.account_id) && t.amount > 0 && !t.transfer_account_id && !t.deleted)
      .map((t) => ({
        id: t.id,
        date: t.date,
        // The bank's own wording ("Platinum Resy Credit") is what gets
        // matched; the payee can be renamed in YNAB, so it's only a fallback.
        name: t.import_payee_name_original || t.import_payee_name || t.payee_name || "",
        amount: t.amount / 1000,
      }));
    return { ok: true, error: "", credits };
  } catch {
    return { ok: false, error: "Could not reach YNAB", credits: [] };
  }
}

// The period a credit posted on a given date counts toward.
function periodKeyFor(cadence, date) {
  const y = date.slice(0, 4), mm = date.slice(5, 7), m = parseInt(mm, 10);
  if (cadence === "monthly") return `${y}-${mm}`;
  if (cadence === "quarterly") return `${y}-Q${Math.ceil(m / 3)}`;
  if (cadence === "semiannual") return `${y}-H${m <= 6 ? 1 : 2}`;
  if (cadence === "annual") return y;
  if (cadence === "multiyear") return "once";
  return null;
}

const claimKey = (r) => `${r.card_id}|${r.benefit_id}|${r.period}`;
const round2 = (x) => Math.round(x * 100) / 100;

// YNAB credits → one entry per benefit per period. Two postings in the same
// period (Saks often splits $50 in two) add together.
function matchCredits(cards, credits) {
  const out = new Map();
  for (const t of credits) {
    const name = String(t.name).toLowerCase();
    for (const c of cards) {
      for (const b of c.benefits || []) {
        if (!b.match || !name.includes(b.match.toLowerCase())) continue;
        const period = periodKeyFor(b.cadence, t.date);
        if (!period) continue;
        const m = { card_id: c.id, benefit_id: b.id, period };
        const k = claimKey(m);
        const prev = out.get(k);
        out.set(k, prev
          ? { ...prev, amount: round2(prev.amount + t.amount), posted_on: t.date > prev.posted_on ? t.date : prev.posted_on }
          : { ...m, amount: round2(t.amount), posted_on: t.date, ynab_txn_id: t.id });
      }
    }
  }
  return out;
}

const CLAIM_COLS = "card_id,benefit_id,period,claimed,source,amount,posted_on";

// Read every claim, write in new YNAB matches, and return the result.
async function syncClaims(env, origin) {
  const [cards, ynab] = await Promise.all([loadCards(env, origin), fetchCardCredits(env)]);
  const matches = matchCredits(cards, ynab.credits);
  const ynabStatus = { ok: ynab.ok, error: ynab.error };
  // Not set up, or Supabase is down: show what YNAB found, read-only.
  const readOnly = (error) => ({
    saving: false, error, ynab: ynabStatus,
    rows: [...matches.values()].map((m) => ({ ...m, claimed: true, source: "ynab" })),
  });
  if (!supabaseKey(env)) return readOnly(NO_KEY);
  let saved;
  try {
    saved = await supabase(env, `card_claims?select=${CLAIM_COLS}`);
  } catch (e) {
    return readOnly(String(e.message || e));
  }
  const byKey = new Map(saved.map((r) => [claimKey(r), r]));
  const now = new Date().toISOString();
  const fresh = [], amounts = [];
  for (const [k, m] of matches) {
    const r = byKey.get(k);
    if (!r) fresh.push({ ...m, claimed: true, source: "ynab", updated_at: now });
    else if (r.claimed && (r.amount == null || Number(r.amount) !== m.amount || r.posted_on !== m.posted_on)) {
      // Already marked (by hand or from history): just record what posted.
      amounts.push({ ...m, updated_at: now });
    }
  }
  const upsert = "card_claims?on_conflict=card_id,benefit_id,period";
  if (fresh.length) {
    // Never over a row saved meanwhile (e.g. un-marked on another device).
    await supabase(env, upsert, { method: "POST", body: fresh, prefer: "resolution=ignore-duplicates,return=minimal" });
    for (const r of fresh) if (!byKey.has(claimKey(r))) byKey.set(claimKey(r), r);
  }
  if (amounts.length) {
    await supabase(env, upsert, { method: "POST", body: amounts, prefer: "resolution=merge-duplicates,return=minimal" });
    for (const r of amounts) byKey.set(claimKey(r), { ...byKey.get(claimKey(r)), ...r });
  }
  const rows = [...byKey.values()].map(({ card_id, benefit_id, period, claimed, source, amount, posted_on }) =>
    ({ card_id, benefit_id, period, claimed, source, amount, posted_on }));
  return { saving: true, error: "", ynab: ynabStatus, rows };
}

const PERIOD_RE = /^(\d{4}(-(0[1-9]|1[0-2]|Q[1-4]|H[12]))?|once)$/;

// POST { card_id, benefit_id, periods: [...], claimed } — mark used or not.
async function saveClaims(request, env, origin) {
  if (!supabaseKey(env)) return json({ error: NO_KEY }, 503);
  const body = await readJson(request);
  const { card_id, benefit_id, periods, claimed } = body || {};
  const cards = await loadCards(env, origin);
  const benefitExists = cards.some((c) => c.id === card_id && (c.benefits || []).some((b) => b.id === benefit_id));
  if (!benefitExists || typeof claimed !== "boolean" || !Array.isArray(periods) || !periods.length
      || periods.length > 24 || !periods.every((p) => typeof p === "string" && PERIOD_RE.test(p))) {
    return json({ error: "Bad request" }, 400);
  }
  const now = new Date().toISOString();
  await supabase(env, "card_claims?on_conflict=card_id,benefit_id,period", {
    method: "POST",
    body: periods.map((period) => ({ card_id, benefit_id, period, claimed, source: "manual", updated_at: now })),
    prefer: "resolution=merge-duplicates,return=minimal",
  });
  return json({ ok: true });
}

/* ─── Saved property deals ─── */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function dealsResponse(request, env, url) {
  if (!supabaseKey(env)) return json({ error: NO_KEY }, 503);
  if (request.method === "GET") {
    return json({ deals: await supabase(env, "deals?select=id,name,data,updated_at&order=updated_at.desc") });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!UUID_RE.test(id)) return json({ error: "Bad request" }, 400);
    await supabase(env, `deals?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
    return json({ ok: true });
  }
  if (request.method === "POST") {
    // { id?, name, data }: with an id it updates that deal, else adds one.
    const body = await readJson(request);
    const name = String(body?.name || "").trim().slice(0, 120) || "Untitled deal";
    if (!body || typeof body.data !== "object" || body.data === null || (body.id && !UUID_RE.test(body.id))) {
      return json({ error: "Bad request" }, 400);
    }
    const row = { name, data: body.data, updated_at: new Date().toISOString() };
    const out = body.id
      ? await supabase(env, `deals?id=eq.${body.id}&select=id`, { method: "PATCH", body: row, prefer: "return=representation" })
      : await supabase(env, "deals?select=id", { method: "POST", body: row, prefer: "return=representation" });
    if (!out?.length) return json({ error: "Deal not found" }, 404);
    return json({ id: out[0].id });
  }
  return json({ error: "Method not allowed" }, 405);
}

export default {
  async scheduled(event, env, ctx) {
    // Marks new YNAB card credits used, and the read also keeps the free
    // Supabase project from pausing after a week with no traffic.
    ctx.waitUntil(syncClaims(env, "https://dashboard.local").catch(() => {}));
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
        return html(loginPage("Wrong password.", safeNext(form.get("next"))), 401);
      }
      return new Response(null, {
        status: 303,
        headers: {
          Location: safeNext(form.get("next")),
          "Set-Cookie": `${COOKIE}=${expected}; Max-Age=${ONE_YEAR}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }

    // Icons and the manifest load without the password: browsers fetch the
    // manifest without cookies, and iOS may fetch the home-screen icon the
    // same way. They hold only the logo, the G&C mark and the app name; the login page
    // shows the wordmark.
    if (readCookie(request, COOKIE) !== expected && !PUBLIC_FILES.has(url.pathname)) {
      return html(loginPage("", safeNext(url.pathname + url.search)), 401);
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

    if (url.pathname === "/api/claims" || url.pathname === "/api/deals") {
      try {
        if (url.pathname === "/api/deals") return await dealsResponse(request, env, url);
        if (request.method === "POST") return await saveClaims(request, env, url.origin);
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        return json(await syncClaims(env, url.origin));
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    // Which deploy is live: compare `id` with the Version ID on Cloudflare's
    // Deployments tab.
    if (url.pathname === "/api/version") {
      const v = env.CF_VERSION_METADATA || {};
      return new Response(JSON.stringify({ id: v.id || null, tag: v.tag || null, deployed: v.timestamp || null }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // Page addresses (/cards, /dashboard/paystubs) get index.html via
    // not_found_handling in wrangler.jsonc.
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
    // Always check for a fresh copy of the page so a new deploy shows up
    // immediately instead of a cached old version.
    if ((out.headers.get("Content-Type") || "").includes("text/html")) {
      out.headers.set("Cache-Control", "no-cache");
    }
    return out;
  },
};
