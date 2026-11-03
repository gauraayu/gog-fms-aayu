import { NextResponse } from "next/server";
import { clientIp, handle, HttpError, readJson, requireUser } from "@/lib/auth";
import { getEmployee } from "@/lib/oms-read";
import { computeForEmployees, originalValueFor } from "@/lib/payroll-service";
import { getPolicy } from "@/lib/settings";
import { MONTH_RE } from "@/lib/dates";
import { ADJUSTABLE_FIELDS, FmsAdjustment, FmsPayrollRun } from "@/models/fms";
import { audit } from "@/lib/audit";
import { entryStatus, recomputeEntry } from "@/lib/payroll-run";

const MONEY_FIELDS = new Set(["penaltyAmount", "otherEarnings", "otherDeductions"]);

export const GET = handle(async (req: Request) => {
  await requireUser("employees.view");
  const u = new URL(req.url);
  const filter: Record<string, unknown> = {};
  if (u.searchParams.get("employeeId")) filter.employeeId = u.searchParams.get("employeeId");
  if (u.searchParams.get("month")) filter.month = u.searchParams.get("month");
  const rows = await FmsAdjustment.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  return NextResponse.json({ rows });
});

/**
 * HR payroll adjustment. Never touches OMS attendance/leave — stored in fms_payroll_adjustments
 * with original value, updated value, mandatory reason, who/when; then the open payroll entry is recomputed.
 * Money fields are sent in RUPEES by the UI and stored in paise.
 */
export const POST = handle(async (req: Request) => {
  const user = await requireUser("adjustments.manage");
  const b = await readJson<{ employeeId?: string; month?: string; field?: string; value?: number; reason?: string }>(req);
  const employeeId = String(b.employeeId ?? "");
  const month = String(b.month ?? "");
  const field = String(b.field ?? "");
  const reason = String(b.reason ?? "").trim();
  if (!employeeId || !MONTH_RE.test(month)) throw new HttpError(400, "employeeId and month (YYYY-MM) are required");
  if (!(ADJUSTABLE_FIELDS as readonly string[]).includes(field)) throw new HttpError(400, "Field is not adjustable");
  if (reason.length < 10) throw new HttpError(400, "A reason of at least 10 characters is mandatory");
  const raw = Number(b.value);
  if (!Number.isFinite(raw) || raw < 0) throw new HttpError(400, "Value must be a non-negative number");

  const run = await FmsPayrollRun.findOne({ month }).lean();
  const st = run ? await entryStatus(month, employeeId) : null;
  if (st && !["Draft", "Under Review"].includes(st)) {
    throw new HttpError(409, `This employee's ${month} payroll is ${st}; adjustments are locked (send it back to review first)`);
  }
  const emp = await getEmployee(employeeId);
  if (!emp) throw new HttpError(404, "Employee not found");
  const policy = await getPolicy();
  const [r] = await computeForEmployees([emp], month, policy, "payroll");

  const updatedValue = MONEY_FIELDS.has(field) ? Math.round(raw * 100) : Math.round(raw * 100) / 100;
  if (["payableDays", "lopDays", "penaltyDays"].includes(field) && updatedValue > r.attendance.calendarDays) {
    throw new HttpError(400, `Days cannot exceed ${r.attendance.calendarDays}`);
  }
  // "Original value" = the value in effect right before this edit (prior adjustment or system-computed).
  const prior = r.adjustmentsApplied.find((a) => a.field === field);
  const originalValue = prior ? prior.to : originalValueFor(field, r);
  if (originalValue === updatedValue) throw new HttpError(400, "New value is the same as the current value");

  const doc = await FmsAdjustment.create({
    employeeId, month, field, originalValue, updatedValue, reason, systemValue: originalValueFor(field, r),
    modifiedBy: user.employeeId, modifiedByName: user.name, modifiedByRole: user.role,
  });
  await audit(user, "payroll.adjustment", {
    entity: "employee-month", entityId: `${employeeId}:${month}`,
    previousValue: { [field]: originalValue }, updatedValue: { [field]: updatedValue }, reason, ip: await clientIp(),
  });
  if (run) await recomputeEntry(month, employeeId, user);
  return NextResponse.json({ success: true, adjustment: doc });
});