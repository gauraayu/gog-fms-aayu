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
} from "@/models/oms-readonly";
import { monthStart, monthEnd, todayIST } from "./dates";
import type { FineRec, MonetaryPenalty, OmsCorrection, PdAttendance, PdLeave, PdViolation } from "./payable-days";
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
  holidays: { date: string; forAll?: boolean; collegeIds?: string[] }[];
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
    OmsHoliday.find({ date: { $gte: start, $lte: end }, status: "Approved" }).select("date forAll collegeIds").lean(),
    OmsViolation.find({ employeeId: ids, date: { $gte: start, $lte: end } }).select("employeeId id date type level instance proposedDeduction hrStatus scheduledTime actualTime").lean(),
    OmsExit.find({ employeeId: ids }).select("employeeId lastWorkingDay").lean(),
    OmsFlagRemoval.find({ employeeId: ids, flagDate: { $gte: start, $lte: end } }).select("employeeId flagId removedAt removedByName removalReason").lean(),
    OmsPayableCorrection.find({ employeeId: ids, month, status: "ACTIVE" }).lean(),
  ]);
  const locPen = await locationPenaltiesFor(employeeIds, start, end);
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
      id: c.id, direction: correctionDirection(c), correctionCategory: c.correctionCategory, correctionReason: c.correctionReason,
      correctedByName: c.correctedByName, correctedByRole: c.correctedByRole, correctedAt: c.correctedAt, relatedTicketId: c.relatedTicketId,
    }])));
  }
  const monetary = new Map<string, MonetaryPenalty[]>();
  for (const [emp, list] of locPen.money) monetary.set(emp, list.sort((a, b) => a.date.localeCompare(b.date)));

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
    holidays: hol as any[],
    asOf: month === today.slice(0, 7) ? today : undefined,
  };
}

/** OMS salary-module.ts:85 — holidays that apply to one employee. */
export const holidaysFor = (hol: MonthInputs["holidays"], location?: string) =>
  hol.filter((h) => h.forAll || !h.collegeIds?.length || (location && h.collegeIds.includes(location))).map((h) => h.date);