/**
 * Diagnose payroll entries of a month WITHOUT printing any amount or key.
 *   npx tsx --env-file=.env.local scripts/check-entries.ts 2026-10
 * For each entry: status, and for calc / attendance / netPay whether the stored value is
 * plain, encrypted (with which key id), or encrypted twice, and whether FMS can read it.
 * Read-only: changes nothing.
 */
import mongoose from "mongoose";
import { createHash } from "node:crypto";
import { connectDB } from "../src/lib/db";
import { ENC_PREFIX, decryptValue, isEncrypted } from "../src/lib/field-crypto";

function keyId() {
  const raw = (process.env.FMS_DATA_KEY ?? "").trim();
  if (!raw) return "(no FMS_DATA_KEY)";
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return createHash("sha256").update(k).digest("hex").slice(0, 8);
}

function describe(v: unknown): string {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? "plain number" : "plain NaN!";
  if (!isEncrypted(v)) return typeof v === "object" ? "plain object" : `plain ${typeof v}`;
  const kid = v.slice(ENC_PREFIX.length).split(":")[0];
  let layers = 0, cur: unknown = v;
  try {
    while (isEncrypted(cur)) { cur = decryptValue(cur); layers++; }
  } catch (e) {
    return `encrypted (key ${kid}) — CANNOT decrypt: ${(e as Error).message.slice(0, 80)}`;
  }
  const inner = typeof cur === "number" ? (Number.isFinite(cur) ? "number" : "NaN!") : cur === null ? "null" : typeof cur;
  return `encrypted ×${layers} (key ${kid}) → ${inner}`;
}

async function main() {
  const month = process.argv[2];
  if (!/^\d{4}-\d{2}$/.test(month ?? "")) throw new Error("Usage: scripts/check-entries.ts YYYY-MM");
  await connectDB();
  console.log(`Current FMS_DATA_KEY id: ${keyId()}`);
  const rows = await mongoose.connection.db!.collection("fms_payroll_entries").find({ month }).project({ employeeId: 1, status: 1, calc: 1, attendance: 1, netPay: 1 }).toArray();
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const sig = `status=${r.status} | calc: ${describe(r.calc)} | attendance: ${describe(r.attendance)} | netPay: ${describe(r.netPay)}`;
    groups.set(sig, [...(groups.get(sig) ?? []), String(r.employeeId)]);
  }
  for (const [sig, ids] of groups) console.log(`${ids.length} × ${sig}\n    e.g. ${ids.slice(0, 5).join(", ")}`);
  await mongoose.disconnect();
}
main().catch(async (e) => { console.error("✗", (e as Error).message); await mongoose.disconnect().catch(() => {}); process.exit(1); });