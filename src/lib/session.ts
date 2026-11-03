import { createHmac, timingSafeEqual } from "node:crypto";
import { testUsersEnabled } from "./test-users";

/**
 * FMS session token — same HMAC-SHA256 pattern as OMS src/lib/session.ts,
 * but with its OWN cookie name and its OWN secret (no fallback), so OMS
 * tokens can never be accepted here and vice versa.
 */
export const FMS_COOKIE = "gog_fms_session";

export interface FmsTokenPayload {
  uid: string; // OMS employees._id
  eid: string; // OMS employee id (e.g. EMP251)
  email: string;
  role: string; // FMS role from fms_access
  test?: boolean; // test user from fms_test_users
  iat: number;
  exp: number;
}

// Used ONLY while the real DB is not connected (built-in test-user mode) or in local dev,
// so the app works with zero configuration. With a real DB in production a real secret is required.
const DEV_FALLBACK_SECRET = "gog-fms-local-test-mode-secret-do-not-use-in-production";

function secret(): string {
  const s = process.env.FMS_SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV !== "production" || testUsersEnabled()) return DEV_FALLBACK_SECRET;
  throw new Error("FMS_SESSION_SECRET must be set (>= 32 chars)");
}

export const sessionTtlSeconds = () => Math.max(1, Number(process.env.FMS_SESSION_HOURS || 10)) * 3600;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const sign = (body: string) => createHmac("sha256", secret()).update(`fms.v1.${body}`).digest("base64url");

export function createToken(p: Omit<FmsTokenPayload, "iat" | "exp">, nowSec = Math.floor(Date.now() / 1000)): string {
  const payload: FmsTokenPayload = { ...p, iat: nowSec, exp: nowSec + sessionTtlSeconds() };
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string | undefined | null, nowSec = Math.floor(Date.now() / 1000)): FmsTokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  let expected: string;
  try {
    expected = sign(body);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as FmsTokenPayload;
    if (!p.exp || p.exp < nowSec) return null;
    return p;
  } catch {
    return null;
  }
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge: sessionTtlSeconds(),
  };
}