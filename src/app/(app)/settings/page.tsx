"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, UserPlus } from "lucide-react";
import { api } from "@/lib/client";
import { useAuth } from "@/components/AuthContext";
import { Badge, Button, Card, Field, Input, Modal, Notice, Page, PageHeader, Select, Spinner, Table, Tabs, Textarea, td, th, tr } from "@/components/ui";
import type { PayrollPolicy } from "@/lib/policy";

interface Access { _id: string; employeeId: string; email: string; name: string; role: string; active: boolean; grantedBy?: string; revokedAt?: string }
interface S { policy: PayrollPolicy; permissions: Record<string, string[]>; catalog: Record<string, string> }
const ROLES = ["FOUNDER", "HR", "ACCOUNTS"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function SettingsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"policy" | "access" | "perms">("policy");
  const [s, setS] = useState<S | null>(null);
  const [p, setP] = useState<PayrollPolicy | null>(null);
  const [access, setAccess] = useState<Access[] | null>(null);
  const [perms, setPerms] = useState<Record<string, string[]>>({});
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<null | { employeeId: string; role: string; active: boolean; reason: string; existing?: boolean }>(null);

  const load = useCallback(() => {
    api<S>("/api/settings").then((d) => { setS(d); setP(d.policy); setPerms(d.permissions); }).catch((e) => setMsg({ k: "error", t: e.message }));
    api<{ rows: Access[] }>("/api/settings/access").then((d) => setAccess(d.rows)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function save(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try {
      await api("/api/settings", { method: "PUT", json: { ...body, reason } });
      setMsg({ k: "ok", t: ok });
      setReason("");
      load();
    } catch (e) { setMsg({ k: "error", t: (e as Error).message }); } finally { setBusy(false); }
  }
  const upd = <K extends keyof PayrollPolicy>(k: K, v: PayrollPolicy[K]) => setP((x) => ({ ...x!, [k]: v }));
  const canConfirm = user && ["FOUNDER", "FMS_ADMIN"].includes(user.role);

  return (
    <Page wide>
      <PageHeader title="Settings" subtitle="Payroll policy, FMS access and the permission matrix. Every change needs a reason and is audited." />
      {msg && <Notice kind={msg.k} onClose={() => setMsg(null)}>{msg.t}</Notice>}
      <Tabs value={tab} onChange={setTab} items={[{ value: "policy", label: "Payroll Policy" }, { value: "access", label: "FMS Access" }, { value: "perms", label: "Permission Matrix" }]} />

      {!s || !p ? <Spinner /> : tab === "policy" ? (
        <Card title="Payroll policy" actions={p.confirmed ? <Badge tone="emerald">Confirmed by {p.confirmedBy}</Badge> : <Badge tone="amber">Not confirmed</Badge>}>
          <Notice kind="warn">Payable days, LOP, leave quota (1 paid day / month), Sundays, holidays and penalties are taken exactly from GOG OMS (same calculation as OMS → Salary Management, including HR payable corrections). Only the salary settings below are decided in FMS. Saving any change un-confirms the policy.</Notice>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
            <Field label="Payroll divisor"><Select value={p.divisorMode} onChange={(e) => upd("divisorMode", e.target.value as PayrollPolicy["divisorMode"])}><option value="CALENDAR_DAYS">Calendar days in month</option><option value="FIXED">Fixed number of days</option></Select></Field>
            {p.divisorMode === "FIXED" && <Field label="Fixed divisor"><Input type="number" min={1} max={31} value={p.fixedDivisor} onChange={(e) => upd("fixedDivisor", Number(e.target.value))} /></Field>}
            <Field label="Also deduct OMS employees.fines (OMS itself does not)"><Select value={String(p.includeOmsFines)} onChange={(e) => upd("includeOmsFines", e.target.value === "true")}><option value="true">Yes</option><option value="false">No</option></Select></Field>
            <Field label="OMS fine amount unit"><Select value={p.omsFineUnit} onChange={(e) => upd("omsFineUnit", e.target.value as never)}><option value="RUPEES">Rupees</option><option value="PAISE">Paise</option></Select></Field>
            <Field label="Net pay rounding"><Select value={p.rounding} onChange={(e) => upd("rounding", e.target.value as never)}><option value="NEAREST_RUPEE">Nearest rupee</option><option value="PAISE">Exact (paise)</option></Select></Field>
            <Field label="Active OMS statuses (comma)"><Input value={p.activeStatuses.join(",")} onChange={(e) => upd("activeStatuses", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} /></Field>
          </div>
          <div className="mt-4 grid sm:grid-cols-[1fr_auto_auto] gap-2 items-end">
            <Field label="Reason (required)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Policy approved in founders' meeting 28 Oct" /></Field>
            <Button variant="outline" loading={busy} disabled={reason.trim().length < 5} onClick={() => save({ policy: p }, "Policy saved (needs confirmation)")}>Save</Button>
            {canConfirm && <Button loading={busy} disabled={reason.trim().length < 5} onClick={() => save({ policy: p, confirm: true }, "Policy saved and confirmed")}><ShieldCheck size={12} /> Save & Confirm</Button>}
          </div>
        </Card>
      ) : tab === "access" ? (
        <Card title="Who can use GOG FMS" actions={<Button onClick={() => setGrant({ employeeId: "", role: "HR", active: true, reason: "" })}><UserPlus size={12} /> Grant access</Button>}>
          <p className="text-[11px] text-zinc-500 mb-3">An OMS login alone never grants FMS access. Users sign in with their existing OMS credentials; revocation is immediate.</p>
          {!access ? <Spinner /> : (
            <Table head={<tr><th className={th}>Employee</th><th className={th}>Email</th><th className={th}>FMS role</th><th className={th}>Status</th><th className={th}></th></tr>}>
              {access.map((a) => (
                <tr key={a._id} className={tr}>
                  <td className={td}><div className="text-white font-semibold">{a.name}</div><div className="text-[10px] text-zinc-500">{a.employeeId}</div></td>
                  <td className={`${td} text-[11px]`}>{a.email}</td>
                  <td className={td}>{a.role}</td>
                  <td className={td}>{a.active ? <Badge tone="emerald">Active</Badge> : <Badge tone="zinc">Revoked</Badge>}</td>
                  <td className={td}><Button variant="outline" className="h-8" onClick={() => setGrant({ employeeId: a.employeeId, role: a.role, active: a.active, reason: "", existing: true })}>Edit</Button></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ) : (
        <Card title="Permission matrix">
          <p className="text-[11px] text-zinc-500 mb-3">Founder always has every permission. Changes take effect on the next request.</p>
          <Table head={<tr><th className={th}>Permission</th>{ROLES.filter((r) => r !== "FOUNDER").map((r) => <th key={r} className={`${th} text-center`}>{r}</th>)}</tr>}>
            {Object.entries(s.catalog).map(([perm, label]) => (
              <tr key={perm} className={tr}>
                <td className={td}><div className="text-white">{label}</div><div className="text-[10px] font-mono text-zinc-600">{perm}</div></td>
                {ROLES.filter((r) => r !== "FOUNDER").map((r) => (
                  <td key={r} className={`${td} text-center`}>
                    <input type="checkbox" aria-label={`${r} ${perm}`} checked={perms[r]?.includes(perm) ?? false}
                      onChange={(e) => setPerms((x) => ({ ...x, [r]: e.target.checked ? [...(x[r] ?? []), perm] : (x[r] ?? []).filter((y) => y !== perm) }))} />
                  </td>
                ))}
              </tr>
            ))}
          </Table>
          <div className="mt-4 grid sm:grid-cols-[1fr_auto] gap-2 items-end">
            <Field label="Reason (required)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <Button loading={busy} disabled={reason.trim().length < 5} onClick={() => save({ permissions: perms }, "Permission matrix saved")}>Save matrix</Button>
          </div>
        </Card>
      )}

      <Modal open={!!grant} onClose={() => setGrant(null)} title={grant?.existing ? "Update FMS access" : "Grant FMS access"}
        footer={<><Button variant="outline" onClick={() => setGrant(null)}>Cancel</Button><Button loading={busy} disabled={!grant?.employeeId || (grant?.reason.trim().length ?? 0) < 5} onClick={async () => {
          setBusy(true);
          try { await api("/api/settings/access", { method: "POST", json: grant }); setGrant(null); setMsg({ k: "ok", t: "Access updated" }); load(); }
          catch (e) { setMsg({ k: "error", t: (e as Error).message }); } finally { setBusy(false); }
        }}>Save</Button></>}>
        {grant && (
          <div className="space-y-3">
            <Field label="OMS Employee ID"><Input disabled={grant.existing} value={grant.employeeId} onChange={(e) => setGrant({ ...grant, employeeId: e.target.value.trim() })} placeholder="e.g. EMP251" /></Field>
            <Field label="FMS role"><Select value={grant.role} onChange={(e) => setGrant({ ...grant, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</Select></Field>
            <Field label="Status"><Select value={String(grant.active)} onChange={(e) => setGrant({ ...grant, active: e.target.value === "true" })}><option value="true">Active</option><option value="false">Revoked</option></Select></Field>
            <Field label="Reason (audited)"><Textarea value={grant.reason} onChange={(e) => setGrant({ ...grant, reason: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </Page>
  );
}