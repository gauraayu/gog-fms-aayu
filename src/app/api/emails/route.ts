import { NextResponse } from "next/server";
import { handle, HttpError, readJson, requireUser } from "@/lib/auth";
import { FmsEmailLog } from "@/models/fms";
import { sendPayslipEmail } from "@/lib/payslip-service";

export const GET = handle(async (req: Request) => {
  await requireUser("emails.view");
  const u = new URL(req.url);
  const f: Record<string, unknown> = {};
  for (const k of ["status", "month", "kind", "trigger"]) if (u.searchParams.get(k)) f[k] = u.searchParams.get(k);
  if (u.searchParams.get("employeeId")) f.employeeId = u.searchParams.get("employeeId");
  const rows = await FmsEmailLog.find(f).sort({ updatedAt: -1 }).limit(500).lean();
  const counts = await FmsEmailLog.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
  return NextResponse.json({ rows, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
});

/** Retry failed payslip emails: { keys: ["payslip:EMP1:2026-09", ...] } */
export const POST = handle(async (req: Request) => {
  const user = await requireUser("payslips.email");
  const { keys } = await readJson<{ keys?: string[] }>(req);
  if (!Array.isArray(keys) || !keys.length) throw new HttpError(400, "keys required");
  const results = [];
  for (const key of keys.slice(0, 200)) {
    const [kind, emp, month] = String(key).split(":");
    if (kind !== "payslip" || !emp || !month) {
      results.push({ key, status: "Skipped" });
      continue;
    }
    try {
      results.push({ key, ...(await sendPayslipEmail(emp, month, { trigger: "MANUAL", actor: user })) });
    } catch (e) {
      results.push({ key, status: "Failed", error: (e as Error).message });
    }
  }
  return NextResponse.json({ results });
});
