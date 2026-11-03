import { NextResponse } from "next/server";
import { clientIp, handle, HttpError, readJson, requireUser } from "@/lib/auth";
import { getEmployee, listEmployees } from "@/lib/oms-read";
import { getPolicy } from "@/lib/settings";
import { currentMonthIST, MONTH_RE } from "@/lib/dates";
import { FmsPayrollRun, FmsSalaryStructure } from "@/models/fms";
import { audit } from "@/lib/audit";
import { pickStructure } from "@/lib/payroll-calc";

export const GET = handle(async (req: Request) => {
  await requireUser("salary.view");
  const u = new URL(req.url);
  const employeeId = u.searchParams.get("employeeId");
  if (employeeId) {
    const rows = await FmsSalaryStructure.find({ employeeId }).sort({ effectiveFrom: -1 }).lean();
    return NextResponse.json({ rows });
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
    return { employee: { id: e.id, name: e.name, dept: e.dept, designation: e.designation }, current: pickStructure(list, month), versions: list.length };
  });
  return NextResponse.json({ month, rows });
});

const str = (v: unknown) => String(v ?? "").trim().slice(0, 60);

type RuleIn = { mode?: string; amount?: number; percent?: number };
const rule = (r?: RuleIn) => {
  const mode = r?.mode === "FIXED" || r?.mode === "PERCENT_OF_EARNED_BASIC" ? r.mode : "NONE";
  const amount = Math.round(Math.max(0, Number(r?.amount) || 0) * 100);
  const percent = Math.max(0, Math.min(100, Number(r?.percent) || 0));
  return { mode, amount: mode === "FIXED" ? amount : 0, percent: mode === "PERCENT_OF_EARNED_BASIC" ? percent : 0 };
};

/** Create a NEW effective-dated version. Existing versions are immutable (history never changes). Amounts in rupees. */
export const POST = handle(async (req: Request) => {
  const user = await requireUser("salary.manage");
  const b = await readJson<{
    employeeId?: string; effectiveFrom?: string; basic?: number; hra?: number; otherAllowances?: number;
    epf?: RuleIn; pt?: RuleIn; tds?: RuleIn; otherDeductions?: number; collegePaid?: number; notes?: string; reason?: string;
    statutory?: { uan?: string; pfAccountNo?: string; esiNumber?: string; pran?: string; pan?: string; taxRegime?: string };
  }>(req);
  const employeeId = String(b.employeeId ?? "");
  const effectiveFrom = String(b.effectiveFrom ?? "");
  if (!employeeId || !MONTH_RE.test(effectiveFrom)) throw new HttpError(400, "employeeId and effectiveFrom (YYYY-MM) are required");
  const reason = String(b.reason ?? "").trim();
  if (reason.length < 5) throw new HttpError(400, "Reason is required");
  const basic = Number(b.basic);
  if (!(basic > 0)) throw new HttpError(400, "Basic salary must be > 0");
  if (!(await getEmployee(employeeId))) throw new HttpError(404, "Employee not found");

  const locked = await FmsPayrollRun.findOne({ month: { $gte: effectiveFrom }, status: { $in: ["Approved", "Finalized", "Disbursed"] } }).lean();
  if (locked) throw new HttpError(409, `Payroll ${locked.month} is ${locked.status}; choose an effective month after it`);

  const prev = pickStructure(await FmsSalaryStructure.find({ employeeId }).lean(), effectiveFrom);
  const doc = await FmsSalaryStructure.create({
    employeeId,
    effectiveFrom,
    basic: Math.round(basic * 100),
    hra: Math.round(Math.max(0, Number(b.hra) || 0) * 100),
    otherAllowances: Math.round(Math.max(0, Number(b.otherAllowances) || 0) * 100),
    epf: rule(b.epf),
    pt: rule(b.pt),
    tds: rule(b.tds),
    otherDeductions: Math.round(Math.max(0, Number(b.otherDeductions) || 0) * 100),
    collegePaid: Math.round(Math.max(0, Number(b.collegePaid) || 0) * 100),
    statutory: {
      uan: str(b.statutory?.uan), pfAccountNo: str(b.statutory?.pfAccountNo), esiNumber: str(b.statutory?.esiNumber),
      pran: str(b.statutory?.pran), pan: str(b.statutory?.pan).toUpperCase(), taxRegime: str(b.statutory?.taxRegime) || "Regular",
    },
    notes: b.notes,
    createdBy: user.employeeId,
  });
  await audit(user, "salary.structure_version", {
    entity: "salary-structure", entityId: employeeId, previousValue: prev ?? null, updatedValue: doc.toObject(), reason, ip: await clientIp(),
  });
  return NextResponse.json({ success: true, structure: doc });
});