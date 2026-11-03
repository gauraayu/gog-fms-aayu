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

  const sumTx = async (from: string, to: string) => {
    const r = await FmsTransaction.aggregate([
      { $match: { type: "SALARY_DISBURSEMENT", disbursedOn: { $gte: from, $lte: to }, ...locF } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    return r[0]?.total ?? 0;
  };

  const [salaryFY, salaryPrev, employees, violationsAssessed, closedRuns, salarySeries, challanSeries] = await Promise.all([
    sumTx(start, end),
    sumTx(`${prev}-01`, monthEnd(prev)),
    listEmployees({ policy, month: cur, location }).then((l) => l.length),
    OmsViolation.countDocuments({ hrStatus: "Approved for Payroll", period: { $in: fyMonths } }),
    FmsPayrollRun.find({ month: { $in: fyMonths } }).select("_id").lean(),
    FmsTransaction.aggregate([
      { $match: { type: "SALARY_DISBURSEMENT", disbursedOn: { $gte: `${chartMonths[0]}-01`, $lte: monthEnd(chartMonths[5]) }, ...locF } },
      { $group: { _id: { $substrCP: ["$disbursedOn", 0, 7] }, total: { $sum: "$amount" } } },
    ]),
    FmsChallan.aggregate([
      { $match: { type: { $in: ["EPF", "TDS", "GST"] }, paymentStatus: { $in: policy.challanPaidStatuses } } },
      {
        $project: {
          type: 1, amount: 1,
          ym: { $concat: [{ $toString: "$year" }, "-", { $cond: [{ $lt: ["$month", 10] }, { $concat: ["0", { $toString: "$month" }] }, { $toString: "$month" }] }] },
        },
      },
      { $match: { ym: { $in: chartMonths } } },
      { $group: { _id: { type: "$type", ym: "$ym" }, total: { $sum: "$amount" } } },
    ]),
  ]);

  const penAgg = closedRuns.length
    ? await FmsPayrollEntry.aggregate([
        { $match: { runId: { $in: closedRuns.map((r) => r._id) }, excluded: { $ne: true }, status: { $in: ["Finalized", "Disbursed"] }, ...(location ? { "employee.location": location } : {}) } },
        { $group: { _id: null, total: { $sum: "$calc.deductions.penalties" } } },
      ])
    : [];

  const sal = new Map(salarySeries.map((s: { _id: string; total: number }) => [s._id, s.total]));
  const ch = new Map(challanSeries.map((s: { _id: { type: string; ym: string }; total: number }) => [`${s._id.type}:${s._id.ym}`, s.total]));
  const series = (fn: (m: string) => number) => chartMonths.map((m) => ({ month: m, label: monthLabel(m), amount: fn(m) }));

  return NextResponse.json({
    fy,
    location: location ?? null,
    kpis: {
      salaryDisbursedFY: salaryFY,
      salaryDisbursedPrevMonth: salaryPrev,
      prevMonth: prev,
      activeEmployees: employees,
      penaltiesDeductedFY: penAgg[0]?.total ?? 0,
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