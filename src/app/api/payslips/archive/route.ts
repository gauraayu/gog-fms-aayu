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
  const [rows, months] = await Promise.all([
    FmsEmailLog.find(filter)
      .select("employeeId employeeName month to subject netPay sentAt sentVersion sentByName sentHistory.at sentHistory.version sentHistory.to")
      .sort({ month: -1, employeeName: 1 }).limit(2000).lean(),
    FmsEmailLog.aggregate([
      { $match: { kind: "PAYSLIP", status: "Sent" } },
      { $group: { _id: "$month", count: { $sum: 1 }, total: { $sum: { $ifNull: ["$netPay", 0] } }, lastSentAt: { $max: "$sentAt" } } },
      { $sort: { _id: -1 } },
    ]),
  ]);
  return NextResponse.json({ rows, months: months.map((m) => ({ month: m._id, count: m.count, total: m.total, lastSentAt: m.lastSentAt })) });
});