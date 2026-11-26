import { stripDays } from "@/lib/field-crypto";
import { NextResponse } from "next/server";
import { can, handle, HttpError, readJson, requireUser } from "@/lib/auth";
import { FmsPayrollEntry, FmsPayrollRun } from "@/models/fms";
import { setExcluded, syncRunWithOms, transitionEntries } from "@/lib/payroll-run";
import { syncPayrollMonth } from "@/lib/sheets-sync";
import { MONTH_RE } from "@/lib/dates";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ month: string }> }) => {
  const user = await requireUser("payroll.view");
  const { month } = await ctx.params;
  if (!MONTH_RE.test(month)) throw new HttpError(400, "Invalid month");
  // Pull in any change HR made in OMS (open runs update; locked runs report drift).
  await syncRunWithOms(month).catch((e) => console.error("[FMS] OMS sync failed", e));
  const run = await FmsPayrollRun.findOne({ month }).lean();
  if (!run) return NextResponse.json({ run: null, entries: [] });
  const showSalary = can(user, "salary.view");
  const entries = (await FmsPayrollEntry.find({ runId: run._id }).select(showSalary ? "" : "-calc").sort({ "employee.name": 1 }).lean()).map(stripDays);
  return NextResponse.json({ run, entries: showSalary ? entries : entries.map((e) => ({ ...e, netPay: null })) });
});

/** body: { action: submit|reopen|approve|reject|finalize|disburse, employeeIds?: [...], note?, disbursedOn?, reference? }
 *     (no employeeIds = every employee in that stage; with employeeIds = only those, e.g. one to test)
 *     or { action: "exclude"|"include", employeeId, reason } */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ month: string }> }) => {
  const user = await requireUser("payroll.view");
  const { month } = await ctx.params;
  const b = await readJson<{ action?: string; note?: string; disbursedOn?: string; reference?: string; employeeId?: string; employeeIds?: string[]; reason?: string }>(req);
  if (b.action === "exclude" || b.action === "include") {
    if (!can(user, "payroll.prepare")) throw new HttpError(403, "Missing permission: payroll.prepare");
    await setExcluded(month, String(b.employeeId), b.action === "exclude", String(b.reason ?? ""), user);
    return NextResponse.json({ success: true });
  }
  const r = await transitionEntries(month, String(b.action), user, {
    note: b.note, disbursedOn: b.disbursedOn, reference: b.reference,
    employeeIds: Array.isArray(b.employeeIds) ? b.employeeIds : b.employeeId ? [String(b.employeeId)] : undefined,
  });
  // Approved / Finalized / Disbursed list changed → refresh that month's tab in the Google Sheet (if switched on).
  // A Google problem never undoes the payroll action; it is returned as a warning and logged.
  const sheet = r.moved > 0 ? await syncPayrollMonth(month, user).catch((e) => ({ ok: false, month, error: (e as Error).message })) : null;
  return NextResponse.json({ ...r, sheet });
});