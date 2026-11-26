"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Send, CheckCircle2, Lock, Banknote, Undo2, Eye, Ban, Download } from "lucide-react";
import { api } from "@/lib/client";
import { formatINR } from "@/lib/money";
import { monthLabel } from "@/lib/dates";
import { useAuth } from "@/components/AuthContext";
import { Badge, Button, Card, Empty, Field, Input, Modal, Notice, Page, PageHeader, Select, Spinner, Stat, Table, Textarea, td, th, tr } from "@/components/ui";
import { EmployeeDetail } from "@/components/EmployeeDetail";
import { cn } from "@/lib/utils";
import type { Permission } from "@/lib/permissions";

type Snap = { payableDays: number; lopDays: number; penaltyDays: number; netPay: number };
type OmsChange = { employeeId: string; name: string; status?: string; before: Snap | null; after: Snap };
interface Run {
  month: string; status: string; computedAt?: string; computedBy?: string;
  totals: { employees: number; gross: number; deductions: number; net: number; missingStructure: number; flagged: number };
  statusCounts?: Record<string, number>;
  history: { from: string; to: string; by: string; byRole: string; at: string; note?: string }[];
  lastSync?: { at: string; drift?: OmsChange[]; driftCount?: number; lastApplied?: { at: string; count: number; changes: OmsChange[] } | null };
}
interface Entry {
  _id: string; employeeId: string; employee: { name: string; dept: string; designation: string; location: string };
  calc: { payableDays: number; lopDays: number; penaltyDays: number; grossEarnings: number; totalDeductions: number } | null;
  netPay: number | null; flags: string[]; excluded: boolean; status?: string; disbursement?: { status: string };
  omsSync?: { at: string; before: Snap | null } | null;
}

const STEPS = ["Draft", "Under Review", "Approved", "Finalized", "Disbursed"];
const ist = (d: string) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const FLAG_TONE: Record<string, "sky" | "red" | "amber" | "emerald"> = { HR_ADJUSTED: "sky", UPDATED_FROM_OMS: "emerald", HR_CORRECTED_IN_OMS: "sky", NO_SALARY_STRUCTURE: "red" };

type ActionKey = "submit" | "reopen" | "approve" | "reject" | "finalize" | "disburse";
const ACTIONS: Record<ActionKey, { from: string; label: string; perm: Permission; icon: typeof Send; needsNote?: boolean; primary?: boolean }> = {
  submit: { from: "Draft", label: "Submit for Review", perm: "payroll.prepare", icon: Send, primary: true },
  reopen: { from: "Under Review", label: "Back to Draft", perm: "payroll.prepare", icon: Undo2, needsNote: true },
  approve: { from: "Under Review", label: "Approve", perm: "payroll.approve", icon: CheckCircle2, primary: true },
  reject: { from: "Approved", label: "Send Back", perm: "payroll.approve", icon: Undo2, needsNote: true },
  finalize: { from: "Approved", label: "Finalize", perm: "payroll.finalize", icon: Lock, primary: true },
  disburse: { from: "Finalized", label: "Disburse", perm: "payroll.disburse", icon: Banknote, primary: true },
};
const ORDER: ActionKey[] = ["submit", "reopen", "approve", "reject", "finalize", "disburse"];

export default function PayrollPage() {
  const { can } = useAuth();
  const [month, setMonth] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  // pending action needing a note or disbursement details; employee = null → bulk
  const [pending, setPending] = useState<null | { action: ActionKey; employee: Entry | null }>(null);
  const [note, setNote] = useState("");
  const [disbursedOn, setDisbursedOn] = useState("");
  const [reference, setReference] = useState("");
  const [excl, setExcl] = useState<Entry | null>(null);
  const [exclReason, setExclReason] = useState("");

  useEffect(() => {
    api<{ currentMonth: string }>("/api/meta").then((m) => setMonth((x) => x || m.currentMonth));
    api<{ runs: Run[] }>("/api/payroll/runs").then((r) => setRuns(r.runs)).catch(() => {});
  }, []);

  const load = useCallback(() => {
    if (!month) return;
    setEntries(null);
    api<{ run: Run | null; entries: Entry[] }>(`/api/payroll/runs/${month}`).then((r) => { setRun(r.run); setEntries(r.entries); }).catch((e) => setMsg({ k: "error", t: e.message }));
  }, [month]);
  useEffect(load, [load]);

  async function call(label: string, fn: () => Promise<unknown>, ok: (r: unknown) => string) {
    setBusy(label);
    try {
      const r = await fn();
      setMsg({ k: "ok", t: ok(r) });
      load();
      api<{ runs: Run[] }>("/api/payroll/runs").then((x) => setRuns(x.runs));
    } catch (e) {
      setMsg({ k: "error", t: (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  /** employee = null → every employee in that stage; otherwise just that employee */
  function doAction(action: ActionKey, employee: Entry | null, extra: Record<string, string> = {}) {
    const a = ACTIONS[action];
    const key = `${action}:${employee?.employeeId ?? "ALL"}`;
    return call(
      key,
      () => api(`/api/payroll/runs/${month}`, { method: "POST", json: { action, ...(employee ? { employeeIds: [employee.employeeId] } : {}), ...extra } }),
      (r) => {
        const n = (r as { moved?: number })?.moved ?? 0;
        return employee ? `${a.label}: ${employee.employee?.name ?? employee.employeeId} done` : `${a.label}: ${n} employee(s) done`;
      },
    );
  }
  function start(action: ActionKey, employee: Entry | null) {
    if (ACTIONS[action].needsNote || action === "disburse") {
      setNote(""); setReference("");
      setPending({ action, employee });
    } else doAction(action, employee);
  }

  const counts = run?.statusCounts ?? {};
  const included = (entries ?? []).filter((e) => !e.excluded);
  const countIn = (s: string) => counts[s] ?? included.filter((e) => (e.status ?? "Draft") === s).length;
  const anyOpen = !run || countIn("Draft") + countIn("Under Review") > 0 || (entries ?? []).length === 0;
  const shown = useMemo(() => (entries ?? []).filter((e) => !statusFilter || (statusFilter === "Excluded" ? e.excluded : !e.excluded && (e.status ?? "Draft") === statusFilter)), [entries, statusFilter]);
  const pendingDef = pending ? ACTIONS[pending.action] : null;
  const pendingNet = pending
    ? (pending.employee ? pending.employee.netPay ?? 0 : included.filter((e) => (e.status ?? "Draft") === "Finalized").reduce((s, e) => s + (e.netPay ?? 0), 0))
    : 0;

  return (
    <Page wide>
      <PageHeader
        title="Payroll Management"
        subtitle="Calculate → review → approve → finalize → disburse. Do it for everyone at once (top buttons) or for one employee (row buttons)."
        actions={
          <>
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-40" />
            {run && can("salary.view") && (
              <a href={`/api/reports?type=payroll-sheet&month=${month}&format=xlsx`} className="h-9 px-3 rounded-lg border border-zinc-700 text-xs font-semibold text-zinc-200 hover:text-white hover:border-zinc-500 inline-flex items-center gap-1.5" title="Excel with all salary columns for this month">
                <Download size={12} /> Download Excel
              </a>
            )}
            {can("payroll.prepare") && anyOpen && (
              <Button loading={busy === "compute"} onClick={() => call("compute", () => api("/api/payroll/runs", { method: "POST", json: { month } }), () => (run ? "Draft / Under Review employees recalculated from latest OMS data" : "Payroll draft created"))}>
                <RefreshCw size={12} /> {run ? "Recalculate" : "Calculate Payroll"}
              </Button>
            )}
          </>
        }
      />
      {msg && <Notice kind={msg.k} onClose={() => setMsg(null)}>{msg.t}</Notice>}

      {run && (
        <Card>
          <div className="flex flex-wrap items-center gap-1.5 mb-4">
            {STEPS.map((s, i) => {
              const n = countIn(s);
              return (
                <div key={s} className="flex items-center gap-1.5">
                  <button
                    onClick={() => setStatusFilter(statusFilter === s ? "" : s)}
                    className={cn("px-3 py-1 rounded-full text-[10px] font-bold border", n ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300" : "border-zinc-800 text-zinc-600", statusFilter === s && "ring-1 ring-emerald-400")}
                    title="Filter rows by this stage"
                  >{s} <span className="tabular-nums">{n}</span></button>
                  {i < STEPS.length - 1 && <span className="w-4 h-px bg-zinc-800" />}
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <Stat label="Employees" value={run.totals.employees} />
            <Stat label="Gross" value={formatINR(run.totals.gross, { decimals: false })} />
            <Stat label="Deductions" value={formatINR(run.totals.deductions, { decimals: false })} />
            <Stat label="Net Payable" value={formatINR(run.totals.net, { decimals: false })} />
            <Stat label="No Structure" value={<span className={run.totals.missingStructure ? "text-amber-400" : ""}>{run.totals.missingStructure}</span>} />
            <Stat label="Flagged" value={<span className={run.totals.flagged ? "text-amber-400" : ""}>{run.totals.flagged}</span>} />
          </div>

          <div className="mt-4">
            <div className="text-[9px] font-bold uppercase tracking-widest text-zinc-500 mb-2">For everyone in that stage</div>
            <div className="flex flex-wrap gap-2">
              {ORDER.filter((k) => can(ACTIONS[k].perm) && countIn(ACTIONS[k].from) > 0).map((k) => {
                const a = ACTIONS[k];
                const Icon = a.icon;
                return (
                  <Button key={k} variant={a.primary ? "primary" : "outline"} loading={busy === `${k}:ALL`} onClick={() => start(k, null)}>
                    <Icon size={12} /> {a.label} — All ({countIn(a.from)})
                  </Button>
                );
              })}
            </div>
            <p className="text-[10px] text-zinc-500 mt-2">Want to test with one person first? Use the button on that employee&apos;s row instead.</p>
          </div>

          {run.history?.length > 0 && (
            <div className="mt-4 text-[11px] text-zinc-500 space-y-0.5">
              {run.history.slice(-5).reverse().map((h, i) => (
                <div key={i}>{new Date(h.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} — {h.from || "∅"} → <span className="text-zinc-300">{h.to}</span> by {h.by} ({h.byRole}){h.note ? ` · ${h.note}` : ""}</div>
              ))}
            </div>
          )}
        </Card>
      )}

      {run && included.some((e) => e.flags.includes("UPDATED_FROM_OMS")) && (
        <Notice kind="ok">
          {included.filter((e) => e.flags.includes("UPDATED_FROM_OMS")).length} employee(s) were updated automatically because HR changed attendance / leave / payable days in OMS
          {run.lastSync?.lastApplied?.at ? ` (last change ${ist(run.lastSync.lastApplied.at)})` : ""}. Rows are marked UPDATED_FROM_OMS.
        </Notice>
      )}
      {run && (run.lastSync?.driftCount ?? 0) > 0 && (
        <Notice kind="warn">
          OMS changed after approval for {run.lastSync!.driftCount} employee(s):{" "}
          {run.lastSync!.drift!.slice(0, 5).map((c) => `${c.name} (${c.status}) payable ${c.before?.payableDays ?? "—"} → ${c.after.payableDays}`).join(" · ")}
          {run.lastSync!.driftCount! > 5 ? " …" : ""}. Approved employees: use “Send Back” on their row to apply it. Finalized / Disbursed are never changed automatically.
        </Notice>
      )}
      {run?.lastSync?.at && <p className="text-[10px] text-zinc-600 -mt-2">Checked against OMS: {ist(run.lastSync.at)}</p>}

      {!entries ? <Spinner /> : !run ? (
        <Card><Empty text={`No payroll for ${month ? monthLabel(month) : "this month"} yet. Click “Calculate Payroll” to create a draft.`} /></Card>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-48" aria-label="Filter by stage">
              <option value="">All employees ({entries.length})</option>
              {STEPS.map((s) => <option key={s} value={s}>{s} ({countIn(s)})</option>)}
              <option value="Excluded">Excluded</option>
            </Select>
          </div>
          <Table head={
            <tr><th className={th}>Employee</th><th className={th}>Status</th><th className={th}>Payable</th><th className={th}>LOP</th><th className={th}>Penalty d</th><th className={th}>Gross</th><th className={th}>Deductions</th><th className={th}>Net</th><th className={th}>Flags</th><th className={th}>Actions</th></tr>
          }>
            {shown.map((e) => {
              const est = e.status ?? "Draft";
              const rowActions = e.excluded ? [] : ORDER.filter((k) => ACTIONS[k].from === est && can(ACTIONS[k].perm));
              return (
                <tr key={e._id} className={cn(tr, e.excluded && "opacity-40")}>
                  <td className={td}><div className="font-semibold text-white truncate max-w-[180px]">{e.employee?.name}</div><div className="text-[10px] text-zinc-500">{e.employeeId} · {e.employee?.dept}</div></td>
                  <td className={td}>{e.excluded ? <Badge tone="zinc">Excluded</Badge> : <Badge>{est}</Badge>}</td>
                  <td className={`${td} tabular-nums`}>{e.calc?.payableDays ?? "—"}{e.omsSync?.before && e.omsSync.before.payableDays !== e.calc?.payableDays && <div className="text-[10px] text-zinc-500">was {e.omsSync.before.payableDays}</div>}</td>
                  <td className={`${td} tabular-nums`}>{e.calc?.lopDays ?? "—"}</td>
                  <td className={`${td} tabular-nums`}>{e.calc?.penaltyDays || ""}</td>
                  <td className={`${td} tabular-nums`}>{e.calc ? formatINR(e.calc.grossEarnings, { decimals: false }) : "—"}</td>
                  <td className={`${td} tabular-nums`}>{e.calc ? formatINR(e.calc.totalDeductions, { decimals: false }) : "—"}</td>
                  <td className={`${td} tabular-nums font-semibold text-white`}>{e.netPay !== null ? formatINR(e.netPay, { decimals: false }) : "•••"}</td>
                  <td className={td}><div className="flex flex-wrap gap-1 max-w-[220px]">{e.flags.filter((f) => f !== "MONTH_IN_PROGRESS").map((f) => <Badge key={f} tone={FLAG_TONE[f] ?? "amber"}>{f}</Badge>)}</div></td>
                  <td className={`${td} whitespace-nowrap`}>
                    <div className="flex items-center gap-1">
                      {rowActions.map((k) => {
                        const a = ACTIONS[k];
                        const Icon = a.icon;
                        return (
                          <Button key={k} variant={a.primary ? "primary" : "outline"} className="h-8 px-2.5" loading={busy === `${k}:${e.employeeId}`} onClick={() => start(k, e)} title={`${a.label} — only ${e.employee?.name}`}>
                            <Icon size={12} /> {a.label}
                          </Button>
                        );
                      })}
                      <button onClick={() => setOpen(e.employeeId)} className="h-8 px-2 rounded-lg border border-zinc-800 text-zinc-300 hover:text-white inline-flex items-center gap-1" title="View details"><Eye size={12} /></button>
                      {est === "Draft" && can("payroll.prepare") && (
                        <button onClick={() => { setExcl(e); setExclReason(""); }} className="h-8 px-2 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white inline-flex items-center gap-1" title={e.excluded ? "Include" : "Exclude"}><Ban size={12} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        </>
      )}

      {runs.length > 0 && (
        <Card title="Payroll history">
          <div className="flex flex-wrap gap-2">
            {runs.map((r) => (
              <button key={r.month} onClick={() => setMonth(r.month)} className={cn("px-3 py-2 rounded-xl border text-xs flex items-center gap-2", r.month === month ? "border-emerald-500/40 bg-emerald-500/10" : "border-zinc-800 hover:border-zinc-600")}>
                <span className="text-white">{monthLabel(r.month)}</span><Badge>{r.status}</Badge>
              </button>
            ))}
          </div>
        </Card>
      )}

      <EmployeeDetail employeeId={open} month={month} onClose={() => setOpen(null)} onChanged={load} />

      <Modal
        open={!!pending} onClose={() => setPending(null)}
        title={pending && pendingDef ? `${pendingDef.label} — ${pending.employee ? pending.employee.employee?.name : `All ${pendingDef.from} (${countIn(pendingDef.from)})`}` : ""}
        footer={<>
          <Button variant="outline" onClick={() => setPending(null)}>Cancel</Button>
          <Button
            loading={!!busy}
            disabled={pending?.action === "disburse" ? !disbursedOn : note.trim().length < 5}
            onClick={async () => {
              const p = pending!;
              setPending(null);
              await doAction(p.action, p.employee, p.action === "disburse" ? { disbursedOn, reference, note } : { note });
            }}
          >Confirm</Button>
        </>}
      >
        {pending?.action === "disburse" ? (
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">
              This records that net salary {pending.employee ? `for ${pending.employee.employee?.name}` : `for all Finalized employees`} ({formatINR(pendingNet)}) was actually paid for {month && monthLabel(month)}. It feeds the dashboard and cannot be undone from the UI.
            </p>
            <Field label="Disbursement date"><Input type="date" value={disbursedOn} onChange={(e) => setDisbursedOn(e.target.value)} /></Field>
            <Field label="Bank / UTR reference (optional)"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
          </div>
        ) : (
          <Field label="Note (required)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        )}
      </Modal>

      <Modal
        open={!!excl} onClose={() => setExcl(null)} title={excl?.excluded ? "Include employee in payroll" : "Exclude employee from payroll"}
        footer={<><Button variant="outline" onClick={() => setExcl(null)}>Cancel</Button><Button disabled={exclReason.trim().length < 10} onClick={async () => {
          const e = excl!; setExcl(null);
          await call("excl", () => api(`/api/payroll/runs/${month}`, { method: "POST", json: { action: e.excluded ? "include" : "exclude", employeeId: e.employeeId, reason: exclReason } }), () => "Updated");
        }}>Confirm</Button></>}
      >
        <Field label={`Reason for ${excl?.employee?.name ?? ""}`} hint="Min 10 characters — audited."><Textarea value={exclReason} onChange={(e) => setExclReason(e.target.value)} /></Field>
      </Modal>
    </Page>
  );
}