import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { FmsLoginOtp } from "@/models/fms";
import { sendFmsMail, isValidRecipient } from "./fms-mail";
import { HttpError } from "./auth";

/**
 * Email OTP after the password (2-step login).
 *  - 6-digit code, valid OTP_TTL_MIN minutes, MAX_ATTEMPTS wrong tries, one use only.
 *  - Only an HMAC of the code is stored (fms_login_otps); documents auto-delete after an hour.
 *  - The challenge is bound to the browser by an httpOnly cookie, so a code alone is useless.
 *  - Resend after RESEND_SEC seconds; at most MAX_SENDS_PER_HOUR emails per employee per hour.
 * Turn off with FMS_LOGIN_OTP=false (then the password alone logs in, as before).
 */
export const OTP_COOKIE = "gog_fms_otp";
export const OTP_TTL_MIN = 5;
export const MAX_ATTEMPTS = 5;
export const RESEND_SEC = 60;
export const MAX_SENDS_PER_HOUR = 5;

export const otpEnabled = () => String(process.env.FMS_LOGIN_OTP ?? "true").toLowerCase() !== "false";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function pepper() {
  const s = process.env.FMS_SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV !== "production") return "gog-fms-local-otp-pepper";
  throw new Error("FMS_SESSION_SECRET must be set (>= 32 chars)");
}
export const hashCode = (challengeHash: string, code: string) => createHmac("sha256", pepper()).update(`fms.otp.v1.${challengeHash}.${code}`).digest("hex");
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

export function maskEmail(email: string) {
  const [u, d] = email.split("@");
  if (!d) return email;
  const shown = u.length <= 2 ? u[0] ?? "" : u.slice(0, 2);
  return `${shown}${"*".repeat(Math.max(2, u.length - shown.length))}@${d}`;
}

export function otpEmailHtml(name: string, code: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:480px;margin:auto;color:#18181b">
  <div style="background:#0a0a0a;color:#e4e4e7;padding:18px 22px;border-radius:12px 12px 0 0">
    <div style="font-size:15px;font-weight:700">GOG FMS</div>
    <div style="font-size:11px;color:#a1a1aa">Geeks of Gurukul · Finance Management System</div>
  </div>
  <div style="border:1px solid #e4e4e7;border-top:0;padding:22px;border-radius:0 0 12px 12px;font-size:13px;line-height:1.6">
    <p>Hi ${esc(name)},</p>
    <p>Your one-time password to sign in to GOG FMS is:</p>
    <p style="font-size:30px;font-weight:800;letter-spacing:8px;margin:14px 0;color:#059669">${code}</p>
    <p>It is valid for <b>${OTP_TTL_MIN} minutes</b> and can be used only once.</p>
    <p style="color:#71717a;font-size:12px">Never share this code with anyone — GOG staff will never ask for it. If you did not try to sign in, change your password and inform the FMS Admin.</p>
  </div></div>`;
}

async function deliver(to: string, name: string, code: string) {
  if (!isValidRecipient(to)) throw new HttpError(400, "Your OMS profile has no valid email address, so the OTP cannot be sent. Ask HR to update your email in OMS.");
  if (process.env.NODE_ENV !== "production" && process.env.FMS_OTP_DEV_LOG === "true") console.log(`[FMS] DEV ONLY — login OTP for ${to}: ${code}`);
  try {
    await sendFmsMail({ to, subject: "Your GoG FMS login OTP", html: otpEmailHtml(name, code) });
  } catch (e) {
    console.error("[FMS] OTP email failed:", (e as Error).message);
    if (process.env.NODE_ENV !== "production" && process.env.FMS_OTP_DEV_LOG === "true") return; // local testing without SMTP
    throw new HttpError(503, "Could not send the OTP email. Check the SMTP settings (SMTP_USER / SMTP_PASS) or contact the FMS Admin.");
  }
}

async function sendsLastHour(employeeId: string) {
  const docs = await FmsLoginOtp.find({ employeeId, createdAt: { $gte: new Date(Date.now() - 3600_000) } }).select("sends").lean();
  return docs.reduce((s, d) => s + (d.sends ?? 1), 0);
}

const cookieOpts = () => ({
  httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" as const, path: "/api/auth", maxAge: 15 * 60,
});

/** Password was correct and access is fine → email an OTP and ask for it. */
export async function startOtp(p: { uid: string; employeeId: string; email: string; name: string; role: string; accessSource?: string; ip: string }) {
  if ((await sendsLastHour(p.employeeId)) >= MAX_SENDS_PER_HOUR) throw new HttpError(429, "Too many OTPs requested. Try again after an hour.");
  const challenge = randomBytes(32).toString("base64url");
  const challengeHash = sha(challenge);
  const code = newCode();
  const now = Date.now();
  await deliver(p.email, p.name, code);
  await FmsLoginOtp.create({
    challengeHash, uid: p.uid, employeeId: p.employeeId, email: p.email, role: p.role, accessSource: p.accessSource,
    codeHash: hashCode(challengeHash, code), expiresAt: new Date(now + OTP_TTL_MIN * 60_000), purgeAt: new Date(now + 3600_000), ip: p.ip,
  });
  const res = NextResponse.json({ otpRequired: true, email: maskEmail(p.email), expiresInSec: OTP_TTL_MIN * 60, resendInSec: RESEND_SEC });
  res.cookies.set(OTP_COOKIE, challenge, cookieOpts());
  return res;
}

export async function findChallenge(challenge: string | undefined) {
  if (!challenge) return null;
  return FmsLoginOtp.findOne({ challengeHash: sha(challenge) });
}

/** Check the code. Returns the challenge on success (and marks it used — one use only). */
export async function verifyOtp(challenge: string | undefined, code: string) {
  const doc = await findChallenge(challenge);
  if (!doc || doc.usedAt) throw new HttpError(401, "This sign-in has expired. Enter your password again.");
  if (doc.expiresAt.getTime() < Date.now()) throw new HttpError(401, "OTP expired. Click “Resend OTP” or sign in again.");
  if ((doc.attempts ?? 0) >= MAX_ATTEMPTS) throw new HttpError(429, "Too many wrong OTPs. Sign in again to get a new one.");
  const clean = String(code ?? "").replace(/\D/g, "");
  const ok = clean.length === 6 && timingSafeEqual(Buffer.from(hashCode(doc.challengeHash, clean)), Buffer.from(doc.codeHash));
  if (!ok) {
    const upd = await FmsLoginOtp.findOneAndUpdate({ _id: doc._id, usedAt: { $exists: false } }, { $inc: { attempts: 1 } }, { new: true }).lean();
    const left = Math.max(0, MAX_ATTEMPTS - (upd?.attempts ?? MAX_ATTEMPTS));
    throw new HttpError(401, left ? `Wrong OTP. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many wrong OTPs. Sign in again to get a new one.");
  }
  // atomic one-time use
  const used = await FmsLoginOtp.findOneAndUpdate({ _id: doc._id, usedAt: { $exists: false } }, { $set: { usedAt: new Date() } }, { new: true }).lean();
  if (!used) throw new HttpError(401, "This OTP was already used. Sign in again.");
  return used;
}

/** New code for the same sign-in (after RESEND_SEC). */
export async function resendOtp(challenge: string | undefined, name: string | undefined) {
  const doc = await findChallenge(challenge);
  if (!doc || doc.usedAt) throw new HttpError(401, "This sign-in has expired. Enter your password again.");
  const wait = Math.ceil((doc.sentAt.getTime() + RESEND_SEC * 1000 - Date.now()) / 1000);
  if (wait > 0) throw new HttpError(429, `Please wait ${wait} seconds before asking for a new OTP.`);
  if ((await sendsLastHour(doc.employeeId)) >= MAX_SENDS_PER_HOUR) throw new HttpError(429, "Too many OTPs requested. Try again after an hour.");
  const code = newCode();
  await deliver(doc.email, name || "there", code);
  await FmsLoginOtp.updateOne(
    { _id: doc._id },
    { $set: { codeHash: hashCode(doc.challengeHash, code), attempts: 0, sentAt: new Date(), expiresAt: new Date(Date.now() + OTP_TTL_MIN * 60_000) }, $inc: { sends: 1 } },
  );
  return { email: maskEmail(doc.email), expiresInSec: OTP_TTL_MIN * 60, resendInSec: RESEND_SEC };
}

export const clearOtpCookie = (res: NextResponse) => {
  res.cookies.set(OTP_COOKIE, "", { ...cookieOpts(), maxAge: 0 });
  return res;
};