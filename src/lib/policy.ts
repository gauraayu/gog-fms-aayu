import type { RoundingMode } from "./money";

/**
 * Payroll policy. OMS has NO payroll policy defined (handover §11/§18), so every
 * value here is a configurable setting. Defaults are placeholders taken from the
 * never-deployed OMS draft and are marked `confirmed:false` — payroll cannot be
 * Approved/Finalized until a Founder/Admin reviews and confirms the policy.
 */
/**
 * NOTE: payable / LOP / penalty / leave-quota / weekly-off rules now come from the verbatim
 * OMS calculation (oms-payable-days.ts). Fields marked (legacy) are no longer used by it.
 */
export interface PayrollPolicy {
  confirmed: boolean;
  confirmedBy?: string;
  confirmedAt?: string;
  divisorMode: "CALENDAR_DAYS" | "FIXED";
  fixedDivisor: number; // used when divisorMode = FIXED (e.g. 26 or 30)
  /** (legacy, unused) */ weeklyOffDays: number[]; // 0=Sun … 6=Sat (OMS: Sunday = weekly off)
  /** What to do with a scheduled working day that has NO attendance record and no leave/holiday. */
  /** (legacy, unused) */ missingRecordTreatment: "FLAG_PAYABLE" | "LOP";
  /** Leave still pending approval on payroll date. */
  /** (legacy, unused) */ pendingLeaveTreatment: "FLAG_PAYABLE" | "LOP";
  /** Max PAID leave days per month counted as payable; extra paid leave becomes LOP. null = no cap. */
  /** (legacy, unused) */ paidLeaveMonthlyCap: number | null;
  /** Include OMS `leaverequests.lossOfPayDays` (e.g. rejected emergency leave LOP) as extra LOP. */
  /** (legacy, unused) */ includeOmsLeaveLop: boolean;
  /** Day-value of approved-for-payroll attendance violations. */
  /** (legacy, unused) */ violationDays: { "Half-Day": number; "Full-Day": number };
  /** Include employees.fines.records[] amounts (dated within the month) as penalty deductions. */
  includeOmsFines: boolean;
  /** Unit of employees.fines.records[].amount in OMS. */
  omsFineUnit: "RUPEES" | "PAISE";
  rounding: RoundingMode;
  /** (legacy, unused) automatic payslip email is disabled — emails only on "Send" click */
  payslipEmailDay: number;
  /** (legacy, unused) */ payslipMonthOffset: number;
  /** Challan payment statuses counted as "paid" on the dashboard. */
  challanPaidStatuses: string[];
  /** OMS employee roles excluded from payroll (e.g. FOUNDER). */
  /** (legacy, unused) */ excludedRoles: string[];
  /** OMS employee status values treated as active. */
  activeStatuses: string[];
}

export const DEFAULT_POLICY: PayrollPolicy = {
  confirmed: false,
  divisorMode: "CALENDAR_DAYS",
  fixedDivisor: 30,
  weeklyOffDays: [0],
  missingRecordTreatment: "FLAG_PAYABLE",
  pendingLeaveTreatment: "FLAG_PAYABLE",
  paidLeaveMonthlyCap: 1,
  includeOmsLeaveLop: true,
  violationDays: { "Half-Day": 0.5, "Full-Day": 1 },
  includeOmsFines: false, // OMS totals do not use employees.fines
  omsFineUnit: "RUPEES",
  rounding: "NEAREST_RUPEE",
  payslipEmailDay: Number(process.env.PAYSLIP_EMAIL_DAY || 25),
  payslipMonthOffset: 1,
  challanPaidStatuses: ["Paid", "Verified"],
  excludedRoles: ["FOUNDER"],
  activeStatuses: ["Active"],
};

export function mergePolicy(stored: Partial<PayrollPolicy> | null | undefined): PayrollPolicy {
  return { ...DEFAULT_POLICY, ...(stored || {}), violationDays: { ...DEFAULT_POLICY.violationDays, ...(stored?.violationDays || {}) } };
}

export function validatePolicy(p: PayrollPolicy): string[] {
  const errs: string[] = [];
  if (!["CALENDAR_DAYS", "FIXED"].includes(p.divisorMode)) errs.push("divisorMode invalid");
  if (p.divisorMode === "FIXED" && !(p.fixedDivisor >= 1 && p.fixedDivisor <= 31)) errs.push("fixedDivisor must be 1–31");
  if (!Array.isArray(p.weeklyOffDays) || p.weeklyOffDays.some((d) => d < 0 || d > 6)) errs.push("weeklyOffDays must be 0–6");
  if (p.paidLeaveMonthlyCap !== null && !(p.paidLeaveMonthlyCap >= 0)) errs.push("paidLeaveMonthlyCap must be ≥ 0 or null");
  if (!(p.payslipEmailDay >= 1 && p.payslipEmailDay <= 28)) errs.push("payslipEmailDay must be 1–28");
  if (!(p.payslipMonthOffset >= 0 && p.payslipMonthOffset <= 1)) errs.push("payslipMonthOffset must be 0 or 1");
  return errs;
}