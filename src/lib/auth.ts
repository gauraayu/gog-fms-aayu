import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { connectDB } from "./db";
import { FMS_COOKIE, verifyToken } from "./session";
import { FmsAccess } from "@/models/fms";
import { getTestUser, testUsersEnabled } from "./test-users";
import { getRoleAccess, resolveGrantRole } from "./role-access";
import { OmsEmployee } from "@/models/oms-readonly";
import { resolvePermissions, type Permission } from "./permissions";
import { getPermissionOverrides, getPolicy } from "./settings";

export interface SessionUser {
  uid: string;
  employeeId: string;
  name: string;
  email: string;
  role: string;
  omsRole: string;
  permissions: Permission[];
  isTest?: boolean;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Resolve the logged-in FMS user. Re-checked on EVERY request:
 *  - valid FMS token (own cookie + own secret)
 *  - active fms_access grant (revocation takes effect immediately)
 *  - OMS employee still exists, not removed, status active
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const payload = verifyToken(jar.get(FMS_COOKIE)?.value);
  if (!payload) return null;
  if (payload.test) {
    // Built-in test user — resolved from code, no database needed.
    if (!testUsersEnabled()) return null;
    const t = getTestUser(payload.eid);
    if (!t) return null;
    const overrides = process.env.MONGODB_URI ? await getPermissionOverrides().catch(() => null) : null;
    return {
      uid: t.employeeId,
      employeeId: t.employeeId,
      name: t.name,
      email: t.email,
      role: t.role,
      omsRole: "TEST",
      permissions: resolvePermissions(t.role, overrides),
      isTest: true,
    };
  }
  await connectDB();
  const [grantDoc, emp, policy, ra] = await Promise.all([
    FmsAccess.findOne({ employeeId: payload.eid }).lean(),
    OmsEmployee.findOne({ _id: payload.uid, isRemoved: { $ne: true } }).select("id name email role status").lean(),
    getPolicy(),
    getRoleAccess(),
  ]);
  if (!emp) return null;
  if (String(emp.id) !== payload.eid) return null;
  if (!policy.activeStatuses.includes(String(emp.status ?? "Active"))) return null;
  // Re-resolved every request: OMS role change or revocation takes effect immediately.
  const grant = resolveGrantRole(grantDoc, String(emp.role ?? ""), ra);
  if (!grant) return null;
  const overrides = await getPermissionOverrides();
  return {
    uid: payload.uid,
    employeeId: payload.eid,
    name: String(emp.name ?? ""),
    email: String(emp.email ?? ""),
    role: grant.role,
    omsRole: String(emp.role ?? ""),
    permissions: resolvePermissions(grant.role, overrides),
  };
}

export async function requireUser(...perms: Permission[]): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, "Not authenticated");
  const missing = perms.filter((p) => !user.permissions.includes(p));
  if (missing.length) throw new HttpError(403, `Missing permission: ${missing.join(", ")}`);
  return user;
}

export const can = (u: SessionUser, p: Permission) => u.permissions.includes(p);

export async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] || h.get("x-real-ip") || "unknown").trim();
}

/** Wrap a route handler: converts HttpError / validation errors into JSON responses. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      const err = e as { name?: string; code?: number | string; message?: string; syscall?: string };
      if (err?.name === "DbNotConfigured") return NextResponse.json({ error: err.message }, { status: 503 });
      if (
        err?.name === "MongooseServerSelectionError" || err?.name === "MongoServerSelectionError" ||
        err?.syscall === "querySrv" || ["ECONNREFUSED", "ENOTFOUND", "ETIMEOUT", "ETIMEDOUT"].includes(String(err?.code))
      ) {
        console.error("[FMS] MongoDB unreachable:", err.message);
        return NextResponse.json(
          { error: "Cannot reach the database. Check MONGODB_URI, internet/DNS, and that this IP is allowed in MongoDB Atlas → Network Access." },
          { status: 503 },
        );
      }
      if (err?.name === "ValidationError") return NextResponse.json({ error: err.message }, { status: 400 });
      if (err?.code === 11000) return NextResponse.json({ error: "Duplicate record" }, { status: 409 });
      console.error("[FMS]", e);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  };
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}