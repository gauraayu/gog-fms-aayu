import { NextResponse } from "next/server";
import { handle, requireUser } from "@/lib/auth";
import { FmsEmailLog } from "@/models/fms";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Month-wise archive of every payslip that was actually emailed. */
export const GET = handle(async (req: Request) => {
  await requireUser("payslips.view");
  const u = new URL(req.url);
  const month = u.searchParams.get("month");
  const search = u.searchParams.get("search");
  const filter: Record<string, unknown> = { kind: "PAYSLIP", status: "Sent" };
  if (month) filter.month = month;
  if (search) {
    const re = { $regex: escapeRe(search), $options: "i" };
    filter.$or = [{ employeeId: re }, { employeeName: re }, { to: re }];
  }
  const [rows, sent] = await Promise.all([
    FmsEmailLog.find(filter)
      .select("employeeId employeeName month to subject netPay sentAt sentVersion sentByName sentHistory.at sentHistory.version sentHistory.to")
      .sort({ month: -1, employeeName: 1 }).limit(2000).lean(),
    FmsEmailLog.find({ kind: "PAYSLIP", status: "Sent" }).select("month netPay sentAt").lean(),
  ]);
  // netPay is encrypted in MongoDB → month totals are added up here
  const byMonth = new Map<string, { month: string; count: number; total: number; lastSentAt: Date | null }>();
  for (const l of sent) {
    const k = String(l.month ?? "");
    const m = byMonth.get(k) ?? { month: k, count: 0, total: 0, lastSentAt: null };
    m.count++;
    m.total += typeof l.netPay === "number" ? l.netPay : 0;
    if (l.sentAt && (!m.lastSentAt || l.sentAt > m.lastSentAt)) m.lastSentAt = l.sentAt;
    byMonth.set(k, m);
  }
  const months = [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
  return NextResponse.json({ rows, months });
});