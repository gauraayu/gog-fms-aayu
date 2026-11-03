import { NextResponse } from "next/server";
import { clientIp, handle, HttpError, requireUser } from "@/lib/auth";
import { CHALLAN_STATUSES, CHALLAN_TYPES, FmsChallan } from "@/models/fms";
import { buildKey, putObject, readUpload } from "@/lib/s3";
import { audit } from "@/lib/audit";
import { DATE_RE, financialYearOf } from "@/lib/dates";

export const GET = handle(async (req: Request) => {
  await requireUser("challans.view");
  const u = new URL(req.url);
  const f: Record<string, unknown> = {};
  if (u.searchParams.get("fy")) f.financialYear = u.searchParams.get("fy");
  if (u.searchParams.get("type")) f.type = u.searchParams.get("type");
  if (u.searchParams.get("month")) f.month = Number(u.searchParams.get("month"));
  if (u.searchParams.get("status")) f.paymentStatus = u.searchParams.get("status");
  const rows = await FmsChallan.find(f).select("-s3Key -versions.s3Key").sort({ year: -1, month: -1, type: 1 }).limit(1000).lean();
  return NextResponse.json({ rows });
});

/** multipart: type, month, year, referenceNumber, amount (rupees), paymentDate, paymentStatus, file */
export const POST = handle(async (req: Request) => {
  const user = await requireUser("challans.manage");
  const form = await req.formData();
  const s = (k: string) => String(form.get(k) ?? "").trim();
  const type = s("type");
  const month = Number(s("month"));
  const year = Number(s("year"));
  const paymentStatus = s("paymentStatus") || "Uploaded";
  const paymentDate = s("paymentDate");
  const referenceNumber = s("referenceNumber");
  if (!(CHALLAN_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "Type must be EPF, GST, PT or TDS");
  if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2100)) throw new HttpError(400, "Invalid month/year");
  if (!(CHALLAN_STATUSES as readonly string[]).includes(paymentStatus)) throw new HttpError(400, "Invalid payment status");
  if (paymentStatus !== "Uploaded" && (!DATE_RE.test(paymentDate) || !referenceNumber)) {
    throw new HttpError(400, "Paid/Verified challans need a payment date and reference number");
  }
  const amount = Math.round(Number(s("amount")) * 100);
  if (!(amount >= 0)) throw new HttpError(400, "Invalid amount");
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const fy = financialYearOf(ym);

  const up = await readUpload(form);
  const s3Key = buildKey(`challans/${fy}/${String(month).padStart(2, "0")}/${type}`, up.name, up.type);
  await putObject(s3Key, up.buf, up.type);
  const doc = await FmsChallan.create({
    type, month, year, financialYear: fy, referenceNumber: referenceNumber || undefined, amount,
    paymentDate: paymentDate || undefined, paymentStatus, s3Key, fileName: up.name, uploadedBy: user.employeeId, notes: s("notes") || undefined,
  });
  await audit(user, "challan.upload", { entity: "challan", entityId: `${type}:${ym}`, updatedValue: { amount, paymentStatus, referenceNumber }, ip: await clientIp() });
  return NextResponse.json({ success: true, id: doc._id });
});
