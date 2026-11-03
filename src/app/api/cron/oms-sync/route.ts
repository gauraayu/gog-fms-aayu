import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { connectDB } from "@/lib/db";
import { FmsPayrollRun } from "@/models/fms";
import { syncRunWithOms } from "@/lib/payroll-run";
import { addMonths, currentMonthIST } from "@/lib/dates";

export const maxDuration = 300;

function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const a = Buffer.from(req.headers.get("authorization") ?? "");
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Daily: re-check the last 3 months of payroll against OMS (open runs update, locked runs report drift). */
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await connectDB();
  const from = addMonths(currentMonthIST(), -2);
  const runs = await FmsPayrollRun.find({ month: { $gte: from }, status: { $ne: "Disbursed" } }).select("month").lean();
  const out: Record<string, unknown> = {};
  for (const r of runs) {
    try {
      const s = await syncRunWithOms(r.month, { force: true });
      out[r.month] = { status: s?.status, changedNow: s?.changedNow ?? 0, drift: s && "driftCount" in s ? s.driftCount : 0 };
    } catch (e) {
      out[r.month] = { error: (e as Error).message };
    }
  }
  return NextResponse.json(out);
}