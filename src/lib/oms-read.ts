/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The ONLY place FMS reads OMS collections. Read-only, lean, no password fields.
 * Payable-day inputs are loaded EXACTLY like OMS `payableForMany`
 * (src/lib/salary-module.ts:62-97) and the salary employee list like
 * OMS `salaryEmployees` (salary-module.ts:104-114).
 */
import { connectDB } from "./db";
import {
  OmsEmployee, OmsAttendance, OmsLeave, OmsHoliday, OmsViolation, OmsExit, OmsLocation,
  OmsPayableCorrection, OmsFlagRemoval, OmsLocationJustification, EMPLOYEE_SAFE_FIELDS,
  OmsLateJustification, OmsFullAttireReview, OmsFullAttireSubmission, OmsHrMonetaryPenalty,
} from "@/models/oms-readonly";
import { monthStart, monthEnd, todayIST } from "./dates";
import type { FineRec, MonetaryPenalty, OmsCorrection, PdAttendance, PdFullAttire, PdLeave, PdViolation } from "./payable-days";
import type { PayrollPolicy } from "./policy";

export interface OmsEmployeeView {
  _id: string;
  id: string;
  name: string;
  email: string;
  role: string;
  dept: string;
  designation: string;
  location: string;
  status: string;
  joiningDate?: string;
  /** employees.noticePeriod.lastWorkingDay (OMS uses this before exitrecords) */
  noticeLastWorkingDay?: string;
  reportsTo?: string[];
  fines: FineRec[];
  isRemoved?: boolean;
}

export function toEmployeeView(e: any): OmsEmployeeView {
  return {
    _id: String(e._id),
    id: String(e.id ?? ""),
    name: String(e.name ?? ""),
    email: String(e.email ?? ""),
    role: String(e.role ?? ""),
    dept: String(e.dept ?? ""),
    designation: String(e.designation || e.current_designation_at_gog || ""),
    location: String(e.location ?? ""),
    status: String(e.status ?? "Active"),
    joiningDate: e.joiningDate ? String(e.joiningDate) : undefined,
    noticeLastWorkingDay: e.noticePeriod?.lastWorkingDay ? String(e.noticePeriod.lastWorkingDay) : undefined,
    reportsTo: Array.isArray(e.reportsTo) ? e.reportsTo.map(String) : [],
    fines: Array.isArray(e.fines?.records) ? e.fines.records : [],
    isRemoved: !!e.isRemoved,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** OMS salaryEmployees(month) filter: who is on the salary list for a month. */
export function isOnSalaryList(e: { role?: string; joiningDate?: string; noticeLastWorkingDay?: string; status?: string }, month: string): boolean {
  const start = monthStart(month), end = monthEnd(month);
  if (e.role === "FOUNDER") return false;
  if (e.joiningDate && String(e.joiningDate) > end) return false;
  const exit = e.noticeLastWorkingDay;
  if (exit && exit < start) return false;
  return !/^(inactive|removed|exited|resigned|terminated)$/i.test(String(e.status || "")) || !!(exit && exit >= start);
}

export async function listEmployees(q: {
  search?: string;
  dept?: string;
  location?: string;
  /** "active" (default) = OMS salary list for `month`; "all"; or an exact OMS status */
  status?: string;
  month?: string;
  policy: PayrollPolicy;
}): Promise<OmsEmployeeView[]> {
  await connectDB();
  // OMS Employee.find() hides isRemoved:true via a pre-find hook — replicated explicitly.
  const filter: Record<string, any> = { isRemoved: { $ne: true } };
  if (q.search) {
    const re = { $regex: escapeRe(q.search), $options: "i" };
    filter.$or = [{ name: re }, { id: re }, { email: re }];
  }
  if (q.dept) filter.dept = q.dept;
  if (q.location) filter.location = q.location;
  if (q.status && q.status !== "active" && q.status !== "all") filter.status = q.status;
  const rows = (await OmsEmployee.find(filter).select(EMPLOYEE_SAFE_FIELDS).sort({ name: 1 }).lean()).map(toEmployeeView);
  if (!q.status || q.status === "active") {
    const month = q.month || todayIST().slice(0, 7);
    return rows.filter((e) => isOnSalaryList(e, month));
  }
  return rows;
}

/** Employees on the OMS salary list for a month (same rule as OMS /hr/salary-management). */
export const salaryEmployees = (month: string, policy: PayrollPolicy) => listEmployees({ month, policy, status: "active" });

export async function getEmployee(employeeId: string, includeRemoved = true): Promise<OmsEmployeeView | null> {
  await connectDB();
  const filter = includeRemoved ? { id: employeeId, isRemoved: { $in: [true, false, null] } } : { id: employeeId, isRemoved: { $ne: true } };
  const e = await OmsEmployee.findOne(filter).select(EMPLOYEE_SAFE_FIELDS).lean();
  return e ? toEmployeeView(e) : null;
}

export async function countActiveEmployees(policy: PayrollPolicy, month?: string): Promise<number> {
  return (await listEmployees({ policy, month, status: "active" })).length;
}

export async function distinctValues() {
  await connectDB();
  const [depts, locs] = await Promise.all([
    OmsEmployee.distinct("dept", { isRemoved: { $ne: true } }),
    OmsLocation.find({}).select("id name shortName").lean(),
  ]);
  return {
    departments: (depts as unknown[]).filter(Boolean).map(String).sort(),
    locations: locs.map((l) => ({ id: String(l.id), name: String(l.shortName || l.name || l.id) })),
  };
}

export interface MonthInputs {
  attendance: Map<string, PdAttendance[]>;
  leaves: Map<string, PdLeave[]>;
  violations: Map<string, PdViolation[]>;
  removed: Map<string, Map<string, { removedAt?: string; removedByName?: string; removalReason?: string }>>;
  corrections: Map<string, Map<string, OmsCorrection>>;
  monetary: Map<string, MonetaryPenalty[]>;
  exits: Map<string, string>;
  /** dates with a pending Late Justification, per employee */
  lateJustificationPending: Map<string, Set<string>>;
  /** rejected Full Attire reviews, per employee */
  fullAttire: Map<string, PdFullAttire[]>;
  holidays: { date: string; forAll?: boolean; collegeIds?: string[]; employeeIds?: string[]; excludedEmployeeIds?: string[] }[];
  /** OMS: asOf = today only for the current month */
  asOf?: string;
}

function group<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = m.get(k) ?? [];
    arr.push(r);
    m.set(k, arr);
  }
  return m;
}

/** OMS salary-module.ts:53 correctionDirection */
export const correctionDirection = (c: any) =>
  c?.direction === "TO_NON_PAYABLE" || c?.updatedPayableStatus === "Non-Payable" || Number(c?.adjustment) < 0 ? "TO_NON_PAYABLE" : "TO_PAYABLE";

/** OMS location-justification.ts:315 locationPenaltiesFor */
async function locationPenaltiesFor(ids: string[], start: string, end: string) {
  const rows: any[] = ids.length
    ? await OmsLocationJustification.find({ employeeId: { $in: ids }, date: { $gte: start, $lte: end }, status: "rejected", action: { $in: ["half_day", "full_day", "penalty"] } })
        .select("id employeeId date action penaltyAmount decisionReason reviewedByName reviewedByRole reviewedAt scheduledLocationName actualLocationName clockIn").lean()
    : [];
  const violations = new Map<string, any[]>(), money = new Map<string, MonetaryPenalty[]>();
  for (const r of rows) {
    if (r.action === "penalty") {
      if (!money.has(r.employeeId)) money.set(r.employeeId, []);
      money.get(r.employeeId)!.push({ id: r.id, date: r.date, amount: r.penaltyAmount || 0, reason: r.decisionReason || "", source: "Location Mismatch", detail: `Scheduled ${r.scheduledLocationName || "—"} · Actual ${r.actualLocationName || "—"}` });
    } else {
      if (!violations.has(r.employeeId)) violations.set(r.employeeId, []);
      violations.get(r.employeeId)!.push({ id: r.id, employeeId: r.employeeId, date: r.date, type: "LOCATION_MISMATCH", level: r.action === "full_day" ? "FULL_DAY" : "HALF_DAY", instance: null, proposedDeduction: r.action === "full_day" ? "Full-Day" : "Half-Day", hrStatus: "Approved for Payroll", actualTime: r.clockIn || "" });
    }
  }
  return { violations, money };
}

/** Bulk-load exactly what OMS payableForMany loads (salary-module.ts:66-77). */
export async function loadMonthInputs(employeeIds: string[], month: string): Promise<MonthInputs> {
  await connectDB();
  const start = monthStart(month);
  const end = monthEnd(month);
  const ids = { $in: employeeIds };
  const [att, leaves, hol, viol, exits, removed, corr] = await Promise.all([
    OmsAttendance.find({ employeeId: ids, date: { $gte: start, $lte: end } })
      .select("_id employeeId date status clockIn clockOut workMode location dressCodeStatus dressCodeRejectionReasons").lean(),
    OmsLeave.find({ employeeId: ids, startDate: { $lte: end }, endDate: { $gte: start } }).select("employeeId id type leaveType startDate endDate days status").lean(),
    OmsHoliday.find({ date: { $gte: start, $lte: end }, status: "Approved" }).select("date forAll collegeIds employeeIds excludedEmployeeIds").lean(),
    OmsViolation.find({ employeeId: ids, date: { $gte: start, $lte: end } }).select("employeeId id date type level instance proposedDeduction hrStatus scheduledTime actualTime").lean(),
    OmsExit.find({ employeeId: ids }).select("employeeId lastWorkingDay").lean(),
    OmsFlagRemoval.find({ employeeId: ids, flagDate: { $gte: start, $lte: end } }).select("employeeId flagId removedAt removedByName removalReason").lean(),
    OmsPayableCorrection.find({ employeeId: ids, month, status: "ACTIVE" }).lean(),
  ]);
  const [locPen, lj, fa, hrPen] = await Promise.all([
    locationPenaltiesFor(employeeIds, start, end),
    OmsLateJustification.find({ employeeId: ids, date: { $gte: start, $lte: end } }).select("employeeId date justificationStatus").lean(),
    fullAttireFor(employeeIds, month),
    OmsHrMonetaryPenalty.find({ employeeId: ids, month, status: "ACTIVE" }).select("id employeeId month date amount reasonCategory explanation").lean(),
  ]);
  const k = (r: any) => String(r.employeeId);

  const V = group(viol as any[], k);
  for (const [emp, list] of locPen.violations) V.set(emp, [...(V.get(emp) ?? []), ...list]);

  const R = new Map<string, Map<string, any>>();
  for (const [emp, list] of group(removed as any[], k)) {
    R.set(emp, new Map(list.map((r) => [r.flagId, { removedAt: r.removedAt, removedByName: r.removedByName, removalReason: r.removalReason }])));
  }
  const C = new Map<string, Map<string, OmsCorrection>>();
  for (const [emp, list] of group(corr as any[], k)) {
    C.set(emp, new Map(list.map((c) => [c.date, {
      id: c.id, direction: correctionDirection(c), payableType: c.payableType ? String(c.payableType) : undefined, correctionCategory: c.correctionCategory, correctionReason: c.correctionReason,
      correctedByName: c.correctedByName, correctedByRole: c.correctedByRole, correctedAt: c.correctedAt, relatedTicketId: c.relatedTicketId,
    }])));
  }
  const monetary = new Map<string, MonetaryPenalty[]>();
  for (const [emp, list] of locPen.money) monetary.set(emp, [...list]);
  // HR ₹ penalties (hrmonetarypenalties, ACTIVE, this month; empty date = for the whole month)
  for (const r of hrPen as any[]) {
    const emp = String(r.employeeId);
    const list = monetary.get(emp) ?? [];
    list.push({ id: r.id ? String(r.id) : undefined, date: r.date ? String(r.date) : "", amount: Number(r.amount) || 0, reason: r.explanation || r.reasonCategory || "", source: "HR Penalty", detail: r.date ? undefined : "Whole month" });
    monetary.set(emp, list);
  }
  for (const [emp, list] of monetary) monetary.set(emp, list.sort((a, b) => a.date.localeCompare(b.date)));
  const LJ = new Map<string, Set<string>>();
  for (const r of lj as any[]) {
    if (!/pending/i.test(String(r.justificationStatus || ""))) continue;
    const emp = String(r.employeeId);
    if (!LJ.has(emp)) LJ.set(emp, new Set());
    LJ.get(emp)!.add(String(r.date));
  }

  const lwd = new Map((exits as any[]).filter((x) => x.lastWorkingDay).map((x) => [String(x.employeeId), String(x.lastWorkingDay)]));
  const today = todayIST();
  return {
    attendance: group(att as any[], k),
    leaves: group(leaves as any[], k),
    violations: V,
    removed: R,
    corrections: C,
    monetary,
    exits: lwd,
    lateJustificationPending: LJ,
    fullAttire: fa,
    holidays: hol as any[],
    asOf: month === today.slice(0, 7) ? today : undefined,
  };
}

/**
 * OMS holidayForEmployee (src/lib/holiday-scope.ts) — holidays that apply to one employee:
 * employeeIds set → only those people; else excludedEmployeeIds → not them;
 * else forAll, or no collegeIds, or the employee's location is in collegeIds.
 */
export const holidaysFor = (hol: MonthInputs["holidays"], location?: string, employeeId?: string) =>
  hol.filter((h) => {
    if (h.employeeIds?.length) return !!employeeId && h.employeeIds.map(String).includes(employeeId);
    if (employeeId && h.excludedEmployeeIds?.map(String).includes(employeeId)) return false;
    return h.forAll || !h.collegeIds?.length || (!!location && h.collegeIds.includes(location));
  }).map((h) => h.date);

/** IST calendar day (YYYY-MM-DD) of a timestamp */
export function istDay(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = new Date(v as string | number | Date).getTime();
  if (Number.isNaN(t)) return "";
  return new Date(t + 330 * 60 * 1000).toISOString().slice(0, 10);
}

/** Rejected Full Attire reviews; date = IST day of fullattiresubmissions.submittedAt (not the review date). */
async function fullAttireFor(ids: string[], month: string): Promise<Map<string, PdFullAttire[]>> {
  const out = new Map<string, PdFullAttire[]>();
  if (!ids.length) return out;
  const reviews: any[] = await OmsFullAttireReview.find({ professorId: { $in: ids }, status: "rejected" }).select("id submissionId professorId reasons other").lean();
  if (!reviews.length) return out;
  const subs: any[] = await OmsFullAttireSubmission.find({ id: { $in: [...new Set(reviews.map((r) => r.submissionId).filter(Boolean))] } }).select("id submittedAt").lean();
  const at = new Map(subs.map((s) => [String(s.id), istDay(s.submittedAt)]));
  for (const r of reviews) {
    const date = at.get(String(r.submissionId)) || "";
    if (!date.startsWith(month)) continue;
    const emp = String(r.professorId);
    const reasons = [...(Array.isArray(r.reasons) ? r.reasons : []), r.other].filter(Boolean).join(", ");
    const list = out.get(emp) ?? [];
    list.push({ id: String(r.id), date, reasons: reasons || undefined });
    out.set(emp, list);
  }
  return out;
}

/**
 * Extra OMS details printed on the salary slip (server-only; never returned by any list API).
 * Bank account number is masked to the last 4 digits.
 */
export async function getEmployeePayslipDetails(employeeId: string) {
  await connectDB();
  const e = await OmsEmployee.findOne({ id: employeeId, isRemoved: { $in: [true, false, null] } })
    .select("id name designation current_designation_at_gog dept location joiningDate bankName bank_name accountNumber bank_account_number panNumber")
    .lean();
  if (!e) return null;
  const loc = e.location ? await OmsLocation.findOne({ id: e.location }).select("name shortName").lean() : null;
  const acct = String(e.accountNumber || e.bank_account_number || "").replace(/\s+/g, "");
  return {
    id: String(e.id ?? employeeId),
    name: String(e.name ?? ""),
    designation: String(e.designation || e.current_designation_at_gog || ""),
    department: String(e.dept ?? ""),
    location: String(loc?.name || loc?.shortName || e.location || ""),
    joiningDate: e.joiningDate ? String(e.joiningDate).slice(0, 10) : "",
    bankName: String(e.bankName || e.bank_name || ""),
    bankAccount: acct ? `${"X".repeat(Math.max(0, Math.min(8, acct.length - 4)))}${acct.slice(-4)}` : "",
    pan: String(e.panNumber ?? "").toUpperCase(),
  };
}