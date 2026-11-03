import { NextResponse } from "next/server";
import { clientIp, handle, HttpError, readJson, requireUser } from "@/lib/auth";
import { getPermissionOverrides, getPolicy, setSetting } from "@/lib/settings";
import { mergePolicy, validatePolicy, type PayrollPolicy } from "@/lib/policy";
import { ALL_PERMISSIONS, DEFAULT_MATRIX, FMS_ROLES, PERMISSIONS, resolvePermissions } from "@/lib/permissions";
import { audit } from "@/lib/audit";

export const GET = handle(async () => {
  await requireUser("settings.manage");
  const [policy, overrides] = await Promise.all([getPolicy(), getPermissionOverrides()]);
  return NextResponse.json({
    policy,
    permissions: Object.fromEntries(FMS_ROLES.map((r) => [r, resolvePermissions(r, overrides)])),
    defaults: DEFAULT_MATRIX,
    catalog: PERMISSIONS,
  });
});

/** PUT { policy?: Partial<PayrollPolicy>, confirm?: boolean, permissions?: Record<role, string[]>, reason } */
export const PUT = handle(async (req: Request) => {
  const user = await requireUser("settings.manage");
  const b = await readJson<{ policy?: Partial<PayrollPolicy>; confirm?: boolean; permissions?: Record<string, string[]>; reason?: string }>(req);
  const reason = String(b.reason ?? "").trim();
  if (reason.length < 5) throw new HttpError(400, "Reason is required for settings changes");
  const ip = await clientIp();

  if (b.policy || b.confirm !== undefined) {
    const before = await getPolicy();
    const next = mergePolicy({ ...before, ...(b.policy ?? {}) });
    const errs = validatePolicy(next);
    if (errs.length) throw new HttpError(400, errs.join("; "));
    // Any policy change un-confirms it unless this same request confirms.
    const changed = JSON.stringify({ ...before, confirmed: 0, confirmedBy: 0, confirmedAt: 0 }) !== JSON.stringify({ ...next, confirmed: 0, confirmedBy: 0, confirmedAt: 0 });
    if (b.confirm) {
      if (!["FOUNDER", "FMS_ADMIN"].includes(user.role)) throw new HttpError(403, "Only a Founder or FMS Admin can confirm payroll policy");
      Object.assign(next, { confirmed: true, confirmedBy: user.employeeId, confirmedAt: new Date().toISOString() });
    } else if (changed || b.confirm === false) {
      Object.assign(next, { confirmed: false, confirmedBy: undefined, confirmedAt: undefined });
    }
    await setSetting("payrollPolicy", next, user.employeeId);
    await audit(user, "settings.policy", { entity: "settings", entityId: "payrollPolicy", previousValue: before, updatedValue: next, reason, ip });
  }

  if (b.permissions) {
    const before = await getPermissionOverrides();
    const clean: Record<string, string[]> = {};
    for (const role of FMS_ROLES) {
      if (role === "FMS_ADMIN") continue;
      const list = b.permissions[role];
      if (Array.isArray(list)) clean[role] = list.filter((p) => (ALL_PERMISSIONS as string[]).includes(p));
    }
    await setSetting("permissions", { ...(before ?? {}), ...clean }, user.employeeId);
    await audit(user, "settings.permissions", { entity: "settings", entityId: "permissions", previousValue: before, updatedValue: clean, reason, ip });
  }
  return NextResponse.json({ success: true });
});
