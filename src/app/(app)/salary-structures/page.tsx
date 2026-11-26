"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, History, Search, RotateCcw, Info, Sparkles, PenLine } from "lucide-react";
import { api, qs } from "@/lib/client";
import { formatINR } from "@/lib/money";
import { monthLabel } from "@/lib/dates";
import { useAuth } from "@/components/AuthContext";
import { Badge, Button, Empty, Field, Input, Modal, Notice, Page, PageHeader, Select, Spinner, Table, Textarea, td, th, tr } from "@/components/ui";
import {
  DEFAULT_SALARY_DEFAULTS, inputFromStructure, resolveStructure, validateStatutory,
  type EngineMode, type EpfSetting, type PercentBase, type PtSetting, type SalaryDefaults, type StructureInput,
} from "@/lib/salary-structure";

type Rule = { mode: EngineMode; amount: number; percent: number };
interface Structure {
  _id: string; employeeId: string; effectiveFrom: string; basic: number; hra: number; otherAllowances: number;
  epf: Rule; pt: Rule; tds: Rule; otherDeductions: number; collegePaid?: number;
  annualPackage?: number; monthlySalary?: number; monthlyOverride?: boolean;
  config?: { epfApplicable?: boolean; epfSetting?: EpfSetting; ptSetting?: PtSetting; tdsSetting?: string; estimatedNet?: number };
  employerEpf?: { mode: string; amount: number; percent: number; base: PercentBase; monthly?: number };
  statutory?: { uan?: string; pfAccountNo?: string; esiNumber?: string; pran?: string; pan?: string; taxRegime?: string };
  notes?: string; changeReason?: string; createdBy?: string; updatedBy?: string; createdAt?: string; updatedAt?: string;
}
interface Emp { id: string; name: string; dept: string; designation: string; location?: string; status?: string }
interface Row { employee: Emp; current: Structure | null; versions: number }

const r2s = (p: number) => (p ? String(Math.round(p) / 100) : "");
const s2p = (s: string) => Math.round(Math.max(0, Number(s) || 0) * 100);
const inr = (p: number) => formatINR(p, { decimals: false });
const monthly = (s: Structure) => s.monthlySalary ?? s.basic + s.hra + s.otherAllowances;
/** monthly ₹ of a rule on the full-month salary (preview), with how it is worked out */
const ruleAmt = (s: Structure, r?: Rule, setting?: string) => {
  if (!r || r.mode === "NONE") return <span className="text-zinc-600">—</span>;
  const amt = r.mode === "FIXED" ? r.amount : Math.round(((r.mode === "PERCENT_OF_EARNED_GROSS" ? monthly(s) : s.basic) * r.percent) / 100);
  const how = r.mode === "FIXED" ? (setting === "AUTO" ? "auto" : "fixed") : `${r.percent}% of ${r.mode === "PERCENT_OF_EARNED_GROSS" ? "salary" : "basic"}${setting === "AUTO" ? " · auto" : ""}`;
  return <><span className="text-white">{inr(amt)}</span><div className="text-[10px] text-zinc-500">{how}</div></>;
};

/** form state: rupee strings */
interface Form {
  employee: Emp; existing: Structure | null; effectiveFrom: string;
  annual: string; monthly: string; override: boolean; hra: string; other: string;
  epfApplicable: boolean; epfSetting: EpfSetting; epfAmount: string; epfPercent: string; epfBase: PercentBase;
  ptSetting: PtSetting; ptAmount: string;
  tdsMode: EngineMode | "AUTO"; tdsAmount: string; tdsPercent: string;
  otherDeductions: string; college: string;
  erMode: "NONE" | "FIXED" | "PERCENT"; erAmount: string; erPercent: string; erBase: PercentBase;
  statutory: Record<string, string>; notes: string; reason: string;
}

function toForm(emp: Emp, s: Structure | null, month: string, d: SalaryDefaults): Form {
  const i = inputFromStructure(s as never, d);
  return {
    employee: emp, existing: s, effectiveFrom: month,
    annual: r2s(i.annualPackage), monthly: r2s(i.monthlySalary), override: i.monthlyOverride, hra: r2s(i.hra), other: r2s(i.otherAllowances),
    epfApplicable: i.epfApplicable, epfSetting: i.epfSetting === "NONE" ? "AUTO" : i.epfSetting, epfAmount: r2s(i.epfAmount), epfPercent: i.epfPercent ? String(i.epfPercent) : "", epfBase: i.epfBase,
    ptSetting: i.ptSetting, ptAmount: r2s(i.ptAmount),
    tdsMode: i.tdsSetting === "AUTO" ? "AUTO" : i.tds.mode, tdsAmount: r2s(i.tds.amount), tdsPercent: i.tds.percent ? String(i.tds.percent) : "",
    otherDeductions: r2s(i.otherDeductions), college: r2s(i.collegePaid),
    erMode: i.employerEpf.mode, erAmount: r2s(i.employerEpf.amount), erPercent: i.employerEpf.percent ? String(i.employerEpf.percent) : "", erBase: i.employerEpf.base,
    statutory: { uan: s?.statutory?.uan ?? "", pfAccountNo: s?.statutory?.pfAccountNo || d.pfEstablishmentCode || "", esiNumber: s?.statutory?.esiNumber ?? "", pran: s?.statutory?.pran ?? "", pan: s?.statutory?.pan ?? "", taxRegime: s?.statutory?.taxRegime ?? "Regular" },
    notes: "", reason: "",
  };
}
function toInput(f: Form): StructureInput {
  return {
    annualPackage: s2p(f.annual), monthlySalary: s2p(f.monthly), monthlyOverride: f.override, hra: s2p(f.hra), otherAllowances: s2p(f.other),
    epfApplicable: f.epfApplicable, epfSetting: f.epfApplicable ? f.epfSetting : "NONE", epfAmount: s2p(f.epfAmount), epfPercent: Number(f.epfPercent) || 0, epfBase: f.epfBase,
    ptSetting: f.ptSetting, ptAmount: s2p(f.ptAmount),
    tds: f.tdsMode === "AUTO" ? { mode: "NONE", amount: 0, percent: 0 } : { mode: f.tdsMode, amount: s2p(f.tdsAmount), percent: Number(f.tdsPercent) || 0 },
    tdsSetting: f.tdsMode === "AUTO" ? "AUTO" : "MANUAL",
    otherDeductions: s2p(f.otherDeductions), collegePaid: s2p(f.college),
    employerEpf: { mode: f.erMode, amount: s2p(f.erAmount), percent: Number(f.erPercent) || 0, base: f.erBase },
  };
}
function toBody(f: Form) {
  return {
    employeeId: f.employee.id, effectiveFrom: f.effectiveFrom, reason: f.reason, notes: f.notes,
    annualPackage: Number(f.annual) || 0, monthlySalary: Number(f.monthly) || 0, monthlyOverride: f.override, hra: Number(f.hra) || 0, otherAllowances: Number(f.other) || 0,
    epfApplicable: f.epfApplicable, epfSetting: f.epfSetting, epfAmount: Number(f.epfAmount) || 0, epfPercent: Number(f.epfPercent) || 0, epfBase: f.epfBase,
    ptSetting: f.ptSetting, ptAmount: Number(f.ptAmount) || 0,
    tds: { mode: f.tdsMode === "AUTO" ? "NONE" : f.tdsMode, amount: Number(f.tdsAmount) || 0, percent: Number(f.tdsPercent) || 0 },
    tdsSetting: f.tdsMode === "AUTO" ? "AUTO" : "MANUAL",
    otherDeductions: Number(f.otherDeductions) || 0, collegePaid: Number(f.college) || 0,
    employerEpf: { mode: f.erMode, amount: Number(f.erAmount) || 0, percent: Number(f.erPercent) || 0, base: f.erBase },
    statutory: f.statutory,
  };
}

const Section = ({ letter, title, children, right }: { letter: string; title: string; children: React.ReactNode; right?: React.ReactNode }) => (
  <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3.5">
    <div className="flex items-center justify-between gap-2 mb-3">
      <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-400"><span className="text-emerald-400 mr-1.5">{letter}</span>{title}</div>
      {right}
    </div>
    {children}
  </div>
);
const Tip = ({ text }: { text: string }) => <span title={text} className="inline-flex align-middle ml-1 text-zinc-600 hover:text-zinc-300 cursor-help"><Info size={11} /></span>;
const AutoBadge = () => <Badge tone="emerald"><span className="inline-flex items-center gap-1"><Sparkles size={9} />Auto-calculated</span></Badge>;
const ManualBadge = () => <Badge tone="amber"><span className="inline-flex items-center gap-1"><PenLine size={9} />Manually overridden</span></Badge>;
const Info2 = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div><div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div><div className="text-xs text-white font-semibold truncate">{value || <span className="text-zinc-600 font-normal">—</span>}</div></div>
);
const Line = ({ label, value, strong, minus, muted }: { label: string; value: number | null; strong?: boolean; minus?: boolean; muted?: boolean }) => (
  <div className={`flex justify-between gap-3 py-1 text-xs ${strong ? "font-bold text-white" : muted ? "text-zinc-500" : "text-zinc-300"}`}>
    <span>{label}</span><span className="tabular-nums">{value === null ? "Not configured" : `${minus && value ? "− " : ""}${formatINR(value)}`}</span>
  </div>
);

export default function SalaryStructuresPage() {
  const { can } = useAuth();
  const [month, setMonth] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [defaults, setDefaults] = useState<SalaryDefaults>(DEFAULT_SALARY_DEFAULTS);
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [hist, setHist] = useState<{ emp: Emp; rows: Structure[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { api<{ currentMonth: string }>("/api/meta").then((m) => setMonth(m.currentMonth)); }, []);
  const load = useCallback(() => {
    if (!month) return;
    setRows(null);
    api<{ rows: Row[]; defaults: SalaryDefaults }>(`/api/salary-structures${qs({ month, search })}`)
      .then((r) => { setRows(r.rows); if (r.defaults) setDefaults(r.defaults); })
      .catch((e) => setMsg({ k: "error", t: e.message }));
  }, [month, search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const res = useMemo(() => (form ? resolveStructure(toInput(form), defaults) : null), [form, defaults]);
  const stErrors = useMemo(() => {
    if (!form) return [];
    const st = { ...form.statutory };
    if (defaults.pfEstablishmentCode && st.pfAccountNo.toUpperCase().replace(/[\s/-]/g, "") === defaults.pfEstablishmentCode) st.pfAccountNo = ""; // only the company code = not filled yet
    return validateStatutory(st);
  }, [form, defaults]);
  const blockReason = !form || !res ? "" : res.errors.length ? "Fix the salary errors shown on the right" : stErrors.length ? "Fix the UAN / PF / PAN details in section D" : form.reason.trim().length < 5 ? "Write the reason for this change (at least 5 characters) to enable Save" : "";
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  // annual → monthly (unless HR has overridden the monthly salary)
  const onAnnual = (v: string) => setForm((f) => (f ? { ...f, annual: v, monthly: f.override ? f.monthly : v ? String(Math.round((Number(v) / 12) * 100) / 100) : "" } : f));
  const onMonthly = (v: string) => setForm((f) => {
    if (!f) return f;
    const auto = f.annual ? Math.round((Number(f.annual) / 12) * 100) / 100 : null;
    return { ...f, monthly: v, override: auto === null ? false : Number(v) !== auto };
  });
  const resetMonthly = () => setForm((f) => (f ? { ...f, override: false, monthly: f.annual ? String(Math.round((Number(f.annual) / 12) * 100) / 100) : f.monthly } : f));

  async function save() {
    if (!form) return;
    setBusy(true); setErr("");
    try {
      const r = await api<{ replaced: boolean; warnings: string[] }>("/api/salary-structures", { method: "POST", json: toBody(form) });
      setMsg({ k: "ok", t: `${form.employee.name}: salary structure saved from ${monthLabel(form.effectiveFrom)}${r.replaced ? " (replaced the earlier version of the same month)" : ""}. Payroll will use it from that month.` });
      setForm(null);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function openHistory(emp: Emp) {
    const h = await api<{ rows: Structure[] }>(`/api/salary-structures?employeeId=${encodeURIComponent(emp.id)}`);
    setHist({ emp, rows: h.rows });
  }

  const p = res?.preview;
  const sameMonthExists = !!form?.existing && form.existing.effectiveFrom === form.effectiveFrom;

  return (
    <Page wide>
      <PageHeader
        title="Salary Structures"
        subtitle="Annual package → monthly salary → EPF / PT → estimated in-hand. Every change is effective from a month; older versions and past payroll never change."
        actions={<>
          <div className="relative"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="pl-8 w-48" /></div>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-40" />
        </>}
      />
      {msg && <Notice kind={msg.k} onClose={() => setMsg(null)}>{msg.t}</Notice>}

      {!rows ? <Spinner /> : rows.length === 0 ? <Empty text="No active employees" /> : (
        <Table head={<tr><th className={th}>Employee</th><th className={th}>Effective</th><th className={th}>Annual</th><th className={th}>Monthly</th><th className={th}>EPF</th><th className={th}>PT</th><th className={th}>TDS</th><th className={th}>College</th><th className={th}>Est. in-hand</th><th className={th}></th></tr>}>
          {rows.map((r) => {
            const c = r.current;
            const est = c ? (c.config?.estimatedNet ?? null) : null;
            return (
              <tr key={r.employee.id} className={tr}>
                <td className={td}><div className="font-semibold text-white truncate max-w-[200px]">{r.employee.name}</div><div className="text-[10px] text-zinc-500 truncate max-w-[200px]">{r.employee.id} · {r.employee.designation || r.employee.dept}</div></td>
                <td className={td}>{c ? monthLabel(c.effectiveFrom) : <Badge tone="amber">Not set</Badge>}</td>
                <td className={`${td} tabular-nums`}>{c?.annualPackage ? inr(c.annualPackage) : c ? <span className="text-zinc-600">{inr(monthly(c) * 12)}</span> : ""}</td>
                <td className={`${td} tabular-nums text-white`}>{c ? <>{inr(monthly(c))}{c.monthlyOverride && <span className="ml-1 text-amber-400" title="Manually overridden">•</span>}</> : ""}</td>
                <td className={`${td} tabular-nums`}>{c ? ruleAmt(c, c.epf, c.config?.epfSetting) : ""}</td>
                <td className={`${td} tabular-nums`}>{c ? ruleAmt(c, c.pt, c.config?.ptSetting) : ""}</td>
                <td className={`${td} tabular-nums`}>{c ? (c.config?.tdsSetting === "AUTO" ? <span className="text-zinc-300">Auto<div className="text-[10px] text-zinc-500">{c.config?.epfApplicable === false ? `${defaults.tdsPercent}% if > ${inr(defaults.tdsThreshold)}` : "not with EPF"}</div></span> : ruleAmt(c, c.tds)) : ""}</td>
                <td className={`${td} tabular-nums`}>{c ? (c.collegePaid ? inr(c.collegePaid) : <span className="text-zinc-600">Not configured</span>) : ""}</td>
                <td className={`${td} tabular-nums text-emerald-400 font-semibold`}>{est !== null ? inr(est) : ""}</td>
                <td className={`${td} whitespace-nowrap text-right`}>
                  {r.versions > 0 && <button onClick={() => openHistory(r.employee)} className="h-8 px-2 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white mr-1" title="Revision history"><History size={12} /></button>}
                  {can("salary.manage") && <Button variant="outline" className="h-8 px-2.5" onClick={() => { setErr(""); setForm(toForm(r.employee, c, month, defaults)); }}><Plus size={12} /> {c ? "Revise" : "Configure"}</Button>}
                </td>
              </tr>
            );
          })}
        </Table>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} size="xl" title={`Salary structure — ${form?.employee.name ?? ""}`}
        footer={<>
          <Button variant="outline" onClick={() => setForm(null)}>Cancel</Button>
          <Button variant="outline" onClick={() => form && setForm(toForm(form.employee, form.existing, form.effectiveFrom, defaults))}><RotateCcw size={12} /> Reset</Button>
          {blockReason && <span className="text-[11px] text-amber-400 mr-auto">{blockReason}</span>}
          <Button loading={busy} onClick={save} disabled={!!blockReason}>Save Salary Structure</Button>
        </>}>
        {form && res && p && (
          <div className="grid lg:grid-cols-[1fr_290px] gap-4">
            <div className="space-y-3 min-w-0">
              {/* A — employee */}
              <Section letter="A" title="Employee information">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <Info2 label="Employee name" value={form.employee.name} />
                  <Info2 label="Employee ID" value={form.employee.id} />
                  <Info2 label="Designation" value={form.employee.designation} />
                  <Info2 label="Department" value={form.employee.dept} />
                  <Info2 label="Assigned college / location" value={form.employee.location} />
                  <Info2 label="Employment status" value={form.employee.status} />
                  <Info2 label="Current structure" value={form.existing ? `${inr(monthly(form.existing))} / month · from ${monthLabel(form.existing.effectiveFrom)}` : "Not configured"} />
                  <Field label="Effective from (month & year)"><Input type="month" value={form.effectiveFrom} onChange={(e) => set("effectiveFrom", e.target.value)} /></Field>
                </div>
                {sameMonthExists && <p className="text-[10px] text-amber-400 mt-2">A version from {monthLabel(form.effectiveFrom)} already exists — saving replaces it (the old values stay in the audit history).</p>}
              </Section>

              {/* B — package */}
              <Section letter="B" title="Salary package">
                <div className="grid sm:grid-cols-2 gap-3">
                  <Field label="Annual package (gross) ₹"><Input type="number" min={0} step="1" value={form.annual} onChange={(e) => onAnnual(e.target.value)} placeholder="e.g. 360000" /></Field>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Monthly salary (gross) ₹<Tip text="Annual ÷ 12. You can change it — then it is marked as manually overridden and is not recalculated when the annual package changes." /></span>
                      {form.override ? <ManualBadge /> : form.annual ? <AutoBadge /> : null}
                    </div>
                    <Input type="number" min={0} step="0.01" value={form.monthly} onChange={(e) => onMonthly(e.target.value)} />
                    {form.override && <button type="button" onClick={resetMonthly} className="mt-1 text-[10px] text-emerald-400 hover:underline inline-flex items-center gap-1"><RotateCcw size={10} />Reset to Auto-Calculated Salary</button>}
                  </div>
                  <Field label="HRA ₹ / month (optional)"><Input type="number" min={0} step="0.01" value={form.hra} onChange={(e) => set("hra", e.target.value)} /></Field>
                  <Field label="Other allowances ₹ / month (optional)"><Input type="number" min={0} step="0.01" value={form.other} onChange={(e) => set("other", e.target.value)} /></Field>
                </div>
                <p className="text-[10px] text-zinc-500 mt-2">Basic = monthly salary − HRA − allowances = <span className="text-zinc-300 tabular-nums">{formatINR(Math.max(0, res.basic))}</span>. Annual package is gross salary — employer EPF is recorded separately and never added to take-home.</p>
                <div className="grid sm:grid-cols-2 gap-3 mt-3 pt-3 border-t border-zinc-800">
                  <Field label="Assigned college (from OMS)"><Input value={form.employee.location || "—"} disabled /></Field>
                  <Field label="Salary to be paid by college ₹ / month (optional)" hint="Shown as “Salary to be Paid by College (CS)” and deducted from what GOG pays, as on the salary slip. Leave empty if not applicable.">
                    <Input type="number" min={0} step="0.01" value={form.college} onChange={(e) => set("college", e.target.value)} placeholder="Not configured" />
                  </Field>
                </div>
                {p.companyShare !== null && <p className="text-[10px] text-zinc-400 mt-1">Remaining company-funded portion: <span className="text-white tabular-nums">{formatINR(p.companyShare)}</span> (monthly salary − college amount)</p>}
              </Section>

              {/* C — statutory deductions */}
              <Section letter="C" title="Statutory deductions" right={<Badge tone="zinc">Company defaults · Settings</Badge>}>
                <div className="grid sm:grid-cols-2 gap-3">
                  <Field label="EPF applicable">
                    <Select value={String(form.epfApplicable)} onChange={(e) => set("epfApplicable", e.target.value === "true")}><option value="true">Yes</option><option value="false">No / Not applicable</option></Select>
                  </Field>
                  {form.epfApplicable && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Employee EPF mode</span>
                        {form.epfSetting === "AUTO" ? <AutoBadge /> : <ManualBadge />}
                      </div>
                      <Select value={form.epfSetting} onChange={(e) => set("epfSetting", e.target.value as EpfSetting)}>
                        <option value="AUTO">Auto calculate</option><option value="FIXED">Fixed amount</option><option value="PERCENT">Percentage</option><option value="NONE">None / Not applicable</option>
                      </Select>
                    </div>
                  )}
                </div>
                {form.epfApplicable && (
                  <div className="mt-2 rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2 text-[11px] text-zinc-400 flex flex-wrap items-center justify-between gap-2">
                    <span>Suggested: <span className="text-white font-semibold">{res.epfSuggested.mode === "FIXED" ? formatINR(res.epfSuggested.amount) : `${res.epfSuggested.percent}% = ${formatINR(Math.round((res.epfSuggested.mode === "PERCENT_OF_EARNED_BASIC" ? Math.max(0, res.basic) : res.monthlySalary) * res.epfSuggested.percent / 100))}`}</span> <span className="text-zinc-600">({res.epfSuggested.label})</span></span>
                    {form.epfSetting !== "AUTO" && <button type="button" onClick={() => set("epfSetting", "AUTO")} className="text-emerald-400 hover:underline inline-flex items-center gap-1"><RotateCcw size={10} />Restore auto</button>}
                  </div>
                )}
                {form.epfApplicable && form.epfSetting === "FIXED" && <div className="mt-2 max-w-xs"><Field label="Employee EPF ₹ / month"><Input type="number" min={0} step="0.01" value={form.epfAmount} onChange={(e) => set("epfAmount", e.target.value)} /></Field></div>}
                {form.epfApplicable && form.epfSetting === "PERCENT" && (
                  <div className="mt-2 grid grid-cols-2 gap-3 max-w-md">
                    <Field label="EPF %"><Input type="number" min={0} max={100} step="0.01" value={form.epfPercent} onChange={(e) => set("epfPercent", e.target.value)} /></Field>
                    <Field label="Of"><Select value={form.epfBase} onChange={(e) => set("epfBase", e.target.value as PercentBase)}><option value="GROSS">Monthly salary</option><option value="BASIC">Basic</option></Select></Field>
                  </div>
                )}
                <div className="grid sm:grid-cols-2 gap-3 mt-3 pt-3 border-t border-zinc-800">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Professional Tax<Tip text="Separate from EPF. Default amount is a company setting — confirm the state PT slab for each employee." /></span>
                      {form.ptSetting === "AUTO" ? <AutoBadge /> : form.ptSetting === "FIXED" ? <ManualBadge /> : null}
                    </div>
                    <div className="flex gap-2">
                      <Select value={form.ptSetting} onChange={(e) => set("ptSetting", e.target.value as PtSetting)} className="w-44">
                        <option value="AUTO">Default ({formatINR(defaults.ptDefault, { decimals: false })})</option><option value="FIXED">Custom amount</option><option value="NONE">Not applicable</option>
                      </Select>
                      {form.ptSetting === "FIXED" && <Input type="number" min={0} step="0.01" value={form.ptAmount} onChange={(e) => set("ptAmount", e.target.value)} placeholder="₹ / month" />}
                    </div>
                  </div>
                  <Field label="TDS">
                    <div className="flex gap-2">
                      <Select value={form.tdsMode} onChange={(e) => set("tdsMode", e.target.value as Form["tdsMode"])} className="w-44">
                        <option value="AUTO">Auto (company rule)</option>
                        <option value="NONE">None</option><option value="FIXED">Fixed ₹</option><option value="PERCENT_OF_EARNED_BASIC">% of basic</option><option value="PERCENT_OF_EARNED_GROSS">% of salary</option>
                      </Select>
                      {form.tdsMode === "FIXED" && <Input type="number" min={0} step="0.01" value={form.tdsAmount} onChange={(e) => set("tdsAmount", e.target.value)} placeholder="₹ / month" />}
                      {form.tdsMode.startsWith("PERCENT") && <Input type="number" min={0} max={100} step="0.01" value={form.tdsPercent} onChange={(e) => set("tdsPercent", e.target.value)} placeholder="%" />}
                    </div>
                  </Field>
                  {form.tdsMode === "AUTO" && (
                    <p className="sm:col-span-2 -mt-1 text-[10px] text-zinc-500">
                      TDS auto: {form.epfApplicable && form.epfSetting !== "NONE" ? <span className="text-amber-400">not applied — EPF is applicable for this employee.</span> : <>each month, adjusted payable salary ≤ {formatINR(defaults.tdsThreshold, { decimals: false })} → ₹0, above → {defaults.tdsPercent}%.</>}
                    </p>
                  )}
                  <Field label="Other applicable deductions ₹ / month"><Input type="number" min={0} step="0.01" value={form.otherDeductions} onChange={(e) => set("otherDeductions", e.target.value)} /></Field>
                </div>
              </Section>

              {/* D — EPF details */}
              <Section letter="D" title="EPF & statutory details (kept from the previous version)">
                <div className="grid sm:grid-cols-3 gap-3">
                  <Field label="UAN number (12 digits)">
                    <Input inputMode="numeric" maxLength={12} placeholder="101234567890" value={form.statutory.uan ?? ""} onChange={(e) => set("statutory", { ...form.statutory, uan: e.target.value.replace(/\D/g, "").slice(0, 12) })} />
                  </Field>
                  <Field label="PF account number" hint={defaults.pfEstablishmentCode ? `Company code ${defaults.pfEstablishmentCode} is filled in — add the employee's member number after it.` : "Set the company PF code once in Settings → Salary Defaults to pre-fill this."}>
                    <Input placeholder="RJJPR00123450000012345" value={form.statutory.pfAccountNo ?? ""} onChange={(e) => set("statutory", { ...form.statutory, pfAccountNo: e.target.value.toUpperCase().slice(0, 30) })} />
                  </Field>
                  <Field label="ESI number"><Input inputMode="numeric" value={form.statutory.esiNumber ?? ""} onChange={(e) => set("statutory", { ...form.statutory, esiNumber: e.target.value.replace(/\D/g, "").slice(0, 17) })} /></Field>
                  <Field label="PRAN (12 digits)"><Input inputMode="numeric" maxLength={12} value={form.statutory.pran ?? ""} onChange={(e) => set("statutory", { ...form.statutory, pran: e.target.value.replace(/\D/g, "").slice(0, 12) })} /></Field>
                  <Field label="PAN (blank = from OMS)"><Input maxLength={10} placeholder="ABCDE1234F" value={form.statutory.pan ?? ""} onChange={(e) => set("statutory", { ...form.statutory, pan: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) })} /></Field>
                  <Field label="Tax regime"><Select value={form.statutory.taxRegime || "Regular"} onChange={(e) => set("statutory", { ...form.statutory, taxRegime: e.target.value })}><option>Regular</option><option>New</option><option>Old</option></Select></Field>
                </div>
                {stErrors.length > 0 && <div className="mt-2"><Notice kind="error">{stErrors.join(" · ")}</Notice></div>}
                <div className="grid sm:grid-cols-3 gap-3 mt-3 pt-3 border-t border-zinc-800">
                  <Field label="Employer EPF contribution" hint="Company cost — NOT deducted from the employee.">
                    <Select value={form.erMode} onChange={(e) => set("erMode", e.target.value as Form["erMode"])}><option value="NONE">Not recorded</option><option value="FIXED">Fixed ₹</option><option value="PERCENT">Percentage</option></Select>
                  </Field>
                  {form.erMode === "FIXED" && <Field label="Employer EPF ₹ / month"><Input type="number" min={0} step="0.01" value={form.erAmount} onChange={(e) => set("erAmount", e.target.value)} /></Field>}
                  {form.erMode === "PERCENT" && <>
                    <Field label="Employer EPF %"><Input type="number" min={0} max={100} step="0.01" value={form.erPercent} onChange={(e) => set("erPercent", e.target.value)} /></Field>
                    <Field label="Of"><Select value={form.erBase} onChange={(e) => set("erBase", e.target.value as PercentBase)}><option value="GROSS">Monthly salary</option><option value="BASIC">Basic</option></Select></Field>
                  </>}
                </div>
              </Section>

              <Field label="Notes (optional)"><Input value={form.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
              <Field label="Reason for this change (required)"><Textarea value={form.reason} onChange={(e) => set("reason", e.target.value)} placeholder="e.g. Annual increment approved by founders — effective November" /></Field>
            </div>

            {/* E — live preview */}
            <div className="lg:sticky lg:top-0 self-start space-y-3">
              <Section letter="E" title="Live salary preview">
                <Line label="Monthly gross salary" value={p.gross} strong />
                <div className="pl-2 border-l border-zinc-800 my-1">
                  <Line label="Basic" value={Math.max(0, res.basic)} muted />
                  {res.hra > 0 && <Line label="HRA" value={res.hra} muted />}
                  {res.otherAllowances > 0 && <Line label="Other allowances" value={res.otherAllowances} muted />}
                </div>
                <Line label="Employee EPF" value={p.epf} minus />
                <Line label="Professional Tax" value={p.pt} minus />
                {p.tds > 0 && <Line label="TDS" value={p.tds} minus />}
                {p.other > 0 && <Line label="Other deductions" value={p.other} minus />}
                <Line label="Paid by college (CS)" value={p.college || null} minus />
                <div className="border-t border-zinc-800 mt-1 pt-1"><Line label="Total employee deductions" value={p.totalDeductions} /></div>
                <div className="mt-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-3 py-2.5">
                  <div className="text-[10px] uppercase tracking-widest text-emerald-400 font-bold">Estimated monthly in-hand</div>
                  <div className="text-xl font-black text-white tabular-nums">{formatINR(p.net)}</div>
                </div>
                {p.employerEpf > 0 && <p className="text-[10px] text-zinc-500 mt-2">Employer EPF (company cost, not deducted): <span className="text-zinc-300 tabular-nums">{formatINR(p.employerEpf)}</span></p>}
                <p className="text-[10px] text-zinc-500 mt-2">Full-month estimate. The actual payable salary is calculated by payroll each month after attendance, leave, LOP, penalties and adjustments.</p>
              </Section>
              {res.warnings.map((w) => <Notice key={w} kind="warn">{w}</Notice>)}
              {res.errors.length > 0 && form.monthly && <Notice kind="error">{res.errors.join(" · ")}</Notice>}
              {err && <Notice kind="error" onClose={() => setErr("")}>{err}</Notice>}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!hist} onClose={() => setHist(null)} size="xl" title={`Salary revision history — ${hist?.emp.name ?? ""}`}>
        {hist && (
          <Table head={<tr><th className={th}>From</th><th className={th}>Annual</th><th className={th}>Monthly</th><th className={th}>EPF</th><th className={th}>PT</th><th className={th}>TDS</th><th className={th}>College</th><th className={th}>Est. in-hand</th><th className={th}>By / when</th><th className={th}>Reason</th></tr>}>
            {hist.rows.map((s) => (
              <tr key={s._id} className={tr}>
                <td className={td}>{monthLabel(s.effectiveFrom)}</td>
                <td className={`${td} tabular-nums`}>{s.annualPackage ? inr(s.annualPackage) : "—"}</td>
                <td className={`${td} tabular-nums`}>{inr(monthly(s))}{s.monthlyOverride && <span className="ml-1 text-amber-400" title="Manually overridden">•</span>}</td>
                <td className={`${td} tabular-nums`}>{ruleAmt(s, s.epf, s.config?.epfSetting)}</td>
                <td className={`${td} tabular-nums`}>{ruleAmt(s, s.pt, s.config?.ptSetting)}</td>
                <td className={`${td} tabular-nums`}>{ruleAmt(s, s.tds)}</td>
                <td className={`${td} tabular-nums`}>{s.collegePaid ? inr(s.collegePaid) : "—"}</td>
                <td className={`${td} tabular-nums`}>{s.config?.estimatedNet !== undefined ? inr(s.config.estimatedNet) : "—"}</td>
                <td className={`${td} text-[10px]`}>{s.updatedBy ?? s.createdBy}<br /><span className="text-zinc-500">{s.updatedAt ? new Date(s.updatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : ""}</span></td>
                <td className={`${td} text-[10px] max-w-[200px] whitespace-normal`}>{s.changeReason ?? "—"}</td>
              </tr>
            ))}
          </Table>
        )}
        <p className="text-[10px] text-zinc-500 mt-2">Every save is also in Audit History with the old and new values.</p>
      </Modal>
    </Page>
  );
}