import { NextResponse } from "next/server";
import { can, handle, HttpError, requireUser } from "@/lib/auth";
import { getEmployee } from "@/lib/oms-read";
import { computeForEmployees } from "@/lib/payroll-service";
import { getPolicy } from "@/lib/settings";
import { currentMonthIST, MONTH_RE } from "@/lib/dates";
import { FmsAdjustment, FmsSalaryStructure } from "@/models/fms";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("employees.view");
  const { id } = await ctx.params;
  const u = new URL(req.url);
  const month = u.searchParams.get("month") || currentMonthIST();
  const mode = u.searchParams.get("mode") === "payroll" ? "payroll" : "soFar";
  if (!MONTH_RE.test(month)) throw new HttpError(400, "month must be YYYY-MM");

  const emp = await getEmployee(id);
  if (!emp) throw new HttpError(404, "Employee not found");
  const policy = await getPolicy();
  const [r] = await computeForEmployees([emp], month, policy, mode);
  const showSalary = can(user, "salary.view");
  const [adjustments, structures] = await Promise.all([
    FmsAdjustment.find({ employeeId: id, month }).sort({ createdAt: -1 }).lean(),
    showSalary ? FmsSalaryStructure.find({ employeeId: id }).sort({ effectiveFrom: -1 }).lean() : Promise.resolve([]),
  ]);

  return NextResponse.json({
    month,
    mode,
    employee: emp,
    attendance: r.attendance,
    adjustmentsApplied: r.adjustmentsApplied,
    adjustmentsSuperseded: r.adjustmentsSuperseded,
    adjustments,
    structure: showSalary ? r.structure : null,
    structures,
    calc: showSalary ? r.calc : null,
    flags: r.flags,
    policy: { divisorMode: policy.divisorMode, fixedDivisor: policy.fixedDivisor, confirmed: policy.confirmed },
  });
});