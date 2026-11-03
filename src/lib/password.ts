import { scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Verification-only copy of OMS src/lib/password.ts.
 * OMS stores either `scrypt$<salthex>$<hashhex>` (keylen 64) or legacy plain text.
 *
 * Deliberate differences from OMS:
 *  - FMS NEVER rewrites / rehashes the stored password (read-only on `employees`).
 *  - FMS does NOT accept the OMS default passkey for empty stored passwords:
 *    an empty stored password can never log into the finance app.
 */
export function isHashedPassword(stored: string): boolean {
  return typeof stored === "string" && stored.startsWith("scrypt$") && stored.split("$").length === 3;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyPassword(input: string, stored: string | null | undefined): boolean {
  if (!input || typeof input !== "string") return false;
  if (!stored || typeof stored !== "string") return false;

  if (isHashedPassword(stored)) {
    const [, saltHex, hashHex] = stored.split("$");
    try {
      const expected = Buffer.from(hashHex, "hex");
      const actual = scryptSync(input, Buffer.from(saltHex, "hex"), expected.length || 64);
      return safeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  return safeEqual(Buffer.from(input, "utf8"), Buffer.from(stored, "utf8"));
}
