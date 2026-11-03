import { NextResponse } from "next/server";
import { handle, HttpError, readJson, requireUser } from "@/lib/auth";
import { FmsEmailLog, FmsPayslip } from "@/models/fms";
import { generatePayslipsForMonth } from "@/lib/payslip-service";
import { MONTH_RE } from "@/lib/dates";

export const GET = handle(async (req: Request) => {
  await requireUser("payslips.view");
  const u = new URL(req.url);
  const filter: Record<string, unknown> = {};
  const month = u.searchParams.get("month");
  if (month) filter.month = month;
  if (u.searchParams.get("employeeId")) filter.employeeId = u.searchParams.get("employeeId");
  const slips = await FmsPayslip.find(filter).sort({ month: -1, employeeId: 1 }).limit(1000).lean();
  const logs = await FmsEmailLog.find({ key: { $in: slips.map((s) => `payslip:${s.employeeId}:${s.month}`) } })
    .select("key status sentAt lastError").lean();
  const byKey = new Map(logs.map((l) => [l.key, l]));
  return NextResponse.json({
    rows: slips.map((s) => ({ ...s, s3Key: undefined, email: byKey.get(`payslip:${s.employeeId}:${s.month}`) ?? null })),
  });
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser("payslips.generate");
  const b = await readJson<{ month?: string; employeeIds?: string[] }>(req);
  if (!b.month || !MONTH_RE.test(b.month)) throw new HttpError(400, "month must be YYYY-MM");
  const results = await generatePayslipsForMonth(b.month, user, b.employeeIds);
  return NextResponse.json({ results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
});
