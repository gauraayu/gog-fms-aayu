/** IST date helpers. OMS stores dates as "YYYY-MM-DD" IST strings. */
export const TZ = process.env.TZ_NAME || "Asia/Kolkata";

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function todayIST(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function currentMonthIST(now: Date = new Date()): string {
  return todayIST(now).slice(0, 7);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  return `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
}

export function listMonthDates(month: string): string[] {
  const n = daysInMonth(month);
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD string (calendar date, no TZ shift). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function lastNMonths(endMonth: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addMonths(endMonth, i - (n - 1)));
}

/** Indian financial year label for a month, e.g. 2026-10 → "2026-27" */
export function financialYearOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function fyRange(fy: string): { start: string; end: string; months: string[] } {
  const startYear = Number(fy.slice(0, 4));
  const months = Array.from({ length: 12 }, (_, i) => addMonths(`${startYear}-04`, i));
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31`, months };
}

/** IST day boundaries as UTC Date objects for a date range (inclusive). */
export function istRangeToUTC(startDate: string, endDate: string): { from: Date; to: Date } {
  return {
    from: new Date(`${startDate}T00:00:00+05:30`),
    to: new Date(`${endDate}T23:59:59.999+05:30`),
  };
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}
