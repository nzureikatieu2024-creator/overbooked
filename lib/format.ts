export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DIFFICULTY = { 1: "Easy", 2: "Medium", 3: "Hard" } as Record<number, string>;

export function formatMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

export function formatClock(ms: number | Date): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatDay(ms: number | Date): string {
  return new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

/** "2025-01-06" → "Mon 6 Jan" without time zone shifts */
export function formatDeadline(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return formatDay(new Date(y, m - 1, d));
}

export function trimClock(value: string): string {
  return value.slice(0, 5);
}

export function localDateTime(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, mi);
}

export function startOfWeek(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const diff = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - diff);
  return d;
}

export function sameDay(a: number, b: Date): boolean {
  const x = new Date(a);
  return x.getFullYear() === b.getFullYear() && x.getMonth() === b.getMonth() && x.getDate() === b.getDate();
}

export function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** True for events that cover whole local days (midnight to midnight), e.g. imported all-day events. */
export function isAllDay(start: number, end: number): boolean {
  const s = new Date(start);
  const e = new Date(end);
  return s.getHours() === 0 && s.getMinutes() === 0 && e.getHours() === 0 && e.getMinutes() === 0 && end - start >= 23 * 3600_000;
}
