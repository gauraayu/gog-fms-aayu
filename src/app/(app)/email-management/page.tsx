"use client";

import { useCallback, useEffect, useState } from "react";
import { MailCheck, MailX, Clock, RotateCw } from "lucide-react";
import { api, qs } from "@/lib/client";
import { useAuth } from "@/components/AuthContext";
import { Badge, Button, Empty, Input, KpiCard, Notice, Page, PageHeader, Select, Spinner, Table, td, th, tr } from "@/components/ui";

interface Log { _id: string; key: string; kind: string; employeeId?: string; month?: string; to: string; subject: string; status: string; trigger: string; lastError?: string; sentAt?: string; updatedAt: string; attempts: { at: string; ok: boolean; error?: string; by?: string }[] }

export default function EmailManagementPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState("");
  const [month, setMonth] = useState("");
  const [data, setData] = useState<{ rows: Log[]; counts: Record<string, number> } | null>(null);
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setData(null);
    api<{ rows: Log[]; counts: Record<string, number> }>(`/api/emails${qs({ status, month })}`).then(setData).catch((e) => setMsg({ k: "error", t: e.message }));
  }, [status, month]);
  useEffect(load, [load]);

  const failed = (data?.rows ?? []).filter((r) => r.status === "Failed" && r.kind === "PAYSLIP");
  async function retry(keys: string[]) {
    setBusy(true);
    try {
      const r = await api<{ results: { status: string }[] }>("/api/emails", { method: "POST", json: { keys } });
      setMsg({ k: "ok", t: `Retried ${keys.length}: ${r.results.filter((x) => x.status === "Sent").length} sent` });
      load();
    } catch (e) { setMsg({ k: "error", t: (e as Error).message }); } finally { setBusy(false); }
  }

  return (
    <Page wide>
      <PageHeader title="Email Management" subtitle="Every payslip and finance alert email, with delivery attempts. Duplicates are prevented per employee per month."
        actions={can("payslips.email") && failed.length > 0 && <Button loading={busy} onClick={() => retry(failed.map((f) => f.key))}><RotateCw size={12} /> Retry all failed ({failed.length})</Button>} />
      {msg && <Notice kind={msg.k} onClose={() => setMsg(null)}>{msg.t}</Notice>}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard icon={<MailCheck size={16} />} label="Sent" value={data?.counts.Sent ?? 0} />
        <KpiCard tone="red" icon={<MailX size={16} />} label="Failed" value={data?.counts.Failed ?? 0} />
        <KpiCard tone="amber" icon={<Clock size={16} />} label="Queued / Sending" value={(data?.counts.Queued ?? 0) + (data?.counts.Sending ?? 0)} />
      </div>
      <div className="flex gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40"><option value="">All statuses</option>{["Sent", "Failed", "Queued", "Sending"].map((s) => <option key={s}>{s}</option>)}</Select>
        <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-40" />
      </div>
      {!data ? <Spinner /> : data.rows.length === 0 ? <Empty text="No emails yet" /> : (
        <Table head={<tr><th className={th}>Updated</th><th className={th}>Type</th><th className={th}>Recipient</th><th className={th}>Subject</th><th className={th}>Trigger</th><th className={th}>Status</th><th className={th}>Attempts</th><th className={th}></th></tr>}>
          {data.rows.map((r) => (
            <tr key={r._id} className={tr}>
              <td className={`${td} whitespace-nowrap`}>{new Date(r.updatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
              <td className={td}>{r.kind}{r.employeeId ? <div className="text-[10px] text-zinc-500">{r.employeeId}</div> : null}</td>
              <td className={`${td} text-[11px] max-w-[200px] truncate`}>{r.to}</td>
              <td className={`${td} text-[11px] max-w-[260px] truncate`}>{r.subject}</td>
              <td className={td}>{r.trigger}</td>
              <td className={td}><span title={r.lastError}><Badge>{r.status}</Badge></span>{r.lastError && <div className="text-[10px] text-red-400 max-w-[200px] truncate">{r.lastError}</div>}</td>
              <td className={`${td} tabular-nums`}>{r.attempts?.length ?? 0}</td>
              <td className={td}>{r.status === "Failed" && r.kind === "PAYSLIP" && can("payslips.email") && <button onClick={() => retry([r.key])} className="h-8 px-2 rounded-lg border border-zinc-800 text-zinc-300 hover:text-white"><RotateCw size={12} /></button>}</td>
            </tr>
          ))}
        </Table>
      )}
    </Page>
  );
}
