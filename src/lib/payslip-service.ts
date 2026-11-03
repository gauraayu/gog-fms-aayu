import { connectDB } from "./db";
import { FmsEmailLog, FmsPayrollEntry, FmsPayrollRun, FmsPayslip, FmsSalaryStructure, FmsTransaction } from "@/models/fms";
import { renderSlipPdf, payslipEmailBody, amountInWords, slipMoney, LOGO_DATA_URI, logoBuffer, type SlipData } from "./payslip-template";
import { putObject, buildKey, getObjectBuffer } from "./s3";
import { sendFmsMail, isValidRecipient } from "./fms-mail";
import { getEmployeePayslipDetails } from "./oms-read";
import { audit } from "./audit";
import { monthLabel } from "./dates";
import { HttpError } from "./auth";
import type { SalaryCalc } from "./payroll-calc";
import type { PayableDaysResult } from "./payable-days";

type Actor = { employeeId: string; name: string; role: string } | null;
const PAYSLIP_READY = ["Finalized", "Disbursed"];

const dmy = (ymd?: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};

/**
 * Build the exact data printed on the salary slip.
 * Design: "With EPF" when the employee has any EPF / PT / TDS / other deduction / college-paid amount,
 * otherwise "Without EPF".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildSlipData(entry: any, month: string): Promise<SlipData> {
  const c = entry.calc as SalaryCalc;
  const a = (entry.attendance ?? {}) as Partial<PayableDaysResult>;
  const [oms, structure, txn] = await Promise.all([
    getEmployeePayslipDetails(entry.employeeId),
    entry.structureId ? FmsSalaryStructure.findById(entry.structureId).lean() : null,
    FmsTransaction.findOne({ type: "SALARY_DISBURSEMENT", month, employeeId: entry.employeeId }).select("disbursedOn").lean(),
  ]);
  const st = (structure?.statutory ?? {}) as { uan?: string; pfAccountNo?: string; esiNumber?: string; pran?: string; pan?: string; taxRegime?: string };
  const emp = entry.employee ?? {};
  const money = slipMoney(c);
  const [y, m] = month.split("-");
  return {
    template: money.template,
    month,
    monthTitle: `${FULL_MONTH[Number(m) - 1]} ${y}`,
    monthYear: `${m} / ${y}`,
    employee: {
      name: oms?.name || emp.name || "",
      id: entry.employeeId,
      designation: oms?.designation || emp.designation || "",
      department: oms?.department || emp.dept || "",
      location: oms?.location || emp.location || "",
      joiningDate: dmy(oms?.joiningDate),
      bankName: oms?.bankName || "",
      bankAccount: oms?.bankAccount || "",
      pan: (st.pan || oms?.pan || "").toUpperCase(),
      uan: st.uan || "",
      pfAccountNo: st.pfAccountNo || "",
      esiNumber: st.esiNumber || "",
      pran: st.pran || "",
      taxRegime: st.taxRegime || "Regular",
    },
    paymentDate: dmy(txn?.disbursedOn),
    paymentMode: "Bank Transfer",
    days: { total: c.calendarDays ?? a.calendarDays ?? 0, payable: c.payableDays, paidLeave: a.paidLeaveDays ?? 0, present: a.presentDays ?? 0 },
    earnings: money.earnings,
    deductions: money.deductions,
    net: money.net,
    netWords: amountInWords(money.net),
    generatedAt: new Date().toISOString(),
  };
}
const FULL_MONTH = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

export async function generatePayslipsForMonth(month: string, actor: Actor, employeeIds?: string[]) {
  await connectDB();
  const run = await FmsPayrollRun.findOne({ month }).lean();
  if (!run) throw new HttpError(404, "No payroll for this month");
  // Per employee: only employees whose payroll is Finalized / Disbursed get a payslip.
  const filter: Record<string, unknown> = { runId: run._id, excluded: { $ne: true }, calc: { $ne: null }, status: { $in: PAYSLIP_READY } };
  if (employeeIds?.length) filter.employeeId = { $in: employeeIds };
  const entries = await FmsPayrollEntry.find(filter).lean();
  if (!entries.length) throw new HttpError(409, "No Finalized employee to generate a payslip for — finalize the employee's payroll first");
  const results: { employeeId: string; ok: boolean; template?: string; error?: string }[] = [];
  for (const e of entries) {
    try {
      const data = await buildSlipData(e, month);
      const buf = renderSlipPdf(data);
      const key = buildKey(`payslips/${month}`, `payslip_${e.employeeId}_${month}.pdf`, "application/pdf");
      await putObject(key, buf, "application/pdf");
      const prev = await FmsPayslip.findOne({ employeeId: e.employeeId, month }).lean();
      await FmsPayslip.updateOne(
        { employeeId: e.employeeId, month },
        { $set: { s3Key: key, entryId: e._id, runId: run._id, netPay: e.netPay, template: data.template, data, generatedBy: actor?.employeeId ?? "SYSTEM" }, $inc: { version: prev ? 1 : 0 } },
        { upsert: true },
      );
      await audit(actor, "payslip.generate", { entity: "payslip", entityId: `${e.employeeId}:${month}`, previousValue: prev?.s3Key, updatedValue: { key, template: data.template } });
      results.push({ employeeId: e.employeeId, ok: true, template: data.template });
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
  // Normally the exact generated data is stored with the payslip. If it is missing (older payslip), rebuild it from the finalized payroll.
  let data = slip.data as SlipData | undefined;
  if (!data) {
    if (!entry?.calc) throw new HttpError(409, "Payslip data is missing — click Generate again");
    data = await buildSlipData(entry, month);
  }
  const to = String((entry?.employee as { email?: string } | undefined)?.email ?? "");
  const log = await FmsEmailLog.findOne({ key: `payslip:${employeeId}:${month}` }).select("status sentAt").lean();
  return {
    slip,
    data,
    employeeName: data.employee.name,
    to,
    validRecipient: isValidRecipient(to),
    subject: `Salary Slip — ${data.monthTitle} — ${data.employee.name}`,
    /** preview (logo inline as data URI) */
    html: payslipEmailBody(data, LOGO_DATA_URI),
    /** email (logo as CID attachment, which Gmail / Outlook display) */
    mailHtml: payslipEmailBody(data, "cid:goglogo"),
    attachmentName: `Salary_Slip_${employeeId}_${month}.pdf`,
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
      html: mail.mailHtml,
      attachments: [
        { filename: mail.attachmentName, content: pdf, contentType: "application/pdf" },
        { filename: "geeks-of-gurukul.jpg", content: logoBuffer(), contentType: "image/jpeg", cid: "goglogo" },
      ],
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
    await audit(opts.actor, opts.resend ? "payslip.email_resend" : "payslip.email", { entity: "payslip", entityId: `${employeeId}:${month}`, updatedValue: { to, trigger: opts.trigger, template: mail.data.template } });
    return { status: "Sent" };
  } catch (err) {
    attempt.error = (err as Error).message;
    await FmsEmailLog.updateOne({ key }, { $set: { status: "Failed", lastError: attempt.error }, $push: { attempts: attempt } });
    return { status: "Failed", error: attempt.error };
  }
}