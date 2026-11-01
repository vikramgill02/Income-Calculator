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

export default {
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

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
    return out;
  },
};
