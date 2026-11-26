/**
 * Payroll → Google Sheet. One tab per month ("Nov 2026") with the same columns as the Payroll Excel /
 * Financial Reports → Monthly Salary Report, but ONLY employees whose payroll is Approved / Finalized / Disbursed.
 * The sheet is a copy: editing it never changes FMS or OMS. Every sync rewrites that month's tab.
 */
import { buildReport } from "./reports";
import { getSetting, setSetting } from "./settings";
import { parseSpreadsheetId, SheetsError, sheetsCredentials, sheetUrl, writeTab } from "./google-sheets";
import { monthLabel } from "./dates";
import { audit } from "./audit";
import type { SessionUser } from "./auth";

export const SHEET_STATUSES = ["Approved", "Finalized", "Disbursed"];

export interface GoogleSheetsConfig { enabled: boolean; spreadsheetId: string }
export interface SheetsSyncLog { at: string; month: string; ok: boolean; rows?: number; error?: string; by: string }
export interface SheetsSyncResult { ok: boolean; skipped?: boolean; month: string; tab?: string; rows?: number; url?: string; error?: string }

export const getSheetsConfig = async (): Promise<GoogleSheetsConfig> => {
  const c = await getSetting<Partial<GoogleSheetsConfig>>("googleSheets");
  return { enabled: !!c?.enabled, spreadsheetId: String(c?.spreadsheetId ?? "") };
};
export const getSheetsLog = async (): Promise<SheetsSyncLog[]> => (await getSetting<SheetsSyncLog[]>("googleSheetsLog")) ?? [];

export async function saveSheetsConfig(input: { link?: string; enabled?: boolean }, by: string): Promise<GoogleSheetsConfig> {
  const id = input.link ? parseSpreadsheetId(input.link) : "";
  if (input.link && !id) throw new SheetsError("That is not a Google Sheets link. Copy the link from the browser address bar (…/spreadsheets/d/…/edit).");
  const next = { enabled: !!input.enabled && !!id, spreadsheetId: id || "" };
  await setSetting("googleSheets", next, by);
  return next;
}

type Actor = Pick<SessionUser, "employeeId" | "name" | "role">;

export async function syncPayrollMonth(month: string, user: Actor, opts: { force?: boolean } = {}): Promise<SheetsSyncResult> {
  const cfg = await getSheetsConfig();
  if (!cfg.spreadsheetId || (!cfg.enabled && !opts.force)) return { ok: true, skipped: true, month };
  const tab = monthLabel(month);
  let result: SheetsSyncResult;
  try {
    if (!sheetsCredentials()) throw new SheetsError("Google service account is not set in .env.local (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY)");
    const r = await buildReport("monthly-salary", { month, statuses: SHEET_STATUSES, withStatus: true });
    const ist = new Date(Date.now() + 330 * 60000).toISOString().replace("T", " ").slice(0, 16);
    const { sheetId, rows } = await writeTab(cfg.spreadsheetId, tab, {
      title: `${r.title} — Approved / Finalized / Disbursed only · synced from GOG FMS ${ist} IST`,
      columns: r.columns,
      rows: r.rows.map((row) => r.columns.map((c) => {
        const v = row[c.key];
        if (c.money) return typeof v === "number" ? v / 100 : null;
        return v === undefined || v === null ? "" : (v as string | number);
      })),
    });
    result = { ok: true, month, tab, rows, url: sheetUrl(cfg.spreadsheetId, sheetId) };
  } catch (e) {
    result = { ok: false, month, tab, error: (e as Error).message };
  }
  const log = [{ at: new Date().toISOString(), month, ok: result.ok, rows: result.rows, error: result.error, by: user.employeeId }, ...(await getSheetsLog())].slice(0, 20);
  await setSetting("googleSheetsLog", log, user.employeeId);
  await audit(user, "google_sheets.sync", { entity: "payroll", entityId: month, updatedValue: { ok: result.ok, rows: result.rows, error: result.error } });
  return result;
}