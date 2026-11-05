/* ─── Work shifts from Google Calendar ───
   Reads the BSN calendar's iCal feed (its "secret address in iCal format",
   kept in the BSN_ICAL Worker secret) and lists the work shifts in a date
   range, with repeating events expanded. Handles what Google Calendar
   writes: start times with a TZID or in UTC, RRULE (DAILY / WEEKLY /
   MONTHLY / YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, WKST),
   EXDATE, single occurrences that were moved or cancelled (RECURRENCE-ID),
   and STATUS:CANCELLED. Times are reported in Pacific time. */

export const HOME_TZ = "America/Los_Angeles";
const DAY = 86400000;
const DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// A "wall" is a clock reading with no zone: { y, m, d, h, mi, s }.
const pad = (n) => String(n).padStart(2, "0");
const wallDate = (w) => `${w.y}-${pad(w.m)}-${pad(w.d)}`;
const wallKey = (w) => `${wallDate(w)}T${pad(w.h)}:${pad(w.mi)}`;
const wallMs = (w) => Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
const msWall = (ms) => {
  const t = new Date(ms);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
};
const addDays = (w, n) => ({ ...msWall(wallMs({ ...w, h: 0, mi: 0, s: 0 }) + n * DAY), h: w.h, mi: w.mi, s: w.s });
const weekday = (w) => new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const fmtCache = {};
function zoneWall(tz, ms) {
  const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }));
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
// The UTC instant at which `tz` clocks read `w`.
function zoneToMs(w, tz) {
  const guess = wallMs(w);
  let ms = guess - (wallMs(zoneWall(tz, guess)) - guess);
  ms = guess - (wallMs(zoneWall(tz, ms)) - ms);
  return ms;
}

function unfold(text) {
  return String(text).replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseLine(line) {
  let q = false, i = 0;
  for (; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ":" && !q) break;
  }
  const [name, ...params] = line.slice(0, i).split(";");
  const p = {};
  for (const x of params) {
    const j = x.indexOf("=");
    if (j > 0) p[x.slice(0, j).toUpperCase()] = x.slice(j + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params: p, value: line.slice(i + 1) };
}

const unescape = (v) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");

// A time value as { kind: "date" | "utc" | "zone" | "floating", wall, tz }.
function parseTime(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const wall = { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  if (!m[4]) return { kind: "date", wall };
  if (m[7]) return { kind: "utc", wall };
  if (params.TZID) return { kind: "zone", wall, tz: params.TZID };
  return { kind: "floating", wall };
}

// Instant (ms) for a time, and the same moment on Pacific clocks.
function toMs(t) {
  if (t.kind === "utc") return wallMs(t.wall);
  if (t.kind === "zone") { try { return zoneToMs(t.wall, t.tz); } catch { return zoneToMs(t.wall, HOME_TZ); } }
  return zoneToMs(t.wall, HOME_TZ);
}
function toHome(t) {
  if (t.kind === "date") return { ...t.wall, allDay: true };
  if (t.kind === "floating" || (t.kind === "zone" && t.tz === HOME_TZ)) return t.wall;
  return zoneWall(HOME_TZ, toMs(t));
}

function parseRule(v) {
  const r = {};
  for (const part of v.split(";")) {
    const [k, val] = part.split("=");
    if (k && val !== undefined) r[k.toUpperCase()] = val;
  }
  return r;
}

/* Every start (as a wall in the event's own zone) of a repeating event,
   from DTSTART up to `endMs`. */
function expand(start, rule, endMs, cap = 4000) {
  const freq = rule.FREQ;
  const interval = Math.max(1, parseInt(rule.INTERVAL || "1", 10));
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : Infinity;
  let untilMs = Infinity;
  if (rule.UNTIL) {
    const u = parseTime(rule.UNTIL, {});
    if (u) untilMs = u.kind === "date" ? toMs({ ...start, wall: { ...u.wall, h: 23, mi: 59, s: 59 } }) : toMs(u);
  }
  const t0 = start.wall;
  const msOf = (w) => toMs({ ...start, wall: w });
  const out = [];
  let n = 0;
  const push = (w) => {
    if (n >= count) return false;
    const ms = msOf(w);
    if (ms > untilMs || ms > endMs) return false;
    n++;
    out.push(w);
    return out.length < cap;
  };
  const byday = (rule.BYDAY || "").split(",").filter(Boolean);

  if (freq === "DAILY") {
    for (let i = 0; ; i += interval) if (!push(addDays(t0, i))) break;
  } else if (freq === "WEEKLY") {
    const days = byday.length ? byday.map((d) => DOW.indexOf(d.slice(-2))).filter((d) => d >= 0) : [weekday(t0)];
    const wkst = DOW.indexOf(rule.WKST || "MO");
    const back = (weekday(t0) - wkst + 7) % 7;
    const week0 = addDays(t0, -back);
    const order = days.map((d) => (d - wkst + 7) % 7).sort((a, b) => a - b);
    outer: for (let k = 0; k < 2000; k += interval) {
      for (const off of order) {
        const w = addDays(week0, k * 7 + off);
        if (wallMs(w) < wallMs(t0)) continue;
        if (!push(w)) break outer;
      }
    }
  } else if (freq === "MONTHLY" || freq === "YEARLY") {
    const step = freq === "MONTHLY" ? interval : interval * 12;
    const monthdays = (rule.BYMONTHDAY || "").split(",").filter(Boolean).map(Number);
    outer: for (let k = 0; k < 600; k += step) {
      const mm = t0.m - 1 + k;
      const y = t0.y + Math.floor(mm / 12), m = (mm % 12) + 1;
      if (freq === "YEARLY" && m !== t0.m) continue;
      const dim = daysInMonth(y, m);
      let dates = [];
      if (byday.length) {
        for (const b of byday) {
          const wd = DOW.indexOf(b.slice(-2));
          const nth = parseInt(b.slice(0, -2) || "0", 10);
          const all = [];
          for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === wd) all.push(d);
          if (!nth) dates.push(...all);
          else { const d = nth > 0 ? all[nth - 1] : all[all.length + nth]; if (d) dates.push(d); }
        }
      } else if (monthdays.length) {
        dates = monthdays.map((d) => (d < 0 ? dim + 1 + d : d)).filter((d) => d >= 1 && d <= dim);
      } else if (t0.d <= dim) {
        dates = [t0.d];
      }
      for (const d of [...new Set(dates)].sort((a, b) => a - b)) {
        const w = { ...t0, y, m, d };
        if (wallMs(w) < wallMs(t0)) continue;
        if (!push(w)) break outer;
      }
    }
  } else {
    push(t0);
  }
  return out;
}

/* All events between fromDate and toDate ("YYYY-MM-DD", Pacific), each as
   { date, time, summary }; all-day events have time "". */
export function listEvents(ics, fromDate, toDate) {
  const lines = unfold(ics);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { exdates: [] }; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (!cur || !line) continue;
    const { name, params, value } = parseLine(line);
    if (name === "UID") cur.uid = value;
    else if (name === "SUMMARY") cur.summary = unescape(value);
    else if (name === "STATUS") cur.status = value.toUpperCase();
    else if (name === "DTSTART") cur.start = parseTime(value, params);
    else if (name === "RRULE") cur.rule = parseRule(value);
    else if (name === "RECURRENCE-ID") cur.recur = parseTime(value, params);
    else if (name === "EXDATE") for (const v of value.split(",")) { const t = parseTime(v, params); if (t) cur.exdates.push(t); }
  }

  const endMs = zoneToMs({ ...parseIso(toDate), h: 23, mi: 59, s: 59 }, HOME_TZ);
  // Single occurrences that were moved or cancelled replace their slot in the series.
  const replaced = new Set();
  for (const e of events) if (e.recur && e.uid) replaced.add(`${e.uid}|${wallKey(toHome(e.recur))}`);

  const out = [];
  const add = (e, home) => {
    const date = wallDate(home);
    if (date < fromDate || date > toDate) return;
    out.push({ date, time: home.allDay ? "" : `${pad(home.h)}:${pad(home.mi)}`, summary: e.summary || "" });
  };
  for (const e of events) {
    if (!e.start || e.status === "CANCELLED") continue;
    if (e.recur || !e.rule) { add(e, toHome(e.start)); continue; }
    // EXDATE is usually a full time; a bare date drops every start on that date.
    const skip = new Set(e.exdates.filter((t) => t.kind !== "date").map((t) => wallKey(toHome(t))));
    const skipDay = new Set(e.exdates.filter((t) => t.kind === "date").map((t) => wallDate(t.wall)));
    for (const w of expand(e.start, e.rule, endMs)) {
      const home = toHome({ ...e.start, wall: w });
      const key = wallKey(home);
      if (skip.has(key) || skipDay.has(wallDate(w)) || replaced.has(`${e.uid}|${key}`)) continue;
      add(e, home);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}

function parseIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

/* Work shifts: timed events whose title says "shift" (CVICU Shift, OT Shift,
   [SWAP] CVICU Shift), not all-day reminders like "Request shift". */
export function listShifts(ics, fromDate, toDate) {
  const seen = new Set();
  return listEvents(ics, fromDate, toDate).filter((e) => {
    if (!e.time || !/shift/i.test(e.summary) || /request/i.test(e.summary)) return false;
    const k = `${e.date}|${e.time}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
