"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, qs } from "@/lib/client";
import { Empty, Input, Notice, Page, PageHeader, Pagination, Select, Spinner, Table, td, th, tr } from "@/components/ui";

interface Row { _id: string; at: string; userId: string; userName: string; userRole: string; action: string; entity?: string; entityId?: string; previousValue?: unknown; updatedValue?: unknown; reason?: string; ip?: string }
const PREFIXES = ["", "auth", "payroll", "salary", "payslip", "invoice", "challan", "access", "settings", "report", "cron"];

export default function AuditPage() {
  const [action, setAction] = useState("");
  const [entityId, setEntityId] = useState("");
  const [userId, setUserId] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: Row[]; total: number; limit: number } | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    setData(null);
    api<{ rows: Row[]; total: number; limit: number }>(`/api/audit${qs({ action, entityId, userId, page })}`).then(setData).catch((e) => setErr(e.message));
  }, [action, entityId, userId, page]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  return (
    <Page wide>
      <PageHeader title="Audit History" subtitle="Append-only. Nobody — including admins — can edit or delete entries from FMS." />
      {err && <Notice kind="error" onClose={() => setErr("")}>{err}</Notice>}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>{PREFIXES.map((p) => <option key={p} value={p}>{p ? `${p}.*` : "All actions"}</option>)}</Select>
        <Input value={entityId} onChange={(e) => { setEntityId(e.target.value); setPage(1); }} placeholder="Entity (e.g. EMP251 or 2026-10)" />
        <Input value={userId} onChange={(e) => { setUserId(e.target.value); setPage(1); }} placeholder="User employee ID" />
      </div>
      {!data ? <Spinner /> : data.rows.length === 0 ? <Empty text="No audit entries" /> : (
        <>
          <Table head={<tr><th className={th}></th><th className={th}>When (IST)</th><th className={th}>User</th><th className={th}>Action</th><th className={th}>Entity</th><th className={th}>Reason</th></tr>}>
            {data.rows.map((r) => {
              const isOpen = open.has(r._id);
              const hasDiff = r.previousValue !== undefined || r.updatedValue !== undefined;
              return (
                <Fragment key={r._id}>
                  <tr className={tr}>
                    <td className={td}>{hasDiff && <button onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(r._id)) n.delete(r._id); else n.add(r._id); return n; })} className="text-zinc-500" aria-label="Toggle details">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>}</td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>{new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                    <td className={td}>{r.userName}<div className="text-[10px] text-zinc-500">{r.userId} · {r.userRole}</div></td>
                    <td className={`${td} font-mono text-[11px] text-emerald-300`}>{r.action}</td>
                    <td className={`${td} text-[11px]`}>{r.entity}{r.entityId ? <div className="text-zinc-500">{r.entityId}</div> : null}</td>
                    <td className={`${td} text-[11px] max-w-[280px]`}>{r.reason ?? <span className="text-zinc-600">—</span>}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={6} className="px-3 pb-3">
                        <div className="grid md:grid-cols-2 gap-2">
                          <pre className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-[10px] text-zinc-400 overflow-auto max-h-60">Previous:{"\n"}{JSON.stringify(r.previousValue ?? null, null, 2)}</pre>
                          <pre className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-[10px] text-zinc-300 overflow-auto max-h-60">Updated:{"\n"}{JSON.stringify(r.updatedValue ?? null, null, 2)}</pre>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </Table>
          <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />
        </>
      )}
    </Page>
  );
}
