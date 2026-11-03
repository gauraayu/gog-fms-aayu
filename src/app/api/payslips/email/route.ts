import { NextResponse } from "next/server";
import { handle, HttpError, readJson, requireUser } from "@/lib/auth";
import { sendPayslipEmail } from "@/lib/payslip-service";
import { MONTH_RE } from "@/lib/dates";

/** Manual payslip email: { month, employeeIds: [...], resend?: boolean, reason? } */
export const POST = handle(async (req: Request) => {
  const user = await requireUser("payslips.email");
  const b = await readJson<{ month?: string; employeeIds?: string[]; resend?: boolean; reason?: string }>(req);
  if (!b.month || !MONTH_RE.test(b.month)) throw new HttpError(400, "month must be YYYY-MM");
  const ids = Array.isArray(b.employeeIds) ? b.employeeIds.slice(0, 500).map(String) : [];
  if (!ids.length) throw new HttpError(400, "employeeIds required");
  if (b.resend && String(b.reason ?? "").trim().length < 5) throw new HttpError(400, "A reason is required to resend");
  const results = [];
  for (const id of ids) {
    try {
      results.push({ employeeId: id, ...(await sendPayslipEmail(id, b.month, { trigger: "MANUAL", actor: user, resend: !!b.resend })) });
    } catch (e) {
      results.push({ employeeId: id, status: "Failed", error: (e as Error).message });
    }
  }
  return NextResponse.json({ results });
});
