/**
 * One-time bootstrap: grant FOUNDER (full access) to the OMS employee ids in FMS_BOOTSTRAP_ADMIN_IDS.
 * Writes ONLY to fms_access / fms_audit_logs. Run: `npm run seed:access` (needs MONGODB_URI).
 * Dry run by default; pass --apply to write.
 */
import mongoose from "mongoose";
import { connectDB } from "../src/lib/db";
import { FmsAccess, FmsAudit } from "../src/models/fms";
import { OmsEmployee } from "../src/models/oms-readonly";

async function main() {
  const apply = process.argv.includes("--apply");
  const ids = (process.env.FMS_BOOTSTRAP_ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error("Set FMS_BOOTSTRAP_ADMIN_IDS=EMP001,EMP002");
  await connectDB();
  for (const id of ids) {
    const emp = await OmsEmployee.findOne({ id, isRemoved: { $ne: true } }).select("id name email role status").lean();
    if (!emp) {
      console.log(`✗ ${id}: not found in OMS employees`);
      continue;
    }
    console.log(`${apply ? "✓ granting" : "• would grant"} FOUNDER → ${emp.id} ${emp.name} <${emp.email}> (OMS role ${emp.role}, ${emp.status})`);
    if (apply) {
      await FmsAccess.updateOne(
        { employeeId: String(emp.id) },
        { $set: { email: String(emp.email), name: String(emp.name), role: "FOUNDER", active: true, grantedBy: "BOOTSTRAP" } },
        { upsert: true },
      );
      await FmsAudit.create({ userId: "BOOTSTRAP", userName: "Bootstrap script", userRole: "SYSTEM", action: "access.grant", entity: "fms_access", entityId: String(emp.id), updatedValue: { role: "FOUNDER" }, reason: "Initial FMS admin bootstrap" });
    }
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});