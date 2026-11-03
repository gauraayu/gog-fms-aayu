import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { clientIp, handle, HttpError, requireUser } from "@/lib/auth";
import { CHALLAN_STATUSES, FmsChallan } from "@/models/fms";
import { buildKey, putObject, readUpload, signedDownloadUrl } from "@/lib/s3";
import { audit } from "@/lib/audit";
import { DATE_RE } from "@/lib/dates";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("challans.view");
  const { id } = await ctx.params;
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const c = await FmsChallan.findById(id).lean();
  if (!c?.s3Key) throw new HttpError(404, "No document");
  const v = new URL(req.url).searchParams.get("version");
  const key = v !== null ? c.versions?.[Number(v)]?.s3Key : c.s3Key;
  if (!key) throw new HttpError(404, "Version not found");
  const url = await signedDownloadUrl(key, c.fileName ?? `${c.type}_${c.year}_${c.month}.pdf`);
  await audit(user, "challan.download", { entity: "challan", entityId: `${c.type}:${c.year}-${c.month}` });
  return NextResponse.json({ url });
});

/**
 * multipart PATCH: reason (required) + any of paymentStatus, paymentDate, referenceNumber, amount (rupees), file.
 * Replacing the file keeps the old one in `versions` (version history, nothing deleted).
 */
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("challans.manage");
  const { id } = await ctx.params;
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const c = await FmsChallan.findById(id).lean();
  if (!c) throw new HttpError(404, "Not found");
  const form = await req.formData();
  const s = (k: string) => (form.get(k) === null ? undefined : String(form.get(k)).trim());
  const reason = s("reason") ?? "";
  if (reason.length < 5) throw new HttpError(400, "Reason is required");

  const set: Record<string, unknown> = {};
  const push: Record<string, unknown> = {};
  if (s("paymentStatus") !== undefined) {
    if (!(CHALLAN_STATUSES as readonly string[]).includes(s("paymentStatus")!)) throw new HttpError(400, "Invalid status");
    set.paymentStatus = s("paymentStatus");
  }
  if (s("paymentDate")) {
    if (!DATE_RE.test(s("paymentDate")!)) throw new HttpError(400, "Invalid payment date");
    set.paymentDate = s("paymentDate");
  }
  if (s("referenceNumber")) set.referenceNumber = s("referenceNumber");
  if (s("amount")) {
    const a = Math.round(Number(s("amount")) * 100);
    if (!(a >= 0)) throw new HttpError(400, "Invalid amount");
    set.amount = a;
  }
  const finalStatus = (set.paymentStatus ?? c.paymentStatus) as string;
  if (finalStatus !== "Uploaded" && !((set.paymentDate ?? c.paymentDate) && (set.referenceNumber ?? c.referenceNumber))) {
    throw new HttpError(400, "Paid/Verified challans need a payment date and reference number");
  }
  if (form.get("file")) {
    const up = await readUpload(form);
    const key = buildKey(`challans/${c.financialYear}/${String(c.month).padStart(2, "0")}/${c.type}`, up.name, up.type);
    await putObject(key, up.buf, up.type);
    push.versions = { s3Key: c.s3Key, fileName: c.fileName, replacedAt: new Date(), replacedBy: user.employeeId, reason };
    set.s3Key = key;
    set.fileName = up.name;
  }
  if (!Object.keys(set).length) throw new HttpError(400, "Nothing to update");
  await FmsChallan.updateOne({ _id: id }, { $set: set, ...(push.versions ? { $push: push } : {}) });
  await audit(user, "challan.update", {
    entity: "challan", entityId: `${c.type}:${c.year}-${c.month}`,
    previousValue: { paymentStatus: c.paymentStatus, amount: c.amount, paymentDate: c.paymentDate, referenceNumber: c.referenceNumber, fileName: c.fileName },
    updatedValue: { ...set, s3Key: undefined }, reason, ip: await clientIp(),
  });
  return NextResponse.json({ success: true });
});
