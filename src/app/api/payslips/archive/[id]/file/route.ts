import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { handle, HttpError, requireUser } from "@/lib/auth";
import { FmsEmailLog } from "@/models/fms";
import { signedDownloadUrl } from "@/lib/s3";
import { audit } from "@/lib/audit";

/** Opens the exact PDF that was emailed (?h=<index> for an earlier send in sentHistory). */
export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("payslips.view");
  const { id } = await ctx.params;
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const log = await FmsEmailLog.findOne({ _id: id, kind: "PAYSLIP", status: "Sent" }).lean();
  if (!log) throw new HttpError(404, "Not found");
  const h = new URL(req.url).searchParams.get("h");
  const key = h !== null ? log.sentHistory?.[Number(h)]?.s3Key : log.sentS3Key;
  if (!key) throw new HttpError(404, "PDF not available for this send");
  const url = await signedDownloadUrl(key, `Payslip_${log.employeeId}_${log.month}.pdf`);
  await audit(user, "payslip.archive_view", { entity: "payslip", entityId: `${log.employeeId}:${log.month}` });
  return NextResponse.json({ url });
});