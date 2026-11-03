import { connectDB } from "./db";
import { FmsEmailLog, FmsPayrollEntry, FmsPayrollRun, FmsPayslip } from "@/models/fms";
import { renderPayslipPdf } from "./payslip-pdf";
import { putObject, buildKey, getObjectBuffer } from "./s3";
import { sendFmsMail, payslipEmailHtml, isValidRecipient } from "./fms-mail";
import { audit } from "./audit";
import { monthLabel } from "./dates";
import { HttpError } from "./auth";
import type { SalaryCalc } from "./payroll-calc";

type Actor = { employeeId: string; name: string; role: string } | null;
const PAYSLIP_READY = ["Finalized", "Disbursed"];

export async function generatePayslipsForMonth(month: string, actor: Actor, employeeIds?: string[]) {
  await connectDB();
  const run = await FmsPayrollRun.findOne({ month }).lean();
  if (!run) throw new HttpError(404, "No payroll for this month");
  // Per employee: only employees whose payroll is Finalized / Disbursed get a payslip.
  const filter: Record<string, unknown> = { runId: run._id, excluded: { $ne: true }, calc: { $ne: null }, status: { $in: PAYSLIP_READY } };
  if (employeeIds?.length) filter.employeeId = { $in: employeeIds };
  const entries = await FmsPayrollEntry.find(filter).lean();
  if (!entries.length) throw new HttpError(409, "No Finalized employee to generate a payslip for — finalize the employee's payroll first");
  const results: { employeeId: string; ok: boolean; error?: string }[] = [];
  for (const e of entries) {
    try {
      const buf = renderPayslipPdf({
        employee: { id: e.employeeId, ...(e.employee as object) } as never,
        month,
        calc: e.calc as SalaryCalc,
        generatedAt: new Date(),
      });
      const key = buildKey(`payslips/${month}`, `payslip_${e.employeeId}_${month}.pdf`, "application/pdf");
      await putObject(key, buf, "application/pdf");
      const prev = await FmsPayslip.findOne({ employeeId: e.employeeId, month }).lean();
      await FmsPayslip.updateOne(
        { employeeId: e.employeeId, month },
        { $set: { s3Key: key, entryId: e._id, runId: run._id, netPay: e.netPay, generatedBy: actor?.employeeId ?? "SYSTEM" }, $inc: { version: prev ? 1 : 0 } },
        { upsert: true },
      );
      await audit(actor, "payslip.generate", { entity: "payslip", entityId: `${e.employeeId}:${month}`, previousValue: prev?.s3Key, updatedValue: key });
      results.push({ employeeId: e.employeeId, ok: true });
    } catch (err) {
      results.push({ employeeId: e.employeeId, ok: false, error: (err as Error).message });
    }
  }
  return results;
}

/** Exactly what will be emailed for one payslip (used by Preview and by Send). */
export async function buildPayslipEmail(employeeId: string, month: string) {
  await connectDB();
  const st = await FmsPayrollEntry.findOne({ month, employeeId }).select("status").lean();
  if (!st || !PAYSLIP_READY.includes(st.status ?? "")) throw new HttpError(409, "This employee's payroll is not finalized");
  const slip = await FmsPayslip.findOne({ employeeId, month }).lean();
  if (!slip) throw new HttpError(404, "Payslip not generated yet");
  const entry = await FmsPayrollEntry.findOne({ month, employeeId }).lean();
  const emp = (entry?.employee ?? {}) as { name?: string; email?: string };
  const to = String(emp.email ?? "");
  const log = await FmsEmailLog.findOne({ key: `payslip:${employeeId}:${month}` }).select("status sentAt").lean();
  return {
    slip,
    employeeName: emp.name ?? "",
    to,
    validRecipient: isValidRecipient(to),
    subject: `Payslip — ${monthLabel(month)} — Geeks of Gurukul`,
    html: payslipEmailHtml(emp.name ?? "", monthLabel(month)),
    attachmentName: `Payslip_${employeeId}_${month}.pdf`,
    alreadySent: log?.status === "Sent",
    sentAt: log?.sentAt ?? null,
  };
}

/**
 * Send one payslip email — ONLY when a user clicks Send (no automatic sending). Duplicate-safe: one fms_email_logs doc per payslip:<emp>:<month>;
 * a Sent log is never re-sent unless `resend` is explicitly requested (manual, audited).
 */
export async function sendPayslipEmail(
  employeeId: string,
  month: string,
  opts: { trigger: "MANUAL" | "SCHEDULED"; actor: Actor; resend?: boolean },
): Promise<{ status: string; error?: string }> {
  const mail = await buildPayslipEmail(employeeId, month);
  const { slip, to, subject } = mail;
  const key = `payslip:${employeeId}:${month}`;

  // Atomic claim: only one sender can move the log into "Sending".
  await FmsEmailLog.updateOne(
    { key },
    { $setOnInsert: { key, kind: "PAYSLIP", employeeId, month, to, subject, status: "Queued", trigger: opts.trigger } },
    { upsert: true },
  );
  const claimFilter: Record<string, unknown> = { key, status: opts.resend ? { $in: ["Queued", "Failed", "Sent"] } : { $in: ["Queued", "Failed"] } };
  const claimed = await FmsEmailLog.findOneAndUpdate(claimFilter, { $set: { status: "Sending", to, trigger: opts.trigger } }, { new: true });
  if (!claimed) {
    const cur = await FmsEmailLog.findOne({ key }).lean();
    return { status: cur?.status === "Sent" ? "AlreadySent" : "InProgress" };
  }

  const attempt = { at: new Date(), ok: false, error: "", messageId: "", by: opts.actor?.employeeId ?? "SCHEDULER" };
  try {
    if (!isValidRecipient(to)) throw new Error("Employee has no valid registered email in OMS");
    const pdf = await getObjectBuffer(slip.s3Key);
    const { messageId } = await sendFmsMail({
      to,
      subject,
      html: mail.html,
      attachments: [{ filename: mail.attachmentName, content: pdf, contentType: "application/pdf" }],
    });
    attempt.ok = true;
    attempt.messageId = messageId;
    // Keep an exact copy reference of the PDF that was mailed (S3 objects are never overwritten),
    // so the month-wise "Sent Payslips" archive always opens what the employee received.
    await FmsEmailLog.updateOne(
      { key },
      {
        $set: {
          status: "Sent", sentAt: new Date(), lastError: "", to, subject,
          employeeName: mail.employeeName, netPay: slip.netPay, sentS3Key: slip.s3Key, sentVersion: slip.version ?? 1,
          sentBy: opts.actor?.employeeId ?? "SYSTEM", sentByName: opts.actor?.name ?? "System",
        },
        $push: { attempts: attempt, sentHistory: { at: new Date(), s3Key: slip.s3Key, version: slip.version ?? 1, to, by: opts.actor?.employeeId ?? "SYSTEM" } },
      },
    );
    await audit(opts.actor, opts.resend ? "payslip.email_resend" : "payslip.email", { entity: "payslip", entityId: `${employeeId}:${month}`, updatedValue: { to, trigger: opts.trigger } });
    return { status: "Sent" };
  } catch (err) {
    attempt.error = (err as Error).message;
    await FmsEmailLog.updateOne({ key }, { $set: { status: "Failed", lastError: attempt.error }, $push: { attempts: attempt } });
    return { status: "Failed", error: attempt.error };
  }
}