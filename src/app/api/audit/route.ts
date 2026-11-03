import { NextResponse } from "next/server";
import { handle, requireUser } from "@/lib/auth";
import { FmsAudit } from "@/models/fms";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Read-only. There is intentionally no write/delete endpoint for audit history. */
export const GET = handle(async (req: Request) => {
  await requireUser("audit.view");
  const u = new URL(req.url);
  const f: Record<string, unknown> = {};
  if (u.searchParams.get("action")) f.action = { $regex: `^${escapeRe(u.searchParams.get("action")!)}` };
  if (u.searchParams.get("entityId")) f.entityId = { $regex: escapeRe(u.searchParams.get("entityId")!), $options: "i" };
  if (u.searchParams.get("userId")) f.userId = u.searchParams.get("userId");
  const page = Math.max(1, Number(u.searchParams.get("page") || 1));
  const limit = 50;
  const [rows, total] = await Promise.all([
    FmsAudit.find(f).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    FmsAudit.countDocuments(f),
  ]);
  return NextResponse.json({ rows, total, page, limit });
});
