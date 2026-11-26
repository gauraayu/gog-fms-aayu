/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Salary structure configuration — PURE (used by the page for the live preview AND by the API,
 * which recomputes everything itself before saving; the browser's numbers are never trusted).
 * All amounts in integer paise.
 *
 *   Monthly salary (gross)  = Annual package / 12   (HR may override; both values are stored)
 *   Basic                   = Monthly salary − HRA − Other allowances
 *   EPF "Auto"              = company default rule (Settings → Salary Defaults):
 *                               monthly > threshold → fixed amount   (default ₹25,000 → ₹6,000)
 *                               monthly ≤ threshold → percent        (default 24% of monthly gross)
 *   (24% of ₹25,000 = ₹6,000 — i.e. the company rule is "24% of salary, at most ₹6,000")
 *   PT  "Auto"              = company default amount (default ₹200)
 *   College (CS)            = deducted from what GOG pays (as on the salary slip)
 *   Estimated net (full month) = gross − (EPF + PT + TDS + other deductions + CS)
 *   Employer EPF            = company cost, recorded separately, NEVER deducted from the employee.
 *
 * These are COMPANY DEFAULTS, not statutory rules. EPF / PT applicability, ceilings and state PT slabs
 * must be confirmed by Accounts before production payroll.
 */

export type EpfSetting = "AUTO" | "FIXED" | "PERCENT" | "NONE";
export type PtSetting = "AUTO" | "FIXED" | "NONE";
export type PercentBase = "GROSS" | "BASIC";
export type EngineMode = "NONE" | "FIXED" | "PERCENT_OF_EARNED_BASIC" | "PERCENT_OF_EARNED_GROSS";
export interface EngineRule { mode: EngineMode; amount: number; percent: number }

export interface SalaryDefaults {
  epfThreshold: number; // paise — adjusted monthly payable at or above this → fixed EPF
  epfAboveFixed: number; // paise
  epfBelowPercent: number; // %
  epfPercentBase: PercentBase;
  ptDefault: number; // paise
  /** TDS "Auto" (only when EPF is not applicable): adjusted payable ≤ tdsThreshold → 0, else tdsPercent % */
  tdsThreshold: number; // paise
  tdsPercent: number; // %
  /** Company PF code (state + office + establishment [+ extension]), e.g. "RJJPR0012345000" — pre-fills PF account numbers */
  pfEstablishmentCode: string;
}
export const DEFAULT_SALARY_DEFAULTS: SalaryDefaults = {
  epfThreshold: 2500000, epfAboveFixed: 600000, epfBelowPercent: 24, epfPercentBase: "GROSS", ptDefault: 20000, tdsThreshold: 1000000, tdsPercent: 2, pfEstablishmentCode: "",
};
export function mergeSalaryDefaults(v: Partial<SalaryDefaults> | null | undefined): SalaryDefaults {
  const d = { ...DEFAULT_SALARY_DEFAULTS, ...(v ?? {}) };
  return {
    epfThreshold: Math.max(0, Math.round(Number(d.epfThreshold) || 0)),
    epfAboveFixed: Math.max(0, Math.round(Number(d.epfAboveFixed) || 0)),
    epfBelowPercent: Math.min(100, Math.max(0, Number(d.epfBelowPercent) || 0)),
    epfPercentBase: d.epfPercentBase === "BASIC" ? "BASIC" : "GROSS",
    ptDefault: Math.max(0, Math.round(Number(d.ptDefault) || 0)),
    tdsThreshold: Math.max(0, Math.round(Number(d.tdsThreshold) || 0)),
    tdsPercent: Math.min(100, Math.max(0, Number(d.tdsPercent) || 0)),
    pfEstablishmentCode: normPf(String(d.pfEstablishmentCode ?? "")).slice(0, 22),
  };
}

/* ───────────── statutory numbers ───────────── */

/** "RJ/JPR/0012345/000/0012345" or with spaces → "RJJPR00123450000012345" */
export const normPf = (v: string) => v.toUpperCase().replace(/[\s/\-]/g, "");
export const normDigits = (v: string) => v.replace(/\s/g, "");
/**
 * Checks of the IDs on the EPF slip (only when filled — every field is optional):
 *   UAN   12 digits                         e.g. 101234567890
 *   PF    2 letters (state) + 3 letters (office) + 7–17 digits / letters
 *         e.g. RJJPR0012345000 0012345  (slashes, spaces allowed while typing)
 *   PAN   5 letters + 4 digits + 1 letter    e.g. ABCDE1234F
 *   PRAN  12 digits
 *   ESI   10 or 17 digits
 */
export function validateStatutory(st: { uan?: string; pfAccountNo?: string; pan?: string; pran?: string; esiNumber?: string }): string[] {
  const e: string[] = [];
  const uan = normDigits(st.uan ?? ""), pf = normPf(st.pfAccountNo ?? ""), pan = (st.pan ?? "").trim().toUpperCase();
  const pran = normDigits(st.pran ?? ""), esi = normDigits(st.esiNumber ?? "");
  if (uan && !/^\d{12}$/.test(uan)) e.push("UAN must be exactly 12 digits");
  if (pf && !/^[A-Z]{5}[A-Z0-9]{7,17}$/.test(pf)) e.push("PF account number should look like RJJPR00123450000012345 (state + office code + establishment + member number)");
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) e.push("PAN must look like ABCDE1234F");
  if (pran && !/^\d{12}$/.test(pran)) e.push("PRAN must be exactly 12 digits");
  if (esi && !/^(\d{10}|\d{17})$/.test(esi)) e.push("ESI number must be 10 or 17 digits");
  return e;
}

export interface StructureInput {
  annualPackage: number; // paise (0 = not entered)
  monthlySalary: number; // paise (used when monthlyOverride, else derived from annual)
  monthlyOverride: boolean;
  hra: number;
  otherAllowances: number;
  epfApplicable: boolean;
  epfSetting: EpfSetting;
  epfAmount: number; // paise (FIXED)
  epfPercent: number; // % (PERCENT)
  epfBase: PercentBase; // (PERCENT)
  ptSetting: PtSetting;
  ptAmount: number; // paise (FIXED)
  tds: EngineRule;
  /** AUTO = company rule (only when EPF is not applicable); MANUAL = the tds rule above */
  tdsSetting: "AUTO" | "MANUAL";
  otherDeductions: number;
  collegePaid: number; // 0 = not configured
  employerEpf: { mode: "NONE" | "FIXED" | "PERCENT"; amount: number; percent: number; base: PercentBase };
}

export interface StructureResult {
  monthlySalary: number;
  autoMonthly: number; // annual / 12
  mismatch: boolean; // override differs from annual / 12
  basic: number; hra: number; otherAllowances: number;
  epf: EngineRule; epfSuggested: EngineRule & { label: string };
  pt: EngineRule; ptSuggested: number;
  employerEpfAmount: number;
  preview: {
    gross: number; epf: number; pt: number; tds: number; other: number; college: number;
    totalDeductions: number; net: number;
    companyShare: number | null; // monthly − college (null when college not configured)
    employerEpf: number;
  };
  errors: string[];
  warnings: string[];
}

const pct = (base: number, p: number) => Math.round((base * p) / 100);
const ruleAmount = (r: EngineRule, basic: number, gross: number) =>
  r.mode === "FIXED" ? r.amount : r.mode === "PERCENT_OF_EARNED_BASIC" ? pct(basic, r.percent) : r.mode === "PERCENT_OF_EARNED_GROSS" ? pct(gross, r.percent) : 0;
const inr = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function suggestEpf(monthly: number, d: SalaryDefaults): EngineRule & { label: string } {
  if (monthly >= d.epfThreshold) return { mode: "FIXED", amount: d.epfAboveFixed, percent: 0, label: `${inr(d.epfThreshold)} or more → fixed ${inr(d.epfAboveFixed)} (decided each month on the adjusted payable salary)` };
  const mode: EngineMode = d.epfPercentBase === "BASIC" ? "PERCENT_OF_EARNED_BASIC" : "PERCENT_OF_EARNED_GROSS";
  return { mode, amount: 0, percent: d.epfBelowPercent, label: `Below ${inr(d.epfThreshold)} → ${d.epfBelowPercent}% (decided each month on the adjusted payable salary)` };
}

export function resolveStructure(i: StructureInput, d: SalaryDefaults): StructureResult {
  const errors: string[] = [], warnings: string[] = [];
  const autoMonthly = i.annualPackage > 0 ? Math.round(i.annualPackage / 12) : 0;
  const monthly = i.monthlyOverride || !autoMonthly ? Math.max(0, Math.round(i.monthlySalary)) : autoMonthly;
  const mismatch = i.monthlyOverride && autoMonthly > 0 && Math.abs(monthly - autoMonthly) >= 100;
  if (!(monthly > 0)) errors.push("Enter the annual package or the monthly salary");
  if (mismatch) warnings.push(`Monthly salary ${inr(monthly)} does not match annual package ÷ 12 = ${inr(autoMonthly)} (manual override)`);

  const hra = Math.max(0, Math.round(i.hra)), other = Math.max(0, Math.round(i.otherAllowances));
  const basic = monthly - hra - other;
  if (monthly > 0 && basic <= 0) errors.push("HRA + other allowances must be less than the monthly salary (Basic = monthly − HRA − allowances)");

  const epfSuggested = suggestEpf(monthly, d);
  let epf: EngineRule = { mode: "NONE", amount: 0, percent: 0 };
  if (i.epfApplicable && i.epfSetting !== "NONE") {
    if (i.epfSetting === "AUTO") epf = { mode: epfSuggested.mode, amount: epfSuggested.amount, percent: epfSuggested.percent };
    else if (i.epfSetting === "FIXED") epf = { mode: "FIXED", amount: Math.max(0, Math.round(i.epfAmount)), percent: 0 };
    else epf = { mode: i.epfBase === "BASIC" ? "PERCENT_OF_EARNED_BASIC" : "PERCENT_OF_EARNED_GROSS", amount: 0, percent: Math.min(100, Math.max(0, Number(i.epfPercent) || 0)) };
    if (i.epfSetting === "PERCENT" && !(epf.percent > 0)) errors.push("Enter the EPF percentage");
    if (i.epfSetting === "FIXED" && !(epf.amount > 0)) errors.push("Enter the EPF fixed amount");
  }
  const pt: EngineRule = i.ptSetting === "NONE" ? { mode: "NONE", amount: 0, percent: 0 } : { mode: "FIXED", amount: i.ptSetting === "AUTO" ? d.ptDefault : Math.max(0, Math.round(i.ptAmount)), percent: 0 };

  const sb = Math.max(0, basic);
  const ePF = ruleAmount(epf, sb, monthly), pT = ruleAmount(pt, sb, monthly);
  const epfOn = i.epfApplicable && i.epfSetting !== "NONE";
  // full-month preview of the TDS "Auto" rule (payroll decides it each month on the adjusted payable salary)
  const tds = i.tdsSetting === "AUTO" ? (epfOn || monthly <= d.tdsThreshold ? 0 : Math.round((monthly * d.tdsPercent) / 100)) : ruleAmount(i.tds, sb, monthly);
  const otherDed = Math.max(0, Math.round(i.otherDeductions)), college = Math.max(0, Math.round(i.collegePaid));
  const totalDeductions = ePF + pT + tds + otherDed + college;
  if (monthly > 0 && totalDeductions > monthly) errors.push("Total deductions are more than the monthly salary");
  if (monthly > 0 && college > monthly) errors.push("College amount is more than the monthly salary");
  if (i.epfApplicable && i.epfSetting === "FIXED" && epf.amount > monthly) errors.push("EPF is more than the monthly salary");

  const ee = i.employerEpf;
  const employerEpfAmount = ee.mode === "FIXED" ? Math.max(0, Math.round(ee.amount)) : ee.mode === "PERCENT" ? pct(ee.base === "BASIC" ? sb : monthly, ee.percent) : 0;

  return {
    monthlySalary: monthly, autoMonthly, mismatch,
    basic, hra, otherAllowances: other,
    epf, epfSuggested, pt, ptSuggested: d.ptDefault, employerEpfAmount,
    preview: {
      gross: monthly, epf: ePF, pt: pT, tds, other: otherDed, college, totalDeductions, net: monthly - totalDeductions,
      companyShare: college > 0 ? monthly - college : null, employerEpf: employerEpfAmount,
    },
    errors, warnings,
  };
}

/** Form input from an existing (possibly older) structure — old versions had no package / settings. */
export function inputFromStructure(s: Record<string, any> | null | undefined, d: SalaryDefaults): StructureInput {
  const monthly = s ? (s.monthlySalary ?? (s.basic ?? 0) + (s.hra ?? 0) + (s.otherAllowances ?? 0)) : 0;
  const cfg = s?.config ?? {};
  const epf = s?.epf ?? {};
  const legacyEpf: EpfSetting = !s ? "AUTO" : epf.mode === "FIXED" ? "FIXED" : String(epf.mode ?? "").startsWith("PERCENT") ? "PERCENT" : "NONE";
  const pt = s?.pt ?? {};
  return {
    annualPackage: s?.annualPackage ?? (monthly ? monthly * 12 : 0),
    monthlySalary: monthly,
    monthlyOverride: !!s?.monthlyOverride,
    hra: s?.hra ?? 0,
    otherAllowances: s?.otherAllowances ?? 0,
    epfApplicable: cfg.epfApplicable ?? (s ? legacyEpf !== "NONE" : true),
    epfSetting: cfg.epfSetting ?? (legacyEpf === "NONE" && !s ? "AUTO" : legacyEpf),
    epfAmount: epf.mode === "FIXED" ? epf.amount ?? 0 : 0,
    epfPercent: epf.percent ?? 0,
    epfBase: epf.mode === "PERCENT_OF_EARNED_BASIC" ? "BASIC" : "GROSS",
    ptSetting: cfg.ptSetting ?? (!s ? "AUTO" : pt.mode === "FIXED" ? (pt.amount === d.ptDefault ? "AUTO" : "FIXED") : "NONE"),
    ptAmount: pt.mode === "FIXED" ? pt.amount ?? 0 : d.ptDefault,
    tds: { mode: (s?.tds?.mode as EngineMode) ?? "NONE", amount: s?.tds?.amount ?? 0, percent: s?.tds?.percent ?? 0 },
    tdsSetting: cfg.tdsSetting === "AUTO" || !s ? "AUTO" : "MANUAL",
    otherDeductions: s?.otherDeductions ?? 0,
    collegePaid: s?.collegePaid ?? 0,
    employerEpf: { mode: s?.employerEpf?.mode ?? "NONE", amount: s?.employerEpf?.amount ?? 0, percent: s?.employerEpf?.percent ?? 0, base: s?.employerEpf?.base ?? "GROSS" },
  };
}