import nodemailer, { type Transporter } from "nodemailer";
import { HttpError } from "./auth";

/**
 * FMS mail module — same nodemailer/SMTP config as OMS (handover §10),
 * own sender name, NO auto-CC (salary mails go only to the employee).
 */
let transport: Transporter | null = null;
function t(): Transporter {
  if (transport) return transport;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) throw new HttpError(503, "Email is not configured (SMTP_*)");
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transport;
}

export const isValidRecipient = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !email.toLowerCase().endsWith("@gog.com"); // OMS placeholder domain

export async function sendFmsMail(o: {
  to: string;
  subject: string;
  html: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}): Promise<{ messageId: string }> {
  if (!isValidRecipient(o.to)) throw new Error(`Invalid recipient ${o.to}`);
  const info = await t().sendMail({ from: `"GoG FMS" <${process.env.SMTP_USER}>`, ...o });
  return { messageId: String(info.messageId) };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function payslipEmailHtml(name: string, monthLabel: string) {
  return `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;color:#18181b">
  <div style="background:#0a0a0a;color:#e4e4e7;padding:18px 22px;border-radius:12px 12px 0 0">
    <div style="font-size:15px;font-weight:700">GOG FMS</div>
    <div style="font-size:11px;color:#a1a1aa">Geeks of Gurukul · Finance Management System</div>
  </div>
  <div style="border:1px solid #e4e4e7;border-top:0;padding:22px;border-radius:0 0 12px 12px;font-size:13px;line-height:1.6">
    <p>Hi ${esc(name)},</p>
    <p>Please find attached your payslip for <b>${esc(monthLabel)}</b>.</p>
    <p style="color:#71717a;font-size:12px">This email and its attachment are confidential and intended only for you. If you received it in error, please inform HR and delete it.</p>
    <p>Regards,<br/>Finance Team, Geeks of Gurukul</p>
  </div></div>`;
}

export function financeAlertHtml(title: string, lines: string[]) {
  return `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;font-size:13px">
  <h3 style="margin:0 0 8px">${esc(title)}</h3><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
  <p style="color:#71717a;font-size:12px">Automated alert from GOG FMS.</p></div>`;
}
