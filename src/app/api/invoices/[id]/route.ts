import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { clientIp, handle, HttpError, readJson, requireUser } from "@/lib/auth";
import { FmsInvoice, INVOICE_STATUSES } from "@/models/fms";
import { signedDownloadUrl } from "@/lib/s3";
import { audit } from "@/lib/audit";

/** GET → signed URL for the invoice document (authorized + audited). */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("invoices.view");
  const { id } = await ctx.params;
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const inv = await FmsInvoice.findById(id).lean();
  if (!inv?.s3Key) throw new HttpError(404, "No document");
  const url = await signedDownloadUrl(inv.s3Key, inv.fileName ?? `${inv.invoiceNumber}.pdf`);
  await audit(user, "invoice.download", { entity: "invoice", entityId: inv.invoiceNumber });
  return NextResponse.json({ url });
});

/** PATCH { status?, amountReceived? (rupees), reason } */
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("invoices.manage");
  const { id } = await ctx.params;
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const b = await readJson<{ status?: string; amountReceived?: number; reason?: string }>(req);
  const reason = String(b.reason ?? "").trim();
  if (reason.length < 5) throw new HttpError(400, "Reason is required");
  const inv = await FmsInvoice.findById(id).lean();
  if (!inv) throw new HttpError(404, "Not found");
  const set: Record<string, unknown> = {};
  if (b.status !== undefined) {
    if (!(INVOICE_STATUSES as readonly string[]).includes(b.status)) throw new HttpError(400, "Invalid status");
    set.status = b.status;
  }
  if (b.amountReceived !== undefined) {
    const v = Math.round(Number(b.amountReceived) * 100);
    if (!(v >= 0) || v > inv.totalAmount) throw new HttpError(400, "Amount received must be between 0 and total");
    set.amountReceived = v;
  }
  if (!Object.keys(set).length) throw new HttpError(400, "Nothing to update");
  await FmsInvoice.updateOne({ _id: id }, { $set: set });
  await audit(user, "invoice.update", {
    entity: "invoice", entityId: inv.invoiceNumber,
    previousValue: { status: inv.status, amountReceived: inv.amountReceived }, updatedValue: set, reason, ip: await clientIp(),
  });
  return NextResponse.json({ success: true });
});
