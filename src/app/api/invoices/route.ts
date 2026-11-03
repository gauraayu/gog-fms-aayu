import { NextResponse } from "next/server";
import { clientIp, handle, HttpError, requireUser } from "@/lib/auth";
import { FmsInvoice, INVOICE_STATUSES } from "@/models/fms";
import { buildKey, putObject, readUpload } from "@/lib/s3";
import { audit } from "@/lib/audit";
import { DATE_RE, todayIST } from "@/lib/dates";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const GET = handle(async (req: Request) => {
  await requireUser("invoices.view");
  const u = new URL(req.url);
  const f: Record<string, unknown> = {};
  if (u.searchParams.get("year")) f.billingYear = Number(u.searchParams.get("year"));
  if (u.searchParams.get("month")) f.billingMonth = Number(u.searchParams.get("month"));
  if (u.searchParams.get("client")) f.clientName = u.searchParams.get("client");
  if (u.searchParams.get("location")) f.clientLocation = u.searchParams.get("location");
  if (u.searchParams.get("status")) f.status = u.searchParams.get("status");
  const q = u.searchParams.get("search");
  if (q) f.$or = [{ invoiceNumber: { $regex: escapeRe(q), $options: "i" } }, { clientName: { $regex: escapeRe(q), $options: "i" } }];
  const rows = await FmsInvoice.find(f).select("-s3Key").sort({ billingYear: -1, billingMonth: -1, clientName: 1, clientLocation: 1 }).limit(1000).lean();
  const today = todayIST();
  // Overdue is derived (not silently written): unpaid & past due date.
  const view = rows.map((r) => ({
    ...r,
    displayStatus: ["Issued", "Partially Paid"].includes(r.status) && r.dueDate && r.dueDate < today ? "Overdue" : r.status,
  }));
  const [clients, locations] = await Promise.all([FmsInvoice.distinct("clientName"), FmsInvoice.distinct("clientLocation")]);
  return NextResponse.json({ rows: view, clients, locations });
});

/** multipart/form-data: file + fields (amounts in rupees). */
export const POST = handle(async (req: Request) => {
  const user = await requireUser("invoices.manage");
  const form = await req.formData();
  const s = (k: string) => String(form.get(k) ?? "").trim();
  const invoiceNumber = s("invoiceNumber");
  const clientName = s("clientName");
  const clientLocation = s("clientLocation");
  const invoiceDate = s("invoiceDate");
  const dueDate = s("dueDate");
  const status = s("status") || "Issued";
  if (!invoiceNumber || !clientName || !clientLocation) throw new HttpError(400, "Invoice number, client name and location are required");
  if (!DATE_RE.test(invoiceDate)) throw new HttpError(400, "Invoice date is required");
  if (dueDate && !DATE_RE.test(dueDate)) throw new HttpError(400, "Invalid due date");
  if (!(INVOICE_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "Invalid status");
  const amount = Math.round(Number(s("amount")) * 100);
  const taxAmount = Math.round(Number(s("taxAmount") || 0) * 100);
  if (!(amount >= 0) || !(taxAmount >= 0)) throw new HttpError(400, "Invalid amounts");
  const billingMonth = Number(s("billingMonth") || invoiceDate.slice(5, 7));
  const billingYear = Number(s("billingYear") || invoiceDate.slice(0, 4));

  let s3Key: string | undefined;
  let fileName: string | undefined;
  if (form.get("file")) {
    const up = await readUpload(form);
    s3Key = buildKey(`invoices/${billingYear}/${String(billingMonth).padStart(2, "0")}`, up.name, up.type);
    await putObject(s3Key, up.buf, up.type);
    fileName = up.name;
  }
  const doc = await FmsInvoice.create({
    invoiceNumber, clientName, clientLocation, invoiceDate, dueDate: dueDate || undefined, billingMonth, billingYear,
    amount, taxAmount, totalAmount: amount + taxAmount, status, s3Key, fileName, uploadedBy: user.employeeId, notes: s("notes") || undefined,
  });
  await audit(user, "invoice.create", { entity: "invoice", entityId: invoiceNumber, updatedValue: { ...doc.toObject(), s3Key: undefined }, ip: await clientIp() });
  return NextResponse.json({ success: true, id: doc._id });
});
