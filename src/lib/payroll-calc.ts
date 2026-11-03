/**
 * Salary calculation engine — PURE. All amounts in integer paise.
 *
 *   fraction (CALENDAR_DAYS) = payableDays / calendarDays
 *   fraction (FIXED divisor) = (divisor − unpaidDays) / divisor, unpaidDays = calendarDays − payableDays
 *   earned component        = round(component × fraction)
 *   payable/LOP/penalty days come from OMS (penalty days are already part of OMS LOP)
 *   reduction               = full monthly gross − earned gross
 *   penalty line            = min(reduction, round(fullGross × penaltyDays / divisor)) + ₹ penalties
 *   LOP line                = reduction − penalty-days part
 *   EPF / PT / TDS          = per salary structure (FIXED or % of earned basic, rate entered by Accounts)
 *   net                     = gross − deductions, rounded per policy, floored at 0 (flagged)
 */
import { roundFinal } from "./money";
import type { PayrollPolicy } from "./policy";
import type { PayableDaysResult } from "./payable-days";

export interface DeductionRule {
  mode?: "NONE" | "FIXED" | "PERCENT_OF_EARNED_BASIC";
  amount?: number;
  percent?: number;
}
export interface SalaryStructureLite {
  _id?: unknown;
  employeeId: string;
  effectiveFrom: string;
  basic: number;
  hra?: number;
  otherAllowances?: number;
  epf?: DeductionRule;
  pt?: DeductionRule;
  tds?: DeductionRule;
  otherDeductions?: number;
}
export type AdjustmentMap = Partial<Record<
  "payableDays" | "lopDays" | "penaltyDays" | "penaltyAmount" | "otherEarnings" | "otherDeductions",
  number
>>;

export interface SalaryCalc {
  divisor: number;
  divisorMode: string;
  calendarDays: number;
  payableDays: number;
  lopDays: number;
  penaltyDays: number;
  fraction: number;
  earnings: { basic: number; hra: number; otherAllowances: number; otherEarnings: number };
  fullMonthly: { basic: number; hra: number; otherAllowances: number; gross: number };
  grossEarnings: number; // full monthly components + other earnings (payslip "Gross Earnings")
  earnedGross: number; // after proration
  deductions: { lop: number; epf: number; pt: number; tds: number; penalties: number; other: number };
  totalDeductions: number;
  netPay: number;
  roundingAdjustment: number;
  flags: string[];
  trace: string[];
}

const rule = (r: DeductionRule | undefined, earnedBasic: number): number => {
  if (!r || !r.mode || r.mode === "NONE") return 0;
  if (r.mode === "FIXED") return Math.max(0, Math.round(r.amount ?? 0));
  return Math.max(0, Math.round((earnedBasic * (r.percent ?? 0)) / 100));
};

const rs = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Days used for salary. OMS payableDays/lopDays ALREADY include applied penalty days
 * (OMS: penalty is added to the day's LOP). So penalty days are never deducted twice:
 * they only decide how much of the LOP is shown as "Penalties" on the payslip.
 */
export function resolveDays(att: PayableDaysResult, adj: AdjustmentMap) {
  const employed = att.employedDays;
  let payable = att.payableDays;
  let lop = att.lopDays;
  let penaltyDays = att.violationDays;
  const daysOverridden = adj.payableDays !== undefined || adj.lopDays !== undefined;
  if (adj.lopDays !== undefined) {
    lop = adj.lopDays;
    payable = Math.max(0, employed - lop);
  }
  if (adj.payableDays !== undefined) {
    payable = adj.payableDays;
    lop = Math.max(0, employed - payable);
  }
  if (adj.penaltyDays !== undefined) {
    if (!daysOverridden) {
      // Changing penalty days moves the difference between payable and LOP.
      const delta = att.violationDays - adj.penaltyDays;
      payable = Math.min(employed, Math.max(0, payable + delta));
      lop = Math.max(0, employed - payable);
    }
    penaltyDays = adj.penaltyDays;
  }
  return {
    payableDays: Math.min(att.calendarDays, Math.max(0, payable)),
    lopDays: Math.max(0, lop),
    notEmployed: att.calendarDays - employed,
    penaltyDays: Math.max(0, Math.min(penaltyDays, Math.max(0, lop))),
    penaltyAmount: adj.penaltyAmount ?? att.finesPaise,
  };
}

export function computeSalary(args: {
  structure: SalaryStructureLite;
  attendance: PayableDaysResult;
  adjustments?: AdjustmentMap;
  policy: PayrollPolicy;
}): SalaryCalc {
  const { structure: s, attendance: att, policy } = args;
  const adj = args.adjustments ?? {};
  const trace: string[] = [];
  const flags: string[] = [];

  const calendarDays = att.calendarDays;
  const divisor = policy.divisorMode === "FIXED" ? policy.fixedDivisor : calendarDays;
  const d = resolveDays(att, adj);

  let fraction: number;
  if (policy.divisorMode === "FIXED") {
    const unpaid = calendarDays - d.payableDays;
    fraction = Math.min(1, Math.max(0, (divisor - unpaid) / divisor));
    trace.push(`Divisor FIXED ${divisor}; unpaid days = ${calendarDays} − ${d.payableDays} = ${round2(unpaid)}; fraction = (${divisor} − ${round2(unpaid)}) / ${divisor} = ${fraction.toFixed(6)}`);
  } else {
    fraction = Math.min(1, Math.max(0, d.payableDays / calendarDays));
    trace.push(`Divisor CALENDAR ${calendarDays}; fraction = ${d.payableDays} / ${calendarDays} = ${fraction.toFixed(6)}`);
  }

  const basic = Math.round(s.basic);
  const hra = Math.round(s.hra ?? 0);
  const other = Math.round(s.otherAllowances ?? 0);
  const fullGross = basic + hra + other;
  const eBasic = Math.round(basic * fraction);
  const eHra = Math.round(hra * fraction);
  const eOther = Math.round(other * fraction);
  const otherEarnings = Math.max(0, Math.round(adj.otherEarnings ?? 0));
  const earnedGross = eBasic + eHra + eOther + otherEarnings;
  trace.push(`Earned basic ${rs(basic)} × fraction = ${rs(eBasic)}; HRA ${rs(eHra)}; allowances ${rs(eOther)}${otherEarnings ? `; other earnings ${rs(otherEarnings)} (adjustment)` : ""}`);

  // Total reduction from proration (LOP + penalty days + days not employed), split for display only.
  const reduction = fullGross - (eBasic + eHra + eOther);
  const penaltyFromDays = Math.min(reduction, Math.round((fullGross * d.penaltyDays) / divisor));
  const lop = reduction - penaltyFromDays;
  const penalties = penaltyFromDays + Math.max(0, Math.round(d.penaltyAmount));
  if (d.penaltyDays) trace.push(`Penalty days ${d.penaltyDays} (already inside OMS LOP) shown as penalty: ${rs(penaltyFromDays)}`);
  if (d.penaltyAmount) trace.push(`₹ penalties (OMS location mismatch / adjustment) ${rs(d.penaltyAmount)}`);
  trace.push(`Loss of pay (excluding penalty days) ${rs(lop)}`);

  const epf = rule(s.epf, eBasic);
  const pt = rule(s.pt, eBasic);
  const tds = rule(s.tds, eBasic);
  const otherDed = Math.round(s.otherDeductions ?? 0) + Math.max(0, Math.round(adj.otherDeductions ?? 0));
  if (epf) trace.push(`EPF (${s.epf?.mode === "FIXED" ? "fixed" : `${s.epf?.percent}% of earned basic`}) = ${rs(epf)}`);
  if (pt) trace.push(`PT = ${rs(pt)}`);
  if (tds) trace.push(`TDS = ${rs(tds)}`);

  const grossEarnings = fullGross + otherEarnings;
  const totalDeductions = lop + epf + pt + tds + penalties + otherDed;
  const rawNet = grossEarnings - totalDeductions;
  let net = roundFinal(rawNet, policy.rounding);
  if (net < 0) {
    flags.push("NEGATIVE_NET_CLAMPED");
    net = 0;
  }
  trace.push(`Net = ${rs(grossEarnings)} − ${rs(totalDeductions)} = ${rs(rawNet)} → ${policy.rounding} → ${rs(net)}`);

  return {
    divisor,
    divisorMode: policy.divisorMode,
    calendarDays,
    payableDays: round2(d.payableDays),
    lopDays: round2(d.lopDays),
    penaltyDays: round2(d.penaltyDays),
    fraction,
    earnings: { basic: eBasic, hra: eHra, otherAllowances: eOther, otherEarnings },
    fullMonthly: { basic, hra, otherAllowances: other, gross: fullGross },
    grossEarnings,
    earnedGross,
    deductions: { lop, epf, pt, tds, penalties, other: otherDed },
    totalDeductions,
    netPay: net,
    roundingAdjustment: Math.max(0, net) - rawNet,
    flags,
    trace,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** Pick the structure effective for a payroll month (latest effectiveFrom ≤ month). */
export function pickStructure<T extends { effectiveFrom: string }>(list: T[], month: string): T | null {
  return list.filter((x) => x.effectiveFrom <= month).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;
}