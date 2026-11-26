import { NextResponse } from "next/server";
import { can, clientIp, handle, HttpError, readJson, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { sheetsCredentials, SheetsError, sheetUrl } from "@/lib/google-sheets";
import { getSheetsConfig, getSheetsLog, saveSheetsConfig, syncPayrollMonth } from "@/lib/sheets-sync";

/** Status for Settings / Payroll pages (no secrets: only the service-account e-mail, which must be shared on the sheet). */
export const GET = handle(async () => {
  const user = await requireUser("payroll.view");
  const cfg = await getSheetsConfig();
  return NextResponse.json({
    enabled: cfg.enabled,
    url: cfg.spreadsheetId ? sheetUrl(cfg.spreadsheetId) : "",
    serviceAccountEmail: sheetsCredentials()?.email ?? "",
    credentialsSet: !!sheetsCredentials(),
    log: can(user, "settings.manage") ? await getSheetsLog() : [],
  });
});

/** PUT { link, enabled, reason } — Settings → Google Sheets */
export const PUT = handle(async (req: Request) => {
  const user = await requireUser("settings.manage");
  const b = await readJson<{ link?: string; enabled?: boolean; reason?: string }>(req);
  const reason = String(b.reason ?? "").trim();
  if (reason.length < 5) throw new HttpError(400, "Reason is required for settings changes");
  const before = await getSheetsConfig();
  let next;
  try { next = await saveSheetsConfig({ link: b.link, enabled: b.enabled }, user.employeeId); } catch (e) {
    if (e instanceof SheetsError) throw new HttpError(400, e.message);
    throw e;
  }
  await audit(user, "settings.google_sheets", { entity: "settings", entityId: "googleSheets", previousValue: before, updatedValue: next, reason, ip: await clientIp() });
  return NextResponse.json({ success: true, ...next });
});

/** POST { month } — "Sync to Google Sheet" (Approved / Finalized / Disbursed employees of that month) */
export const POST = handle(async (req: Request) => {
  const user = await requireUser("salary.view");
  const b = await readJson<{ month?: string }>(req);
  const month = String(b.month ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "month must be YYYY-MM");
  const cfg = await getSheetsConfig();
  if (!cfg.spreadsheetId) throw new HttpError(400, "Add the Google Sheet link in Settings → Google Sheets first");
  const r = await syncPayrollMonth(month, user, { force: true });
  if (!r.ok) throw new HttpError(502, r.error ?? "Google Sheet sync failed");
  return NextResponse.json(r);
});