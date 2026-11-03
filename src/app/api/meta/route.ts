import { NextResponse } from "next/server";
import { handle, requireUser } from "@/lib/auth";
import { distinctValues } from "@/lib/oms-read";
import { currentMonthIST, financialYearOf } from "@/lib/dates";
import { getPolicy } from "@/lib/settings";

export const GET = handle(async () => {
  await requireUser("dashboard.view");
  const [vals, policy] = await Promise.all([distinctValues(), getPolicy()]);
  const month = currentMonthIST();
  return NextResponse.json({ ...vals, currentMonth: month, currentFY: financialYearOf(month), policyConfirmed: policy.confirmed });
});
