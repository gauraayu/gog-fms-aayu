"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Upload, FileDown, Pencil, Search, ChevronDown, ChevronRight } from "lucide-react";
import { api, openSigned, qs } from "@/lib/client";
import { formatINR } from "@/lib/money";
import { useAuth } from "@/components/AuthContext";
import { Badge, Button, Empty, Field, Input, KpiCard, Modal, Notice, Page, PageHeader, Select, Spinner, Table, Textarea, td, th, tr } from "@/components/ui";

const STATUSES = ["Draft", "Issued", "Partially Paid", "Paid", "Overdue", "Cancelled"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
interface Inv { _id: string; invoiceNumber: string; clientName: string; clientLocation: string; invoiceDate: string; dueDate?: string; billingMonth: number; billingYear: number; amount: number; taxAmount: number; totalAmount: number; amountReceived: number; status: string; displayStatus: string; fileName?: string }

export default function InvoicesPage() {
  const { can } = useAuth();
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [month, setMonth] = useState("");
  const [client, setClient] = useState("");
  const [location, setLocation] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [data, setData] = useState<{ rows: Inv[]; clients: string[]; locations: string[] } | null>(null);
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const [upload, setUpload] = useState(false);
  const [edit, setEdit] = useState<Inv | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setData(null);
    api<{ rows: Inv[]; clients: string[]; locations: string[] }>(`/api/invoices${qs({ year, month, client, location, status, search })}`).then(setData).catch((e) => setMsg({ k: "error", t: e.message }));
  }, [year, month, client, location, status, search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  // Year → Month → Client → Location
  const groups = useMemo(() => {
    const g = new Map<string, Inv[]>();
    for (const r of data?.rows ?? []) {
      const k = `${r.billingYear}|${String(r.billingMonth).padStart(2, "0")}|${r.clientName}|${r.clientLocation}`;
      g.set(k, [...(g.get(k) ?? []), r]);
    }
    return [...g.entries()];
  }, [data]);
  const totals = useMemo(() => {
    const rows = (data?.rows ?? []).filter((r) => r.status !== "Cancelled");
    return { billed: rows.reduce((a, r) => a + r.totalAmount, 0), received: rows.reduce((a, r) => a + r.amountReceived, 0), overdue: rows.filter((r) => r.displayStatus === "Overdue").length };
  }, [data]);

  async function submitUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/invoices", { method: "POST", body: new FormData(e.currentTarget) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setUpload(false);
      setMsg({ k: "ok", t: "Invoice saved" });
      load();
    } catch (err) { setMsg({ k: "error", t: (err as Error).message }); } finally { setBusy(false); }
  }
  async function submitEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await api(`/api/invoices/${edit!._id}`, { method: "PATCH", json: { status: f.get("status"), amountReceived: Number(f.get("amountReceived")), reason: f.get("reason") } });
      setEdit(null);
      setMsg({ k: "ok", t: "Invoice updated" });
      load();
    } catch (err) { setMsg({ k: "error", t: (err as Error).message }); } finally { setBusy(false); }
  }

  return (
    <Page wide>
      <PageHeader title="Client Invoices" subtitle="Organised by Year → Month → Client → Location. Documents are private in S3 and opened via short-lived links."
        actions={can("invoices.manage") && <Button onClick={() => setUpload(true)}><Upload size={12} /> Upload Invoice</Button>} />
      {msg && <Notice kind={msg.k} onClose={() => setMsg(null)}>{msg.t}</Notice>}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard icon={<span className="text-xs font-bold">₹</span>} label="Billed (filtered)" value={formatINR(totals.billed, { decimals: false })} />
        <KpiCard tone="sky" icon={<span className="text-xs font-bold">✓</span>} label="Received" value={formatINR(totals.received, { decimals: false })} />
        <KpiCard tone="red" icon={<span className="text-xs font-bold">!</span>} label="Overdue invoices" value={totals.overdue} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-2">
        <div className="relative col-span-2"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Invoice # or client" className="pl-8" /></div>
        <Input type="number" value={year} onChange={(e) => setYear(e.target.value)} placeholder="Year" />
        <Select value={month} onChange={(e) => setMonth(e.target.value)}><option value="">All months</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select>
        <Select value={client} onChange={(e) => setClient(e.target.value)}><option value="">All clients</option>{data?.clients.map((c) => <option key={c}>{c}</option>)}</Select>
        <Select value={location} onChange={(e) => setLocation(e.target.value)}><option value="">All locations</option>{data?.locations.map((c) => <option key={c}>{c}</option>)}</Select>
      </div>
      <div className="flex gap-2 flex-wrap">
        {["", ...STATUSES].map((s) => <button key={s} onClick={() => setStatus(s)} className={`px-3 py-1.5 rounded-xl border text-[11px] ${status === s ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300" : "border-zinc-800 text-zinc-400"}`}>{s || "All"}</button>)}
      </div>

      {!data ? <Spinner /> : groups.length === 0 ? <Empty text="No invoices found" /> : (
        <div className="space-y-3">
          {groups.map(([k, rows]) => {
            const [y, m, c, l] = k.split("|");
            const isC = collapsed.has(k);
            return (
              <div key={k}>
                <button onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })} className="flex items-center gap-2 text-xs text-zinc-300 mb-2">
                  {isC ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <span className="font-bold text-white">{y}</span><span className="text-zinc-600">›</span>{MONTHS[Number(m) - 1]}<span className="text-zinc-600">›</span>{c}<span className="text-zinc-600">›</span><span className="text-zinc-400">{l}</span>
                  <span className="text-zinc-600">({rows.length})</span>
                </button>
                {!isC && (
                  <Table head={<tr><th className={th}>Invoice #</th><th className={th}>Date</th><th className={th}>Due</th><th className={th}>Amount</th><th className={th}>Tax</th><th className={th}>Total</th><th className={th}>Received</th><th className={th}>Status</th><th className={th}></th></tr>}>
                    {rows.map((r) => (
                      <tr key={r._id} className={tr}>
                        <td className={`${td} font-semibold text-white`}>{r.invoiceNumber}</td>
                        <td className={`${td} tabular-nums`}>{r.invoiceDate}</td>
                        <td className={`${td} tabular-nums`}>{r.dueDate ?? "—"}</td>
                        <td className={`${td} tabular-nums`}>{formatINR(r.amount)}</td>
                        <td className={`${td} tabular-nums`}>{formatINR(r.taxAmount)}</td>
                        <td className={`${td} tabular-nums text-white`}>{formatINR(r.totalAmount)}</td>
                        <td className={`${td} tabular-nums`}>{formatINR(r.amountReceived)}</td>
                        <td className={td}><Badge>{r.displayStatus}</Badge></td>
                        <td className={`${td} whitespace-nowrap`}>
                          {r.fileName && <button onClick={() => openSigned(`/api/invoices/${r._id}`).catch((x) => setMsg({ k: "error", t: x.message }))} className="h-8 px-2 rounded-lg border border-zinc-800 text-zinc-300 hover:text-white" title="Preview / download"><FileDown size={12} /></button>}
                          {can("invoices.manage") && <button onClick={() => setEdit(r)} className="ml-1 h-8 px-2 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white" title="Update status"><Pencil size={12} /></button>}
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Modal open={upload} onClose={() => setUpload(false)} size="lg" title="Upload client invoice">
        <form onSubmit={submitUpload} className="space-y-3">
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Invoice number"><Input name="invoiceNumber" required /></Field>
            <Field label="Client name"><Input name="clientName" required list="clients" /></Field>
            <Field label="Client location"><Input name="clientLocation" required list="locs" /></Field>
            <Field label="Invoice date"><Input type="date" name="invoiceDate" required /></Field>
            <Field label="Due date"><Input type="date" name="dueDate" /></Field>
            <Field label="Status"><Select name="status" defaultValue="Issued">{STATUSES.filter((s) => s !== "Overdue").map((s) => <option key={s}>{s}</option>)}</Select></Field>
            <Field label="Billing month"><Select name="billingMonth" defaultValue={new Date().getMonth() + 1}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select></Field>
            <Field label="Billing year"><Input type="number" name="billingYear" defaultValue={new Date().getFullYear()} required /></Field>
            <Field label="Amount ₹ (pre-tax)"><Input type="number" step="0.01" min={0} name="amount" required /></Field>
            <Field label="Tax amount ₹"><Input type="number" step="0.01" min={0} name="taxAmount" defaultValue={0} /></Field>
          </div>
          <Field label="Invoice document (PDF/PNG/JPG, ≤10 MB)"><input type="file" name="file" accept="application/pdf,image/png,image/jpeg" className="text-xs text-zinc-400" /></Field>
          <Field label="Notes"><Input name="notes" /></Field>
          <datalist id="clients">{data?.clients.map((c) => <option key={c} value={c} />)}</datalist>
          <datalist id="locs">{data?.locations.map((c) => <option key={c} value={c} />)}</datalist>
          <div className="flex justify-end gap-2 pt-2"><Button type="button" variant="outline" onClick={() => setUpload(false)}>Cancel</Button><Button type="submit" loading={busy}>Save invoice</Button></div>
        </form>
      </Modal>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={`Update ${edit?.invoiceNumber ?? ""}`}>
        {edit && (
          <form onSubmit={submitEdit} className="space-y-3">
            <Field label="Status"><Select name="status" defaultValue={edit.status}>{STATUSES.filter((s) => s !== "Overdue").map((s) => <option key={s}>{s}</option>)}</Select></Field>
            <Field label={`Amount received ₹ (total ${formatINR(edit.totalAmount)})`}><Input type="number" step="0.01" min={0} name="amountReceived" defaultValue={edit.amountReceived / 100} /></Field>
            <Field label="Reason (audited)"><Textarea name="reason" required minLength={5} /></Field>
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button type="submit" loading={busy}>Save</Button></div>
          </form>
        )}
      </Modal>
    </Page>
  );
}
