import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { OmsEmployee } from "@/models/oms-readonly";
import { FmsAccess, FmsLoginAttempt } from "@/models/fms";
import { checkTestPassword, findTestUser, testUsersEnabled } from "@/lib/test-users";
import { getRoleAccess, resolveGrantRole } from "@/lib/role-access";
import { verifyPassword } from "@/lib/password";
import { createToken, cookieOptions, FMS_COOKIE } from "@/lib/session";
import { clientIp, handle, readJson, HttpError } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getPolicy } from "@/lib/settings";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GENERIC = "Invalid credentials or no FMS access.";

export const POST = handle(async (req: Request) => {
  const body = await readJson<{ identifier?: string; password?: string; employeeId?: string }>(req);
  const identifier = String(body.identifier ?? "").trim();
  const password = String(body.password ?? "");
  if (!identifier || !password) throw new HttpError(400, "Email / Employee ID and password are required");

  // Built-in test users — checked first, work WITHOUT any database.
  if (testUsersEnabled()) {
    const t = findTestUser(identifier);
    if (t) {
      if (!checkTestPassword(password)) return NextResponse.json({ error: GENERIC }, { status: 401 });
      const token = createToken({ uid: t.employeeId, eid: t.employeeId, email: t.email, role: t.role, test: true });
      const res = NextResponse.json({ success: true, user: { employeeId: t.employeeId, name: t.name, role: t.role, test: true } });
      res.cookies.set(FMS_COOKIE, token, cookieOptions());
      return res;
    }
    if (!process.env.MONGODB_URI) return NextResponse.json({ error: `${GENERIC} (database not connected yet — use a test user)` }, { status: 401 });
  }

  await connectDB();
  const ip = await clientIp();
  const rlKey = `${identifier.toLowerCase()}|${ip}`;
  const fails = await FmsLoginAttempt.countDocuments({ key: rlKey, success: false, at: { $gte: new Date(Date.now() - WINDOW_MS) } });
  if (fails >= MAX_FAILS) throw new HttpError(429, "Too many failed attempts. Try again in 15 minutes.");

  const fail = async (status = 401, msg = GENERIC) => {
    await FmsLoginAttempt.create({ key: rlKey, success: false });
    await audit(null, "auth.login_failed", { entity: "auth", entityId: identifier, ip });
    return NextResponse.json({ error: msg }, { status });
  };

  const isEmail = identifier.includes("@");

  // Same person can have several designation records (handover §5) — match by email OR employee id.
  const records = await OmsEmployee.find(
    isEmail ? { email: { $regex: `^${escapeRe(identifier)}$`, $options: "i" }, isRemoved: { $ne: true } } : { id: identifier, isRemoved: { $ne: true } },
  )
    .select("_id id name email role status password")
    .lean();
  if (!records.length) return fail();

  // 1) Password first (verify only — FMS NEVER rewrites the stored OMS password).
  const verified = records.filter((r) => verifyPassword(password, r.password as string | undefined));
  if (!verified.length) return fail();

  // 2) Explicit fms_access grant OR automatic access from OMS role (FOUNDER / HR / HR_EXECUTIVE).
  const [docs, ra] = await Promise.all([
    FmsAccess.find({ employeeId: { $in: verified.map((r) => String(r.id)) } }).lean(),
    getRoleAccess(),
  ]);
  const docById = new Map(docs.map((d) => [d.employeeId, d]));
  const grants = verified
    .map((r) => {
      const g = resolveGrantRole(docById.get(String(r.id)), String(r.role ?? ""), ra);
      return g ? { employeeId: String(r.id), role: g.role, source: g.source } : null;
    })
    .filter((g): g is { employeeId: string; role: string; source: "GRANT" | "OMS_ROLE" } => !!g);
  if (!grants.length) {
    // Password was correct, so it is safe to say why.
    const roles = [...new Set(verified.map((r) => String(r.role ?? "?")))].join(", ");
    return fail(403, `Password is correct, but your OMS role (${roles}) has no FMS access. Ask an FMS Admin or Founder to grant it in Settings → FMS Access.`);
  }

  let grant = grants[0];
  if (grants.length > 1) {
    if (!body.employeeId) {
      return NextResponse.json(
        { needsChoice: true, choices: grants.map((g) => ({ employeeId: g.employeeId, role: g.role })) },
        { status: 409 },
      );
    }
    const chosen = grants.find((g) => g.employeeId === body.employeeId);
    if (!chosen) return fail();
    grant = chosen;
  }

  const emp = records.find((r) => String(r.id) === grant.employeeId)!;
  const policy = await getPolicy();
  if (!policy.activeStatuses.includes(String(emp.status ?? "Active"))) {
    return fail(403, `Your OMS status is "${emp.status}". Only active employees can use FMS.`);
  }

  await FmsLoginAttempt.create({ key: rlKey, success: true });
  const token = createToken({ uid: String(emp._id), eid: grant.employeeId, email: String(emp.email), role: grant.role });
  await audit({ employeeId: grant.employeeId, name: String(emp.name), role: grant.role }, "auth.login", {
    entity: "auth", ip, updatedValue: { accessSource: grant.source, omsRole: emp.role },
  });

  const res = NextResponse.json({ success: true, user: { employeeId: grant.employeeId, name: emp.name, role: grant.role } });
  res.cookies.set(FMS_COOKIE, token, cookieOptions());
  return res;
});