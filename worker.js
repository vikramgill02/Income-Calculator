// Password gate in front of the static site. The password lives in the
// PASSWORD secret on the Cloudflare Worker, never in this repo. Without it
// set, every request is refused, so the site can't be exposed by accident.

import { listShifts, HOME_TZ } from "./ical.js";

const COOKIE = "ic_auth";
const PUBLIC_FILES = new Set(["/favicon.png", "/apple-touch-icon.png", "/icon.png", "/icon-192.png", "/manifest.json",
  "/logos/gill-co-wordmark.png", "/logos/gill-co-lockup.png"]);

// Sign-in lasts while the site is in use: each request (and the page's
// activity ping) renews it, and it lapses after SESSION_TTL with nothing.
// The cookie is "v1.<expiry ms>.<MAC>", signed with a key derived from
// PASSWORD, so it can't be forged or stretched, and changing the password
// signs every device out.
const SESSION_TTL = 5 * 60 * 1000;
const RENEW_AFTER = 30 * 1000; // re-issue at most every 30s

async function sessionMac(env, payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("session:" + env.PASSWORD),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64u(new Uint8Array(mac).subarray(0, 18));
}

async function sessionCookie(env) {
  const payload = `v1.${Date.now() + SESSION_TTL}`;
  const value = `${payload}.${await sessionMac(env, payload)}`;
  return `${COOKIE}=${value}; Max-Age=${SESSION_TTL / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

// A signed "<prefix>.<expiry ms>.<MAC>" cookie's expiry if genuine and current.
async function readSigned(request, env, name, prefix) {
  const m = new RegExp(`^(${prefix}\\.(\\d{13}))\\.([\\w-]{24})$`).exec(readCookie(request, name) || "");
  if (!m || +m[2] < Date.now()) return null;
  const mac = await sessionMac(env, m[1]);
  let diff = mac.length ^ m[3].length;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ m[3].charCodeAt(i);
  return diff ? null : +m[2];
}
const readSession = (request, env) => readSigned(request, env, COOKIE, "v1");

// Typing the password (not the PIN or Face ID) also grants a 5-minute
// "step-up", which adding a Face ID device requires. So someone holding an
// unlocked phone can't add their own face without knowing the password.
const STEPUP = "ic_stepup";
async function stepupCookie(env) {
  const payload = `s1.${Date.now() + SESSION_TTL}`;
  return `${STEPUP}=${payload}.${await sessionMac(env, payload)}; Max-Age=${SESSION_TTL / 1000}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}
const stepupOk = (request, env) => readSigned(request, env, STEPUP, "s1");

/* ─── PIN ───
   The Vik_Code secret on the Worker (any capitalization) (4–8 digits) turns the lock screen into a
   keypad. Five wrong PINs lock the keypad for 15 minutes; Face ID and the
   password still work meanwhile, and either one clears the lock. */
const PIN_TRIES = 5;
const PIN_LOCK = 15 * 60 * 1000;
const PIN_STATE = "auth:pin";
// The secret's name in any capitalization: Vik_Code, Vik_code, vik_code...
const pinSecretName = (env) => Object.keys(env).find((k) => /^vik_?code$/i.test(k));
const pinOf = (env) => { const n = pinSecretName(env); const p = n ? String(env[n]).trim() : ""; return /^\d{4,8}$/.test(p) ? p : ""; };
// Why the keypad isn't showing, without revealing the PIN: is the secret
// there, and is it 4-8 digits? Also names any other secret starting with "vik".
function pinStatus(env) {
  const name = pinSecretName(env);
  if (!name) {
    const near = Object.keys(env).find((k) => /^vik/i.test(k));
    return near ? `misnamed:${near}` : "missing";
  }
  const p = String(env[name]).trim();
  if (/^\d{4,8}$/.test(p)) return "ok";
  if (!/^\d+$/.test(p)) return "not-only-digits";
  return p.length < 4 ? "too-short" : "too-long";
}
async function pinState(env) {
  return (env.HISTORY && (await env.HISTORY.get(PIN_STATE, "json"))) || { fails: 0, until: 0 };
}
async function setPinState(env, state) {
  if (env.HISTORY) await env.HISTORY.put(PIN_STATE, JSON.stringify(state));
}
async function clearPinLock(env) {
  const s = await pinState(env);
  if (s.fails || s.until) await setPinState(env, { fails: 0, until: 0 });
}
const pinLockedMsg = (until) =>
  `Too many wrong PINs. Use Face ID or the password, or wait ${Math.max(1, Math.ceil((until - Date.now()) / 60000))} min.`;

async function pinLogin(request, env) {
  const pin = pinOf(env);
  if (!pin) return json({ error: "No PIN is set" }, 404);
  const body = (await readJson(request)) || {};
  const state = await pinState(env);
  if (state.until > Date.now()) return json({ error: pinLockedMsg(state.until), locked: true, until: state.until }, 429);
  const digest = async (v) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pin:" + v)));
  const ok = sameBytes(await digest(String(body.pin || "")), await digest(pin));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 800));
    const fails = state.fails + 1;
    if (fails >= PIN_TRIES) {
      const until = Date.now() + PIN_LOCK;
      await setPinState(env, { fails: 0, until });
      return json({ error: pinLockedMsg(until), locked: true, until }, 429);
    }
    await setPinState(env, { fails, until: 0 });
    const left = PIN_TRIES - fails;
    return json({ error: `Wrong PIN · ${left} ${left === 1 ? "try" : "tries"} left` }, 401);
  }
  if (state.fails) await setPinState(env, { fails: 0, until: 0 });
  return new Response(JSON.stringify({ ok: true, next: safeNext(body.next) }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": await sessionCookie(env) },
  });
}

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

// Idle lock for pages served by the worker; index.html has its own copy.
const IDLE_CLIENT = String.raw`
(() => {
  // Sign-in lapses after 5 minutes without use (see SESSION_TTL in worker.js).
  // While you're using the page it pings /api/session to stay signed in; after
  // 5 idle minutes, on return to a backgrounded tab or app, or on any 401, it
  // reloads, which shows the lock screen.
  const IDLE = 5 * 60 * 1000, PING = 30 * 1000;
  let last = Date.now(), pinged = Date.now(), locked = false;
  const idle = () => Date.now() - last > IDLE;
  const lock = () => { if (!locked) { locked = true; location.reload(); } };
  const realFetch = window.fetch.bind(window);
  window.fetch = (...args) => realFetch(...args).then((r) => {
    if (r.status === 401 && r.url.startsWith(location.origin)) lock();
    return r;
  });
  const active = () => {
    if (idle()) return lock();
    last = Date.now();
    if (last - pinged > PING) { pinged = last; fetch("/api/session", { cache: "no-store" }).catch(() => {}); }
  };
  for (const ev of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"]) {
    addEventListener(ev, active, { passive: true, capture: true });
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && idle()) lock(); });
  addEventListener("pageshow", (e) => { if (e.persisted && idle()) lock(); });
  setInterval(() => { if (idle()) lock(); }, 15000);
})();
`;

// Browser side of passkeys, shared by the login and /passkeys pages.
const PASSKEY_CLIENT = String.raw`
const $ = (id) => document.getElementById(id);
const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const enc = (b) => { let s = ""; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const say = (text) => { (window.msgEl ? window.msgEl() : $("msg")).textContent = text || ""; };
const cancelled = (e) => e && (e.name === "NotAllowedError" || e.name === "AbortError");
const hasPasskeys = !!(window.PublicKeyCredential && navigator.credentials);
`;

function loginPage(error, next = "/", pinLength = 0) {
  const pinFirst = pinLength && !error;
  const digit = (d) => `<button type="button" class="key" data-d="${d}">${d}</button>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#0a0a0a" />
<title>Gill &amp; Co.</title>
<link rel="icon" type="image/png" href="/favicon.png?v=manor" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=manor" />
<link rel="manifest" href="/manifest.json" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black" />
<meta name="apple-mobile-web-app-title" content="Gill &amp; Co." />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+Display:wght@400&family=Noto+Serif:wght@400;600&display=swap" rel="stylesheet" />
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center;
         background: #0a0a0a; color: #ece8e1; font: 16px 'Noto Serif', Georgia, serif; }
  main { width: min(320px, calc(100vw - 32px)); padding: 16px 0; }
  form { display: grid; gap: 12px; }
  .logo { display: block; width: 240px; max-width: 100%; height: auto; margin: 0 auto 22px; }
  main.pin .logo { width: 190px; margin-bottom: 18px; }
  h1, .label { font-size: 15px; font-weight: 500; margin: 0 0 2px; color: #8a867f; text-align: center; }
  input, form button { font: inherit; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(236,232,225,0.198); }
  input { background: #131313; color: inherit; }
  input:focus { outline: 2px solid rgba(236,232,225,0.315); outline-offset: 1px; }
  form button { background: #ece8e1; color: #0a0a0a; font-weight: 600; border: 0; cursor: pointer; }
  form button.ghost { background: transparent; color: #ece8e1; border: 1px solid rgba(236,232,225,0.198); font-weight: 500; }
  .or { color: #8a867f; font-size: 13px; text-align: center; margin: 6px 0 0; }
  .msg { margin: 0; color: #c0675a; font-size: 14px; text-align: center; min-height: 0; }
  .msg:empty, [hidden] { display: none !important; }
  /* keypad */
  .dots { display: flex; gap: 14px; justify-content: center; margin: 10px 0 6px; }
  .dots i { width: 12px; height: 12px; border-radius: 50%; border: 1px solid rgba(236,232,225,0.5); transition: background .12s; }
  .dots i.on { background: #ece8e1; border-color: #ece8e1; }
  .shake { animation: shake .4s; }
  @keyframes shake { 15%, 55% { transform: translateX(-9px); } 35%, 75% { transform: translateX(9px); } }
  .pad { display: grid; grid-template-columns: repeat(3, 74px); gap: 14px 24px; justify-content: center; margin: 16px 0 6px; }
  .key { width: 74px; height: 74px; border-radius: 50%; padding: 0; display: grid; place-items: center; cursor: pointer;
         border: 1px solid rgba(236,232,225,0.17); background: rgba(236,232,225,0.03); color: #ece8e1;
         font: 400 30px/1 'Noto Serif Display', Georgia, serif; user-select: none; -webkit-user-select: none;
         touch-action: manipulation; -webkit-tap-highlight-color: transparent; transition: background .1s; }
  .key:active { background: rgba(236,232,225,0.18); }
  .key.fn { border-color: transparent; background: transparent; color: #c9c4bb; }
  .key.fn:active { background: rgba(236,232,225,0.08); }
  .key:disabled { opacity: .35; cursor: default; }
  .links { display: flex; justify-content: center; gap: 18px; margin-top: 8px; }
  .link { background: none; border: 0; padding: 8px; color: #8a867f; font: inherit; font-size: 14px; cursor: pointer; }
</style>
</head><body>
<main class="${pinFirst ? "pin" : ""}">
  <img class="logo" src="/logos/gill-co-lockup.png" alt="Gill &amp; Co. Holdings" />

  <section id="pinView" ${pinFirst ? "" : "hidden"}>
    <p class="label">Enter PIN</p>
    <div class="dots" id="dots">${"<i></i>".repeat(pinLength)}</div>
    <p class="msg" id="pmsg"></p>
    <div class="pad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit).join("")}
      <button type="button" class="key fn" id="faceKey" aria-label="Unlock with Face ID" style="visibility:hidden">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9v1.5M15 9v1.5M12 9v4h-1M9.5 15.5c1.4 1.2 3.6 1.2 5 0"/></svg>
      </button>
      ${digit(0)}
      <button type="button" class="key fn" id="del" aria-label="Delete">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6-7z"/><path d="M12.5 9.5l5 5M17.5 9.5l-5 5"/></svg>
      </button>
    </div>
    <div class="links"><button type="button" class="link" id="usePw">Use password</button></div>
  </section>

  <form method="POST" action="/__login" id="pwView" ${pinFirst ? "hidden" : ""}>
    <input type="hidden" name="next" id="next" value="${escapeAttr(next)}" />
    <button type="button" id="faceid" hidden>Unlock with Face ID</button>
    <p class="or" id="or" hidden>or use the password</p>
    <h1 id="prompt">Enter password</h1>
    <input type="password" name="password" id="pw" autocomplete="current-password" ${pinFirst ? "" : "autofocus"} required />
    <p class="msg" id="msg">${error || ""}</p>
    <button type="submit" id="unlock">Unlock</button>
    ${pinLength ? '<button type="button" class="link" id="usePin">Use PIN</button>' : ""}
  </form>

  <div class="links"><button type="button" class="link" id="setup" hidden>Set up Face ID</button></div>
</main>
<script>
// Face ID errors show under whichever view is open.
window.msgEl = () => $("pinView").hidden ? $("msg") : $("pmsg");
</script>
<script>${PASSKEY_CLIENT}
const PIN_LEN = ${pinLength};
const pinMode = () => !$("pinView").hidden;
const showPin = (on) => {
  $("pinView").hidden = !on; $("pwView").hidden = on;
  document.querySelector("main").className = on ? "pin" : "";
  if (!on) $("pw").focus();
};
$("usePw").onclick = () => showPin(false);
if ($("usePin")) $("usePin").onclick = () => showPin(true);

// ── PIN keypad ──
let pin = "", busy = false, lockedUntil = 0;
const dots = [...document.querySelectorAll("#dots i")];
const draw = () => dots.forEach((d, i) => d.classList.toggle("on", i < pin.length));
const setLocked = (until) => {
  lockedUntil = until || 0;
  document.querySelectorAll(".key[data-d], #del").forEach((k) => { k.disabled = Date.now() < lockedUntil; });
  if (lockedUntil > Date.now()) setTimeout(() => { setLocked(0); $("pmsg").textContent = ""; }, lockedUntil - Date.now() + 500);
};
const submitPin = async () => {
  busy = true;
  try {
    const r = await fetch("/__pin", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, next: $("next").value }) });
    const d = await r.json();
    if (r.ok) return location.replace(d.next);
    $("dots").classList.remove("shake"); void $("dots").offsetWidth; $("dots").classList.add("shake");
    $("pmsg").textContent = d.error || "Wrong PIN";
    if (d.locked) setLocked(d.until);
  } catch (e) {
    $("pmsg").textContent = "Couldn't reach the server";
  }
  pin = ""; draw(); busy = false;
};
const press = (d) => {
  if (busy || Date.now() < lockedUntil || pin.length >= PIN_LEN) return;
  if (!pin) $("pmsg").textContent = "";
  pin += d; draw();
  if (pin.length === PIN_LEN) setTimeout(submitPin, 120);
};
document.querySelectorAll(".key[data-d]").forEach((k) => k.onclick = () => press(k.dataset.d));
$("del").onclick = () => { if (!busy) { pin = pin.slice(0, -1); draw(); } };
document.addEventListener("keydown", (e) => {
  if (!pinMode()) return;
  if (/^[0-9]$/.test(e.key)) press(e.key);
  else if (e.key === "Backspace") $("del").click();
});

// ── Face ID ──
// The challenge is fetched ahead of time (and renewed) so the Face ID prompt
// opens straight from a tap, which Safari requires.
let opts = null;
const refresh = () => fetch("/__passkey/options", { method: "POST" }).then((r) => r.json()).then(async (o) => {
  opts = o;
  if (o.pinLockedUntil) setLocked(o.pinLockedUntil);
  if (!o.available) {
    // Nothing set up yet: offer it on devices that have Face ID / Touch ID.
    const can = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
    if (can && $("next").value !== "/passkeys") $("setup").hidden = false;
    return;
  }
  $("setup").hidden = true;
  $("faceKey").style.visibility = "visible";
  $("faceid").hidden = false; $("or").hidden = false; $("prompt").hidden = true;
  $("unlock").className = "ghost"; $("pw").removeAttribute("required");
  if (document.activeElement === $("pw")) $("pw").blur();
  autoTry();
}).catch(() => {});
// Open Face ID by itself once, as soon as the lock screen is showing. Safari
// may insist on a tap; then this fails quietly and the button stays.
let tried = false;
const autoTry = () => {
  if (tried || !opts || !opts.available) return;
  if (document.visibilityState !== "visible") return;
  tried = true;
  faceId(true);
};
document.addEventListener("visibilitychange", autoTry);
if (hasPasskeys) { refresh(); setInterval(refresh, 4 * 60 * 1000); }
const faceId = async (auto) => {
  if (!opts) return;
  say("");
  try {
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: dec(opts.challenge), rpId: opts.rpId, userVerification: "required", timeout: 60000 } });
    const r = cred.response;
    const res = await fetch("/__passkey/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cred.id, clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData),
        signature: enc(r.signature), next: $("next").value }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "Face ID didn't work");
    location.replace(d.next);
  } catch (e) {
    if (!auto && !cancelled(e)) say(e.message);
    refresh();
  }
};
$("faceid").onclick = () => faceId(false);
$("faceKey").onclick = () => faceId(false);
$("unlock").onclick = () => $("pw").setAttribute("required", "");
// Adding Face ID needs the password itself (not the PIN), so set-up goes
// through the password form and then to the Face ID page.
$("setup").onclick = () => {
  showPin(false);
  $("next").value = "/passkeys"; $("setup").hidden = true;
  $("prompt").hidden = false; $("prompt").textContent = "Enter the password once to set up Face ID";
  $("pw").setAttribute("required", ""); $("pw").focus();
};
</script>
</body></html>`;
}

function passkeysPage(pinLength = 0) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#0a0a0a" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black" />
<title>Face ID · Gill &amp; Co.</title>
<link rel="icon" type="image/png" href="/favicon.png?v=manor" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=manor" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+Display:wght@600&family=Noto+Serif:wght@400;600&display=swap" rel="stylesheet" />
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0a0a0a; color: #ece8e1; font: 15px/1.5 'Noto Serif', Georgia, serif; }
  main { max-width: 560px; margin: 0 auto; padding: 28px 20px 56px; }
  a.back { color: #8a867f; text-decoration: none; font-size: 14px; }
  .eyebrow { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; margin: 28px 0 6px; }
  h1 { font: 600 38px/1.05 'Noto Serif Display', Georgia, serif; margin: 0 0 12px; }
  .note { color: #8a867f; font-size: 14px; margin: 0 0 22px; }
  button { font: inherit; font-weight: 600; padding: 12px 16px; border-radius: 10px; border: 0; cursor: pointer;
           background: #ece8e1; color: #0a0a0a; width: 100%; }
  button:disabled { opacity: 0.5; cursor: default; }
  #msg { margin: 12px 0 0; font-size: 14px; color: #c0675a; }
  #msg.ok { color: #6b9a7d; }
  #msg:empty { display: none; }
  ul { list-style: none; padding: 0; margin: 28px 0 0; border-top: 1px solid rgba(236,232,225,0.09); }
  li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; border-bottom: 1px solid rgba(236,232,225,0.09); }
  li small { display: block; color: #8a867f; font-size: 12.5px; }
  li button { width: auto; background: transparent; color: #c0675a; border: 1px solid rgba(192,103,90,0.35); padding: 6px 12px; font-weight: 500; font-size: 13px; }
  .empty { color: #6f6c67; font-size: 14px; padding: 14px 0; }
  #stepup { display: grid; gap: 10px; margin: 0 0 14px; }
  #stepup[hidden] { display: none; }
  #stepup input { font: inherit; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(236,232,225,0.198); background: #131313; color: inherit; }
  #stepup button { background: transparent; color: #ece8e1; border: 1px solid rgba(236,232,225,0.198); font-weight: 500; }
  .pin { margin: 36px 0 0; padding-top: 18px; border-top: 1px solid rgba(236,232,225,0.09); }
  .pin h2 { font: 600 20px 'Noto Serif Display', Georgia, serif; margin: 0 0 6px; }
  .pin p { color: #8a867f; font-size: 14px; margin: 0; }
  .pin code { color: #c9c4bb; }
</style>
</head><body><main>
<a class="back" href="/tools">← Tools</a>
<p class="eyebrow">Sign-in</p>
<h1>Face ID</h1>
<p class="note">Add Face ID on each phone or computer you use. When the site asks you to sign in, tap <em>Unlock with Face ID</em> instead of typing the password. The password still works as a backup.</p>
<form id="stepup" hidden>
  <p class="note" style="margin:0">For security, enter the password to add a device.</p>
  <input type="password" id="spw" autocomplete="current-password" required />
  <button type="submit">Continue</button>
</form>
<button type="button" id="add" disabled>Add Face ID on this device</button>
<p id="msg"></p>
<ul id="list"></ul>
<section class="pin">
  <h2>PIN</h2>
  ${pinLength
    ? `<p>The lock screen shows a ${pinLength}-digit keypad. Five wrong PINs lock it for 15 minutes (Face ID and the password still work). To change the PIN, edit the <code>Vik_Code</code> secret in Cloudflare.</p>`
    : `<p>Not set. To unlock with a keypad, add a secret named <code>Vik_Code</code> (4–8 digits) to the <code>dashboard</code> Worker in Cloudflare: Settings → Variables and Secrets.</p>`}
</section>
</main>
<script>${IDLE_CLIENT}</script>
<script>${PASSKEY_CLIENT}
const deviceName = () => { const u = navigator.userAgent;
  return /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1) ? "iPad"
    : /Macintosh/.test(u) ? "Mac" : /Android/.test(u) ? "Android" : /Windows/.test(u) ? "Windows PC" : "This device"; };
const when = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "never";
let opts = null;
// Adding a device needs the password typed in the last 5 minutes.
const getOptions = () => fetch("/api/passkeys?options").then(async (r) => {
  const o = await r.json();
  if (r.status === 403) { opts = null; $("add").disabled = true; $("stepup").hidden = false; return; }
  opts = o; $("stepup").hidden = true; $("add").disabled = !hasPasskeys;
});
$("stepup").onsubmit = async (e) => {
  e.preventDefault(); say(""); $("msg").className = "";
  const r = await fetch("/api/passkeys?stepup", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: $("spw").value }) });
  if (!r.ok) { say((await r.json().catch(() => ({}))).error || "Wrong password."); return; }
  $("spw").value = ""; await getOptions();
  $("msg").className = "ok"; say("Now tap Add Face ID on this device.");
};
const load = () => fetch("/api/passkeys").then((r) => r.json()).then(({ passkeys }) => {
  const ul = $("list"); ul.innerHTML = "";
  if (!passkeys.length) { ul.innerHTML = '<li class="empty">No devices yet.</li>'; return; }
  for (const p of passkeys) {
    const li = document.createElement("li");
    li.innerHTML = '<div><span></span><small></small></div><button type="button">Remove</button>';
    li.querySelector("span").textContent = p.name;
    li.querySelector("small").textContent = "Added " + when(p.created) + " · last used " + when(p.lastUsed);
    li.querySelector("button").onclick = async () => {
      if (!confirm("Remove Face ID for " + p.name + "? You can add it again any time.")) return;
      await fetch("/api/passkeys?id=" + encodeURIComponent(p.id), { method: "DELETE" });
      load(); getOptions();
    };
    ul.appendChild(li);
  }
});
if (!hasPasskeys) say("This browser can't use passkeys.");
load(); getOptions(); setInterval(getOptions, 4 * 60 * 1000);
$("add").onclick = async () => {
  if (!opts) return;
  say(""); $("msg").className = "";
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: dec(opts.challenge), rp: opts.rp,
      user: { id: dec(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      excludeCredentials: opts.exclude.map((id) => ({ type: "public-key", id: dec(id) })),
      attestation: "none", timeout: 60000 } });
    const r = cred.response;
    const res = await fetch("/api/passkeys", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cred.id, clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.getAuthenticatorData()),
        publicKey: enc(r.getPublicKey()), publicKeyAlgorithm: r.getPublicKeyAlgorithm(), name: deviceName() }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "Couldn't save");
    $("msg").className = "ok"; say("Face ID is set up on this device.");
    load();
  } catch (e) {
    if (e && e.name === "InvalidStateError") say("This device already has Face ID set up.");
    else if (!cancelled(e)) say(e.message);
  }
  getOptions();
};
</script>
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
   Card claims, saved property deals and the PTO plan live in Supabase. Only this worker
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
   benefit's `match` text (cards.json) are written in as claimed. The Cards
   page first gets the saved rows (one fast Supabase read), then asks for a
   quick sync over the last RECENT_DAYS of YNAB. The nightly cron syncs the
   full two years, which also corrects any amounts the quick sync skipped. */

const RECENT_DAYS = 45;

async function loadCards(env, origin) {
  const res = await env.ASSETS.fetch(new Request(origin + "/cards.json"));
  if (!res.ok) throw new Error("cards.json missing");
  return (await res.json()).cards || [];
}

// Inflows on credit-card accounts since `since`, minus card payments. The full
// sync looks back to January of last year (so January still sees December).
async function fetchCardCredits(env, since) {
  if (!env.YNABKEY) return { ok: false, error: "YNABKEY not set", credits: [] };
  try {
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

// First day of a period key, so a quick sync can tell which periods it only
// partly sees. "once" has no start.
function periodStart(period) {
  const m = /^(\d{4})(?:-(\d{2})|-Q([1-4])|-H([12]))?$/.exec(period);
  if (!m) return null;
  const month = m[2] ? +m[2] : m[3] ? (m[3] - 1) * 3 + 1 : m[4] ? (m[4] - 1) * 6 + 1 : 1;
  return `${m[1]}-${String(month).padStart(2, "0")}-01`;
}
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

// Saved claims only: what the Cards page shows first. Falls back to a full
// sync (which has a read-only mode) when Supabase isn't set up or reachable.
async function readClaims(env, origin) {
  if (!supabaseKey(env)) return syncClaims(env, origin);
  try {
    const rows = await supabase(env, `card_claims?select=${CLAIM_COLS}`);
    return { saving: true, error: "", ynab: { ok: null, error: "" }, rows };
  } catch {
    return syncClaims(env, origin);
  }
}

// Read every claim, write in new YNAB matches, and return the result. With
// `recent`, only the last RECENT_DAYS of YNAB are read. That can miss half of
// a credit posted in two parts, so it adds new claims but leaves saved amounts
// alone for any period that started before the window.
async function syncClaims(env, origin, { recent = false } = {}) {
  recent = recent && !!supabaseKey(env); // read-only mode needs the full history
  const since = recent
    ? new Date(Date.now() - RECENT_DAYS * 864e5).toISOString().slice(0, 10)
    : `${new Date().getUTCFullYear() - 1}-01-01`;
  const [cards, ynab] = await Promise.all([loadCards(env, origin), fetchCardCredits(env, since)]);
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
    else if (recent && !((periodStart(m.period) || "") >= since)) continue;
    else if (r.claimed && (r.amount == null || Number(r.amount) !== m.amount || r.posted_on !== m.posted_on)) {
      // Already marked (by hand or from history): just record what posted.
      amounts.push({ ...m, updated_at: now });
    }
  }
  const upsert = "card_claims?on_conflict=card_id,benefit_id,period";
  // The two writes touch different rows, so they run side by side.
  await Promise.all([
    // Never over a row saved meanwhile (e.g. un-marked on another device).
    fresh.length && supabase(env, upsert, { method: "POST", body: fresh, prefer: "resolution=ignore-duplicates,return=minimal" }),
    amounts.length && supabase(env, upsert, { method: "POST", body: amounts, prefer: "resolution=merge-duplicates,return=minimal" }),
  ]);
  for (const r of fresh) if (!byKey.has(claimKey(r))) byKey.set(claimKey(r), r);
  for (const r of amounts) byKey.set(claimKey(r), { ...byKey.get(claimKey(r)), ...r });
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

/* ─── PTO plan ───
   One row (id "main") in pto_plan holding the whole PTO page: Kronos
   balances, paycheck checklist and trips. Until the first Save there is no
   row, and the page starts from pto.json. */

async function loadPtoDefault(env, origin) {
  const res = await env.ASSETS.fetch(new Request(origin + "/pto.json"));
  if (!res.ok) throw new Error("pto.json missing");
  return res.json();
}

async function ptoResponse(request, env, origin) {
  if (request.method === "GET") {
    if (!supabaseKey(env)) return json({ data: await loadPtoDefault(env, origin), source: "default", saving: false, error: NO_KEY });
    try {
      const rows = await supabase(env, "pto_plan?id=eq.main&select=data,updated_at");
      if (rows?.length) return json({ data: rows[0].data, source: "saved", saving: true, updated_at: rows[0].updated_at });
      return json({ data: await loadPtoDefault(env, origin), source: "default", saving: true });
    } catch (e) {
      return json({ data: await loadPtoDefault(env, origin), source: "default", saving: false, error: String(e.message || e) });
    }
  }
  if (request.method === "POST") {
    if (!supabaseKey(env)) return json({ error: NO_KEY }, 503);
    const body = await readJson(request);
    const data = body?.data;
    if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.trips) || !Array.isArray(data.balances)
        || JSON.stringify(data).length > 100000) {
      return json({ error: "Bad request" }, 400);
    }
    await supabase(env, "pto_plan?on_conflict=id", {
      method: "POST", body: [{ id: "main", data, updated_at: new Date().toISOString() }],
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    return json({ ok: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

/* ─── Work schedule ───
   /api/shifts reads the BSN calendar live from Google (its secret iCal
   address, in the BSN_ICAL Worker secret) and returns only the work shifts:
   date, start time and title. Nothing else on that calendar leaves the
   Worker. Without the secret it says so and the page uses shifts.json. */

async function shiftsResponse(env) {
  const url = env.BSN_ICAL || env.BSN_CALENDAR_ICAL || "";
  if (!url) return json({ source: "none", error: "The BSN_ICAL secret is not set on the Worker" });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: HOME_TZ }).format(new Date());
  const y = Number(today.slice(0, 4));
  const from = `${y - 1}-07-01`, to = `${y + 2}-12-31`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "gill-co-worker" }, cf: { cacheTtl: 300, cacheEverything: true } });
    // Never echo the URL: it is the key to the whole calendar.
    if (!res.ok) return json({ source: "error", error: `Google Calendar answered ${res.status}` });
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) return json({ source: "error", error: "That link isn't an iCal feed" });
    return json({ source: "google", fetched: new Date().toISOString(), shifts: listShifts(text, from, to) });
  } catch (e) {
    return json({ source: "error", error: "Couldn't reach Google Calendar" });
  }
}

/* ─── Property lookup by ZIP ───
   /api/lookup?zip=15210 → a conservative property-tax rate and HUD Fair Market
   Rents (what Section 8 pays) for that ZIP. The Property page pulls the ZIP
   out of a pasted Zillow link; nothing here talks to Zillow.

   Tax: Census ACS 5-year median real-estate taxes paid ÷ median home value,
   for the ZIP (ZCTA) and for its county. The higher of the two is returned.
   Needs the CENSUS_KEY secret (free: api.census.gov/data/key_signup.html).

   Rent: HUD's Small Area FMR for the ZIP where HUD publishes one, otherwise
   the metro/county FMR. Needs the HUD_TOKEN secret (free: huduser.gov →
   Datasets → APIs → create a token). The ZIP → county step uses the same
   token (HUD's USPS crosswalk). */

const HUD = "https://www.huduser.gov/hudapi/public";
const ACS_YEARS = [2024, 2023];
const DAY = 86400;

async function hud(env, path) {
  const res = await fetch(HUD + path, {
    headers: { Authorization: `Bearer ${env.HUD_TOKEN}` },
    cf: { cacheTtl: DAY, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`HUD ${res.status}`);
  return (await res.json()).data;
}

// ZIP → the county holding most of its homes.
async function zipCounty(env, zip) {
  const data = await hud(env, `/usps?type=2&query=${zip}`);
  const rows = (data && data.results) || [];
  if (!rows.length) throw new Error("HUD has no county for that ZIP");
  rows.sort((a, b) => Number(b.res_ratio || 0) - Number(a.res_ratio || 0));
  const top = rows[0];
  return { fips: String(top.geoid), city: top.city || "", state: top.state || "" };
}

async function acs(env, geo) {
  for (const year of ACS_YEARS) {
    const q = `https://api.census.gov/data/${year}/acs/acs5?get=NAME,B25103_001E,B25077_001E&${geo}&key=${encodeURIComponent(env.CENSUS_KEY)}`;
    const res = await fetch(q, { cf: { cacheTtl: DAY * 7, cacheEverything: true } });
    if (!res.ok) continue;            // that vintage isn't out yet → try the one before
    const rows = await res.json().catch(() => null);
    if (!rows || rows.length < 2) continue;
    const [name, taxes, value] = rows[1];
    const t = Number(taxes), v = Number(value);
    // ACS uses large negative numbers for "no estimate".
    if (!(t > 0 && v > 0)) return { name, year, rate: null };
    return { name, year, taxes: t, value: v, rate: Math.round((t / v) * 10000) / 100 };
  }
  throw new Error("Census returned no data (check CENSUS_KEY)");
}

async function taxLookup(env, zip, countyFips) {
  if (!env.CENSUS_KEY) return { ok: false, error: "CENSUS_KEY not set" };
  const [z, c] = await Promise.allSettled([
    acs(env, `for=zip%20code%20tabulation%20area:${zip}`),
    countyFips ? acs(env, `for=county:${countyFips.slice(2, 5)}&in=state:${countyFips.slice(0, 2)}`)
      : Promise.reject(new Error("no county")),
  ]);
  const zipT = z.status === "fulfilled" ? z.value : null;
  const cty = c.status === "fulfilled" ? c.value : null;
  const candidates = [zipT && zipT.rate != null && { ...zipT, from: "zip" },
    cty && cty.rate != null && { ...cty, from: "county" }].filter(Boolean);
  if (!candidates.length) {
    const why = [z, c].find((r) => r.status === "rejected");
    return { ok: false, error: why ? String(why.reason.message || why.reason) : "No tax data for this ZIP" };
  }
  const pick = candidates.reduce((a, b) => (b.rate > a.rate ? b : a));
  return { ok: true, rate: pick.rate, from: pick.from, zip: zipT, county: cty };
}

const FMR_KEYS = [["Efficiency", 0], ["One-Bedroom", 1], ["Two-Bedroom", 2], ["Three-Bedroom", 3], ["Four-Bedroom", 4]];

async function rentLookup(env, zip, countyFips) {
  if (!env.HUD_TOKEN) return { ok: false, error: "HUD_TOKEN not set" };
  if (!countyFips) return { ok: false, error: "No county for that ZIP" };
  const d = await hud(env, `/fmr/data/${countyFips}99999`);
  const basic = d && d.basicdata;
  let row = null, smallArea = false;
  if (Array.isArray(basic)) {
    row = basic.find((r) => String(r.zip_code) === zip);
    smallArea = Boolean(row);
    if (!row) row = basic.find((r) => /msa/i.test(String(r.zip_code || ""))) || basic[0];
  } else row = basic;
  if (!row) return { ok: false, error: "HUD returned no rents for this area" };
  const rents = FMR_KEYS.map(([k, beds]) => ({ beds, rent: Number(row[k]) || null })).filter((r) => r.rent);
  return {
    ok: true, smallArea, rents,
    year: (d && d.year) || row.year || null,
    area: (d && (d.area_name || d.metro_name || d.county_name)) || "",
  };
}

async function lookupResponse(env, url) {
  const zip = String(url.searchParams.get("zip") || "").trim();
  if (!/^\d{5}$/.test(zip)) return json({ error: "Need a 5-digit ZIP" }, 400);
  let county = null, countyError = null;
  if (env.HUD_TOKEN) {
    try { county = await zipCounty(env, zip); } catch (e) { countyError = String(e.message || e); }
  } else countyError = "HUD_TOKEN not set";
  const fips = county && county.fips;
  const [tax, rent] = await Promise.all([
    taxLookup(env, zip, fips).catch((e) => ({ ok: false, error: String(e.message || e) })),
    rentLookup(env, zip, fips).catch((e) => ({ ok: false, error: String(e.message || e) })),
  ]);
  if (!fips && rent.ok === false && rent.error === "No county for that ZIP") rent.error = countyError;
  return json({ zip, county, tax, rent });
}

/* ─── Passkeys (Face ID / Touch ID) ───
   A signed-in device can add a passkey at /passkeys; the login page then
   offers "Unlock with Face ID", which signs in the same way as the
   password. The password keeps working as a backup.

   Only ES256 (P-256) keys, which is what Apple and Google passkeys use.
   Registration is allowed only with a valid cookie, so it never needs
   attestation. Challenges are signed with a key derived from PASSWORD instead
   of being stored. Passkeys live in the HISTORY KV namespace under their own
   key, so no new Cloudflare resource is needed. */

const PASSKEYS_KEY = "auth:passkeys";
const CHALLENGE_TTL = 5 * 60 * 1000;
const MAX_PASSKEYS = 10;
const enc = new TextEncoder();

const b64u = (buf) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (str) => {
  const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

async function challengeMac(env, body, purpose) {
  const key = await crypto.subtle.importKey("raw", enc.encode("passkey-challenge:" + env.PASSWORD),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, concat(body, enc.encode(purpose)))).subarray(0, 16);
}

// 16 random bytes + expiry (ms) + a MAC tying both to the purpose.
async function newChallenge(env, purpose) {
  const body = new Uint8Array(24);
  crypto.getRandomValues(body.subarray(0, 16));
  new DataView(body.buffer).setFloat64(16, Date.now() + CHALLENGE_TTL);
  return b64u(concat(body, await challengeMac(env, body, purpose)));
}

async function challengeOk(env, challenge, purpose) {
  let raw;
  try { raw = unb64u(challenge); } catch { return false; }
  if (raw.length !== 40) return false;
  const body = raw.slice(0, 24);
  if (new DataView(body.buffer).getFloat64(16) < Date.now()) return false;
  return sameBytes(raw.subarray(24), await challengeMac(env, body, purpose));
}

async function readPasskeys(env) {
  if (!env.HISTORY) return [];
  return (await env.HISTORY.get(PASSKEYS_KEY, "json")) || [];
}
async function writePasskeys(env, list) {
  await env.HISTORY.put(PASSKEYS_KEY, JSON.stringify(list));
}

// Checks what every ceremony shares: clientData type, challenge and origin,
// then the authenticator data's RP hash and the user-present + user-verified
// flags (UV is what makes it Face ID rather than just a tap).
async function checkCeremony(env, url, { clientDataJSON, authenticatorData }, type, purpose) {
  const clientBytes = unb64u(clientDataJSON);
  const client = JSON.parse(new TextDecoder().decode(clientBytes));
  if (client.type !== type || client.origin !== url.origin) throw new Error("Wrong origin");
  if (!(await challengeOk(env, client.challenge, purpose))) throw new Error("Expired, try again");
  const auth = unb64u(authenticatorData);
  if (auth.length < 37 || !sameBytes(auth.subarray(0, 32), await sha256(enc.encode(url.hostname)))) {
    throw new Error("Wrong site");
  }
  if ((auth[32] & 0x05) !== 0x05) throw new Error("Face ID wasn't confirmed");
  return { auth, clientBytes };
}

// WebAuthn signatures are DER; Web Crypto wants r || s, 32 bytes each.
function derToRaw(der) {
  let i = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const int = () => {
    if (der[i++] !== 0x02) throw new Error("Bad signature");
    const len = der[i++];
    let v = der.subarray(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = int();
  return concat(r, int());
}

const ES256 = { name: "ECDSA", namedCurve: "P-256" };

async function passkeyRegister(request, env, url) {
  const body = await readJson(request);
  if (!body || body.publicKeyAlgorithm !== -7 || !body.id || !body.publicKey) {
    return json({ error: "This device's passkey type isn't supported" }, 400);
  }
  try {
    await checkCeremony(env, url, body, "webauthn.create", "register");
    await crypto.subtle.importKey("spki", unb64u(body.publicKey), ES256, false, ["verify"]);
  } catch (e) {
    return json({ error: String(e.message || e) }, 400);
  }
  const list = (await readPasskeys(env)).filter((p) => p.id !== body.id);
  if (list.length >= MAX_PASSKEYS) return json({ error: `Remove one first (limit ${MAX_PASSKEYS})` }, 400);
  const name = String(body.name || "This device").slice(0, 40);
  list.push({ id: body.id, publicKey: body.publicKey, name, created: new Date().toISOString(), lastUsed: null });
  await writePasskeys(env, list);
  return json({ ok: true });
}

async function passkeyLogin(request, env, url) {
  const body = await readJson(request);
  const fail = async (msg) => {
    await new Promise((r) => setTimeout(r, 1000));
    return json({ error: msg }, 401);
  };
  if (!body || !body.id || !body.signature) return fail("Face ID didn't finish");
  const list = await readPasskeys(env);
  const key = list.find((p) => p.id === body.id);
  if (!key) return fail("This passkey was removed. Use the password, then add Face ID again.");
  try {
    const { auth, clientBytes } = await checkCeremony(env, url, body, "webauthn.get", "login");
    const pub = await crypto.subtle.importKey("spki", unb64u(key.publicKey), ES256, false, ["verify"]);
    const signed = concat(auth, await sha256(clientBytes));
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, derToRaw(unb64u(body.signature)), signed);
    if (!ok) return fail("Face ID didn't match");
  } catch (e) {
    return fail(String(e.message || e));
  }
  key.lastUsed = new Date().toISOString();
  await writePasskeys(env, list).catch(() => {});
  await clearPinLock(env).catch(() => {});
  return new Response(JSON.stringify({ ok: true, next: safeNext(body.next) }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Set-Cookie": await sessionCookie(env),
    },
  });
}

async function passkeysApi(request, env, url) {
  // Re-enter the password on the Face ID page to get the step-up.
  if (request.method === "POST" && url.searchParams.has("stepup")) {
    const body = (await readJson(request)) || {};
    if ((await tokenFor(String(body.password || ""))) !== (await tokenFor(env.PASSWORD))) {
      await new Promise((r) => setTimeout(r, 1500));
      // 403, not 401: the page treats 401 as "signed out" and locks.
      return json({ error: "Wrong password." }, 403);
    }
    return new Response(null, { status: 204, headers: { "Set-Cookie": await stepupCookie(env) } });
  }
  if (request.method === "GET" && url.searchParams.has("options")) {
    // The register challenge is only handed out with a fresh password, and
    // registering needs that challenge, so this is the step-up check.
    if (!(await stepupOk(request, env))) return json({ error: "Enter the password to add a device", needPassword: true }, 403);
    const list = await readPasskeys(env);
    return json({
      challenge: await newChallenge(env, "register"),
      rp: { id: url.hostname, name: "Gill & Co." },
      user: { id: b64u(enc.encode("gill-co-owner")), name: "Gill & Co.", displayName: "Gill & Co." },
      exclude: list.map((p) => p.id),
    });
  }
  if (request.method === "GET") {
    return json({ passkeys: (await readPasskeys(env)).map(({ id, name, created, lastUsed }) => ({ id, name, created, lastUsed })) });
  }
  if (request.method === "POST") return passkeyRegister(request, env, url);
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    const list = await readPasskeys(env);
    await writePasskeys(env, list.filter((p) => p.id !== id));
    return json({ ok: true });
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
        return html(loginPage("Wrong password.", safeNext(form.get("next")), pinOf(env).length), 401);
      }
      await clearPinLock(env);
      const headers = new Headers({ Location: safeNext(form.get("next")) });
      headers.append("Set-Cookie", await sessionCookie(env));
      headers.append("Set-Cookie", await stepupCookie(env));
      return new Response(null, { status: 303, headers });
    }

    // Face ID sign-in happens before the password gate, like /__login.
    if (url.pathname === "/__passkey/options" && request.method === "POST") {
      const [count, pin] = [(await readPasskeys(env)).length, await pinState(env)];
      return json({ available: count > 0, challenge: await newChallenge(env, "login"), rpId: url.hostname,
        pinLockedUntil: pin.until > Date.now() ? pin.until : 0, pinStatus: pinStatus(env) });
    }
    if (url.pathname === "/__pin" && request.method === "POST") return pinLogin(request, env);
    if (url.pathname === "/__passkey/login" && request.method === "POST") {
      return passkeyLogin(request, env, url);
    }

    // Icons and the manifest load without the password: browsers fetch the
    // manifest without cookies, and iOS may fetch the home-screen icon the
    // same way. They hold only the logo, the castle mark and the app name; the login page
    // shows the full logo.
    const expires = await readSession(request, env);
    if (!expires) {
      if (PUBLIC_FILES.has(url.pathname)) return serve(request, env, url);
      // The app's own data requests get a plain 401 so the page can reload
      // into the login screen; anything else gets the login page itself.
      if (url.pathname.startsWith("/api/")) return json({ error: "Signed out", signedOut: true }, 401);
      return html(loginPage("", safeNext(url.pathname + url.search), pinOf(env).length), 401);
    }
    const res = await serve(request, env, url);
    if (expires - Date.now() > SESSION_TTL - RENEW_AFTER) return res;
    const out = new Response(res.body, res);
    out.headers.append("Set-Cookie", await sessionCookie(env));
    return out;
  },
};

// Everything behind the password.
async function serve(request, env, url) {
    // The page pings this while you're using it, to keep the session alive.
    if (url.pathname === "/api/session") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

    if (url.pathname === "/passkeys") return html(passkeysPage(pinOf(env).length), 200);
    if (url.pathname === "/api/passkeys") {
      try { return await passkeysApi(request, env, url); }
      catch (e) { return json({ error: String(e.message || e) }, 500); }
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

    if (url.pathname === "/api/claims" || url.pathname === "/api/deals" || url.pathname === "/api/pto" || url.pathname === "/api/shifts") {
      try {
        if (url.pathname === "/api/shifts") return await shiftsResponse(env);
        if (url.pathname === "/api/deals") return await dealsResponse(request, env, url);
        if (url.pathname === "/api/pto") return await ptoResponse(request, env, url.origin);
        if (request.method === "POST") return await saveClaims(request, env, url.origin);
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        if (url.searchParams.has("sync")) return json(await syncClaims(env, url.origin, { recent: true }));
        return json(await readClaims(env, url.origin));
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    if (url.pathname === "/api/lookup") {
      try { return await lookupResponse(env, url); }
      catch (e) { return json({ error: String(e.message || e) }, 500); }
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
}
