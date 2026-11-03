import { NextResponse } from "next/server";
import { handle, HttpError, requireUser } from "@/lib/auth";
import { FmsPayslip } from "@/models/fms";
import { signedDownloadUrl } from "@/lib/s3";
import { audit } from "@/lib/audit";
import { isValidObjectId } from "mongoose";

/** Authorized, audited, 5-minute signed URL. */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("payslips.view");
  const { id } = await ctx.params;
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const slip = await FmsPayslip.findById(id).lean();
  if (!slip) throw new HttpError(404, "Not found");
  const url = await signedDownloadUrl(slip.s3Key, `Payslip_${slip.employeeId}_${slip.month}.pdf`);
  await audit(user, "payslip.download", { entity: "payslip", entityId: `${slip.employeeId}:${slip.month}` });
  return NextResponse.json({ url });
});
