import { timingSafeEqual } from "node:crypto";

/**
 * BUILT-IN TEST USERS — temporary, for trying FMS before the real database is connected.
 * Kept in code only: no database, no seed script, never written to OMS.
 *
 * ON automatically while MONGODB_URI is NOT set.
 * OFF automatically as soon as MONGODB_URI is set (real DB connected).
 * Override: FMS_ENABLE_TEST_USERS=true forces on, =false forces off.
 * To remove completely later: delete this file and the `payload.test` / `findTestUser` blocks.
 */
export function testUsersEnabled(): boolean {
  const flag = process.env.FMS_ENABLE_TEST_USERS;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return !process.env.MONGODB_URI;
}

export const TEST_USERS = [
  { employeeId: "TEST-ADMIN", name: "Test FMS Admin", email: "admin.test@fms.local", role: "FMS_ADMIN", label: "FMS Admin" },
  { employeeId: "TEST-FOUNDER", name: "Test Founder", email: "founder.test@fms.local", role: "FOUNDER", label: "Founder" },
  { employeeId: "TEST-HR", name: "Test HR", email: "hr.test@fms.local", role: "HR", label: "HR" },
  { employeeId: "TEST-HREXEC", name: "Test HR Executive", email: "hrexec.test@fms.local", role: "HR", label: "HR Executive" },
  { employeeId: "TEST-ACCOUNTS", name: "Test Accounts", email: "accounts.test@fms.local", role: "ACCOUNTS", label: "Accounts" },
] as const;
export type TestUser = (typeof TEST_USERS)[number];

export const testPassword = () => process.env.FMS_TEST_PASSWORD || "FmsTest@2026";

export function findTestUser(identifier: string): TestUser | null {
  const id = identifier.trim().toLowerCase();
  return TEST_USERS.find((u) => u.email === id || u.employeeId.toLowerCase() === id) ?? null;
}

export function getTestUser(employeeId: string): TestUser | null {
  return TEST_USERS.find((u) => u.employeeId === employeeId) ?? null;
}

export function checkTestPassword(input: string): boolean {
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(testPassword(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
