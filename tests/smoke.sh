#!/usr/bin/env bash
# Runs the site in Cloudflare's local runtime (wrangler dev) and checks that
# every page address serves the app, files still load, unknown files 404,
# and the password gate still works. Run before pushing:
#
#   bash tests/smoke.sh
#
# Needs Node. Uses `npx wrangler` unless WRANGLER points at a binary.
set -u
cd "$(dirname "$0")/.."

PORT="${PORT:-8799}"
WRANGLER="${WRANGLER:-npx --yes wrangler@4}"
BASE="http://localhost:$PORT"
LOG="$(mktemp)"
PASS=0; FAIL=0

# Throwaway local password; .dev.vars is never deployed.
printf 'PASSWORD=smoke-test\n' > .dev.vars
COOKIE="ic_auth=$(printf 'income-calculator:smoke-test' | sha256sum | cut -d' ' -f1)"

$WRANGLER dev --port "$PORT" > "$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; rm -f .dev.vars "$LOG"; }
trap cleanup EXIT

for _ in $(seq 1 60); do curl -s -o /dev/null "$BASE/robots.txt" && break; sleep 1; done

check() { # name, expected, actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok   $1"
  else FAIL=$((FAIL+1)); echo "  FAIL $1 (expected $2, got $3)"; fi
}
status() { curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $COOKIE" "$BASE$1"; }
is_app() { curl -s -H "Cookie: $COOKIE" "$BASE$1" | grep -q 'id="root"' && echo app || echo not-app; }

echo "Pages serve the app:"
for p in / /networth/accounts /networth/loans /dashboard /dashboard/employers /dashboard/monthly \
         /dashboard/paystubs /pay /cards /cards/amex-gold /tools /property /property/projections /travel /pto /nope; do
  check "$p" "200 app" "$(status "$p") $(is_app "$p")"
done

echo "Files still load as files:"
for f in /cards.json /paystubs.json /networth.json /travel.json /pto.json /favicon.png /apple-touch-icon.png /icon.png /icon-192.png /manifest.json /logos/gc-seal.png /logos/gc-circle.png /logos/gill-co-wordmark.png; do
  check "$f" 200 "$(status "$f")"
done
check "/cards.json is JSON" yes "$(curl -s -H "Cookie: $COOKIE" "$BASE/cards.json" | head -c1 | grep -q '{' && echo yes || echo no)"

echo "Private files are not served:"
for f in /worker.js /wrangler.jsonc /README.md /tests/smoke.sh; do
  check "$f not the file" no "$(curl -s -H "Cookie: $COOKIE" "$BASE$f" | grep -qE 'export default|\"main\"|^# Income|smoke-test' && echo yes || echo no)"
done

echo "Password gate:"
for f in /favicon.png /apple-touch-icon.png /icon.png /icon-192.png /manifest.json /logos/gill-co-wordmark.png; do
  check "$f loads without password" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$f")"
done
check "/cards.json still needs password" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/cards.json")"
check "/logos/gc-circle.png still needs password" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/logos/gc-circle.png")"
check "no cookie -> login" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/cards")"
check "login keeps the page" "/cards" "$(curl -s -o /dev/null -w '%{redirect_url}' -d 'password=smoke-test&next=/cards' "$BASE/__login" | sed "s#$BASE##")"
check "login refuses other sites" "/" "$(curl -s -o /dev/null -w '%{redirect_url}' -d 'password=smoke-test&next=//evil.example' "$BASE/__login" | sed "s#$BASE##")"
check "/api/version answers" 200 "$(status /api/version)"
# No YNABKEY or SupabaseKey locally: claims answer read-only, deals refuse.
check "/api/claims answers read-only" yes "$(curl -s -H "Cookie: $COOKIE" "$BASE/api/claims" | grep -q '"saving":false' && echo yes || echo no)"
check "/api/claims is gated" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/claims")"
check "/api/claims POST without key" 503 "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $COOKIE" -H 'Content-Type: application/json' -d '{}' "$BASE/api/claims")"
check "/api/deals without key" 503 "$(status /api/deals)"
check "/api/pto falls back to pto.json" yes "$(curl -s -H "Cookie: $COOKIE" "$BASE/api/pto" | grep -q '"source":"default"' && echo yes || echo no)"
check "/api/pto POST without key" 503 "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $COOKIE" -H 'Content-Type: application/json' -d '{}' "$BASE/api/pto")"
check "/api/pto is gated" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/pto")"
check "/api/deals is gated" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/deals")"
echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || { echo "--- wrangler log ---"; tail -20 "$LOG"; exit 1; }
