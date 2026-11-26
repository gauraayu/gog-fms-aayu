import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { connectDB } from "@/lib/db";
import { OmsEmployee } from "@/models/oms-readonly";
import { FmsAccess } from "@/models/fms";
import { clientIp, handle, readJson, HttpError } from "@/lib/auth";
import { getRoleAccess, resolveGrantRole } from "@/lib/role-access";
import { getPolicy } from "@/lib/settings";
import { createToken, cookieOptions, FMS_COOKIE } from "@/lib/session";
import { OTP_COOKIE, clearOtpCookie, verifyOtp } from "@/lib/login-otp";
import { audit } from "@/lib/audit";

/** Step 2 of login: check the email OTP, then create the FMS session. */
export const POST = handle(async (req: Request) => {
  const body = await readJson<{ code?: string }>(req);
  await connectDB();
  const ip = await clientIp();
  const challenge = (await cookies()).get(OTP_COOKIE)?.value;
  let ch;
  try {
    ch = await verifyOtp(challenge, String(body.code ?? ""));
  } catch (e) {
    if (e instanceof HttpError) await audit(null, "auth.otp_failed", { entity: "auth", ip, reason: e.message });
    throw e;
  }

  // Re-check everything at the moment of login (access may have changed in the last minutes).
  const [emp, grantDoc, ra, policy] = await Promise.all([
    OmsEmployee.findOne({ _id: ch.uid, isRemoved: { $ne: true } }).select("_id id name email role status").lean(),
    FmsAccess.findOne({ employeeId: ch.employeeId }).lean(),
    getRoleAccess(),
    getPolicy(),
  ]);
  if (!emp || String(emp.id) !== ch.employeeId) throw new HttpError(403, "Your OMS account is no longer available.");
  if (!policy.activeStatuses.includes(String(emp.status ?? "Active"))) throw new HttpError(403, `Your OMS status is "${emp.status}". Only active employees can use FMS.`);
  const grant = resolveGrantRole(grantDoc, String(emp.role ?? ""), ra);
  if (!grant) throw new HttpError(403, "Your FMS access was removed.");

  const token = createToken({ uid: String(emp._id), eid: ch.employeeId, email: String(emp.email), role: grant.role });
  await audit({ employeeId: ch.employeeId, name: String(emp.name), role: grant.role }, "auth.login", {
    entity: "auth", ip, updatedValue: { accessSource: grant.source, omsRole: emp.role, method: "PASSWORD+EMAIL_OTP" },
  });
  const res = NextResponse.json({ success: true, user: { employeeId: ch.employeeId, name: emp.name, role: grant.role } });
  res.cookies.set(FMS_COOKIE, token, cookieOptions());
  return clearOtpCookie(res);
});