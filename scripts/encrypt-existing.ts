/**
 * One-time: encrypt FMS money data that was saved before encryption was switched on
 * (and, after a key change, re-encrypt everything with the new FMS_DATA_KEY).
 * Touches ONLY fms_* collections. OMS collections are never read or written here.
 *
 *   npx tsx --env-file=.env.local scripts/encrypt-existing.ts           # dry run: only counts
 *   npx tsx --env-file=.env.local scripts/encrypt-existing.ts --apply   # encrypt
 *
 * Safe to run again: values already encrypted with the current key are skipped.
 */
import mongoose from "mongoose";
import { connectDB } from "../src/lib/db";
import { ENC_PREFIX, dataKeyConfigured, decryptValue, encryptValue, isEncrypted } from "../src/lib/field-crypto";
import { createHash } from "node:crypto";

const TARGETS: Record<string, string[]> = {
  fms_salary_structures: ["basic", "hra", "otherAllowances", "epf", "pt", "tds", "otherDeductions", "collegePaid", "statutory", "notes", "annualPackage", "monthlySalary", "monthlyOverride", "config", "employerEpf", "changeReason"],
  fms_payroll_runs: ["totals"],
  fms_payroll_entries: ["attendance", "adjustmentsApplied", "calc", "netPay", "omsSync", "adjustmentsSuperseded"],
  fms_payroll_adjustments: ["originalValue", "systemValue", "updatedValue"],
  fms_payslips: ["netPay", "data"],
  fms_client_invoices: ["amount", "taxAmount", "totalAmount", "amountReceived", "notes"],
  fms_statutory_challans: ["amount"],
  fms_financial_transactions: ["amount"],
  fms_email_logs: ["netPay"],
  fms_audit_logs: ["previousValue", "updatedValue"],
};

async function main() {
  const apply = process.argv.includes("--apply");
  if (!dataKeyConfigured()) throw new Error("FMS_DATA_KEY is not set");
  const raw = process.env.FMS_DATA_KEY!.trim();
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  const currentId = createHash("sha256").update(key).digest("hex").slice(0, 8);
  const current = (v: unknown) => isEncrypted(v) && v.startsWith(`${ENC_PREFIX}${currentId}:`);

  await connectDB();
  const db = mongoose.connection.db!;
  let total = 0;
  for (const [coll, paths] of Object.entries(TARGETS)) {
    const c = db.collection(coll);
    let docs = 0, values = 0;
    for await (const d of c.find({ $or: paths.map((p) => ({ [p]: { $exists: true, $ne: null } })) })) {
      const set: Record<string, string> = {};
      for (const p of paths) {
        const v = d[p];
        if (v === undefined || v === null || current(v)) continue;
        set[p] = encryptValue(isEncrypted(v) ? decryptValue(v) : v); // plain → encrypt · old key → re-encrypt
      }
      if (!Object.keys(set).length) continue;
      docs++; values += Object.keys(set).length;
      // raw driver on purpose: bypasses the append-only audit guard, writes only these fields
      if (apply) await c.updateOne({ _id: d._id }, { $set: set });
    }
    total += docs;
    console.log(`${apply ? "✓ encrypted" : "• would encrypt"} ${coll}: ${docs} documents, ${values} values`);
  }
  console.log(apply ? `Done — ${total} documents encrypted.` : `Dry run — ${total} documents need encryption. Run again with --apply.`);
  await mongoose.disconnect();
}
main().catch(async (e) => {
  console.error("✗", (e as Error).message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});