/**
 * Payable days in FMS = EXACTLY the OMS calculation.
 * This file only adapts the result of the verbatim OMS function
 * (`oms-payable-days.ts` → calculatePayableDays) to the shape the FMS payroll
 * engine / UI use. No payable / LOP / penalty rule is decided here.
 */
import { calculatePayableDays, type PdAttendance, type PdLeave, type PdViolation, type PenaltyItem } from "./oms-payable-days";
import type { PayrollPolicy } from "./policy";

export type { PdAttendance, PdLeave, PdViolation };

export interface FineRec { amount?: number; date?: string; reason?: string }
export interface MonetaryPenalty { id?: string; date: string; amount: number; reason?: string; source?: string; detail?: string }
export interface OmsCorrection {
  id: string; direction?: string; correctionCategory?: string; correctionReason?: string;
  correctedByName?: string; correctedByRole?: string; correctedAt?: string; relatedTicketId?: string;
}

export type DayKind =
  | "PAYABLE" | "NON_PAYABLE" | "PARTLY_PAYABLE" | "UPCOMING" | "NOT_EMPLOYED" | "WEEKLY_OFF" | "HOLIDAY";

export interface DayResult {
  date: string;
  weekday: string;
  kind: DayKind;
  payableStatus: string; // exactly as OMS shows it
  attendance: string;
  leave: string;
  payable: number;
  lop: number;
  source: string; // OMS "reason"
  penalties: string[];
  flag?: string;
  correction?: OmsCorrection;
  clockIn?: string;
  clockOut?: string;
}

export interface PayableDaysResult {
  month: string;
  asOf: string | null;
  provisional: boolean;
  calendarDays: number;
  employedDays: number;
  consideredDays: number;
  workingDays: number;
  presentDays: number;
  weeklyOffs: number;
  holidays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  absentDays: number;
  pendingLeaveDays: number;
  flaggedDays: number;
  futureDays: number;
  /** LOP days INCLUDING applied penalty days (OMS lopDays = nonPayableDays) */
  lopDays: number;
  /** OMS payableDays = employedDays − lopDays (already net of penalty days) */
  payableDays: number;
  basePayableDays: number;
  correctedDays: number;
  hrDeductedDays: number;
  /** Penalty days OMS actually applied (part of lopDays) */
  violationDays: number;
  violationCount: number;
  pendingPenalties: number;
  activeFlags: number;
  /** ₹ penalties in paise: OMS monetaryPenaltyTotal (location mismatch) + employees.fines if enabled */
  finesPaise: number;
  monetaryPenalties: MonetaryPenalty[];
  penalties: PenaltyItem[];
  leavesApplied: number;
  leavesApproved: number;
  /** kept for compatibility (OMS ignores leaverequests.lossOfPayDays) */
  omsLeaveLopDays: number;
  flags: string[];
  days: DayResult[];
}

const kindOf = (row: { payableStatus: string; weeklyOff?: boolean; holiday?: boolean; correction?: unknown }): DayKind => {
  if (row.payableStatus === "Not Employed") return "NOT_EMPLOYED";
  if (row.payableStatus === "Upcoming") return "UPCOMING";
  if (!row.correction && row.payableStatus === "Payable" && row.holiday) return "HOLIDAY";
  if (!row.correction && row.payableStatus === "Payable" && row.weeklyOff) return "WEEKLY_OFF";
  if (row.payableStatus === "Non-Payable") return "NON_PAYABLE";
  if (row.payableStatus === "Partly Payable") return "PARTLY_PAYABLE";
  return "PAYABLE";
};

export function computePayableDays(input: {
  month: string;
  /** OMS: today (IST) for the current month, undefined for past months */
  asOf?: string;
  employee: { id: string; location?: string; joiningDate?: string; exitDate?: string };
  attendance: PdAttendance[];
  leaves: PdLeave[];
  /** dates of approved holidays that apply to this employee (OMS filter already applied) */
  holidays: string[];
  violations: PdViolation[];
  removed: Map<string, { removedAt?: string; removedByName?: string; removalReason?: string }>;
  corrections: Map<string, OmsCorrection>;
  monetaryPenalties: MonetaryPenalty[];
  fines: FineRec[];
  policy: PayrollPolicy;
}): PayableDaysResult {
  const r = calculatePayableDays({
    month: input.month,
    asOf: input.asOf,
    joiningDate: input.employee.joiningDate || undefined,
    exitDate: input.employee.exitDate || undefined,
    attendance: input.attendance,
    leaves: input.leaves,
    holidays: input.holidays,
    violations: input.violations,
    removed: input.removed,
    corrections: input.corrections,
  });

  // ₹ penalties exactly as OMS lists them (withMoney: rupees, rounded to paise)
  const monetaryRupees = Math.round(input.monetaryPenalties.reduce((s, p) => s + (Number(p.amount) || 0), 0) * 100) / 100;
  let finesPaise = Math.round(monetaryRupees * 100);
  // employees.fines is NOT used by OMS totals; optional in FMS (off by default)
  if (input.policy.includeOmsFines) {
    for (const f of input.fines) {
      if (!(f?.date ?? "").startsWith(input.month)) continue;
      const amt = Number(f.amount) || 0;
      finesPaise += input.policy.omsFineUnit === "RUPEES" ? Math.round(amt * 100) : Math.round(amt);
    }
  }

  const days: DayResult[] = r.days.map((d) => ({
    date: d.date,
    weekday: d.weekday,
    kind: kindOf(d),
    payableStatus: d.payableStatus,
    attendance: d.attendance,
    leave: d.leave,
    payable: d.payable,
    lop: d.lop,
    source: d.reason,
    penalties: d.penalties,
    correction: d.correction,
    flag: d.correction ? "HR_CORRECTED_IN_OMS" : /pending/i.test(d.leave || "") ? "PENDING_LEAVE" : undefined,
    clockIn: d.clockIn,
    clockOut: d.clockOut,
  }));

  const leavesInMonth = input.leaves.filter((l) => l?.startDate && l.startDate <= `${input.month}-31` && (l.endDate || l.startDate) >= `${input.month}-01`);
  const flags = new Set<string>();
  if (r.provisional) flags.add("MONTH_IN_PROGRESS");
  if (r.pendingLeaveDays) flags.add("PENDING_LEAVE");
  if (r.pendingPenalties) flags.add("PENDING_PENALTY_DECISION");
  if (r.correctedDays || r.hrDeductedDays) flags.add("HR_CORRECTED_IN_OMS");

  return {
    month: r.month,
    asOf: r.asOf,
    provisional: r.provisional,
    calendarDays: r.totalDays,
    employedDays: r.employedDays,
    consideredDays: r.employedDays - r.upcomingDays,
    workingDays: r.workingDays,
    presentDays: r.presentDays,
    weeklyOffs: r.weeklyOffDays,
    holidays: r.holidayDays,
    paidLeaveDays: r.paidLeaves,
    unpaidLeaveDays: r.unpaidLeaves,
    absentDays: r.absentDays,
    pendingLeaveDays: r.pendingLeaveDays,
    flaggedDays: days.filter((d) => d.flag).length,
    futureDays: r.upcomingDays,
    lopDays: r.lopDays,
    payableDays: r.payableDays,
    basePayableDays: r.basePayableDays,
    correctedDays: r.correctedDays,
    hrDeductedDays: r.hrDeductedDays,
    violationDays: r.penaltyDays,
    violationCount: r.penalties.filter((p) => p.deductedDays > 0).length,
    pendingPenalties: r.pendingPenalties,
    activeFlags: r.activeFlags,
    finesPaise,
    monetaryPenalties: input.monetaryPenalties,
    penalties: r.penalties,
    leavesApplied: leavesInMonth.length,
    leavesApproved: leavesInMonth.filter((l) => /^approved$/i.test(String(l.status || ""))).length,
    omsLeaveLopDays: 0,
    flags: [...flags],
    days,
  };
}