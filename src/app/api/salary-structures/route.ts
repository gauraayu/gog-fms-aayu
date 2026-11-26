/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { clientIp, handle, HttpError, readJson, requireUser } from "@/lib/auth";
import { getEmployee, listEmployees } from "@/lib/oms-read";
import { getPolicy, getSalaryDefaults } from "@/lib/settings";
import { currentMonthIST, MONTH_RE } from "@/lib/dates";
import { FmsPayrollEntry, FmsPayrollRun, FmsSalaryStructure } from "@/models/fms";
import { audit } from "@/lib/audit";
import { pickStructure } from "@/lib/payroll-calc";
import { normDigits, normPf, resolveStructure, validateStatutory, type EngineMode, type EpfSetting, type PercentBase, type PtSetting, type StructureInput } from "@/lib/salary-structure";

const LOCKED = ["Approved", "Finalized", "Disbursed"];

export const GET = handle(async (req: Request) => {
  await requireUser("salary.view");
  const u = new URL(req.url);
  const employeeId = u.searchParams.get("employeeId");
  const defaults = await getSalaryDefaults();
  if (employeeId) {
    // version history (newest first) + employee details from OMS
    const [rows, emp] = await Promise.all([FmsSalaryStructure.find({ employeeId }).sort({ effectiveFrom: -1 }).lean(), getEmployee(employeeId)]);
    return NextResponse.json({
      rows, defaults,
      employee: emp ? { id: emp.id, name: emp.name, dept: emp.dept, designation: emp.designation, location: emp.location, status: emp.status } : null,
    });
  }
  // Overview: every active employee + their current structure
  const month = u.searchParams.get("month") || currentMonthIST();
  const policy = await getPolicy();
  const emps = await listEmployees({ policy, month, search: u.searchParams.get("search") || undefined });
  const all = await FmsSalaryStructure.find({ employeeId: { $in: emps.map((e) => e.id) } }).lean();
  const byEmp = new Map<string, typeof all>();
  for (const s of all) byEmp.set(s.employeeId, [...(byEmp.get(s.employeeId) ?? []), s]);
  const rows = emps.map((e) => {
    const list = byEmp.get(e.id) ?? [];
    return {
      employee: { id: e.id, name: e.name, dept: e.dept, designation: e.designation, location: e.location, status: e.status },
      current: pickStructure(list, month), versions: list.length,
    };
  });
  return NextResponse.json({ month, rows, defaults });
});

const str = (v: unknown) => String(v ?? "").trim().slice(0, 60);
const paise = (v: unknown) => Math.round(Math.max(0, Number(v) || 0) * 100);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

type Body = {
  employeeId?: string; effectiveFrom?: string; reason?: string; notes?: string;
  // all amounts in RUPEES
  annualPackage?: number; monthlySalary?: number; monthlyOverride?: boolean; hra?: number; otherAllowances?: number;
  epfApplicable?: boolean; epfSetting?: string; epfAmount?: number; epfPercent?: number; epfBase?: string;
  ptSetting?: string; ptAmount?: number;
  tds?: { mode?: string; amount?: number; percent?: number };
  /** AUTO = company TDS rule (only when EPF is not applicable), MANUAL = tds above */
  tdsSetting?: string;
  otherDeductions?: number; collegePaid?: number;
  employerEpf?: { mode?: string; amount?: number; percent?: number; base?: string };
  statutory?: { uan?: string; pfAccountNo?: string; esiNumber?: string; pran?: string; pan?: string; taxRegime?: string };
};

/** Build the structure input from the request (rupees → paise). The server recomputes everything. */
function toInput(b: Body): StructureInput {
  const tdsMode = oneOf<EngineMode>(b.tds?.mode, ["NONE", "FIXED", "PERCENT_OF_EARNED_BASIC", "PERCENT_OF_EARNED_GROSS"], "NONE");
  return {
    annualPackage: paise(b.annualPackage),
    monthlySalary: paise(b.monthlySalary),
    monthlyOverride: !!b.monthlyOverride,
    hra: paise(b.hra),
    otherAllowances: paise(b.otherAllowances),
    epfApplicable: b.epfApplicable !== false,
    epfSetting: oneOf<EpfSetting>(b.epfSetting, ["AUTO", "FIXED", "PERCENT", "NONE"], "AUTO"),
    epfAmount: paise(b.epfAmount),
    epfPercent: Math.min(100, Math.max(0, Number(b.epfPercent) || 0)),
    epfBase: oneOf<PercentBase>(b.epfBase, ["GROSS", "BASIC"], "GROSS"),
    ptSetting: oneOf<PtSetting>(b.ptSetting, ["AUTO", "FIXED", "NONE"], "AUTO"),
    ptAmount: paise(b.ptAmount),
    tds: b.tdsSetting === "AUTO" ? { mode: "NONE", amount: 0, percent: 0 } : { mode: tdsMode, amount: tdsMode === "FIXED" ? paise(b.tds?.amount) : 0, percent: tdsMode.startsWith("PERCENT") ? Math.min(100, Math.max(0, Number(b.tds?.percent) || 0)) : 0 },
    tdsSetting: b.tdsSetting === "AUTO" ? "AUTO" : "MANUAL",
    otherDeductions: paise(b.otherDeductions),
    collegePaid: paise(b.collegePaid),
    employerEpf: {
      mode: oneOf(b.employerEpf?.mode, ["NONE", "FIXED", "PERCENT"] as const, "NONE"),
      amount: paise(b.employerEpf?.amount),
      percent: Math.min(100, Math.max(0, Number(b.employerEpf?.percent) || 0)),
      base: oneOf<PercentBase>(b.employerEpf?.base, ["GROSS", "BASIC"], "GROSS"),
    },
  };
}

/** Live preview from the server (same calculation as save). */
export const PUT = handle(async (req: Request) => {
  await requireUser("salary.view");
  const b = await readJson<Body>(req);
  return NextResponse.json(resolveStructure(toInput(b), await getSalaryDefaults()));
});

/**
 * Save a salary structure effective from a month. Amounts in rupees.
 * New month → new version (older versions are never changed, payroll history stays).
 * Same month again → that month's version is replaced (allowed only while its payroll is not Approved / Finalized / Disbursed).
 */
export const POST = handle(async (req: Request) => {
  const user = await requireUser("salary.manage");
  const b = await readJson<Body>(req);
  const employeeId = String(b.employeeId ?? "");
  const effectiveFrom = String(b.effectiveFrom ?? "");
  if (!employeeId || !MONTH_RE.test(effectiveFrom)) throw new HttpError(400, "Employee and effective month are required");
  const reason = String(b.reason ?? "").trim();
  if (reason.length < 5) throw new HttpError(400, "Reason for the change is required (at least 5 characters)");
  if (!(await getEmployee(employeeId))) throw new HttpError(404, "Employee not found in OMS");

  const defaults = await getSalaryDefaults();
  const input = toInput(b);
  const r = resolveStructure(input, defaults);
  if (r.errors.length) throw new HttpError(400, r.errors.join(" · "));

  // never touch a payroll month that is already approved / finalized / disbursed
  const [lockedRun, lockedEntry] = await Promise.all([
    FmsPayrollRun.findOne({ month: { $gte: effectiveFrom }, status: { $in: LOCKED } }).select("month status").lean(),
    FmsPayrollEntry.findOne({ employeeId, month: { $gte: effectiveFrom }, status: { $in: LOCKED } }).select("month status").lean(),
  ]);
  const locked = lockedEntry ?? lockedRun;
  if (locked) throw new HttpError(409, `Payroll for ${locked.month} is ${locked.status} — choose an effective month after it`);

  const all = await FmsSalaryStructure.find({ employeeId }).lean();
  const sameMonth = all.find((s) => s.effectiveFrom === effectiveFrom) ?? null;
  const prev = sameMonth ?? pickStructure(all, effectiveFrom);
  const prevStat = (prev?.statutory ?? {}) as Record<string, string>;
  const keep = (k: string, v: unknown) => str(v) || str(prevStat[k]); // never clear saved UAN / PF numbers by accident
  const statutory = {
    uan: b.statutory ? str(b.statutory.uan) : str(prevStat.uan),
    pfAccountNo: b.statutory ? str(b.statutory.pfAccountNo) : str(prevStat.pfAccountNo),
    esiNumber: b.statutory ? str(b.statutory.esiNumber) : str(prevStat.esiNumber),
    pran: b.statutory ? str(b.statutory.pran) : str(prevStat.pran),
    pan: (b.statutory ? str(b.statutory.pan) : str(prevStat.pan)).toUpperCase(),
    taxRegime: keep("taxRegime", b.statutory?.taxRegime) || "Regular",
  };

  const stErr = validateStatutory(statutory);
  if (stErr.length) throw new HttpError(400, stErr.join(" · "));
  statutory.uan = normDigits(statutory.uan);
  statutory.pran = normDigits(statutory.pran);
  statutory.esiNumber = normDigits(statutory.esiNumber);
  statutory.pfAccountNo = normPf(statutory.pfAccountNo);
  // a PF number that is only the company code (nothing typed after it) is not saved
  if (defaults.pfEstablishmentCode && statutory.pfAccountNo === defaults.pfEstablishmentCode) statutory.pfAccountNo = "";

  const fields = {
    employeeId, effectiveFrom,
    annualPackage: input.annualPackage, monthlySalary: r.monthlySalary, monthlyOverride: input.monthlyOverride && r.mismatch,
    basic: r.basic, hra: r.hra, otherAllowances: r.otherAllowances,
    epf: r.epf, pt: r.pt, tds: input.tds,
    otherDeductions: input.otherDeductions, collegePaid: input.collegePaid,
    employerEpf: { ...input.employerEpf, monthly: r.employerEpfAmount },
    config: {
      epfApplicable: input.epfApplicable, epfSetting: input.epfApplicable ? input.epfSetting : "NONE", epfBase: input.epfBase, ptSetting: input.ptSetting, tdsSetting: input.tdsSetting,
      epfSuggested: r.epfSuggested, defaultsUsed: defaults, estimatedNet: r.preview.net,
    },
    statutory,
    notes: b.notes ? String(b.notes).slice(0, 500) : undefined,
    changeReason: reason.slice(0, 500),
    updatedBy: user.employeeId,
  };

  let saved;
  if (sameMonth) {
    saved = await FmsSalaryStructure.findOneAndUpdate({ _id: sameMonth._id }, { $set: fields }, { returnDocument: "after" }).lean();
  } else {
    saved = (await FmsSalaryStructure.create({ ...fields, createdBy: user.employeeId })).toObject();
  }

  const summary = (s: Record<string, any> | null) => s && ({
    effectiveFrom: s.effectiveFrom,
    annualPackage: s.annualPackage ?? null,
    monthlySalary: s.monthlySalary ?? (s.basic ?? 0) + (s.hra ?? 0) + (s.otherAllowances ?? 0),
    basic: s.basic, hra: s.hra, otherAllowances: s.otherAllowances,
    epf: { setting: s.config?.epfSetting ?? null, ...(s.epf ?? {}) },
    pt: { setting: s.config?.ptSetting ?? null, ...(s.pt ?? {}) },
    tds: s.tds, otherDeductions: s.otherDeductions, collegePaid: s.collegePaid, employerEpf: s.employerEpf ?? null,
  });
  await audit(user, sameMonth ? "salary.structure_replaced" : "salary.structure_version", {
    entity: "salary-structure", entityId: employeeId,
    previousValue: summary(prev as Record<string, any> | null), updatedValue: summary(saved as Record<string, any>),
    reason, ip: await clientIp(),
  });
  return NextResponse.json({ success: true, replaced: !!sameMonth, structure: saved, preview: r.preview, warnings: r.warnings });
});