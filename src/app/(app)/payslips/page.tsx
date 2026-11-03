"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, FileDown, FilePlus2, Mail, RotateCw, Search, Send, Archive } from "lucide-react";
import { api, openSigned, qs } from "@/lib/client";
import { formatINR } from "@/lib/money";
import { monthLabel } from "@/lib/dates";
import { useAuth } from "@/components/AuthContext";
import { Badge, Button, Card, Empty, Field, Input, KpiCard, Modal, Notice, Page, PageHeader, Spinner, Table, Tabs, Textarea, td, th, tr } from "@/components/ui";

interface Slip { _id: string; employeeId: string; month: string; netPay: number; version: number; updatedAt: string; email: { status: string; sentAt?: string; lastError?: string } | null }
interface Entry { employeeId: string; employee: { name: string; email: string; dept: string }; netPay: number | null; excluded: boolean; calc: unknown; status?: string }
const READY = ["Finalized", "Disbursed"];
interface Preview {
  employeeId: string; month: string; employeeName: string; to: string; validRecipient: boolean; subject: string; html: string;
  attachmentName: string; payslipId: string; version: number; netPay: number; alreadySent: boolean; sentAt: string | null;
}
interface ArchiveRow {
  _id: string; employeeId: string; employeeName?: string; month: string; to: string; subject: string; netPay?: number; sentAt: string;
  sentVersion?: number; sentByName?: string; sentHistory?: { at: string; version: number; to: string }[];
}
interface ArchiveMonth { month: string; count: number; total: number; lastSentAt: string }

const ist = (d?: string | null) => (d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

export default function PayslipsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<"send" | "archive">("send");
  const [month, setMonth] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [slips, setSlips] = useState<Slip[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ k: "ok" | "error" | "warn"; t: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [bulk, setBulk] = useState<string[] | null>(null);

  // archive
  const [aMonth, setAMonth] = useState("");
  const [aSearch, setASearch] = useState("");
  const [archive, setArchive] = useState<{ rows: ArchiveRow[]; months: ArchiveMonth[] } | null>(null);

  useEffect(() => {
    api<{ currentMonth: string }>("/api/meta").then((m) => {
      const [y, mm] = m.currentMonth.split("-").map(Number);
      setMonth(new Date(Date.UTC(y, mm - 2, 1)).toISOString().slice(0, 7));
    });
  }, []);

  const load = useCallback(() => {
    if (!month) return;
    setEntries(null);
    setSel(new Set());
    Promise.all([
      api<{ run: { status: string } | null; entries: Entry[] }>(`/api/payroll/runs/${month}`),
      api<{ rows: Slip[] }>(`/api/payslips?month=${month}`),
    ]).then(([r, s]) => { setStatus(r.run?.status ?? null); setEntries(r.entries.filter((e) => !e.excluded && e.calc)); setSlips(s.rows); })
      .catch((e) => setMsg({ k: "error", t: e.message }));
  }, [month]);
  useEffect(load, [load]);

  const loadArchive = useCallback(() => {
    setArchive(null);
    api<{ rows: ArchiveRow[]; months: ArchiveMonth[] }>(`/api/payslips/archive${qs({ month: aMonth, search: aSearch })}`)
      .then(setArchive).catch((e) => setMsg({ k: "error", t: e.message }));
  }, [aMonth, aSearch]);
  useEffect(() => {
    if (tab !== "archive") return;
    const t = setTimeout(loadArchive, 250);
    return () => clearTimeout(t);
  }, [tab, loadArchive]);

  const byEmp = useMemo(() => new Map(slips.map((s) => [s.employeeId, s])), [slips]);
  // Per employee: a payslip can be made once THAT employee's payroll is Finalized / Disbursed.
  const isReady = (e: Entry) => READY.includes(e.status ?? status ?? "");
  const readyCount = (entries ?? []).filter(isReady).length;
  const ready = readyCount > 0;

  async function generate(ids?: string[]) {
    setBusy("gen");
    try {
      const r = await api<{ ok: number; failed: number; results: { employeeId: string; ok: boolean; error?: string }[] }>("/api/payslips", { method: "POST", json: { month, employeeIds: ids } });
      setMsg({ k: r.failed ? "warn" : "ok", t: `Generated ${r.ok} payslip(s)${r.failed ? `, ${r.failed} failed: ${r.results.find((x) => !x.ok)?.error}` : ""}. Nothing has been emailed.` });
      load();
    } catch (e) { setMsg({ k: "error", t: (e as Error).message }); } finally { setBusy(""); }
  }

  async function openPreview(employeeId: string) {
    setPreviewLoading(employeeId);
    try {
      setReason("");
      setPreview(await api<Preview>(`/api/payslips/email/preview${qs({ month, employeeId })}`));
    } catch (e) { setMsg({ k: "error", t: (e as Error).message }); } finally { setPreviewLoading(null); }
  }

  async function email(ids: string[], resendReason?: string) {
    setBusy("mail");
    try {
      const r = await api<{ results: { employeeId: string; status: string; error?: string }[] }>("/api/payslips/email", { method: "POST", json: { month, employeeIds: ids, resend: !!resendReason, reason: resendReason } });
      const c = (s: string) => r.results.filter((x) => x.status === s).length;
      const fail = r.results.find((x) => x.status === "Failed");
      setMsg({ k: fail ? "warn" : "ok", t: `Sent ${c("Sent")}, already sent ${c("AlreadySent")}, failed ${c("Failed")}${fail ? ` (${fail.error})` : ""}. Sent payslips are saved under “Sent Payslips”.` });
      load();
    } catch (e) { setMsg({ k: "error", t: (e as Error).message }); } finally { setBusy(""); }
  }

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const withSlip = (entries ?? []).filter((e) => byEmp.has(e.employeeId)).map((e) => e.employeeId);
  const entryById = useMemo(() => new Map((entries ?? []).map((e) => [e.employeeId, e])), [entries]);
  const bulkNotSent = (bulk ?? []).filter((id) => byEmp.get(id)?.email?.status !== "Sent");
  const bulkAlready = (bulk ?? []).filter((id) => byEmp.get(id)?.email?.status === "Sent");

  return (
    <Page wide>
      <PageHeader
        title="Payslip Management"
        subtitle="Payslips are emailed ONLY when you click Send — never automatically. Preview first; emails go to the employee only (no CC)."
        actions={tab === "send" && <>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-40" />
          {can("payslips.generate") && ready && <Button loading={busy === "gen"} onClick={() => generate()}><FilePlus2 size={12} /> Generate All Finalized ({readyCount})</Button>}
          {can("payslips.email") && ready && <Button variant="outline" disabled={!sel.size} onClick={() => setBulk([...sel])}><Mail size={12} /> Email Selected ({sel.size})</Button>}
        </>}
      />
      <Tabs value={tab} onChange={setTab} items={[{ value: "send", label: "Generate & Send" }, { value: "archive", label: "Sent Payslips (month-wise)" }]} />
      {msg && <Notice kind={msg.k} onClose={() => setMsg(null)}>{msg.t}</Notice>}

      {tab === "send" && (
        <>
          {status !== null && !ready && <Notice kind="warn">No employee is Finalized yet for {monthLabel(month)}. Finalize one employee (or all) in Payroll Management first.</Notice>}
          {status !== null && ready && readyCount < (entries?.length ?? 0) && <Notice kind="warn">{readyCount} of {entries?.length} employees are Finalized — only they can get a payslip right now.</Notice>}
          {!entries ? <Spinner /> : status === null ? <Card><Empty text={`No payroll for ${month && monthLabel(month)}`} /></Card> : (
            <Table head={<tr>
              <th className={th}><input type="checkbox" aria-label="Select all" checked={withSlip.length > 0 && withSlip.every((i) => sel.has(i))} onChange={(e) => setSel(e.target.checked ? new Set(withSlip) : new Set())} /></th>
              <th className={th}>Employee</th><th className={th}>Email</th><th className={th}>Net Pay</th><th className={th}>Payslip</th><th className={th}>Email Status</th><th className={th}></th>
            </tr>}>
              {entries.map((e) => {
                const s = byEmp.get(e.employeeId);
                return (
                  <tr key={e.employeeId} className={tr}>
                    <td className={td}><input type="checkbox" disabled={!s} checked={sel.has(e.employeeId)} onChange={() => toggle(e.employeeId)} aria-label={`Select ${e.employee.name}`} /></td>
                    <td className={td}><div className="font-semibold text-white">{e.employee.name}</div><div className="text-[10px] text-zinc-500">{e.employeeId} · {e.employee.dept}</div></td>
                    <td className={`${td} text-[11px]`}>{e.employee.email}</td>
                    <td className={`${td} tabular-nums`}>{e.netPay !== null ? formatINR(e.netPay) : "•••"}</td>
                    <td className={td}>{s ? <Badge tone="emerald">v{s.version}</Badge> : isReady(e) ? <Badge tone="zinc">Not generated</Badge> : <Badge tone="amber">{e.status ?? status} — not finalized</Badge>}</td>
                    <td className={td}>
                      {s?.email ? <span title={s.email.lastError}><Badge>{s.email.status}</Badge></span> : <span className="text-zinc-600">Not sent</span>}
                      {s?.email?.sentAt && <div className="text-[10px] text-zinc-500">{ist(s.email.sentAt)}</div>}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {s && <button onClick={() => openSigned(`/api/payslips/${s._id}/file`).catch((x) => setMsg({ k: "error", t: x.message }))} className="h-8 px-2 rounded-lg border border-zinc-800 text-zinc-300 hover:text-white inline-flex items-center gap-1" title="View payslip PDF"><FileDown size={12} /> PDF</button>}
                      {s && can("payslips.email") && (
                        <>
                          <Button variant="outline" className="ml-1 h-8 px-2.5" loading={previewLoading === e.employeeId} onClick={() => openPreview(e.employeeId)}>
                            <Eye size={12} /> Preview
                          </Button>
                          {s.email?.status === "Sent"
                            ? <Button variant="outline" className="ml-1 h-8 px-2.5" onClick={() => openPreview(e.employeeId)}><RotateCw size={12} /> Resend</Button>
                            : <Button className="ml-1 h-8 px-2.5" onClick={() => setBulk([e.employeeId])}><Send size={12} /> Send</Button>}
                        </>
                      )}
                      {!s && isReady(e) && can("payslips.generate") && <button onClick={() => generate([e.employeeId])} className="h-8 px-2 rounded-lg border border-zinc-800 text-zinc-300 hover:text-white">Generate</button>}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
        </>
      )}

      {tab === "archive" && (
        <>
          <div className="flex flex-wrap gap-2">
            <Input type="month" value={aMonth} onChange={(e) => setAMonth(e.target.value)} className="w-40" aria-label="Month" />
            {aMonth && <Button variant="ghost" onClick={() => setAMonth("")}>All months</Button>}
            <div className="relative"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" /><Input value={aSearch} onChange={(e) => setASearch(e.target.value)} placeholder="Name, ID or email" className="pl-8 w-56" /></div>
          </div>
          {!archive ? <Spinner /> : (
            <>
              {!aMonth && archive.months.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                  {archive.months.map((m) => (
                    <button key={m.month} onClick={() => setAMonth(m.month)} className="text-left">
                      <KpiCard icon={<Archive size={16} />} label={monthLabel(m.month)} value={`${m.count} sent`} hint={`Net ${formatINR(m.total, { decimals: false })} · last ${ist(m.lastSentAt)}`} />
                    </button>
                  ))}
                </div>
              )}
              {archive.rows.length === 0 ? <Card><Empty text="No payslips have been emailed yet" /></Card> : (
                <Table head={<tr><th className={th}>Month</th><th className={th}>Employee</th><th className={th}>Sent to</th><th className={th}>Net Pay</th><th className={th}>Sent</th><th className={th}>By</th><th className={th}></th></tr>}>
                  {archive.rows.map((r) => (
                    <tr key={r._id} className={tr}>
                      <td className={`${td} whitespace-nowrap`}>{monthLabel(r.month)}</td>
                      <td className={td}><div className="font-semibold text-white">{r.employeeName || r.employeeId}</div><div className="text-[10px] text-zinc-500">{r.employeeId}</div></td>
                      <td className={`${td} text-[11px]`}>{r.to}</td>
                      <td className={`${td} tabular-nums`}>{typeof r.netPay === "number" ? formatINR(r.netPay) : "—"}</td>
                      <td className={`${td} text-[11px] whitespace-nowrap`}>{ist(r.sentAt)}{(r.sentHistory?.length ?? 0) > 1 && <div className="text-[10px] text-zinc-500">sent {r.sentHistory!.length}×</div>}</td>
                      <td className={`${td} text-[11px]`}>{r.sentByName ?? "—"}</td>
                      <td className={`${td} whitespace-nowrap`}>
                        <button onClick={() => openSigned(`/api/payslips/archive/${r._id}/file`).catch((x) => setMsg({ k: "error", t: x.message }))} className="h-8 px-2 rounded-lg border border-zinc-800 text-zinc-300 hover:text-white inline-flex items-center gap-1"><Eye size={12} /> View sent PDF</button>
                        {(r.sentHistory?.length ?? 0) > 1 && r.sentHistory!.slice(0, -1).map((h, i) => (
                          <button key={i} onClick={() => openSigned(`/api/payslips/archive/${r._id}/file?h=${i}`).catch((x) => setMsg({ k: "error", t: x.message }))} className="ml-1 h-8 px-2 rounded-lg border border-zinc-800 text-zinc-500 hover:text-white text-[10px]" title={`Sent ${ist(h.at)}`}>v{h.version}</button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </>
          )}
        </>
      )}

      {/* Single preview → send */}
      <Modal
        open={!!preview} onClose={() => setPreview(null)} size="xl" title={preview ? `Email preview — ${preview.employeeName} · ${monthLabel(preview.month)}` : ""}
        footer={preview && <>
          <Button variant="outline" onClick={() => setPreview(null)}>Cancel</Button>
          <Button
            loading={busy === "mail"}
            disabled={!preview.validRecipient || (preview.alreadySent && reason.trim().length < 5)}
            onClick={async () => { const p = preview; setPreview(null); await email([p.employeeId], p.alreadySent ? reason : undefined); }}
          ><Send size={12} /> {preview.alreadySent ? "Resend email" : "Send email"}</Button>
        </>}
      >
        {preview && (
          <div className="space-y-3">
            {!preview.validRecipient && <Notice kind="error">This employee has no valid registered email in OMS — it can’t be sent.</Notice>}
            {preview.alreadySent && <Notice kind="warn">Already sent on {ist(preview.sentAt)}. Resending needs a reason (audited).</Notice>}
            <div className="grid sm:grid-cols-2 gap-2 text-xs">
              <div className="rounded-xl border border-zinc-800 px-3 py-2"><div className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">To</div><div className="text-white break-all">{preview.to || "—"}</div><div className="text-[10px] text-zinc-500">No CC</div></div>
              <div className="rounded-xl border border-zinc-800 px-3 py-2"><div className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">Subject</div><div className="text-white">{preview.subject}</div></div>
            </div>
            <div className="text-[10px] text-zinc-500">Exactly what the employee will see in the email (the attached PDF has the same design).</div>
            <div className="rounded-xl border border-zinc-800 overflow-auto bg-white max-h-[60vh]">
              <iframe title="Email preview" srcDoc={preview.html} sandbox="" className="w-full border-0 block" style={{ height: 1280, minWidth: 800 }} />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-zinc-800 px-3 py-2 text-xs">
              <span className="text-zinc-300">📎 {preview.attachmentName} <span className="text-zinc-500">(v{preview.version} · net {formatINR(preview.netPay)})</span></span>
              <button onClick={() => openSigned(`/api/payslips/${preview.payslipId}/file`).catch((x) => setMsg({ k: "error", t: x.message }))} className="h-8 px-2 rounded-lg border border-zinc-800 text-zinc-300 hover:text-white inline-flex items-center gap-1"><FileDown size={12} /> Open attachment</button>
            </div>
            {preview.alreadySent && <Field label="Reason for resending"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Employee did not receive the email" /></Field>}
          </div>
        )}
      </Modal>

      {/* Bulk confirm */}
      <Modal
        open={!!bulk} onClose={() => setBulk(null)} size="lg" title={`Send ${bulkNotSent.length} payslip email(s) — ${month && monthLabel(month)}`}
        footer={<>
          <Button variant="outline" onClick={() => setBulk(null)}>Cancel</Button>
          <Button loading={busy === "mail"} disabled={!bulkNotSent.length} onClick={async () => { const ids = bulkNotSent; setBulk(null); await email(ids); }}><Send size={12} /> Send {bulkNotSent.length} email(s)</Button>
        </>}
      >
        <div className="space-y-3">
          <p className="text-xs text-zinc-400">Each employee gets their own payslip PDF at their OMS email (no CC). Use “Preview &amp; Send” on a row to see the exact email first.</p>
          {bulkAlready.length > 0 && <Notice kind="warn">{bulkAlready.length} selected employee(s) were already sent this month and will be skipped. Use “Preview / Resend” on their row to resend.</Notice>}
          <Table head={<tr><th className={th}>Employee</th><th className={th}>To</th><th className={th}>Net Pay</th></tr>}>
            {bulkNotSent.map((id) => {
              const e = entryById.get(id);
              return (
                <tr key={id} className={tr}>
                  <td className={td}>{e?.employee.name ?? id}<div className="text-[10px] text-zinc-500">{id}</div></td>
                  <td className={`${td} text-[11px]`}>{e?.employee.email || <span className="text-red-400">no email</span>}</td>
                  <td className={`${td} tabular-nums`}>{e?.netPay != null ? formatINR(e.netPay) : "•••"}</td>
                </tr>
              );
            })}
          </Table>
        </div>
      </Modal>
    </Page>
  );
}