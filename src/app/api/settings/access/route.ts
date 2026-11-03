import { NextResponse } from "next/server";
import { clientIp, handle, HttpError, readJson, requireUser } from "@/lib/auth";
import { FmsAccess } from "@/models/fms";
import { getEmployee } from "@/lib/oms-read";
import { FMS_ROLES } from "@/lib/permissions";
import { audit } from "@/lib/audit";

export const GET = handle(async () => {
  await requireUser("settings.manage");
  const rows = await FmsAccess.find({}).sort({ active: -1, role: 1, name: 1 }).lean();
  return NextResponse.json({ rows });
});

/** Grant / change / revoke FMS access: { employeeId, role?, active?, reason } */
export const POST = handle(async (req: Request) => {
  const user = await requireUser("settings.manage");
  const b = await readJson<{ employeeId?: string; role?: string; active?: boolean; reason?: string }>(req);
  const employeeId = String(b.employeeId ?? "").trim();
  const reason = String(b.reason ?? "").trim();
  if (!employeeId) throw new HttpError(400, "employeeId required");
  if (reason.length < 5) throw new HttpError(400, "Reason is required");
  if (employeeId === user.employeeId && b.active === false) throw new HttpError(400, "You cannot revoke your own access");
  const emp = await getEmployee(employeeId, false);
  if (!emp) throw new HttpError(404, "OMS employee not found (or removed)");
  const existing = await FmsAccess.findOne({ employeeId }).lean();
  const role = b.role ?? existing?.role;
  if (!role || !(FMS_ROLES as readonly string[]).includes(role)) throw new HttpError(400, "Valid FMS role required");
  if (role === "FMS_ADMIN" && user.role !== "FMS_ADMIN") throw new HttpError(403, "Only an FMS Admin can grant FMS_ADMIN");
  const active = b.active ?? true;

  await FmsAccess.updateOne(
    { employeeId },
    {
      $set: {
        email: emp.email, name: emp.name, role, active,
        ...(active ? { grantedBy: user.employeeId, revokedBy: null, revokedAt: null } : { revokedBy: user.employeeId, revokedAt: new Date() }),
      },
    },
    { upsert: true },
  );
  await audit(user, active ? "access.grant" : "access.revoke", {
    entity: "fms_access", entityId: employeeId,
    previousValue: existing ? { role: existing.role, active: existing.active } : null,
    updatedValue: { role, active }, reason, ip: await clientIp(),
  });
  return NextResponse.json({ success: true });
});
