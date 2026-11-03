"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, History, Search } from "lucide-react";
import { api, qs } from "@/lib/client";
import { formatINR } from "@/lib/money";
import { monthLabel } from "@/lib/dates";
import { useAuth } from "@/components/AuthContext";
import { Badge, Button, Empty, Field, Input, Modal, Notice, Page, PageHeader, Select, Spinner, Table, Textarea, td, th, tr } from "@/components/ui";

type Rule = { mode: "NONE" | "FIXED" | "PERCENT_OF_EARNED_BASIC"; amount: number; percent: number };
interface Structure { _id: string; employeeId: string; effectiveFrom: string; basic: number; hra: number; otherAllowances: number; epf: Rule; pt: Rule; tds: Rule; otherDeductions: number; collegePaid?: number; statutory?: { uan?: string; pfAccountNo?: string; esiNumber?: string; pran?: string; pan?: string; taxRegime?: string }; notes?: string; createdBy?: string; createdAt?: string }
interface Row { employee: { id: string; name: string; dept: string; designation: string }; current: Structure | null; versions: number }

const ruleText = (r?: Rule) => !r || r.mode === "NONE" ? "—" : r.mode === "FIXED" ? formatINR(r.amount, { decimals: false }) : `${r.percent}% of earned basic`;
const emptyRule = { mode: "NONE", amount: "", percent: "" };

export default function SalaryStructuresPage() {
  const { can } = useAuth();
  const [month, setMonth] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const [form, setForm] = useState<null | Record<string, unknown>>(null);
  const [hist, setHist] = useState<{ emp: Row["employee"]; rows: Structure[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<{ currentMonth: string }>("/api/meta").then((m) => setMonth(m.currentMonth)); }, []);
  const load = useCallback(() => {
    if (!month) return;
    setRows(null);
    api<{ rows: Row[] }>(`/api/salary-structures${qs({ month, search })}`).then((r) => setRows(r.rows)).catch((e) => setMsg({ k: "error", t: e.message }));
  }, [month, search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const openNew = (r: Row) => {
    const c = r.current;
    const rr = (x?: Rule) => (x ? { mode: x.mode, amount: x.amount ? String(x.amount / 100) : "", percent: x.percent ? String(x.percent) : "" } : { ...emptyRule });
    setForm({
      employeeId: r.employee.id, name: r.employee.name, effectiveFrom: month,
      basic: c ? String(c.basic / 100) : "", hra: c ? String(c.hra / 100) : "", otherAllowances: c ? String(c.otherAllowances / 100) : "",
      otherDeductions: c ? String(c.otherDeductions / 100) : "", epf: rr(c?.epf), pt: rr(c?.pt), tds: rr(c?.tds), notes: "", reason: "",
      collegePaid: c?.collegePaid ? String(c.collegePaid / 100) : "",
      statutory: { uan: c?.statutory?.uan ?? "", pfAccountNo: c?.statutory?.pfAccountNo ?? "", esiNumber: c?.statutory?.esiNumber ?? "", pran: c?.statutory?.pran ?? "", pan: c?.statutory?.pan ?? "", taxRegime: c?.statutory?.taxRegime ?? "Regular" },
    });
  };
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f!, [k]: v }));
  const setStat = (k: string, v: string) => setForm((f) => ({ ...f!, statutory: { ...((f!.statutory as object) ?? {}), [k]: v } }));
  const setRule = (k: string, p: string, v: string) => setForm((f) => ({ ...f!, [k]: { ...(f![k] as object), [p]: v } }));

  async function save() {
    setBusy(true);
    try {
      await api("/api/salary-structures", { method: "POST", json: form });
      setMsg({ k: "ok", t: "New salary structure version saved (history preserved)." });
      setForm(null);
      load();
    } catch (e) {
      setMsg({ k: "error", t: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const ruleInput = (k: string, label: string) => {
    const r = (form?.[k] ?? emptyRule) as { mode: string; amount: string; percent: string };
    return (
      <Field label={label}>
        <div className="flex gap-2">
          <Select value={r.mode} onChange={(e) => setRule(k, "mode", e.target.value)} className="w-40">
            <option value="NONE">None</option><option value="FIXED">Fixed ₹</option><option value="PERCENT_OF_EARNED_BASIC">% of earned basic</option>
          </Select>
          {r.mode === "FIXED" && <Input type="number" min={0} step="0.01" value={r.amount} onChange={(e) => setRule(k, "amount", e.target.value)} placeholder="₹ / month" />}
          {r.mode === "PERCENT_OF_EARNED_BASIC" && <Input type="number" min={0} max={100} step="0.01" value={r.percent} onChange={(e) => setRule(k, "percent", e.target.value)} placeholder="%" />}
        </div>
      </Field>
    );
  };

  return (
    <Page wide>
      <PageHeader
        title="Salary Structures"
        subtitle="Effective-dated and immutable — a change creates a new version from a month onward; past payroll never changes."
        actions={<>
          <div className="relative"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="pl-8 w-48" /></div>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-40" />
        </>}
      />
      {msg && <Notice kind={msg.k} onClose={() => setMsg(null)}>{msg.t}</Notice>}
      <Notice kind="warn">FMS does not assume any statutory rate. EPF / PT / TDS are entered per employee by Accounts as a fixed amount or a percentage.</Notice>

      {!rows ? <Spinner /> : rows.length === 0 ? <Empty text="No active employees" /> : (
        <Table head={<tr><th className={th}>Employee</th><th className={th}>Effective</th><th className={th}>Basic</th><th className={th}>HRA</th><th className={th}>Allowances</th><th className={th}>Gross</th><th className={th}>EPF</th><th className={th}>PT</th><th className={th}>TDS</th><th className={th}></th></tr>}>
          {rows.map((r) => {
            const c = r.current;
            return (
              <tr key={r.employee.id} className={tr}>
                <td className={td}><div className="font-semibold text-white truncate max-w-[180px]">{r.employee.name}</div><div className="text-[10px] text-zinc-500">{r.employee.id} · {r.employee.dept}</div></td>
                <td className={td}>{c ? monthLabel(c.effectiveFrom) : <Badge tone="amber">Missing</Badge>}</td>
                <td className={`${td} tabular-nums`}>{c ? formatINR(c.basic, { decimals: false }) : ""}</td>
                <td className={`${td} tabular-nums`}>{c ? formatINR(c.hra, { decimals: false }) : ""}</td>
                <td className={`${td} tabular-nums`}>{c ? formatINR(c.otherAllowances, { decimals: false }) : ""}</td>
                <td className={`${td} tabular-nums text-white`}>{c ? formatINR(c.basic + c.hra + c.otherAllowances, { decimals: false }) : ""}</td>
                <td className={td}>{ruleText(c?.epf)}</td><td className={td}>{ruleText(c?.pt)}</td><td className={td}>{ruleText(c?.tds)}</td>
                <td className={`${td} whitespace-nowrap`}>
                  {r.versions > 0 && <button onClick={async () => { const h = await api<{ rows: Structure[] }>(`/api/salary-structures?employeeId=${encodeURIComponent(r.employee.id)}`); setHist({ emp: r.employee, rows: h.rows }); }} className="h-8 px-2 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white mr-1" title="History"><History size={12} /></button>}
                  {can("salary.manage") && <Button variant="outline" className="h-8 px-2.5" onClick={() => openNew(r)}><Plus size={12} /> {c ? "New version" : "Add"}</Button>}
                </td>
              </tr>
            );
          })}
        </Table>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} size="lg" title={`Salary structure — ${String(form?.name ?? "")}`}
        footer={<><Button variant="outline" onClick={() => setForm(null)}>Cancel</Button><Button loading={busy} onClick={save} disabled={String(form?.reason ?? "").trim().length < 5}>Save new version</Button></>}>
        {form && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Field label="Effective from (month)"><Input type="month" value={String(form.effectiveFrom)} onChange={(e) => set("effectiveFrom", e.target.value)} /></Field>
              <Field label="Basic ₹ / month"><Input type="number" min={0} step="0.01" value={String(form.basic)} onChange={(e) => set("basic", e.target.value)} /></Field>
              <Field label="HRA ₹ / month"><Input type="number" min={0} step="0.01" value={String(form.hra)} onChange={(e) => set("hra", e.target.value)} /></Field>
              <Field label="Other allowances ₹"><Input type="number" min={0} step="0.01" value={String(form.otherAllowances)} onChange={(e) => set("otherAllowances", e.target.value)} /></Field>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              {ruleInput("epf", "Employee EPF deduction")}
              {ruleInput("pt", "Professional Tax")}
              {ruleInput("tds", "TDS")}
              <Field label="Other authorized deductions ₹ / month"><Input type="number" min={0} step="0.01" value={String(form.otherDeductions)} onChange={(e) => set("otherDeductions", e.target.value)} /></Field>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Salary to be paid by college (CS) ₹ / month" hint="Deducted from what GOG pays; shown on the EPF salary slip."><Input type="number" min={0} step="0.01" value={String(form.collegePaid ?? "")} onChange={(e) => set("collegePaid", e.target.value)} /></Field>
              <Field label="Tax regime">
                <select className="h-9 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 text-xs text-white" value={String((form.statutory as Record<string, string>)?.taxRegime ?? "Regular")} onChange={(e) => setStat("taxRegime", e.target.value)}>
                  <option>Regular</option><option>New</option><option>Old</option>
                </select>
              </Field>
            </div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 pt-1">Statutory details (printed on the EPF salary slip)</div>
            <div className="grid sm:grid-cols-3 gap-3">
              {([["uan", "UAN"], ["pfAccountNo", "PF Account No."], ["esiNumber", "ESI Number"], ["pran", "PRAN"], ["pan", "PAN (blank = from OMS)"]] as const).map(([k, l]) => (
                <Field key={k} label={l}><Input value={String((form.statutory as Record<string, string>)?.[k] ?? "")} onChange={(e) => setStat(k, e.target.value)} /></Field>
              ))}
            </div>
            <p className="text-[10px] text-zinc-500">Salary slip design: if EPF, PT, TDS, other deductions and college amount are all 0 / None → “Without EPF” slip; otherwise the “EPF” slip.</p>
            <Field label="Notes (optional)"><Input value={String(form.notes)} onChange={(e) => set("notes", e.target.value)} /></Field>
            <Field label="Reason for change (required)"><Textarea value={String(form.reason)} onChange={(e) => set("reason", e.target.value)} placeholder="e.g. Annual increment approved by founders" /></Field>
          </div>
        )}
      </Modal>

      <Modal open={!!hist} onClose={() => setHist(null)} size="lg" title={`Version history — ${hist?.emp.name ?? ""}`}>
        {hist && (
          <Table head={<tr><th className={th}>From</th><th className={th}>Gross</th><th className={th}>EPF</th><th className={th}>PT</th><th className={th}>TDS</th><th className={th}>By</th></tr>}>
            {hist.rows.map((s) => (
              <tr key={s._id} className={tr}>
                <td className={td}>{monthLabel(s.effectiveFrom)}</td>
                <td className={`${td} tabular-nums`}>{formatINR(s.basic + s.hra + s.otherAllowances, { decimals: false })}</td>
                <td className={td}>{ruleText(s.epf)}</td><td className={td}>{ruleText(s.pt)}</td><td className={td}>{ruleText(s.tds)}</td>
                <td className={td}>{s.createdBy}</td>
              </tr>
            ))}
          </Table>
        )}
      </Modal>
    </Page>
  );
}