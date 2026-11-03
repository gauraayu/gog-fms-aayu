"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Upload, FileDown, Pencil, History } from "lucide-react";
import { api, openSigned, qs } from "@/lib/client";
import { formatINR } from "@/lib/money";
import { fyRange, monthLabel } from "@/lib/dates";
import { useAuth } from "@/components/AuthContext";
import { Badge, Button, Card, Field, Input, Modal, Notice, Page, PageHeader, Select, Spinner, Stat, Textarea } from "@/components/ui";

const TYPES = ["EPF", "GST", "PT", "TDS"] as const;
interface Challan { _id: string; type: string; month: number; year: number; financialYear: string; referenceNumber?: string; amount: number; paymentDate?: string; paymentStatus: string; fileName?: string; versions?: { fileName?: string; replacedAt: string; replacedBy: string; reason: string }[] }

export default function ChallansPage() {
  const { can } = useAuth();
  const [fy, setFy] = useState("");
  const [rows, setRows] = useState<Challan[] | null>(null);
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const [upload, setUpload] = useState<null | { type: string; ym: string }>(null);
  const [edit, setEdit] = useState<Challan | null>(null);
  const [vers, setVers] = useState<Challan | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<{ currentFY: string }>("/api/meta").then((m) => setFy(m.currentFY)); }, []);
  const load = useCallback(() => {
    if (!fy) return;
    setRows(null);
    api<{ rows: Challan[] }>(`/api/challans${qs({ fy })}`).then((r) => setRows(r.rows)).catch((e) => setMsg({ k: "error", t: e.message }));
  }, [fy]);
  useEffect(load, [load]);

  const byKey = useMemo(() => new Map((rows ?? []).map((c) => [`${c.type}:${c.year}-${String(c.month).padStart(2, "0")}`, c])), [rows]);
  const months = fy ? fyRange(fy).months : [];
  const totals = TYPES.map((t) => ({ t, paid: (rows ?? []).filter((c) => c.type === t && c.paymentStatus !== "Uploaded").reduce((a, c) => a + c.amount, 0) }));
  const fys = fy ? [0, 1, 2, 3].map((i) => { const y = Number(fy.slice(0, 4)) - i; return `${y}-${String((y + 1) % 100).padStart(2, "0")}`; }) : [];

  async function send(url: string, method: string, form: HTMLFormElement, ok: string) {
    setBusy(true);
    try {
      const res = await fetch(url, { method, body: new FormData(form) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setMsg({ k: "ok", t: ok });
      setUpload(null); setEdit(null);
      load();
    } catch (e) { setMsg({ k: "error", t: (e as Error).message }); } finally { setBusy(false); }
  }

  return (
    <Page wide>
      <PageHeader title="EPF, GST, PT & TDS Challans" subtitle="Financial Year → Month → Type. Only Paid / Verified challans (with date + reference) count as payments."
        actions={<Select value={fy} onChange={(e) => setFy(e.target.value)} className="w-32">{fys.map((f) => <option key={f} value={f}>FY {f}</option>)}</Select>} />
      {msg && <Notice kind={msg.k} onClose={() => setMsg(null)}>{msg.t}</Notice>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">{totals.map((x) => <Stat key={x.t} label={`${x.t} paid — FY ${fy}`} value={formatINR(x.paid, { decimals: false })} />)}</div>

      {!rows ? <Spinner /> : (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {months.map((ym) => (
            <Card key={ym} title={monthLabel(ym)}>
              <div className="space-y-2">
                {TYPES.map((t) => {
                  const c = byKey.get(`${t}:${ym}`);
                  return (
                    <div key={t} className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-[11px] font-bold text-white">{t}</div>
                        <div className="text-[10px] text-zinc-500 truncate">{c ? `${formatINR(c.amount, { decimals: false })}${c.referenceNumber ? ` · ${c.referenceNumber}` : ""}${c.paymentDate ? ` · ${c.paymentDate}` : ""}` : "Not uploaded"}</div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {c ? <Badge>{c.paymentStatus}</Badge> : null}
                        {c && <button onClick={() => openSigned(`/api/challans/${c._id}`).catch((x) => setMsg({ k: "error", t: x.message }))} className="h-7 px-1.5 rounded-lg border border-zinc-800 text-zinc-300 hover:text-white" title="View"><FileDown size={11} /></button>}
                        {c && !!c.versions?.length && <button onClick={() => setVers(c)} className="h-7 px-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white" title="Versions"><History size={11} /></button>}
                        {can("challans.manage") && (c
                          ? <button onClick={() => setEdit(c)} className="h-7 px-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white" title="Update / replace"><Pencil size={11} /></button>
                          : <button onClick={() => setUpload({ type: t, ym })} className="h-7 px-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white" title="Upload"><Upload size={11} /></button>)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={!!upload} onClose={() => setUpload(null)} title={upload ? `Upload ${upload.type} challan — ${monthLabel(upload.ym)}` : ""}>
        {upload && (
          <form onSubmit={(e) => { e.preventDefault(); send("/api/challans", "POST", e.currentTarget, "Challan uploaded"); }} className="space-y-3">
            <input type="hidden" name="type" value={upload.type} />
            <input type="hidden" name="year" value={upload.ym.slice(0, 4)} />
            <input type="hidden" name="month" value={Number(upload.ym.slice(5, 7))} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount ₹"><Input type="number" step="0.01" min={0} name="amount" required /></Field>
              <Field label="Payment status"><Select name="paymentStatus" defaultValue="Uploaded"><option>Uploaded</option><option>Paid</option><option>Verified</option></Select></Field>
              <Field label="Challan reference no."><Input name="referenceNumber" /></Field>
              <Field label="Payment date"><Input type="date" name="paymentDate" /></Field>
            </div>
            <Field label="Document (PDF/PNG/JPG ≤10 MB)"><input type="file" name="file" required accept="application/pdf,image/png,image/jpeg" className="text-xs text-zinc-400" /></Field>
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setUpload(null)}>Cancel</Button><Button type="submit" loading={busy}>Upload</Button></div>
          </form>
        )}
      </Modal>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit ? `${edit.type} — ${monthLabel(`${edit.year}-${String(edit.month).padStart(2, "0")}`)}` : ""}>
        {edit && (
          <form onSubmit={(e) => { e.preventDefault(); send(`/api/challans/${edit._id}`, "PATCH", e.currentTarget, "Challan updated"); }} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount ₹"><Input type="number" step="0.01" min={0} name="amount" defaultValue={edit.amount / 100} /></Field>
              <Field label="Payment status"><Select name="paymentStatus" defaultValue={edit.paymentStatus}><option>Uploaded</option><option>Paid</option><option>Verified</option></Select></Field>
              <Field label="Reference no."><Input name="referenceNumber" defaultValue={edit.referenceNumber} /></Field>
              <Field label="Payment date"><Input type="date" name="paymentDate" defaultValue={edit.paymentDate} /></Field>
            </div>
            <Field label="Replace document (optional — old version is kept)"><input type="file" name="file" accept="application/pdf,image/png,image/jpeg" className="text-xs text-zinc-400" /></Field>
            <Field label="Reason (audited)"><Textarea name="reason" required minLength={5} /></Field>
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button type="submit" loading={busy}>Save</Button></div>
          </form>
        )}
      </Modal>

      <Modal open={!!vers} onClose={() => setVers(null)} title="Document version history">
        <div className="space-y-2">
          {vers?.versions?.map((v, i) => (
            <div key={i} className="flex items-center justify-between rounded-xl border border-zinc-800 px-3 py-2 text-xs">
              <div><div className="text-white">{v.fileName ?? `Version ${i + 1}`}</div><div className="text-[10px] text-zinc-500">Replaced {new Date(v.replacedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} by {v.replacedBy} — {v.reason}</div></div>
              <button onClick={() => openSigned(`/api/challans/${vers._id}?version=${i}`)} className="h-7 px-2 rounded-lg border border-zinc-800 text-zinc-300"><FileDown size={11} /></button>
            </div>
          ))}
        </div>
      </Modal>
    </Page>
  );
}
