/**
 * Salary calculation engine — PURE. All amounts in integer paise.
 *
 *   fraction (CALENDAR_DAYS) = payableDays / calendarDays
 *   fraction (FIXED divisor) = (divisor − unpaidDays) / divisor, unpaidDays = calendarDays − payableDays
 *   earned component        = round(component × fraction)
 *   payable/LOP/penalty days come from OMS (penalty days are already part of OMS LOP)
 *   reduction               = full monthly gross − earned gross
 *   penalty line            = min(reduction, round(fullGross × penaltyDays / divisor)) + ₹ penalties + % fines
 *   % fine (Dress Code / Full Attire, from 04/11/2026) = round(fullGross / divisor × percent / 100), one line each
 *   LOP line                = reduction − penalty-days part
 *   ADJUSTED MONTHLY PAYABLE = earned components + other earnings − ₹ penalties − % fines
 *                              (after attendance, LOP, unpaid leave, penalty days and ₹ penalties;
 *                               BEFORE EPF / PT / TDS / other deductions / college)
 *   EPF "Auto"  (company rule, Settings): adjusted ≥ ₹25,000 → ₹6,000 · below → 24% of adjusted
 *   TDS "Auto"  (company rule, only when EPF is NOT applicable): adjusted ≤ ₹10,000 → 0 · above → 2% of adjusted
 *   EPF / PT / TDS manual   = per salary structure (FIXED, or % of earned basic / salary)
 *   College (CS)            = configured amount × the same payable fraction (both payers share the LOP)
 *   Employer EPF            = recorded only, never deducted from the employee
 *   net                     = gross − deductions, rounded per policy, floored at 0 (flagged)
 * EPF / TDS are worked out on the adjusted amount — never on the final in-hand (no circular maths).
 */
import { DEFAULT_SALARY_DEFAULTS, type SalaryDefaults } from "./salary-structure";
import { roundFinal } from "./money";
import type { PayrollPolicy } from "./policy";
import type { PayableDaysResult } from "./payable-days";

export interface DeductionRule {
  mode?: "NONE" | "FIXED" | "PERCENT_OF_EARNED_BASIC" | "PERCENT_OF_EARNED_GROSS";
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
  /** "Salary to be Paid by College (CS)" — paise / month, deducted from what GOG pays */
  collegePaid?: number;
  /** settings from the Salary Structure page (newer structures) */
  config?: { epfApplicable?: boolean; epfSetting?: string; tdsSetting?: string };
  employerEpf?: { mode?: string; amount?: number; percent?: number; base?: string };
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
  deductions: { lop: number; epf: number; pt: number; tds: number; penalties: number; other: number; college: number };
  /** salary left after attendance, LOP and penalties — before EPF / TDS / other deductions. EPF & TDS "Auto" use this. */
  adjustedPayable: number;
  epfApplicable: boolean;
  /** AUTO_FIXED | AUTO_PERCENT | FIXED | PERCENT | NONE */
  epfMode: string;
  /** AUTO | AUTO_BELOW_LIMIT | MANUAL | NONE */
  tdsMode: string;
  /** company cost — never part of deductions */
  employerEpf: number;
  /** configured college amount (full month) and the part payable this month */
  college: { configured: number; payable: number };
  /** % fines inside deductions.penalties (one line per fine) */
  fineLines: { type: string; date: string; instance: number; percent: number; amount: number }[];
  totalDeductions: number;
  netPay: number;
  roundingAdjustment: number;
  flags: string[];
  trace: string[];
}

/** FIXED = same every month · PERCENT_OF_EARNED_BASIC / _GROSS = % of the earned (after LOP) basic / basic+HRA+allowances */
const rule = (r: DeductionRule | undefined, earnedBasic: number, earnedComponents = earnedBasic): number => {
  if (!r || !r.mode || r.mode === "NONE") return 0;
  if (r.mode === "FIXED") return Math.max(0, Math.round(r.amount ?? 0));
  const base = r.mode === "PERCENT_OF_EARNED_GROSS" ? earnedComponents : earnedBasic;
  return Math.max(0, Math.round((base * (r.percent ?? 0)) / 100));
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
  /** company rules for EPF / TDS "Auto" (Settings → Salary Defaults) */
  salaryDefaults?: SalaryDefaults;
}): SalaryCalc {
  const { structure: s, attendance: att, policy } = args;
  const sd = args.salaryDefaults ?? DEFAULT_SALARY_DEFAULTS;
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
  const oneDayGross = fullGross / divisor;
  const fineLines = (att.percentFines ?? []).map((f) => ({ type: f.type, date: f.date, instance: f.instance, percent: f.percent, amount: Math.round((oneDayGross * f.percent) / 100) }));
  const fineTotal = fineLines.reduce((s, f) => s + f.amount, 0);
  const penalties = penaltyFromDays + Math.max(0, Math.round(d.penaltyAmount)) + fineTotal;
  for (const f of fineLines) trace.push(`${f.type === "FULL_ATTIRE" ? "Full Attire" : "Dress Code"} #${f.instance} on ${f.date}: ${f.percent}% of one day's gross ${rs(Math.round(oneDayGross))} = ${rs(f.amount)}`);
  if (d.penaltyDays) trace.push(`Penalty days ${d.penaltyDays} (already inside OMS LOP) shown as penalty: ${rs(penaltyFromDays)}`);
  if (d.penaltyAmount) trace.push(`₹ penalties (OMS location mismatch / HR ₹ penalty / adjustment) ${rs(d.penaltyAmount)}`);
  trace.push(`Loss of pay (excluding penalty days) ${rs(lop)}`);

  const eComp = eBasic + eHra + eOther;
  // Adjusted monthly payable: after attendance / LOP / penalty days (already in eComp) and ₹ penalties + fines.
  const adjustedPayable = Math.max(0, eComp + otherEarnings - Math.max(0, Math.round(d.penaltyAmount)) - fineTotal);
  trace.push(`Adjusted monthly payable (before EPF / TDS) = ${rs(eComp + otherEarnings)} − ₹ penalties ${rs(Math.max(0, Math.round(d.penaltyAmount)) + fineTotal)} = ${rs(adjustedPayable)}`);

  // ── EPF
  const cfg = s.config ?? {};
  const epfApplicable = cfg.epfApplicable !== undefined ? cfg.epfApplicable !== false : !!s.epf && s.epf.mode !== "NONE" && s.epf.mode !== undefined;
  let epf = 0, epfMode = "NONE";
  if (cfg.epfApplicable === false || cfg.epfSetting === "NONE") {
    epf = 0; epfMode = "NONE";
  } else if (cfg.epfSetting === "AUTO") {
    if (adjustedPayable >= sd.epfThreshold) { epf = sd.epfAboveFixed; epfMode = "AUTO_FIXED"; }
    else { epf = Math.round((adjustedPayable * sd.epfBelowPercent) / 100); epfMode = "AUTO_PERCENT"; }
    epf = Math.min(epf, adjustedPayable);
    trace.push(epfMode === "AUTO_FIXED"
      ? `EPF auto: adjusted ${rs(adjustedPayable)} ≥ ${rs(sd.epfThreshold)} → fixed ${rs(epf)}`
      : `EPF auto: adjusted ${rs(adjustedPayable)} < ${rs(sd.epfThreshold)} → ${sd.epfBelowPercent}% = ${rs(epf)}`);
  } else {
    epf = rule(s.epf, eBasic, eComp);
    epfMode = !s.epf?.mode || s.epf.mode === "NONE" ? "NONE" : s.epf.mode === "FIXED" ? "FIXED" : "PERCENT";
    if (epf) trace.push(`EPF (${s.epf?.mode === "FIXED" ? "fixed" : `${s.epf?.percent}% of earned ${s.epf?.mode === "PERCENT_OF_EARNED_GROSS" ? "salary" : "basic"}`}) = ${rs(epf)}`);
  }
  const pt = rule(s.pt, eBasic, eComp);
  if (pt) trace.push(`PT = ${rs(pt)}`);

  // ── TDS (company "Auto" rule only for employees WITHOUT EPF)
  let tds = 0, tdsMode = "NONE";
  if (cfg.tdsSetting === "AUTO") {
    if (epfApplicable && epfMode !== "NONE") { tdsMode = "NONE"; trace.push("TDS auto: not applied (EPF is applicable)"); }
    else if (adjustedPayable <= sd.tdsThreshold) { tdsMode = "AUTO_BELOW_LIMIT"; trace.push(`TDS auto: adjusted ${rs(adjustedPayable)} ≤ ${rs(sd.tdsThreshold)} → ₹0`); }
    else { tds = Math.round((adjustedPayable * sd.tdsPercent) / 100); tdsMode = "AUTO"; trace.push(`TDS auto: adjusted ${rs(adjustedPayable)} > ${rs(sd.tdsThreshold)} → ${sd.tdsPercent}% = ${rs(tds)}`); }
  } else {
    tds = rule(s.tds, eBasic, eComp);
    tdsMode = tds ? "MANUAL" : "NONE";
    if (tds) trace.push(`TDS = ${rs(tds)}`);
  }
  const otherDed = Math.round(s.otherDeductions ?? 0) + Math.max(0, Math.round(adj.otherDeductions ?? 0));

  // ── College share: payable days apply to the college part too
  const collegeConfigured = Math.max(0, Math.round(s.collegePaid ?? 0));
  const college = Math.round(collegeConfigured * fraction);
  if (collegeConfigured) trace.push(`Salary to be paid by college (CS) ${rs(collegeConfigured)} × fraction = ${rs(college)}`);

  // ── Employer EPF (record only)
  const er = s.employerEpf ?? {};
  const employerEpf = er.mode === "FIXED" ? Math.max(0, Math.round(er.amount ?? 0)) : er.mode === "PERCENT" ? Math.round(((er.base === "BASIC" ? eBasic : adjustedPayable) * (er.percent ?? 0)) / 100) : 0;
  if (employerEpf) trace.push(`Employer EPF (company cost, not deducted) ${rs(employerEpf)}`);
  const grossEarnings = fullGross + otherEarnings;
  const totalDeductions = lop + epf + pt + tds + penalties + otherDed + college;
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
    deductions: { lop, epf, pt, tds, penalties, other: otherDed, college },
    adjustedPayable,
    epfApplicable: epfApplicable && epfMode !== "NONE",
    epfMode,
    tdsMode,
    employerEpf,
    college: { configured: collegeConfigured, payable: college },
    fineLines,
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