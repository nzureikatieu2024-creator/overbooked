# Overbooked

Overbooked automatically plans your studying around your life — and replans when you fall behind.

Next.js (App Router, TypeScript) + Supabase Auth + Postgres with Row Level Security.

## Setup

1. `npm install`
2. Create `.env.local` with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
3. In Supabase → SQL Editor, run `supabase/schema.sql`. Re-run it after updates: it is safe to re-run and only adds what is missing (e.g. `busy_events.external_uid` for calendar import).
4. In Supabase → Authentication → Sign In / Providers → Email, turn **Confirm email** off.
5. `npm run dev` and open http://localhost:3000

## Scripts

- `npm run dev` — local development
- `npm run build` — production build and type check
- `npm test` — scheduler, estimate and .ics parser unit tests

## How planning works

`lib/scheduler.ts` is a deterministic earliest-deadline-first planner:

- Free time = weekly availability − busy events − kept (completed/missed) sessions, from now until each deadline (end of the deadline day; 14 days for tasks without one).
- Each task fills the earliest free time in sessions of at most the chosen length, with a break after each, never shorter than 25 minutes unless less work is left.
- Work that does not fit is reported, never silently dropped.
- Replan keeps completed sessions, counts past unmarked sessions as missed, and rebuilds all upcoming planned sessions.
- Time factor = actual ÷ planned minutes over completed sessions (from 2 sessions, clamped 0.5–2). Remaining work = estimate × factor − time already logged.

Times use the time zone of the browser that runs Auto-Plan.

## Calendar import (.ics)

`lib/ics.ts` parses Google Calendar / Outlook `.ics` exports in the browser, with no external API. It reads the next 30 days: UTC, TZID (IANA and common Windows zone names) and floating times, all-day events, DURATION, RRULE (DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH), RDATE, EXDATE, moved or cancelled occurrences (RECURRENCE-ID) and TRANSP. Unsupported rule parts (e.g. BYSETPOS, HOURLY) and unknown time zones are shown as warnings, never guessed.

Confirmed events are saved as `busy_events` with `external_uid` = event UID + original start. A unique index on `(user_id, external_uid)` makes re-imports skip duplicates. This is a one-time copy, not a live sync.

## Estimate suggestion

Per-difficulty factor = actual ÷ planned minutes over completed sessions of tasks with that difficulty (from 2 sessions, clamped 0.5–2). Because plans already multiply estimates by the overall factor, the suggestion is `estimate × difficulty factor ÷ overall factor`. It is only applied when the user clicks it.

