/**
 * Automatic FMS access from the OMS `employees.role`.
 * Default (as requested): OMS FOUNDER → FMS "FOUNDER", OMS HR and HR_EXECUTIVE → FMS "HR",
 * using their existing OMS credentials — no manual grant needed.
 *
 * Precedence: an explicit fms_access document always wins
 *   - active:true  → its role is used
 *   - active:false → access revoked, even if the OMS role is mapped
 * FMS_ADMIN can never be given automatically.
 */
import { getSetting } from "./settings";

export interface RoleAccess {
  enabled: boolean;
  map: Record<string, string>; // OMS role → FMS role
}

export const AUTO_ASSIGNABLE = ["HR", "FOUNDER", "ACCOUNTS"] as const;

export const DEFAULT_ROLE_ACCESS: RoleAccess = { enabled: true, map: { FOUNDER: "FOUNDER", HR: "HR", HR_EXECUTIVE: "HR" } };

export const OMS_ROLES = [
  "FOUNDER", "HR", "HR_EXECUTIVE", "AD", "TL", "HOI", "OM", "MARKETING_TEAM", "TECH_TEAM",
  "CURRICULUM_HEAD", "CURRICULUM_LEAD", "PROFESSOR", "FACULTY",
] as const;

export async function getRoleAccess(): Promise<RoleAccess> {
  const s = await getSetting<RoleAccess>("roleAccess");
  return s ? { enabled: !!s.enabled, map: { ...(s.map ?? {}) } } : { ...DEFAULT_ROLE_ACCESS, map: { ...DEFAULT_ROLE_ACCESS.map } };
}

export function resolveGrantRole(
  explicit: { role: string; active?: boolean | null } | null | undefined,
  omsRole: string,
  ra: RoleAccess,
): { role: string; source: "GRANT" | "OMS_ROLE" } | null {
  if (explicit) return explicit.active === false ? null : { role: explicit.role, source: "GRANT" };
  if (!ra.enabled) return null;
  const r = ra.map[omsRole];
  return r && (AUTO_ASSIGNABLE as readonly string[]).includes(r) ? { role: r, source: "OMS_ROLE" } : null;
}

export function cleanRoleAccess(input: unknown): RoleAccess {
  const i = (input ?? {}) as { enabled?: unknown; map?: Record<string, unknown> };
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.map ?? {})) {
    if ((OMS_ROLES as readonly string[]).includes(k) && (AUTO_ASSIGNABLE as readonly string[]).includes(String(v))) map[k] = String(v);
  }
  return { enabled: i.enabled === true, map };
}