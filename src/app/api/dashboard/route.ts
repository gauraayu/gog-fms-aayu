import { NextResponse } from "next/server";
import { handle, requireUser } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { FmsChallan, FmsPayrollEntry, FmsPayrollRun, FmsTransaction } from "@/models/fms";
import { OmsViolation } from "@/models/oms-readonly";
import { listEmployees } from "@/lib/oms-read";
import { getPolicy } from "@/lib/settings";
import { addMonths, currentMonthIST, financialYearOf, fyRange, lastNMonths, monthEnd, monthLabel } from "@/lib/dates";

/**
 * Definitions (shown in UI):
 *  - Salary disbursed = fms_financial_transactions SALARY_DISBURSEMENT by disbursement date (IST). Calculated/finalized payroll is NOT counted.
 *  - Previous month = previous calendar month by disbursement date.
 *  - EPF/TDS/GST paid = challans with paymentStatus in policy.challanPaidStatuses, by challan period month.
 *  - Penalties: assessed = OMS violations "Approved for Payroll"; deducted = penalties in Finalized/Disbursed payroll entries.
 */
export const GET = handle(async (req: Request) => {
  await requireUser("dashboard.view");
  await connectDB();
  const u = new URL(req.url);
  const policy = await getPolicy();
  const cur = currentMonthIST();
  const fy = u.searchParams.get("fy") || financialYearOf(cur);
  const location = u.searchParams.get("location") || undefined;
  const { start, end, months: fyMonths } = fyRange(fy);
  const prev = addMonths(cur, -1);
  const chartEnd = fyMonths.includes(cur) ? cur : fyMonths[11] < cur ? fyMonths[11] : cur;
  const chartMonths = lastNMonths(chartEnd, 6);
  const locF = location ? { location } : {};

  // Amounts are encrypted in MongoDB → load the matching rows (decrypted by FMS) and add them up here.
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const sumTx = async (from: string, to: string) =>
    (await FmsTransaction.find({ type: "SALARY_DISBURSEMENT", disbursedOn: { $gte: from, $lte: to }, ...locF }).select("amount").lean()).reduce((s, r) => s + num(r.amount), 0);

  const [salaryFY, salaryPrev, employees, violationsAssessed, closedRuns, chartTx, challans] = await Promise.all([
    sumTx(start, end),
    sumTx(`${prev}-01`, monthEnd(prev)),
    listEmployees({ policy, month: cur, location }).then((l) => l.length),
    OmsViolation.countDocuments({ hrStatus: "Approved for Payroll", period: { $in: fyMonths } }),
    FmsPayrollRun.find({ month: { $in: fyMonths } }).select("_id").lean(),
    FmsTransaction.find({ type: "SALARY_DISBURSEMENT", disbursedOn: { $gte: `${chartMonths[0]}-01`, $lte: monthEnd(chartMonths[5]) }, ...locF }).select("disbursedOn amount").lean(),
    FmsChallan.find({ type: { $in: ["EPF", "TDS", "GST"] }, paymentStatus: { $in: policy.challanPaidStatuses } }).select("type year month amount").lean(),
  ]);

  const penEntries = closedRuns.length
    ? await FmsPayrollEntry.find({ runId: { $in: closedRuns.map((r) => r._id) }, excluded: { $ne: true }, status: { $in: ["Finalized", "Disbursed"] }, ...(location ? { "employee.location": location } : {}) }).select("calc").lean()
    : [];
  const penaltiesTotal = penEntries.reduce((s, e) => s + num((e.calc as { deductions?: { penalties?: number } } | undefined)?.deductions?.penalties), 0);

  const sal = new Map<string, number>();
  for (const t of chartTx) { const m = String(t.disbursedOn).slice(0, 7); sal.set(m, (sal.get(m) ?? 0) + num(t.amount)); }
  const ch = new Map<string, number>();
  for (const c of challans) {
    const ym = `${c.year}-${String(c.month).padStart(2, "0")}`;
    if (!chartMonths.includes(ym)) continue;
    ch.set(`${c.type}:${ym}`, (ch.get(`${c.type}:${ym}`) ?? 0) + num(c.amount));
  }
  const series = (fn: (m: string) => number) => chartMonths.map((m) => ({ month: m, label: monthLabel(m), amount: fn(m) }));

  return NextResponse.json({
    fy,
    location: location ?? null,
    kpis: {
      salaryDisbursedFY: salaryFY,
      salaryDisbursedPrevMonth: salaryPrev,
      prevMonth: prev,
      activeEmployees: employees,
      penaltiesDeductedFY: penaltiesTotal,
      violationsAssessedFY: violationsAssessed,
    },
    charts: {
      salary: series((m) => sal.get(m) ?? 0),
      epf: series((m) => ch.get(`EPF:${m}`) ?? 0),
      tds: series((m) => ch.get(`TDS:${m}`) ?? 0),
      gst: series((m) => ch.get(`GST:${m}`) ?? 0),
    },
    definitions: {
      challanPaidStatuses: policy.challanPaidStatuses,
      locationFilterAppliesTo: "salary disbursed, employees, penalties (challans are organisation-level)",
    },
  });
});