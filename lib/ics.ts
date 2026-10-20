// .ics (iCalendar, RFC 5545) parser for one-off calendar imports.
// Runs entirely in the browser: the file is never uploaded, only the events
// the user confirms are saved. Pure and self-contained so it can be unit tested.
//
// Supported: folded lines, UTC / TZID / floating times, all-day events,
// DURATION, RRULE (DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL, COUNT, UNTIL,
// BYDAY, BYMONTHDAY, BYMONTH), RDATE, EXDATE, RECURRENCE-ID overrides,
// STATUS:CANCELLED and TRANSP:TRANSPARENT.
// Anything else in a rule is reported as a warning instead of being guessed.

export type IcsOccurrence = {
  key: string; // UID + original start, stable across re-imports
  title: string;
  start: number; // epoch ms
  end: number;
  allDay: boolean;
  free: boolean; // TRANSP:TRANSPARENT, e.g. "show as free" in Outlook
  recurring: boolean;
  warning: string | null;
};

export type IcsResult = {
  occurrences: IcsOccurrence[];
  calendarName: string | null;
  eventCount: number; // VEVENTs found in the file
  skipped: number; // cancelled or zero-length events
  warnings: string[];
};

type Wall = { y: number; m: number; d: number; h: number; mi: number; s: number }; // m is 1–12
type Stamp = { wall: Wall; tz: string | null; utc: boolean; allDay: boolean };
type Prop = { name: string; params: Record<string, string>; value: string };

type RawEvent = {
  uid: string;
  title: string;
  start: Stamp;
  end: Stamp | null;
  durationMs: number | null;
  rrule: string | null;
  rdates: Stamp[];
  exdates: Stamp[];
  recurrenceId: Stamp | null;
  cancelled: boolean;
  free: boolean;
  warnings: string[];
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_ITERATIONS = 20_000;
const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const SUPPORTED_RULE_PARTS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST"]);

// Outlook / Exchange exports often use Windows time zone names
const WINDOWS_ZONES: Record<string, string> = {
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow",
  "Turkey Standard Time": "Europe/Istanbul",
  "Israel Standard Time": "Asia/Jerusalem",
  "Jordan Standard Time": "Asia/Amman",
  "Egypt Standard Time": "Africa/Cairo",
  "Arab Standard Time": "Asia/Riyadh",
  "Arabian Standard Time": "Asia/Dubai",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Singapore Standard Time": "Asia/Singapore",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "SA Pacific Standard Time": "America/Bogota",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Buenos_Aires",
};

// ── Low-level parsing ────────────────────────────

function unfold(text: string): string[] {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

function parseProp(line: string): Prop | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [rawName, ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: rawName.toUpperCase(), params, value: line.slice(colon + 1) };
}

function splitOutsideQuotes(value: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const c of value) {
    if (c === '"') inQuotes = !inQuotes;
    if (c === sep && !inQuotes) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? " " : c)).trim();
}

function parseStamp(value: string, params: Record<string, string>): Stamp | null {
  const v = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date || params.VALUE === "DATE") {
    const m = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { wall: { y: +m[1], m: +m[2], d: +m[3], h: 0, mi: 0, s: 0 }, tz: null, utc: false, allDay: true };
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/.exec(v);
  if (!dt) return null;
  const wall = { y: +dt[1], m: +dt[2], d: +dt[3], h: +dt[4], mi: +dt[5], s: dt[6] ? +dt[6] : 0 };
  if (dt[7] === "Z") return { wall, tz: null, utc: true, allDay: false };
  return { wall, tz: params.TZID ?? null, utc: false, allDay: false };
}

function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 * 3600 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

// ── Time zones ───────────────────────────────────

const zoneCache = new Map<string, string | null>();

/** Map a TZID to an IANA zone the browser understands, or null if unknown. */
export function resolveZone(tzid: string): string | null {
  if (zoneCache.has(tzid)) return zoneCache.get(tzid)!;
  const cleaned = tzid.replace(/^\/[^/]+\/[^/]+\//, "").replace(/^"|"$/g, "").trim(); // e.g. /mozilla.org/20050126_1/Europe/Madrid
  const candidates = [WINDOWS_ZONES[cleaned], cleaned].filter(Boolean) as string[];
  let found: string | null = null;
  for (const c of candidates) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: c });
      found = c;
      break;
    } catch {
      // not a valid IANA name
    }
  }
  zoneCache.set(tzid, found);
  return found;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneOffset(ms: number, zone: string): number {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time in an IANA zone → epoch ms (handles DST). */
function zonedToUtc(w: Wall, zone: string): number {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  let ms = guess - zoneOffset(guess, zone);
  const second = guess - zoneOffset(ms, zone);
  if (second !== ms) ms = second;
  return ms;
}

/** Converts a stamp to epoch ms. All-day and floating times use the device's local time. */
function toMs(stamp: Stamp, wall: Wall = stamp.wall): { ms: number; unknownZone: string | null } {
  if (stamp.utc) return { ms: Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s), unknownZone: null };
  if (stamp.tz && !stamp.allDay) {
    const zone = resolveZone(stamp.tz);
    if (zone) return { ms: zonedToUtc(wall, zone), unknownZone: null };
    return { ms: new Date(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s).getTime(), unknownZone: stamp.tz };
  }
  return { ms: new Date(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s).getTime(), unknownZone: null };
}

// ── Date arithmetic on wall-clock dates (UTC math, so no DST surprises) ──

function dayNumber(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

function fromDayNumber(n: number): { y: number; m: number; d: number } {
  const dt = new Date(n * DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function weekdayOf(n: number): number {
  return new Date(n * DAY).getUTCDay();
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

type ByDay = { weekday: number; ordinal: number | null };

function parseByDay(value: string): ByDay[] | null {
  const out: ByDay[] = [];
  for (const part of value.split(",")) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(part.trim().toUpperCase());
    if (!m) return null;
    out.push({ weekday: WEEKDAY_CODES.indexOf(m[2]), ordinal: m[1] ? Number(m[1]) : null });
  }
  return out;
}

/** Days in a month matching BYDAY entries like MO, 2TU or -1FR. */
function monthDaysForByDay(y: number, m: number, byDay: ByDay[]): number[] {
  const total = daysInMonth(y, m);
  const first = dayNumber(y, m, 1);
  const days = new Set<number>();
  for (const b of byDay) {
    const matches: number[] = [];
    for (let d = 1; d <= total; d++) if (weekdayOf(first + d - 1) === b.weekday) matches.push(d);
    if (b.ordinal === null) matches.forEach((d) => days.add(d));
    else {
      const pick = b.ordinal > 0 ? matches[b.ordinal - 1] : matches[matches.length + b.ordinal];
      if (pick) days.add(pick);
    }
  }
  return [...days].sort((a, b) => a - b);
}

function monthDaysForByMonthDay(y: number, m: number, list: number[]): number[] {
  const total = daysInMonth(y, m);
  return [...new Set(list.map((d) => (d < 0 ? total + d + 1 : d)).filter((d) => d >= 1 && d <= total))].sort(
    (a, b) => a - b,
  );
}

/**
 * Expands an RRULE into day numbers of occurrence starts (wall-clock dates).
 * Iterates from DTSTART so COUNT is honoured, and stops after `untilDay`.
 */
function expandRule(
  rule: string,
  start: Stamp,
  untilDay: number,
  startMsOf: (day: number) => number,
): { days: number[]; warning: string | null } {
  const parts: Record<string, string> = {};
  for (const p of rule.split(";")) {
    const eq = p.indexOf("=");
    if (eq > 0) parts[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  const unsupported = Object.keys(parts).filter((k) => !SUPPORTED_RULE_PARTS.has(k));
  const freq = parts.FREQ;
  if (unsupported.length || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) {
    return {
      days: [],
      warning: `Repeat rule not supported (${unsupported.join(", ") || freq || "no FREQ"}); only the first occurrence is shown.`,
    };
  }

  const interval = Math.max(1, Number(parts.INTERVAL) || 1);
  const count = parts.COUNT ? Math.max(0, Number(parts.COUNT)) : Infinity;
  let untilMs = Infinity;
  if (parts.UNTIL) {
    const u = parseStamp(parts.UNTIL, {});
    if (u) {
      untilMs = u.allDay
        ? new Date(u.wall.y, u.wall.m - 1, u.wall.d + 1).getTime() - 1 // inclusive of the whole day
        : u.utc
          ? Date.UTC(u.wall.y, u.wall.m - 1, u.wall.d, u.wall.h, u.wall.mi, u.wall.s)
          : toMs({ ...start, wall: u.wall }).ms;
    }
  }
  const byDay = parts.BYDAY ? parseByDay(parts.BYDAY) : null;
  if ((parts.BYDAY && !byDay) || (freq === "YEARLY" && byDay && !parts.BYMONTH)) {
    return { days: [], warning: "Repeat days could not be read; only the first occurrence is shown." };
  }
  const byMonthDay = parts.BYMONTHDAY ? parts.BYMONTHDAY.split(",").map(Number).filter((n) => n !== 0 && !isNaN(n)) : null;
  const byMonth = parts.BYMONTH ? parts.BYMONTH.split(",").map(Number).filter((n) => n >= 1 && n <= 12) : null;
  const wkst = parts.WKST ? Math.max(0, WEEKDAY_CODES.indexOf(parts.WKST.toUpperCase())) : 1;

  const s = start.wall;
  const startDay = dayNumber(s.y, s.m, s.d);
  const days: number[] = [];
  let produced = 0;
  let iterations = 0;

  // Returns false once the rule is exhausted.
  const consider = (day: number): boolean => {
    if (day < startDay) return true;
    if (day > untilDay) return false;
    if (byMonth && !byMonth.includes(fromDayNumber(day).m)) return true;
    if (startMsOf(day) > untilMs) return false;
    if (produced >= count) return false;
    produced++;
    days.push(day);
    return true;
  };

  if (freq === "DAILY") {
    const weekdays = byDay?.map((b) => b.weekday);
    for (let day = startDay; iterations++ < MAX_ITERATIONS; day += interval) {
      if (weekdays && !weekdays.includes(weekdayOf(day))) {
        if (day > untilDay) break;
        continue;
      }
      if (!consider(day)) break;
    }
  } else if (freq === "WEEKLY") {
    const weekdays = (byDay?.map((b) => b.weekday) ?? [weekdayOf(startDay)]).sort(
      (a, b) => ((a - wkst + 7) % 7) - ((b - wkst + 7) % 7),
    );
    const weekStart = startDay - ((weekdayOf(startDay) - wkst + 7) % 7);
    outer: for (let w = weekStart; iterations++ < MAX_ITERATIONS; w += 7 * interval) {
      for (const wd of weekdays) {
        if (!consider(w + ((wd - wkst + 7) % 7))) break outer;
      }
    }
  } else {
    // MONTHLY or YEARLY: walk month by month, only months that are in step with the interval
    const monthsList = freq === "YEARLY" ? (byMonth ?? [s.m]) : null;
    let y = s.y;
    let m = s.m;
    let index = 0; // months since DTSTART
    outer: for (; iterations++ < MAX_ITERATIONS; index++) {
      const inStep =
        freq === "MONTHLY" ? index % interval === 0 : (y - s.y) % interval === 0 && monthsList!.includes(m);
      if (inStep) {
        let monthDays: number[];
        if (byDay) monthDays = monthDaysForByDay(y, m, byDay);
        else if (byMonthDay) monthDays = monthDaysForByMonthDay(y, m, byMonthDay);
        else monthDays = s.d <= daysInMonth(y, m) ? [s.d] : []; // RFC 5545: skip months without that day
        if (byDay && byMonthDay) {
          const allowed = new Set(monthDaysForByMonthDay(y, m, byMonthDay));
          monthDays = monthDays.filter((d) => allowed.has(d));
        }
        for (const d of monthDays) if (!consider(dayNumber(y, m, d))) break outer;
      }
      if (dayNumber(y, m, 1) > untilDay) break;
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
  }

  return { days, warning: null };
}

// ── Public API ───────────────────────────────────

/**
 * Parses an .ics file and returns event occurrences overlapping [from, to).
 * Never throws on malformed events: they are skipped and counted in warnings.
 */
export function parseIcs(text: string, from: number, to: number): IcsResult {
  const lines = unfold(text);
  if (!lines.some((l) => l.toUpperCase().startsWith("BEGIN:VCALENDAR"))) {
    throw new Error("This doesn't look like a calendar file (.ics). Export your calendar again and pick the .ics file.");
  }

  const events: RawEvent[] = [];
  const warnings: string[] = [];
  let calendarName: string | null = null;
  let current: Partial<RawEvent> | null = null;
  let depth = 0; // nested components inside VEVENT, e.g. VALARM
  let malformed = 0;

  for (const line of lines) {
    const prop = parseProp(line);
    if (!prop) continue;
    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VEVENT") {
      current = { title: "", rdates: [], exdates: [], warnings: [], cancelled: false, free: false, rrule: null };
      depth = 0;
      continue;
    }
    if (prop.name === "X-WR-CALNAME" && !current) calendarName = unescapeText(prop.value);
    if (!current) continue;
    if (prop.name === "BEGIN") {
      depth++;
      continue;
    }
    if (prop.name === "END") {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (prop.value.toUpperCase() === "VEVENT") {
        if (current.start) events.push({ uid: "", end: null, durationMs: null, recurrenceId: null, ...current } as RawEvent);
        else malformed++;
        current = null;
      }
      continue;
    }
    if (depth > 0) continue;

    switch (prop.name) {
      case "UID":
        current.uid = prop.value.trim();
        break;
      case "SUMMARY":
        current.title = unescapeText(prop.value);
        break;
      case "DTSTART":
        current.start = parseStamp(prop.value, prop.params) ?? undefined;
        break;
      case "DTEND":
        current.end = parseStamp(prop.value, prop.params);
        break;
      case "DURATION":
        current.durationMs = parseDuration(prop.value);
        break;
      case "RRULE":
        current.rrule = prop.value.trim();
        break;
      case "RDATE":
      case "EXDATE":
        if (prop.params.VALUE === "PERIOD") break;
        for (const v of prop.value.split(",")) {
          const st = parseStamp(v, prop.params);
          if (st) (prop.name === "RDATE" ? current.rdates! : current.exdates!).push(st);
        }
        break;
      case "RECURRENCE-ID":
        current.recurrenceId = parseStamp(prop.value, prop.params);
        break;
      case "STATUS":
        current.cancelled = prop.value.trim().toUpperCase() === "CANCELLED";
        break;
      case "TRANSP":
        current.free = prop.value.trim().toUpperCase() === "TRANSPARENT";
        break;
    }
  }

  if (malformed) warnings.push(`${malformed} event${malformed === 1 ? "" : "s"} without a start time ${malformed === 1 ? "was" : "were"} skipped.`);

  // Overrides (RECURRENCE-ID) replace single occurrences of a recurring series
  const overrides = new Map<string, RawEvent>();
  for (const e of events) if (e.recurrenceId && e.uid) overrides.set(`${e.uid}|${toMs(e.recurrenceId).ms}`, e);

  const out: IcsOccurrence[] = [];
  const unknownZones = new Set<string>();
  let skipped = 0;
  const untilDay = Math.ceil(to / DAY) + 2; // generous bound; exact filtering happens below
  const fromDay = Math.floor(from / DAY) - 400; // long events or all-day spans that started earlier

  const push = (e: RawEvent, startMs: number, endMs: number, originalMs: number, recurring: boolean, warning: string | null) => {
    if (endMs < from || startMs >= to) return;
    if (endMs <= startMs) {
      skipped++;
      return;
    }
    if (endMs === from) return;
    out.push({
      key: `${e.uid || `${e.title}|nouid`}|${originalMs}`,
      title: (e.title || "Busy").slice(0, 200),
      start: startMs,
      end: endMs,
      allDay: e.start.allDay,
      free: e.free,
      recurring,
      warning,
    });
  };

  for (const e of events) {
    if (e.cancelled) {
      if (!e.recurrenceId) skipped++;
      continue; // a cancelled override removes that occurrence; see below
    }
    const first = toMs(e.start);
    if (first.unknownZone) unknownZones.add(first.unknownZone);

    // Event length: DTEND − DTSTART, else DURATION, else one day (all-day) or zero
    let lengthMs: number;
    let allDayDays = 0;
    if (e.end && e.start.allDay) {
      allDayDays = Math.max(1, dayNumber(e.end.wall.y, e.end.wall.m, e.end.wall.d) - dayNumber(e.start.wall.y, e.start.wall.m, e.start.wall.d));
      lengthMs = 0;
    } else if (e.end) lengthMs = toMs(e.end).ms - first.ms;
    else if (e.durationMs !== null) {
      lengthMs = e.durationMs;
      if (e.start.allDay) allDayDays = Math.max(1, Math.round(e.durationMs / DAY));
    } else {
      lengthMs = 0;
      if (e.start.allDay) allDayDays = 1;
    }

    const occurrenceAt = (wall: Wall): { start: number; end: number } => {
      const start = toMs(e.start, wall).ms;
      if (e.start.allDay) {
        const end = new Date(wall.y, wall.m - 1, wall.d + allDayDays).getTime();
        return { start, end };
      }
      return { start, end: start + lengthMs };
    };

    if (e.recurrenceId) {
      const o = occurrenceAt(e.start.wall);
      push(e, o.start, o.end, toMs(e.recurrenceId).ms, true, null);
      continue;
    }

    if (!e.rrule && e.rdates.length === 0) {
      const o = occurrenceAt(e.start.wall);
      push(e, o.start, o.end, o.start, false, null);
      continue;
    }

    const s = e.start.wall;
    const wallOn = (day: number): Wall => ({ ...fromDayNumber(day), h: s.h, mi: s.mi, s: s.s });
    let warning: string | null = null;
    let days = [dayNumber(s.y, s.m, s.d)];
    if (e.rrule) {
      const r = expandRule(e.rrule, e.start, untilDay, (day) => toMs(e.start, wallOn(day)).ms);
      warning = r.warning;
      if (!r.warning) days = r.days;
    }

    const excluded = new Set(e.exdates.map((x) => (x.allDay ? `d${dayNumber(x.wall.y, x.wall.m, x.wall.d)}` : `t${toMs(x).ms}`)));
    const starts: { wall: Wall }[] = days.filter((d) => d >= fromDay).map((d) => ({ wall: wallOn(d) }));
    for (const r of e.rdates) starts.push({ wall: r.allDay ? { ...r.wall, h: s.h, mi: s.mi, s: s.s } : r.wall });

    const seen = new Set<number>();
    for (const { wall } of starts) {
      const o = occurrenceAt(wall);
      if (seen.has(o.start)) continue;
      seen.add(o.start);
      const dayKey = `d${dayNumber(wall.y, wall.m, wall.d)}`;
      if (excluded.has(`t${o.start}`) || excluded.has(dayKey)) continue;
      if (e.uid && overrides.has(`${e.uid}|${o.start}`)) continue; // replaced or cancelled by an override
      push(e, o.start, o.end, o.start, true, warning);
    }
  }

  if (unknownZones.size) {
    warnings.push(
      `Unrecognised time zone${unknownZones.size === 1 ? "" : "s"} (${[...unknownZones].join(", ")}): those times are shown in your device's time zone. Check them before importing.`,
    );
  }

  // The same event can appear twice (e.g. merged exports); keep the first copy
  const unique = [...new Map(out.reverse().map((o) => [o.key, o])).values()].reverse();
  unique.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
  return { occurrences: unique, calendarName, eventCount: events.length, skipped, warnings };
}

/**
 * Default choices in the import preview. All-day events (holidays, "week 5", deadlines,
 * asynchronous modules) are usually informational, so they are imported as non-blocking
 * unless the user ticks "Blocks study". Without non-blocking support they start unselected,
 * so nothing becomes unavailable by surprise.
 */
export function importDefaults(
  o: Pick<IcsOccurrence, "allDay" | "free">,
  duplicate: boolean,
  canSaveNonBlocking: boolean,
): { selected: boolean; blocking: boolean } {
  const blocking = !o.allDay && !o.free;
  if (duplicate || o.free) return { selected: false, blocking };
  if (o.allDay) return { selected: canSaveNonBlocking, blocking: false };
  return { selected: true, blocking };
}
