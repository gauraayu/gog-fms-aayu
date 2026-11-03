import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, scryptSync } from "node:crypto";
import { verifyPassword } from "../src/lib/password";
import { createToken, verifyToken } from "../src/lib/session";
import { resolvePermissions, ALL_PERMISSIONS } from "../src/lib/permissions";
import { OmsEmployee, OmsAttendance, OmsWriteBlockedError } from "../src/models/oms-readonly";
import { assertFmsKey, sniffType } from "../src/lib/s3";

process.env.FMS_SESSION_SECRET = "test-secret-that-is-at-least-32-characters-long";

test("verifyPassword: plain text (OMS legacy) and scrypt hashes", () => {
  assert.equal(verifyPassword("abc123", "abc123"), true);
  assert.equal(verifyPassword("abc124", "abc123"), false);
  const salt = randomBytes(16);
  const hash = scryptSync("s3cret", salt, 64);
  const stored = `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
  assert.equal(verifyPassword("s3cret", stored), true);
  assert.equal(verifyPassword("wrong", stored), false);
});

test("verifyPassword: empty stored password never authenticates (no OMS default passkey)", () => {
  assert.equal(verifyPassword("26082001", ""), false);
  assert.equal(verifyPassword("26082001", undefined), false);
  assert.equal(verifyPassword("", "x"), false);
});

test("FMS token: valid, tampered, expired, and OMS-style token rejected", () => {
  const t = createToken({ uid: "u1", eid: "EMP1", email: "a@b.com", role: "HR" });
  assert.equal(verifyToken(t)?.eid, "EMP1");
  const [body] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ uid: "u1", eid: "EMP1", email: "a@b.com", role: "FMS_ADMIN", iat: 0, exp: 9e9 })).toString("base64url");
  assert.equal(verifyToken(`${forged}.${t.split(".")[1]}`), null);
  assert.equal(verifyToken(t, Math.floor(Date.now() / 1000) + 11 * 3600), null);
  // An OMS gog_session token signed with a different secret/format must not verify
  const omsSig = createHmac("sha256", "oms-secret").update(body).digest("base64url");
  assert.equal(verifyToken(`${body}.${omsSig}`), null);
});

test("permission matrix: OMS role grants nothing; FMS_ADMIN always all; overrides apply", () => {
  assert.deepEqual(resolvePermissions("TECH_TEAM"), []);
  assert.deepEqual(resolvePermissions("FMS_ADMIN", { FMS_ADMIN: [] }), ALL_PERMISSIONS);
  assert.deepEqual(resolvePermissions("FOUNDER", { FOUNDER: [] }), ALL_PERMISSIONS);
  assert.ok(!resolvePermissions("HR").includes("payroll.approve"));
  assert.deepEqual(resolvePermissions("HR", { HR: ["dashboard.view", "bogus"] }), ["dashboard.view"]);
});

test("OMS read-only models refuse every write before touching the DB", async () => {
  await assert.rejects(() => new OmsEmployee({ id: "X" }).save(), OmsWriteBlockedError);
  await assert.rejects(() => OmsEmployee.updateOne({ id: "X" }, { $set: { name: "Y" } }).exec(), OmsWriteBlockedError);
  await assert.rejects(() => OmsAttendance.deleteMany({}).exec(), OmsWriteBlockedError);
  await assert.rejects(() => OmsAttendance.findOneAndUpdate({}, { status: "Absent" }).exec(), OmsWriteBlockedError);
});

test("S3 keys are confined to the FMS prefix; file type sniffed from bytes", () => {
  assert.throws(() => assertFmsKey("1700000_resume.pdf"));
  assert.throws(() => assertFmsKey("gog-fms/../oms/file.pdf"));
  assert.doesNotThrow(() => assertFmsKey("gog-fms/invoices/2026/10/x.pdf"));
  assert.equal(sniffType(Buffer.from("%PDF-1.7 ...")), "application/pdf");
  assert.equal(sniffType(Buffer.from("MZ\x90\x00 exe")), null);
});

test("built-in test users: on without DB, off once MONGODB_URI is set, flag overrides", async () => {
  const { testUsersEnabled, findTestUser, checkTestPassword, TEST_USERS } = await import("../src/lib/test-users");
  const save = { f: process.env.FMS_ENABLE_TEST_USERS, m: process.env.MONGODB_URI };
  delete process.env.FMS_ENABLE_TEST_USERS; delete process.env.MONGODB_URI;
  assert.equal(testUsersEnabled(), true);
  process.env.MONGODB_URI = "mongodb://x/y";
  assert.equal(testUsersEnabled(), false);
  process.env.FMS_ENABLE_TEST_USERS = "true";
  assert.equal(testUsersEnabled(), true);
  process.env.FMS_ENABLE_TEST_USERS = save.f ?? ""; if (save.m) process.env.MONGODB_URI = save.m; else delete process.env.MONGODB_URI;
  assert.deepEqual(TEST_USERS.map((u) => u.role), ["FMS_ADMIN", "FOUNDER", "HR", "HR", "ACCOUNTS"]);
  assert.equal(findTestUser("HR.TEST@fms.local")?.employeeId, "TEST-HR");
  assert.equal(findTestUser("test-accounts")?.role, "ACCOUNTS");
  assert.equal(findTestUser("someone@gog.com"), null);
  assert.equal(checkTestPassword("FmsTest@2026"), true);
  assert.equal(checkTestPassword("fmstest@2026"), false);
  const t = createToken({ uid: "TEST-HR", eid: "TEST-HR", email: "hr.test@fms.local", role: "HR", test: true });
  assert.equal(verifyToken(t)?.test, true);
});

test("OMS role auto-access: FOUNDER/HR/HR_EXECUTIVE allowed, others denied, explicit revoke wins", async () => {
  const { resolveGrantRole, DEFAULT_ROLE_ACCESS } = await import("../src/lib/role-access");
  assert.equal(resolveGrantRole(null, "HR", DEFAULT_ROLE_ACCESS)?.role, "HR");
  assert.equal(resolveGrantRole(null, "HR_EXECUTIVE", DEFAULT_ROLE_ACCESS)?.role, "HR");
  assert.equal(resolveGrantRole(null, "FOUNDER", DEFAULT_ROLE_ACCESS)?.role, "FOUNDER");
  assert.equal(resolveGrantRole(null, "TECH_TEAM", DEFAULT_ROLE_ACCESS), null);
  assert.equal(resolveGrantRole({ role: "HR", active: false }, "HR", DEFAULT_ROLE_ACCESS), null);
  assert.equal(resolveGrantRole({ role: "ACCOUNTS", active: true }, "TECH_TEAM", DEFAULT_ROLE_ACCESS)?.role, "ACCOUNTS");
  assert.equal(resolveGrantRole(null, "HR", { enabled: false, map: DEFAULT_ROLE_ACCESS.map }), null);
});