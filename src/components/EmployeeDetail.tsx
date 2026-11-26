"use client";

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { api, qs } from "@/lib/client";
import { formatINR } from "@/lib/money";
import { monthLabel } from "@/lib/dates";
import { useAuth } from "./AuthContext";
import { Badge, Button, Field, Input, Modal, Notice, Select, Spinner, Stat, Table, Tabs, Textarea, td, th, tr } from "./ui";
import type { PayableDaysResult } from "@/lib/payable-days";
import type { SalaryCalc } from "@/lib/payroll-calc";

interface Detail {
  month: string;
  employee: { id: string; name: string; email: string; dept: string; designation: string; location: string; status: string; joiningDate?: string };
  attendance: PayableDaysResult;
  adjustmentsSuperseded: { field: string; adjustedTo: number; omsAtEdit: number; omsNow: number }[];
  adjustments: { _id: string; field: string; originalValue: number; updatedValue: number; reason: string; modifiedByName?: string; modifiedBy: string; modifiedByRole?: string; createdAt: string }[];
  calc: SalaryCalc | null;
  structure: unknown;
  flags: string[];
}

const FIELD_LABEL: Record<string, string> = {
  payableDays: "Payable Days", lopDays: "LOP Days", penaltyDays: "Penalty Days",
  penaltyAmount: "Penalty Amount (₹)", otherEarnings: "Other Earnings (₹)", otherDeductions: "Other Deductions (₹)",
};
const MONEY = new Set(["penaltyAmount", "otherEarnings", "otherDeductions"]);
const showVal = (f: string, v: number) => (MONEY.has(f) ? formatINR(v) : String(v));

const KIND_TONE: Record<string, "emerald" | "sky" | "amber" | "red" | "zinc" | "purple"> = {
  PAYABLE: "emerald", WEEKLY_OFF: "zinc", HOLIDAY: "sky", PARTLY_PAYABLE: "amber", NON_PAYABLE: "red",
  UPCOMING: "zinc", NOT_EMPLOYED: "zinc",
};
const FIELD_NAME: Record<string, string> = { payableDays: "Payable Days", lopDays: "LOP Days", penaltyDays: "Penalty Days", penaltyAmount: "Penalty Amount" };

export function EmployeeDetail({ employeeId, month, onClose, onChanged }: { employeeId: string | null; month: string; onClose: () => void; onChanged?: () => void }) {
  const { can } = useAuth();
  const [d, setD] = useState<Detail | null>(null);
  const [tab, setTab] = useState<"summary" | "days" | "salary" | "history">("summary");
  const [mode, setMode] = useState<"soFar" | "payroll">("payroll");
  const [edit, setEdit] = useState(false);
  const [field, setField] = useState("payableDays");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);

  const load = () => {
    if (!employeeId) return;
    setD(null);
    api<Detail>(`/api/employees/${encodeURIComponent(employeeId)}${qs({ month, mode })}`).then(setD).catch((e) => setMsg({ k: "error", t: e.message }));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [employeeId, month, mode]);

  const current = (f: string): number => {
    if (!d) return 0;
    const applied = d.adjustments.find((a) => a.field === f);
    if (applied) return applied.updatedValue;
    const a = d.attendance;
    return ({ payableDays: a.payableDays, lopDays: a.lopDays, penaltyDays: a.violationDays, penaltyAmount: a.finesPaise, otherEarnings: 0, otherDeductions: 0 } as Record<string, number>)[f] ?? 0;
  };

  async function save() {
    setBusy(true);
    try {
      await api("/api/adjustments", { method: "POST", json: { employeeId, month, field, value: Number(value), reason } });
      setMsg({ k: "ok", t: "Adjustment saved, payroll recalculated and audit logged." });
      setEdit(false);
      setValue("");
      setReason("");
      load();
      onChanged?.();
    } catch (e) {
      setMsg({ k: "error", t: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const a = d?.attendance;
  const c = d?.calc;
  return (
    <Modal open={!!employeeId} onClose={onClose} size="xl" title={d ? `${d.employee.name} · ${d.employee.id} · ${monthLabel(month)}` : "Employee"}>
      {msg && <div className="mb-3"><Notice kind={msg.k} onClose={() => setMsg(null)}>{msg.t}</Notice></div>}
      {!d ? <Spinner /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs value={tab} onChange={setTab} items={[
              { value: "summary", label: "Summary" }, { value: "days", label: "Day-wise Attendance" },
              ...(c ? [{ value: "salary" as const, label: "Salary Calculation" }] : []), { value: "history", label: `Adjustments (${d.adjustments.length})` },
            ]} />
            <div className="flex items-center gap-2">
              <Select value={mode} onChange={(e) => setMode(e.target.value as "soFar" | "payroll")} className="w-40">
                <option value="payroll">Full month (payroll)</option>
                <option value="soFar">So far (till today)</option>
              </Select>
              {can("adjustments.manage") && <Button variant="outline" onClick={() => setEdit(true)}><Pencil size={12} /> Edit Payroll Details</Button>}
            </div>
          </div>

          {d.adjustmentsSuperseded?.length > 0 && (
            <Notice kind="warn">
              HR changed this employee&apos;s data in OMS after the FMS edit, so the OMS value now applies:{" "}
              {d.adjustmentsSuperseded.map((x) => `${FIELD_NAME[x.field] ?? x.field}: FMS edit ${showVal(x.field, x.adjustedTo)} ignored (OMS was ${showVal(x.field, x.omsAtEdit)}, now ${showVal(x.field, x.omsNow)})`).join(" · ")}.
              Edit again if the FMS value is still needed.
            </Notice>
          )}
          {d.attendance.provisional && <Notice kind="warn">Month in progress — days after today are shown as Upcoming and projected as payable (same as OMS).</Notice>}
          {d.flags.length > 0 && <div className="flex flex-wrap gap-1.5">{d.flags.map((f) => <Badge key={f} tone={f === "HR_ADJUSTED" ? "sky" : "amber"}>{f}</Badge>)}</div>}

          {tab === "summary" && a && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="Payable Days" value={c?.payableDays ?? a.payableDays} />
              <Stat label="LOP Days" value={c?.lopDays ?? a.lopDays} />
              <Stat label="Present" value={a.presentDays} />
              <Stat label="Weekly Offs / Holidays" value={`${a.weeklyOffs} / ${a.holidays}`} />
              <Stat label="Paid Leave" value={a.paidLeaveDays} />
              <Stat label="Unpaid Leave" value={a.unpaidLeaveDays} />
              <Stat label="Leaves Applied / Approved" value={`${a.leavesApplied} / ${a.leavesApproved}`} />
              <Stat label="Penalty Days (approved)" value={c?.penaltyDays ?? a.violationDays} />
              <Stat label="₹ Penalties (OMS)" value={formatINR(a.finesPaise)} />
              <Stat label="Pending Leave Days" value={a.pendingLeaveDays} />
              <Stat label="HR Corrections (OMS)" value={`+${a.correctedDays} / −${a.hrDeductedDays}`} />
              <Stat label="Pending Penalty Decisions" value={a.pendingPenalties} />
              <Stat label="Department" value={d.employee.dept || "—"} />
              <Stat label="Net Pay" value={c ? formatINR(c.netPay) : "No structure"} />
            </div>
          )}

          {tab === "days" && a && (
            <Table head={<tr><th className={th}>Date</th><th className={th}>Payable Status</th><th className={th}>Attendance</th><th className={th}>Leave</th><th className={th}>Payable</th><th className={th}>LOP</th><th className={th}>Reason (as in OMS)</th></tr>}>
              {a.days.map((x) => (
                <tr key={x.date} className={tr}>
                  <td className={`${td} tabular-nums whitespace-nowrap`}>{x.date} <span className="text-zinc-600">{x.weekday}</span></td>
                  <td className={td}><Badge tone={KIND_TONE[x.kind]}>{x.payableStatus}</Badge>{x.correction && <div className="text-[10px] text-sky-400 mt-0.5">HR corrected in OMS</div>}</td>
                  <td className={`${td} text-[11px]`}>{x.attendance}{x.clockIn ? <div className="text-zinc-600">{x.clockIn}{x.clockOut ? `–${x.clockOut}` : ""}</div> : null}</td>
                  <td className={`${td} text-[11px]`}>{x.leave || ""}</td>
                  <td className={`${td} tabular-nums`}>{x.payable}</td>
                  <td className={`${td} tabular-nums`}>{x.lop || ""}</td>
                  <td className={`${td} text-[11px] text-zinc-500`}>{x.source}{x.penalties.length > 0 && <div className="text-amber-400/80">{x.penalties.join(", ")}</div>}</td>
                </tr>
              ))}
            </Table>
          )}

          {tab === "salary" && c && (
            <div className="space-y-3">
              {c.adjustedPayable !== undefined && (() => {
                const configured = c.fullMonthly.basic + c.fullMonthly.hra + c.fullMonthly.otherAllowances;
                const col = c.college ?? { configured: 0, payable: 0 };
                const EPF_MODE: Record<string, string> = { AUTO_FIXED: "Auto · fixed (≥ threshold)", AUTO_PERCENT: "Auto · % of adjusted", FIXED: "Manual · fixed", PERCENT: "Manual · %", NONE: "—" };
                const TDS_MODE: Record<string, string> = { AUTO: "Auto · % of adjusted", AUTO_BELOW_LIMIT: "Auto · below limit (₹0)", MANUAL: "Manual", NONE: c.epfApplicable ? "Not applied (EPF employee)" : "—" };
                const rows: [string, string][] = [
                  ["Configured Monthly Salary", formatINR(configured)],
                  ["Company Contribution (configured)", formatINR(configured - col.configured)],
                  ["College Contribution (configured → this month)", col.configured ? `${formatINR(col.configured)} → ${formatINR(col.payable)}` : "—"],
                  ["Payable Days / Calendar Days", `${c.payableDays} / ${c.calendarDays}`],
                  ["Paid / Unpaid Leave", a ? `${a.paidLeaveDays} / ${a.unpaidLeaveDays}` : "—"],
                  ["LOP Days · Penalty Days", `${c.lopDays} · ${c.penaltyDays}`],
                  ["LOP Amount", formatINR(c.deductions.lop)],
                  ["Penalties", formatINR(c.deductions.penalties)],
                  ["Adjusted Monthly Payable", formatINR(c.adjustedPayable)],
                  ["EPF Applicable", c.epfApplicable ? "Yes" : "No"],
                  ["EPF Mode", EPF_MODE[c.epfMode] ?? c.epfMode],
                  ["Employee EPF", formatINR(c.deductions.epf)],
                  ["Employer EPF (company cost, not deducted)", formatINR(c.employerEpf ?? 0)],
                  ["TDS", `${formatINR(c.deductions.tds)} · ${TDS_MODE[c.tdsMode] ?? c.tdsMode}`],
                  ["PT", formatINR(c.deductions.pt)],
                  ["Other Deductions", formatINR(c.deductions.other)],
                  ["Final Net (paid by GOG)", formatINR(c.netPay)],
                  ["Employee receives in total (GOG + College)", formatINR(c.netPay + col.payable)],
                ];
                return (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-2">Payroll summary — EPF / TDS decided on the adjusted payable salary</div>
                    <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1">
                      {rows.map(([l, v]) => (
                        <div key={l} className={`flex justify-between text-[12px] ${l.startsWith("Adjusted") || l.startsWith("Final") ? "font-bold text-emerald-300" : "text-zinc-300"}`}>
                          <span className="text-zinc-500">{l}</span><span className="tabular-nums">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              <div className="grid sm:grid-cols-2 gap-3">
                <Table head={<tr><th className={th}>Earnings</th><th className={`${th} text-right`}>Amount</th></tr>}>
                  {[["Basic", c.fullMonthly.basic], ["HRA", c.fullMonthly.hra], ["Allowances", c.fullMonthly.otherAllowances], ["Other Earnings", c.earnings.otherEarnings], ["Gross Earnings", c.grossEarnings]].map(([l, v]) => (
                    <tr key={l as string} className={tr}><td className={td}>{l}</td><td className={`${td} text-right tabular-nums`}>{formatINR(v as number)}</td></tr>
                  ))}
                </Table>
                <Table head={<tr><th className={th}>Deductions</th><th className={`${th} text-right`}>Amount</th></tr>}>
                  {[["Loss of Pay", c.deductions.lop], ["EPF", c.deductions.epf], ["PT", c.deductions.pt], ["TDS", c.deductions.tds], ["Penalties", c.deductions.penalties], ["Other", c.deductions.other], ["Paid by College (CS)", c.deductions.college ?? 0], ["Total Deductions", c.totalDeductions]].map(([l, v]) => (
                    <tr key={l as string} className={tr}><td className={td}>{l}</td><td className={`${td} text-right tabular-nums`}>{formatINR(v as number)}</td></tr>
                  ))}
                </Table>
              </div>
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 flex justify-between text-sm font-bold text-emerald-300">
                <span>Net Payable</span><span className="tabular-nums">{formatINR(c.netPay)}</span>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 space-y-1">
                <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Calculation trace</div>
                {c.trace.map((t, i) => <div key={i} className="text-[11px] text-zinc-400 font-mono">{t}</div>)}
              </div>
            </div>
          )}

          {tab === "history" && (
            d.adjustments.length === 0 ? <p className="text-xs text-zinc-500">No payroll adjustments for this month. OMS attendance and leave records are never modified by FMS.</p> : (
              <Table head={<tr><th className={th}>When</th><th className={th}>Field</th><th className={th}>Original</th><th className={th}>Updated</th><th className={th}>Reason</th><th className={th}>By</th></tr>}>
                {d.adjustments.map((x) => (
                  <tr key={x._id} className={tr}>
                    <td className={`${td} whitespace-nowrap`}>{new Date(x.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                    <td className={td}>{FIELD_LABEL[x.field] ?? x.field}</td>
                    <td className={`${td} tabular-nums`}>{showVal(x.field, x.originalValue)}</td>
                    <td className={`${td} tabular-nums text-white`}>{showVal(x.field, x.updatedValue)}</td>
                    <td className={`${td} text-[11px]`}>{x.reason}</td>
                    <td className={td}>{x.modifiedByName ?? x.modifiedBy} <span className="text-zinc-600">({x.modifiedByRole})</span></td>
                  </tr>
                ))}
              </Table>
            )
          )}
        </div>
      )}

      <Modal
        open={edit} onClose={() => setEdit(false)} title="Edit Payroll Details"
        footer={<><Button variant="outline" onClick={() => setEdit(false)}>Cancel</Button><Button loading={busy} disabled={reason.trim().length < 10 || value === ""} onClick={save}>Save Changes</Button></>}
      >
        <div className="space-y-3">
          <Field label="Field">
            <Select value={field} onChange={(e) => { setField(e.target.value); setValue(""); }}>
              {Object.entries(FIELD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Current value"><Input disabled value={showVal(field, current(field))} /></Field>
            <Field label="New value"><Input type="number" min={0} step={MONEY.has(field) ? "0.01" : "0.5"} value={value} onChange={(e) => setValue(e.target.value)} /></Field>
          </div>
          <Field label="Reason for modification (mandatory)" hint="Min 10 characters. Stored with your name, role and timestamp in the audit history.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Attendance correction approved by HR after verification." />
          </Field>
          <p className="text-[10px] text-zinc-500">This changes the payroll calculation only. Original OMS attendance / leave data stays untouched.</p>
        </div>
      </Modal>
    </Modal>
  );
}