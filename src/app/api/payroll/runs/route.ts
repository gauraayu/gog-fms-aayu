import { NextResponse } from "next/server";
import { handle, HttpError, readJson, requireUser } from "@/lib/auth";
import { FmsPayrollRun } from "@/models/fms";
import { computeRun } from "@/lib/payroll-run";
import { MONTH_RE } from "@/lib/dates";

export const GET = handle(async () => {
  await requireUser("payroll.view");
  const runs = await FmsPayrollRun.find({}).select("-policySnapshot").sort({ month: -1 }).limit(36).lean();
  return NextResponse.json({ runs });
});

/** Create or recompute a month's payroll (Draft / Under Review only). */
export const POST = handle(async (req: Request) => {
  const user = await requireUser("payroll.prepare");
  const { month } = await readJson<{ month?: string }>(req);
  if (!month || !MONTH_RE.test(month)) throw new HttpError(400, "month must be YYYY-MM");
  const run = await computeRun(month, user);
  return NextResponse.json({ run });
});
