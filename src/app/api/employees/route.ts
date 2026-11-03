import { NextResponse } from "next/server";
import { can, handle, HttpError, requireUser } from "@/lib/auth";
import { listEmployees } from "@/lib/oms-read";
import { computeForEmployees } from "@/lib/payroll-service";
import { getPolicy } from "@/lib/settings";
import { currentMonthIST, MONTH_RE } from "@/lib/dates";

export const GET = handle(async (req: Request) => {
  const user = await requireUser("employees.view");
  const u = new URL(req.url);
  const month = u.searchParams.get("month") || currentMonthIST();
  if (!MONTH_RE.test(month)) throw new HttpError(400, "month must be YYYY-MM");
  const page = Math.max(1, Number(u.searchParams.get("page") || 1));
  const limit = Math.min(100, Math.max(5, Number(u.searchParams.get("limit") || 20)));
  const policy = await getPolicy();

  const all = await listEmployees({
    search: u.searchParams.get("search") || undefined,
    dept: u.searchParams.get("dept") || undefined,
    location: u.searchParams.get("location") || undefined,
    status: u.searchParams.get("status") || "active",
    month,
    policy,
  });
  const slice = all.slice((page - 1) * limit, page * limit);
  const results = await computeForEmployees(slice, month, policy, "soFar");
  const showSalary = can(user, "salary.view");

  const rows = results.map((r) => ({
    employeeId: r.employee.id,
    name: r.employee.name,
    email: r.employee.email,
    dept: r.employee.dept,
    designation: r.employee.designation,
    location: r.employee.location,
    status: r.employee.status,
    payableDays: r.calc?.payableDays ?? r.attendance.payableDays,
    consideredDays: r.attendance.consideredDays,
    employedDays: r.attendance.employedDays,
    provisional: r.attendance.provisional,
    leavesApplied: r.attendance.leavesApplied,
    leavesApproved: r.attendance.leavesApproved,
    penaltyDays: r.calc?.penaltyDays ?? r.attendance.violationDays,
    penaltyAmount: r.adjustments.penaltyAmount ?? r.attendance.finesPaise,
    lopDays: r.calc?.lopDays ?? r.attendance.lopDays,
    hasStructure: !!r.structure,
    monthlyGross: showSalary && r.calc ? r.calc.fullMonthly.gross : null,
    netSoFar: showSalary && r.calc ? r.calc.netPay : null,
    flags: r.flags,
  }));
  return NextResponse.json({ month, page, limit, total: all.length, rows });
});