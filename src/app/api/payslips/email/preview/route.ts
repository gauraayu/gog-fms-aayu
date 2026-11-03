import { NextResponse } from "next/server";
import { handle, HttpError, requireUser } from "@/lib/auth";
import { buildPayslipEmail } from "@/lib/payslip-service";
import { MONTH_RE } from "@/lib/dates";

/** Preview exactly what "Send" will email: recipient, subject, body and the attached payslip. Nothing is sent. */
export const GET = handle(async (req: Request) => {
  await requireUser("payslips.email");
  const u = new URL(req.url);
  const month = u.searchParams.get("month") || "";
  const employeeId = u.searchParams.get("employeeId") || "";
  if (!MONTH_RE.test(month) || !employeeId) throw new HttpError(400, "month and employeeId are required");
  const m = await buildPayslipEmail(employeeId, month);
  return NextResponse.json({
    employeeId, month, employeeName: m.employeeName, to: m.to, validRecipient: m.validRecipient,
    subject: m.subject, html: m.html, attachmentName: m.attachmentName,
    payslipId: String(m.slip._id), version: m.slip.version ?? 1, netPay: m.slip.netPay,
    alreadySent: m.alreadySent, sentAt: m.sentAt,
  });
});