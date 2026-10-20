import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIcs } from "../lib/ics.ts";

const HOUR = 3_600_000;
// Window: 1 March 2025 00:00 UTC + 30 days (covers the EU DST switch on 30 March)
const from = Date.UTC(2025, 2, 1);
const to = from + 30 * 24 * HOUR;

function cal(...events: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Uni", ...events, "END:VCALENDAR"].join("\r\n");
}

function event(lines: string[]): string {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

test("rejects files that are not calendars", () => {
  assert.throws(() => parseIcs("hello", from, to));
});

test("reads UTC times, titles with escapes and folded lines", () => {
  const r = parseIcs(
    cal(event(["UID:a", "SUMMARY:Stats\\, lecture \\; room", " 4", "DTSTART:20250303T090000Z", "DTEND:20250303T103000Z"])),
    from,
    to,
  );
  assert.equal(r.calendarName, "Uni");
  assert.equal(r.occurrences.length, 1);
  const o = r.occurrences[0];
  assert.equal(o.title, "Stats, lecture ; room4");
  assert.equal(o.start, Date.UTC(2025, 2, 3, 9));
  assert.equal(o.end, Date.UTC(2025, 2, 3, 10, 30));
  assert.equal(o.recurring, false);
});

test("converts TZID times, including Windows zone names, across DST", () => {
  const r = parseIcs(
    cal(
      event(["UID:m", "SUMMARY:Madrid", "DTSTART;TZID=Europe/Madrid:20250310T100000", "DTEND;TZID=Europe/Madrid:20250310T110000"]),
      // After the 30 March switch Madrid is UTC+2
      event(["UID:m2", "SUMMARY:Madrid summer", "DTSTART;TZID=Europe/Madrid:20250330T100000", "DURATION:PT1H"]),
      event(["UID:w", "SUMMARY:Outlook", 'DTSTART;TZID="Romance Standard Time":20250311T100000', "DTEND;TZID=\"Romance Standard Time\":20250311T120000"]),
    ),
    from,
    to,
  );
  const byTitle = Object.fromEntries(r.occurrences.map((o) => [o.title, o]));
  assert.equal(byTitle["Madrid"].start, Date.UTC(2025, 2, 10, 9));
  assert.equal(byTitle["Madrid summer"].start, Date.UTC(2025, 2, 30, 8));
  assert.equal(byTitle["Madrid summer"].end, Date.UTC(2025, 2, 30, 9));
  assert.equal(byTitle["Outlook"].start, Date.UTC(2025, 2, 11, 9));
  assert.equal(r.warnings.length, 0);
});

test("flags unknown time zones instead of guessing silently", () => {
  const r = parseIcs(cal(event(["UID:x", "DTSTART;TZID=Mars/Olympus:20250303T100000", "DTEND;TZID=Mars/Olympus:20250303T110000"])), from, to);
  assert.equal(r.occurrences.length, 1);
  assert.equal(r.occurrences[0].title, "Busy");
  assert.match(r.warnings[0], /Mars\/Olympus/);
});

test("all-day events span whole local days", () => {
  const r = parseIcs(cal(event(["UID:d", "SUMMARY:Trip", "DTSTART;VALUE=DATE:20250305", "DTEND;VALUE=DATE:20250307"])), from, to);
  const o = r.occurrences[0];
  assert.equal(o.allDay, true);
  assert.equal(o.start, new Date(2025, 2, 5).getTime());
  assert.equal(o.end, new Date(2025, 2, 7).getTime());
});

test("expands weekly recurrence with BYDAY, COUNT and EXDATE, keeping wall-clock time over DST", () => {
  const r = parseIcs(
    cal(
      event([
        "UID:class",
        "SUMMARY:Marketing",
        "DTSTART;TZID=Europe/Madrid:20250303T090000",
        "DTEND;TZID=Europe/Madrid:20250303T103000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=7",
        "EXDATE;TZID=Europe/Madrid:20250305T090000",
      ]),
    ),
    from,
    to,
  );
  // Mar 3, (5 excluded), 10, 12, 17, 19, 24 → COUNT=7 includes the excluded one
  const starts = r.occurrences.map((o) => o.start);
  assert.deepEqual(starts, [3, 10, 12, 17, 19, 24].map((d) => Date.UTC(2025, 2, d, 8)));
  assert.ok(r.occurrences.every((o) => o.recurring && o.end - o.start === 1.5 * HOUR));

  const after = parseIcs(
    cal(event(["UID:c2", "DTSTART;TZID=Europe/Madrid:20250324T090000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;UNTIL=20250331T235959Z"])),
    from,
    to,
  );
  // 31 March is after the switch: 09:00 Madrid = 07:00 UTC
  assert.deepEqual(after.occurrences.map((o) => o.start), [Date.UTC(2025, 2, 24, 8), Date.UTC(2025, 2, 31, 7)].filter((t) => t < to));
});

test("series that started long ago still appear in the window", () => {
  const r = parseIcs(cal(event(["UID:old", "DTSTART:20200106T120000Z", "DTEND:20200106T130000Z", "RRULE:FREQ=WEEKLY"])), from, to);
  // Mondays in the window: 3, 10, 17, 24, 31 (31 March 12:00 is inside the 30-day window)
  assert.deepEqual(
    r.occurrences.map((o) => new Date(o.start).getUTCDate()),
    [3, 10, 17, 24, 31].filter((d) => Date.UTC(2025, 2, d, 12) < to),
  );
});

test("monthly BYDAY ordinals and BYMONTHDAY", () => {
  const r = parseIcs(
    cal(
      event(["UID:mo", "SUMMARY:Last Friday", "DTSTART:20250131T150000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYDAY=-1FR"]),
      event(["UID:md", "SUMMARY:Fifteenth", "DTSTART:20250115T150000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYMONTHDAY=15"]),
    ),
    from,
    to,
  );
  const byTitle = Object.fromEntries(r.occurrences.map((o) => [o.title, o.start]));
  assert.equal(byTitle["Last Friday"], Date.UTC(2025, 2, 28, 15));
  assert.equal(byTitle["Fifteenth"], Date.UTC(2025, 2, 15, 15));
});

test("daily interval and yearly rules", () => {
  const r = parseIcs(
    cal(
      event(["UID:dd", "SUMMARY:Gym", "DTSTART:20250301T070000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;INTERVAL=10"]),
      event(["UID:yy", "SUMMARY:Birthday", "DTSTART:20230320T180000Z", "DURATION:PT2H", "RRULE:FREQ=YEARLY"]),
    ),
    from,
    to,
  );
  assert.deepEqual(
    r.occurrences.filter((o) => o.title === "Gym").map((o) => new Date(o.start).getUTCDate()),
    [1, 11, 21],
  );
  assert.deepEqual(r.occurrences.filter((o) => o.title === "Birthday").map((o) => o.start), [Date.UTC(2025, 2, 20, 18)]);
});

test("moved and cancelled occurrences replace the original", () => {
  const r = parseIcs(
    cal(
      event(["UID:s", "SUMMARY:Seminar", "DTSTART:20250303T100000Z", "DTEND:20250303T110000Z", "RRULE:FREQ=WEEKLY;COUNT=3"]),
      event(["UID:s", "SUMMARY:Seminar (moved)", "RECURRENCE-ID:20250310T100000Z", "DTSTART:20250311T140000Z", "DTEND:20250311T150000Z"]),
      event(["UID:s", "RECURRENCE-ID:20250317T100000Z", "DTSTART:20250317T100000Z", "DTEND:20250317T110000Z", "STATUS:CANCELLED"]),
    ),
    from,
    to,
  );
  assert.deepEqual(
    r.occurrences.map((o) => [o.title, o.start]),
    [
      ["Seminar", Date.UTC(2025, 2, 3, 10)],
      ["Seminar (moved)", Date.UTC(2025, 2, 11, 14)],
    ],
  );
  // The moved occurrence keeps the key of the slot it replaced, so re-imports are detected as duplicates
  assert.equal(r.occurrences[1].key, `s|${Date.UTC(2025, 2, 10, 10)}`);
});

test("skips cancelled and zero-length events, marks free events, ignores alarms", () => {
  const r = parseIcs(
    cal(
      event(["UID:c", "DTSTART:20250303T100000Z", "DTEND:20250303T110000Z", "STATUS:CANCELLED"]),
      event(["UID:z", "DTSTART:20250303T100000Z"]),
      event([
        "UID:f",
        "SUMMARY:Focus",
        "DTSTART:20250304T100000Z",
        "DTEND:20250304T110000Z",
        "TRANSP:TRANSPARENT",
        "BEGIN:VALARM",
        "SUMMARY:Alarm",
        "DTSTART:20250101T000000Z",
        "END:VALARM",
      ]),
    ),
    from,
    to,
  );
  assert.equal(r.skipped, 2);
  assert.equal(r.occurrences.length, 1);
  assert.equal(r.occurrences[0].title, "Focus");
  assert.equal(r.occurrences[0].free, true);
});

test("unsupported rules fall back to the first occurrence with a warning", () => {
  const r = parseIcs(cal(event(["UID:h", "DTSTART:20250303T100000Z", "DURATION:PT30M", "RRULE:FREQ=HOURLY;COUNT=5"])), from, to);
  assert.equal(r.occurrences.length, 1);
  assert.match(r.occurrences[0].warning ?? "", /not supported/);
});

test("events outside the window are left out", () => {
  const r = parseIcs(
    cal(
      event(["UID:p", "DTSTART:20250201T100000Z", "DTEND:20250201T110000Z"]),
      event(["UID:f", "DTSTART:20250501T100000Z", "DTEND:20250501T110000Z"]),
    ),
    from,
    to,
  );
  assert.equal(r.eventCount, 2);
  assert.equal(r.occurrences.length, 0);
});

// ── Regression: all-day informational events must not block study time by default ──

import { importDefaults } from "../lib/ics.ts";

test("all-day events are imported as non-blocking by default; timed events block", () => {
  assert.deepEqual(importDefaults({ allDay: true, free: false }, false, true), { selected: true, blocking: false });
  assert.deepEqual(importDefaults({ allDay: false, free: false }, false, true), { selected: true, blocking: true });
  // "Show as free" and duplicates start unselected
  assert.deepEqual(importDefaults({ allDay: false, free: true }, false, true), { selected: false, blocking: false });
  assert.equal(importDefaults({ allDay: false, free: false }, true, true).selected, false);
  // Before the database can store non-blocking events, all-day events are not pre-selected at all
  assert.deepEqual(importDefaults({ allDay: true, free: false }, false, false), { selected: false, blocking: false });
});

test("recurring all-day events keep their dates when imported", () => {
  const r = parseIcs(
    cal(event(["UID:wk", "SUMMARY:Week 6 (async module)", "DTSTART;VALUE=DATE:20250303", "DTEND;VALUE=DATE:20250304", "RRULE:FREQ=WEEKLY;COUNT=3"])),
    from,
    to,
  );
  assert.deepEqual(r.occurrences.map((o) => o.start), [3, 10, 17].map((d) => new Date(2025, 2, d).getTime()));
  assert.ok(r.occurrences.every((o) => o.allDay && importDefaults(o, false, true).blocking === false));
});
