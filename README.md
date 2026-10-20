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


## Password recovery

`/login` → "Forgot password?" → `/forgot-password` calls `resetPasswordForEmail` with `redirectTo = <current site>/reset-password` (PKCE flow, the default for `@supabase/ssr`). The default Supabase "Reset Password" email template (`{{ .ConfirmationURL }}`) works as is: Supabase verifies the token and redirects to `/reset-password?code=…`.

`/reset-password` (`lib/recovery-flow.ts`) exchanges that code exactly once per page load (React Strict Mode mounts twice in development), keeps it in the URL until verification has finished, and also accepts `?token_hash=…&type=recovery` and `#access_token=…&type=recovery` links. Only after a recovery session exists can the user set a new password (`updateUser`); other devices are then signed out.

Supabase dashboard → Authentication → URL Configuration:

- **Site URL:** `https://overbooked-black.vercel.app`
- **Redirect URLs:** `https://overbooked-black.vercel.app/**` and `http://localhost:3000/**`

PKCE links must be opened in the browser that requested them. For links that work on any device, change the Reset Password template link to `{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&type=recovery` (note: this always uses the Site URL, i.e. production).

## Database migrations

Run each file in `supabase/migrations/` once in the SQL Editor (all are additive and safe to re-run). `002_planner_preferences.sql` adds: minimum session length and transition buffer settings, non-blocking ("info only") busy events, and archived tasks. Until it is run, the app keeps working with the defaults (30-minute minimum, 15-minute buffer) and those controls are disabled.

## Scheduling rules

- Sessions are between the shortest (default 30 min) and longest (default 50 min) length. A final session may be shorter, but at least 15 minutes, and is labelled "short". A leftover under 15 minutes is folded into the previous session when there is room, otherwise reported as too short to schedule; it is never counted as scheduled.
- After every blocking busy event, a transition buffer (default 15 min) stays free. Study sessions stay inside the preferred study hours.
- All-day imported events are "info only" by default and never block study time unless marked "Blocks study".

## What-if simulator and deadline risk

`lib/plan-input.ts` builds the exact input Replan uses. `lib/whatif.ts` applies scenario changes (lost study time on a date, extra hours for a task) to a copy and runs the real `planSchedule` on both, so previews never touch saved data. Nothing is written unless the user clicks "Apply to my plan" and confirms. `lib/risk.ts` compares each task's remaining work with free study time and earlier deadlines before its deadline.
