import type { Types } from "mongoose";
import { connectDB } from "./db";
import { FmsPayrollEntry, FmsPayrollRun, FmsTransaction, PAYROLL_STATUSES } from "@/models/fms";
import { listEmployees, getEmployee } from "./oms-read";
import { computeForEmployees, type EmployeeMonthResult } from "./payroll-service";
import { getPolicy } from "./settings";
import type { PayrollPolicy } from "./policy";
import type { OmsEmployeeView } from "./oms-read";
import { audit } from "./audit";
import { HttpError, type SessionUser } from "./auth";
import { currentMonthIST, monthEnd, todayIST, DATE_RE } from "./dates";
import type { Permission } from "./permissions";

type Actor = Pick<SessionUser, "employeeId" | "name" | "role" | "permissions">;

/**
 * Payroll status is kept PER EMPLOYEE (entry.status), so one employee can be submitted /
 * approved / finalized / disbursed on their own (e.g. to test), or everybody at once.
 * The run's `status` is the LOWEST stage among its included employees; `statusCounts` shows the mix.
 */
export const OPEN_STATUSES = ["Draft", "Under Review"];
const STAGE = (s?: string) => Math.max(0, PAYROLL_STATUSES.indexOf((s ?? "Draft") as (typeof PAYROLL_STATUSES)[number]));

function entryDoc(runId: Types.ObjectId, month: string, r: EmployeeMonthResult) {
  return {
    runId,
    month,
    employeeId: r.employee.id,
    employee: {
      name: r.employee.name, email: r.employee.email, dept: r.employee.dept,
      designation: r.employee.designation, location: r.employee.location,
    },
    structureId: (r.structure as { _id?: Types.ObjectId } | null)?._id,
    attendance: r.attendance,
    adjustmentsApplied: r.adjustmentsApplied,
    calc: r.calc,
    netPay: r.calc?.netPay ?? 0,
    flags: r.flags,
    adjustmentsSuperseded: r.adjustmentsSuperseded,
    omsSync: null,
  };
}

/** Older entries (before per-employee status) inherit the run's status once. */
async function ensureEntryStatuses(run: { _id: Types.ObjectId; status: string }) {
  await FmsPayrollEntry.updateMany({ runId: run._id, status: { $exists: false } }, { $set: { status: run.status } });
}

/** Active OMS employees (salary list for the month) + everyone who already has an entry. */
async function collectEmployees(month: string, existing: { employeeId: string }[], policy: PayrollPolicy) {
  const active = await listEmployees({ policy, month });
  const ids = new Set(active.map((e) => e.id));
  const extra = await Promise.all(existing.filter((e) => !ids.has(e.employeeId)).map((e) => getEmployee(e.employeeId)));
  return [...active, ...extra.filter((e): e is OmsEmployeeView => !!e)];
}

type Snap = { payableDays: number; lopDays: number; penaltyDays: number; netPay: number };
export type OmsChange = { employeeId: string; name: string; status?: string; before: Snap | null; after: Snap };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const snap = (calc: any, att: any, net: number | null | undefined): Snap => ({
  payableDays: calc?.payableDays ?? att?.payableDays ?? 0,
  lopDays: calc?.lopDays ?? att?.lopDays ?? 0,
  penaltyDays: calc?.penaltyDays ?? att?.violationDays ?? 0,
  netPay: net ?? 0,
});
const sameSnap = (a: Snap | null, b: Snap) => !!a && a.payableDays === b.payableDays && a.lopDays === b.lopDays && a.penaltyDays === b.penaltyDays && a.netPay === b.netPay;
const sameDays = (a: Snap | null, b: Snap) => !!a && a.payableDays === b.payableDays && a.lopDays === b.lopDays && a.penaltyDays === b.penaltyDays;

/** Totals + per-status counts + run status (= lowest stage of included employees). */
async function refreshTotals(runId: Types.ObjectId) {
  const entries = await FmsPayrollEntry.find({ runId, excluded: { $ne: true } }).select("calc netPay flags status").lean();
  const totals = { employees: entries.length, gross: 0, deductions: 0, net: 0, missingStructure: 0, flagged: 0 };
  const statusCounts: Record<string, number> = Object.fromEntries(PAYROLL_STATUSES.map((s) => [s, 0]));
  let lowest = PAYROLL_STATUSES.length - 1;
  for (const e of entries) {
    const c = e.calc as { grossEarnings?: number; totalDeductions?: number } | null;
    if (!c) totals.missingStructure++;
    totals.gross += c?.grossEarnings ?? 0;
    totals.deductions += c?.totalDeductions ?? 0;
    totals.net += e.netPay ?? 0;
    if ((e.flags ?? []).some((f) => !["HR_ADJUSTED", "MONTH_IN_PROGRESS", "UPDATED_FROM_OMS"].includes(f))) totals.flagged++;
    const st = e.status ?? "Draft";
    statusCounts[st] = (statusCounts[st] ?? 0) + 1;
    lowest = Math.min(lowest, STAGE(st));
  }
  const status = entries.length ? PAYROLL_STATUSES[lowest] : "Draft";
  await FmsPayrollRun.updateOne({ _id: runId }, { $set: { totals, statusCounts, status } });
  return totals;
}

/**
 * Keep payroll in step with OMS, per employee:
 *  - Draft / Under Review employees: recomputed and saved automatically when OMS data changed
 *    (flag UPDATED_FROM_OMS, previous values kept in omsSync.before). New OMS employees are added as Draft.
 *  - Approved / Finalized / Disbursed employees: never changed; a difference in payable / LOP / penalty days
 *    is reported as `drift` so finance can send that employee back to review.
 * Throttled to once per minute unless forced.
 */
export async function syncRunWithOms(month: string, opts: { force?: boolean } = {}) {
  await connectDB();
  const run = await FmsPayrollRun.findOne({ month }).lean();
  if (!run) return null;
  await ensureEntryStatuses(run);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prevSync = (run.lastSync ?? null) as any;
  if (!opts.force && prevSync?.at && Date.now() - new Date(prevSync.at).getTime() < 60_000) {
    return { ...prevSync, changedNow: 0, changedIds: [] as string[], driftIds: (prevSync?.drift ?? []).map((d: OmsChange) => d.employeeId) as string[] };
  }

  const policy = await getPolicy();
  const existing = await FmsPayrollEntry.find({ runId: run._id }).select("employeeId excluded calc attendance netPay status").lean();
  const byId = new Map(existing.map((e) => [e.employeeId, e]));
  const employees = await collectEmployees(month, existing, policy);
  const results = await computeForEmployees(employees, month, policy, "payroll");

  const applied: OmsChange[] = [];
  const drift: OmsChange[] = [];
  const ops: unknown[] = [];
  for (const r of results) {
    const prev = byId.get(r.employee.id);
    const before = prev ? snap(prev.calc, prev.attendance, prev.netPay) : null;
    const after = snap(r.calc, r.attendance, r.calc?.netPay ?? 0);
    const status = prev?.status ?? "Draft";
    if (!prev || OPEN_STATUSES.includes(status)) {
      if (sameSnap(before, after)) continue;
      applied.push({ employeeId: r.employee.id, name: r.employee.name, status, before, after });
      const doc = entryDoc(run._id, month, r);
      ops.push({
        updateOne: {
          filter: { month, employeeId: r.employee.id },
          update: {
            $set: { ...doc, flags: [...doc.flags, "UPDATED_FROM_OMS"], excluded: prev?.excluded ?? false, status, omsSync: { at: new Date(), before } },
          },
          upsert: true,
        },
      });
    } else if (!prev.excluded && !sameDays(before, after)) {
      drift.push({ employeeId: r.employee.id, name: r.employee.name, status, before, after });
    }
  }
  if (ops.length) await FmsPayrollEntry.bulkWrite(ops as never);
  await refreshTotals(run._id);

  const now = new Date();
  const lastSync = {
    at: now,
    drift: drift.slice(0, 200),
    driftCount: drift.length,
    lastApplied: applied.length ? { at: now, count: applied.length, changes: applied.slice(0, 100) } : prevSync?.lastApplied ?? null,
  };
  await FmsPayrollRun.updateOne({ _id: run._id }, { $set: { lastSync } });

  if (applied.length) {
    await audit(null, "payroll.oms_sync_applied", { entity: "payroll-run", entityId: month, updatedValue: { count: applied.length, changes: applied.slice(0, 50) } });
  }
  if (JSON.stringify(prevSync?.drift ?? []) !== JSON.stringify(lastSync.drift) && drift.length) {
    await audit(null, "payroll.oms_drift_detected", { entity: "payroll-run", entityId: month, updatedValue: { count: drift.length, changes: drift.slice(0, 50) } });
  }
  return { ...lastSync, changedNow: applied.length, changedIds: applied.map((c) => c.employeeId), driftIds: drift.map((c) => c.employeeId) };
}

/** Create the run or recalculate every Draft / Under Review employee (locked employees are never touched). */
export async function computeRun(month: string, actor: Actor) {
  await connectDB();
  if (month > currentMonthIST()) throw new HttpError(400, "Cannot run payroll for a future month");
  const policy = await getPolicy();
  let run = await FmsPayrollRun.findOne({ month });
  if (!run) {
    run = await FmsPayrollRun.create({ month, status: "Draft", history: [{ from: "", to: "Draft", by: actor.employeeId, byRole: actor.role, at: new Date(), note: "created" }] });
  }
  await ensureEntryStatuses(run);

  const existing = await FmsPayrollEntry.find({ runId: run._id }).select("employeeId excluded status").lean();
  const prevById = new Map(existing.map((e) => [e.employeeId, e]));
  const employees = (await collectEmployees(month, existing, policy)).filter((e) => {
    const st = prevById.get(e.id)?.status;
    return !st || OPEN_STATUSES.includes(st);
  });
  if (!employees.length) throw new HttpError(409, "Every employee in this payroll is already Approved or later — nothing to recalculate");

  const results = await computeForEmployees(employees, month, policy, "payroll");
  const ops = results.map((r) => ({
    updateOne: {
      filter: { month, employeeId: r.employee.id },
      update: { $set: { ...entryDoc(run!._id, month, r), excluded: prevById.get(r.employee.id)?.excluded ?? false, status: prevById.get(r.employee.id)?.status ?? "Draft" } },
      upsert: true,
    },
  }));
  if (ops.length) await FmsPayrollEntry.bulkWrite(ops as never);
  await FmsPayrollRun.updateOne(
    { _id: run._id },
    { $set: { policySnapshot: policy, computedAt: new Date(), computedBy: actor.employeeId, lastSync: { at: new Date(), drift: [], driftCount: 0, lastApplied: null } } },
  );
  const totals = await refreshTotals(run._id);
  await audit(actor, "payroll.compute", { entity: "payroll-run", entityId: month, updatedValue: { ...totals, recalculated: employees.length } });
  return FmsPayrollRun.findById(run._id).lean();
}

/** Recompute one employee after an adjustment (only while that employee is Draft / Under Review). */
export async function recomputeEntry(month: string, employeeId: string, actor: Actor) {
  const run = await FmsPayrollRun.findOne({ month }).lean();
  if (!run) return;
  await ensureEntryStatuses(run);
  const cur = await FmsPayrollEntry.findOne({ month, employeeId }).select("status excluded").lean();
  if (cur && !OPEN_STATUSES.includes(cur.status ?? "Draft")) return;
  const emp = await getEmployee(employeeId);
  if (!emp) return;
  const [r] = await computeForEmployees([emp], month, await getPolicy(), "payroll");
  await FmsPayrollEntry.updateOne(
    { month, employeeId },
    { $set: { ...entryDoc(run._id, month, r), status: cur?.status ?? "Draft", excluded: cur?.excluded ?? false } },
    { upsert: true },
  );
  await refreshTotals(run._id);
  await audit(actor, "payroll.recompute_entry", { entity: "payroll-entry", entityId: `${employeeId}:${month}` });
}

/** Status of one employee's payroll entry (Draft if not created yet). */
export async function entryStatus(month: string, employeeId: string): Promise<string | null> {
  const run = await FmsPayrollRun.findOne({ month }).select("_id status").lean();
  if (!run) return null;
  const e = await FmsPayrollEntry.findOne({ month, employeeId }).select("status").lean();
  return e ? e.status ?? run.status : "Draft";
}

export const TRANSITIONS: Record<string, { from: string[]; to: string; perm: Permission; label: string }> = {
  submit: { from: ["Draft"], to: "Under Review", perm: "payroll.prepare", label: "Submit for Review" },
  reopen: { from: ["Under Review"], to: "Draft", perm: "payroll.prepare", label: "Back to Draft" },
  approve: { from: ["Under Review"], to: "Approved", perm: "payroll.approve", label: "Approve" },
  reject: { from: ["Approved"], to: "Under Review", perm: "payroll.approve", label: "Send Back" },
  finalize: { from: ["Approved"], to: "Finalized", perm: "payroll.finalize", label: "Finalize" },
  disburse: { from: ["Finalized"], to: "Disbursed", perm: "payroll.disburse", label: "Disburse" },
};

/**
 * Move employees to the next payroll stage.
 *  - employeeIds omitted → every included employee currently in the "from" stage (bulk)
 *  - employeeIds given   → only those employees (e.g. one employee to test)
 */
export async function transitionEntries(
  month: string,
  action: string,
  actor: Actor,
  extra: { note?: string; disbursedOn?: string; reference?: string; employeeIds?: string[] } = {},
) {
  await connectDB();
  const t = TRANSITIONS[action];
  if (!t) throw new HttpError(400, "Unknown action");
  if (!actor.permissions.includes(t.perm)) throw new HttpError(403, `Missing permission: ${t.perm}`);
  const run = await FmsPayrollRun.findOne({ month }).lean();
  if (!run) throw new HttpError(404, "Payroll run not found");
  await ensureEntryStatuses(run);

  const single = Array.isArray(extra.employeeIds) && extra.employeeIds.length > 0;
  const ids = single ? extra.employeeIds!.map(String).slice(0, 1000) : null;

  if (["reject", "reopen"].includes(action) && !(extra.note && extra.note.trim().length >= 5)) {
    throw new HttpError(400, "A note is required");
  }
  if (action === "disburse") {
    if (!extra.disbursedOn || !DATE_RE.test(extra.disbursedOn)) throw new HttpError(400, "disbursedOn (YYYY-MM-DD) is required");
    if (extra.disbursedOn > todayIST()) throw new HttpError(400, "Disbursement date cannot be in the future");
  }
  if (action === "approve" || action === "finalize") {
    const policy = await getPolicy();
    if (!policy.confirmed) throw new HttpError(409, "Payroll policy has not been confirmed in Settings yet");
    if (todayIST() < monthEnd(month)) throw new HttpError(409, "The payroll month has not ended yet");
  }
  if (action === "approve" && run.computedBy === actor.employeeId && !["FOUNDER", "FMS_ADMIN"].includes(actor.role)) {
    throw new HttpError(409, "Maker-checker: the person who calculated payroll cannot approve it");
  }

  // Re-check OMS first so nobody approves / finalizes numbers that changed since.
  let sync: Awaited<ReturnType<typeof syncRunWithOms>> = null;
  if (action === "approve" || action === "finalize") sync = await syncRunWithOms(month, { force: true });

  const baseFilter: Record<string, unknown> = { runId: run._id, excluded: { $ne: true }, status: { $in: t.from } };
  if (ids) baseFilter.employeeId = { $in: ids };
  const targets = await FmsPayrollEntry.find(baseFilter).select("employeeId employee calc netPay status").lean();
  if (!targets.length) {
    if (ids) {
      const cur = await FmsPayrollEntry.find({ runId: run._id, employeeId: { $in: ids } }).select("employeeId status excluded").lean();
      const st = cur.map((c) => `${c.employeeId}: ${c.excluded ? "Excluded" : c.status}`).join(", ") || "not in this payroll";
      throw new HttpError(409, `Cannot ${t.label.toLowerCase()} — needs status ${t.from.join("/")} (${st})`);
    }
    throw new HttpError(409, `No employee is in ${t.from.join("/")} status`);
  }

  if (action === "approve" || action === "finalize") {
    const noStructure = targets.filter((e) => !e.calc);
    if (noStructure.length) {
      throw new HttpError(409, `${noStructure.length} employee(s) have no salary structure (${noStructure.slice(0, 5).map((e) => e.employeeId).join(", ")}${noStructure.length > 5 ? "…" : ""}) — add one, exclude them, or ${t.label.toLowerCase()} employees one by one`);
    }
    const targetIds = new Set(targets.map((e) => e.employeeId));
    const changed = (sync?.changedIds ?? []).filter((id: string) => targetIds.has(id));
    if (action === "approve" && changed.length) {
      throw new HttpError(409, `OMS attendance/leave just changed for ${changed.length} employee(s) (${changed.slice(0, 5).join(", ")}); their payroll was updated. Review, then approve again.`);
    }
    const drifted = (sync?.driftIds ?? []).filter((id: string) => targetIds.has(id));
    if (action === "finalize" && drifted.length) {
      throw new HttpError(409, `OMS attendance/leave changed after approval for ${drifted.length} employee(s) (${drifted.slice(0, 5).join(", ")}). Send them back to review first.`);
    }
  }

  // Atomic per-entry claim: only entries still in the "from" stage move.
  const targetIds = targets.map((e) => e._id);
  const histItem = { from: t.from[0], to: t.to, by: actor.employeeId, byRole: actor.role, at: new Date(), note: extra.note };
  const res = await FmsPayrollEntry.updateMany(
    { _id: { $in: targetIds }, status: { $in: t.from } },
    { $set: { status: t.to }, $push: { history: histItem } },
  );
  const moved = await FmsPayrollEntry.find({ _id: { $in: targetIds }, status: t.to }).select("employeeId employee netPay").lean();

  if (action === "disburse") {
    const docs = moved.filter((e) => (e.netPay ?? 0) > 0).map((e) => ({
      type: "SALARY_DISBURSEMENT" as const,
      month,
      employeeId: e.employeeId,
      location: (e.employee as { location?: string })?.location,
      amount: e.netPay,
      disbursedOn: extra.disbursedOn!,
      reference: extra.reference,
      idempotencyKey: `salary:${month}:${e.employeeId}`,
      recordedBy: actor.employeeId,
    }));
    try {
      if (docs.length) await FmsTransaction.insertMany(docs, { ordered: false }).catch((err) => {
        if (err?.code !== 11000 && !err?.writeErrors?.every((w: { code?: number }) => w.code === 11000)) throw err;
      });
      await FmsPayrollEntry.updateMany({ _id: { $in: moved.map((e) => e._id) } }, { $set: { "disbursement.status": "Disbursed" } });
    } catch (err) {
      await FmsPayrollEntry.updateMany({ _id: { $in: moved.map((e) => e._id) } }, { $set: { status: "Finalized" } });
      await refreshTotals(run._id);
      throw err;
    }
  }

  await refreshTotals(run._id);

  const scope = ids ? (ids.length === 1 ? `employee ${ids[0]}` : `${moved.length} selected employees`) : `all (${moved.length})`;
  await FmsPayrollRun.updateOne({ _id: run._id }, { $push: { history: { from: t.from[0], to: t.to, by: actor.employeeId, byRole: actor.role, at: new Date(), note: `${t.label} — ${scope}${extra.note ? ` · ${extra.note}` : ""}` } } });
  await audit(actor, `payroll.${action}`, {
    entity: "payroll-run", entityId: month, previousValue: t.from.join("/"), updatedValue: { status: t.to, employees: moved.map((e) => e.employeeId) },
    reason: extra.note || (action === "disburse" ? `Disbursed on ${extra.disbursedOn} ref ${extra.reference ?? "-"}` : undefined),
  });
  return { moved: res.modifiedCount, employees: moved.map((e) => e.employeeId), run: await FmsPayrollRun.findById(run._id).lean() };
}

export async function setExcluded(month: string, employeeId: string, excluded: boolean, reason: string, actor: Actor) {
  const run = await FmsPayrollRun.findOne({ month }).lean();
  if (!run) throw new HttpError(404, "Payroll run not found");
  await ensureEntryStatuses(run);
  const e = await FmsPayrollEntry.findOne({ runId: run._id, employeeId }).select("status").lean();
  if (!e || (e.status ?? "Draft") !== "Draft") throw new HttpError(409, "An employee can only be excluded / included while their payroll is Draft");
  if (reason.trim().length < 10) throw new HttpError(400, "A reason of at least 10 characters is required");
  await FmsPayrollEntry.updateOne({ runId: run._id, employeeId }, { $set: { excluded } });
  await refreshTotals(run._id);
  await audit(actor, excluded ? "payroll.exclude_employee" : "payroll.include_employee", {
    entity: "payroll-entry", entityId: `${employeeId}:${month}`, reason,
  });
}