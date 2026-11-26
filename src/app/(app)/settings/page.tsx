"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, UserPlus, FileSpreadsheet, ExternalLink } from "lucide-react";
import { api } from "@/lib/client";
import { useAuth } from "@/components/AuthContext";
import { Badge, Button, Card, Field, Input, Modal, Notice, Page, PageHeader, Select, Spinner, Table, Tabs, Textarea, td, th, tr } from "@/components/ui";
import type { PayrollPolicy } from "@/lib/policy";
import type { SalaryDefaults } from "@/lib/salary-structure";

interface Access { _id: string; employeeId: string; email: string; name: string; role: string; active: boolean; grantedBy?: string; revokedAt?: string }
interface S { policy: PayrollPolicy; salaryDefaults?: SalaryDefaults; permissions: Record<string, string[]>; catalog: Record<string, string> }
const ROLES = ["FMS_ADMIN", "FOUNDER", "HR", "ACCOUNTS"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function SettingsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"policy" | "salary" | "sheets" | "access" | "perms">("policy");
  const [gs, setGs] = useState<{ enabled: boolean; url: string; serviceAccountEmail: string; credentialsSet: boolean; log: { at: string; month: string; ok: boolean; rows?: number; error?: string; by: string }[] } | null>(null);
  const [gsLink, setGsLink] = useState("");
  const [gsOn, setGsOn] = useState(true);
  const [gsMonth, setGsMonth] = useState("");
  const [gsBusy, setGsBusy] = useState("");
  const [sd, setSd] = useState<Record<string, string> | null>(null);
  const [s, setS] = useState<S | null>(null);
  const [p, setP] = useState<PayrollPolicy | null>(null);
  const [access, setAccess] = useState<Access[] | null>(null);
  const [perms, setPerms] = useState<Record<string, string[]>>({});
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<null | { employeeId: string; role: string; active: boolean; reason: string; existing?: boolean }>(null);

  const load = useCallback(() => {
    api<S>("/api/settings").then((d) => { setS(d); setP(d.policy); setPerms(d.permissions); if (d.salaryDefaults) setSd({ epfThreshold: String(d.salaryDefaults.epfThreshold / 100), epfAboveFixed: String(d.salaryDefaults.epfAboveFixed / 100), epfBelowPercent: String(d.salaryDefaults.epfBelowPercent), epfPercentBase: d.salaryDefaults.epfPercentBase, ptDefault: String(d.salaryDefaults.ptDefault / 100), tdsThreshold: String((d.salaryDefaults.tdsThreshold ?? 1000000) / 100), tdsPercent: String(d.salaryDefaults.tdsPercent ?? 2), pfEstablishmentCode: d.salaryDefaults.pfEstablishmentCode ?? "" }); }).catch((e) => setMsg({ k: "error", t: e.message }));
    api<{ rows: Access[] }>("/api/settings/access").then((d) => setAccess(d.rows)).catch(() => {});
    api<NonNullable<typeof gs>>("/api/google-sheets").then((d) => { setGs(d); setGsLink(d.url); setGsOn(d.enabled || !d.url); }).catch(() => {});
    api<{ currentMonth: string }>("/api/meta").then((m) => setGsMonth((x) => x || m.currentMonth)).catch(() => {});
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
      <Tabs value={tab} onChange={setTab} items={[{ value: "policy", label: "Payroll Policy" }, { value: "salary", label: "Salary Defaults" }, { value: "sheets", label: "Google Sheets" }, { value: "access", label: "FMS Access" }, { value: "perms", label: "Permission Matrix" }]} />

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
      ) : tab === "salary" ? (
        <Card title="Salary structure defaults (company rules — not statutory)">
          <Notice kind="warn">EPF “Auto” and TDS “Auto” are decided EVERY payroll month on the employee's adjusted payable salary (after attendance, LOP and penalties), using these numbers. PT “Default” pre-fills new structures. HR can switch any employee to a manual amount. Open (Draft / Under Review) payroll uses new numbers on the next recalculation; Approved / Finalized payroll never changes. Confirm EPF applicability, ceilings and the state PT slab with Accounts before production payroll.</Notice>
          {sd && (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
              <Field label="EPF threshold — adjusted payable ₹ (this or more → fixed)"><Input type="number" min={0} value={sd.epfThreshold} onChange={(e) => setSd({ ...sd, epfThreshold: e.target.value })} /></Field>
              <Field label="EPF at / above threshold — fixed ₹ / month"><Input type="number" min={0} value={sd.epfAboveFixed} onChange={(e) => setSd({ ...sd, epfAboveFixed: e.target.value })} /></Field>
              <Field label="EPF below threshold — % of adjusted payable"><Input type="number" min={0} max={100} step="0.01" value={sd.epfBelowPercent} onChange={(e) => setSd({ ...sd, epfBelowPercent: e.target.value })} /></Field>
              <Field label="EPF % is of"><Select value={sd.epfPercentBase} onChange={(e) => setSd({ ...sd, epfPercentBase: e.target.value })}><option value="GROSS">Monthly salary (gross)</option><option value="BASIC">Basic</option></Select></Field>
              <Field label="Default Professional Tax ₹ / month"><Input type="number" min={0} value={sd.ptDefault} onChange={(e) => setSd({ ...sd, ptDefault: e.target.value })} /></Field>
              <Field label="TDS auto (no EPF) — up to ₹ → no TDS"><Input type="number" min={0} value={sd.tdsThreshold} onChange={(e) => setSd({ ...sd, tdsThreshold: e.target.value })} /></Field>
              <Field label="TDS auto (no EPF) — above that, %"><Input type="number" min={0} max={100} step="0.01" value={sd.tdsPercent} onChange={(e) => setSd({ ...sd, tdsPercent: e.target.value })} /></Field>
              <Field label="Company PF code (pre-fills PF account numbers)" hint="State + office + establishment code (+ extension), e.g. RJJPR0012345000. HR then only adds each employee's member number.">
                <Input value={sd.pfEstablishmentCode} placeholder="RJJPR0012345000" onChange={(e) => setSd({ ...sd, pfEstablishmentCode: e.target.value.toUpperCase().replace(/[\s/-]/g, "").slice(0, 22) })} />
              </Field>
            </div>
          )}
          <div className="mt-4 grid sm:grid-cols-[1fr_auto] gap-2 items-end">
            <Field label="Reason (required)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. EPF defaults approved by founders" /></Field>
            <Button loading={busy} disabled={!sd || reason.trim().length < 5} onClick={() => sd && save({ salaryDefaults: { epfThreshold: Math.round(Number(sd.epfThreshold) * 100), epfAboveFixed: Math.round(Number(sd.epfAboveFixed) * 100), epfBelowPercent: Number(sd.epfBelowPercent), epfPercentBase: sd.epfPercentBase, ptDefault: Math.round(Number(sd.ptDefault) * 100), tdsThreshold: Math.round(Number(sd.tdsThreshold) * 100), tdsPercent: Number(sd.tdsPercent), pfEstablishmentCode: sd.pfEstablishmentCode } }, "Salary defaults saved")}>Save</Button>
          </div>
        </Card>
      ) : tab === "sheets" ? (
        <Card title="Google Sheets — payroll copy, one tab per month">
          <Notice kind="warn">
            Only employees whose payroll is <b>Approved / Finalized / Disbursed</b> go to the sheet, with the same columns as Payroll → Download Excel / Financial Reports → Monthly Salary Report.
            The tab of a month is refreshed automatically after every Approve / Finalize / Disburse / Send Back, and with the “Sync to Google Sheet” button on Payroll.
            Salaries are readable in Google Sheets — share the sheet only with the Founder / Accounts, never “Anyone with the link”. Editing the sheet never changes FMS or OMS.
          </Notice>
          <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-[12px] space-y-1">
            <div className="text-zinc-400">Google service account (in .env.local):{" "}
              {gs?.credentialsSet ? <Badge tone="emerald">Set</Badge> : <Badge tone="red">Not set</Badge>}
            </div>
            {gs?.serviceAccountEmail
              ? <div className="text-zinc-300">Share your Google Sheet as <b>Editor</b> with: <span className="font-mono text-emerald-300 select-all">{gs.serviceAccountEmail}</span></div>
              : <div className="text-zinc-500">Add GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY to .env.local and restart FMS.</div>}
          </div>
          <div className="mt-4 grid sm:grid-cols-[1fr_auto] gap-3 items-end">
            <Field label="Google Sheet link"><Input value={gsLink} onChange={(e) => setGsLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…/edit" /></Field>
            <label className="flex items-center gap-2 text-xs text-zinc-300 h-9"><input type="checkbox" checked={gsOn} onChange={(e) => setGsOn(e.target.checked)} /> Sync automatically</label>
          </div>
          <div className="mt-3 grid sm:grid-cols-[1fr_auto] gap-2 items-end">
            <Field label="Reason (required)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Payroll sheet for founders" /></Field>
            <Button loading={gsBusy === "save"} disabled={reason.trim().length < 5} onClick={async () => {
              setGsBusy("save");
              try {
                await api("/api/google-sheets", { method: "PUT", json: { link: gsLink, enabled: gsOn, reason } });
                setMsg({ k: "ok", t: gsLink ? "Google Sheet saved" : "Google Sheet removed" }); setReason(""); load();
              } catch (e) { setMsg({ k: "error", t: (e as Error).message }); } finally { setGsBusy(""); }
            }}>Save</Button>
          </div>
          {gs?.url && (
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <Field label="Send a month now"><Input type="month" value={gsMonth} onChange={(e) => setGsMonth(e.target.value)} className="w-40" /></Field>
              <Button variant="outline" loading={gsBusy === "sync"} onClick={async () => {
                setGsBusy("sync");
                try {
                  const r = await api<{ tab: string; rows: number }>("/api/google-sheets", { method: "POST", json: { month: gsMonth } });
                  setMsg({ k: "ok", t: `Google Sheet updated: tab “${r.tab}” — ${r.rows} employee(s)` }); load();
                } catch (e) { setMsg({ k: "error", t: (e as Error).message }); load(); } finally { setGsBusy(""); }
              }}><FileSpreadsheet size={12} /> Sync this month</Button>
              <a href={gs.url} target="_blank" rel="noreferrer" className="h-9 px-3 rounded-lg border border-zinc-700 text-xs font-semibold text-zinc-200 hover:text-white inline-flex items-center gap-1.5"><ExternalLink size={12} /> Open sheet</a>
            </div>
          )}
          {!!gs?.log.length && (
            <div className="mt-4">
              <Table head={<tr><th className={th}>When</th><th className={th}>Month</th><th className={th}>Result</th><th className={th}>By</th></tr>}>
                {gs.log.map((l, i) => (
                  <tr key={i} className={tr}>
                    <td className={`${td} text-[11px] tabular-nums`}>{new Date(l.at).toLocaleString("en-IN")}</td>
                    <td className={td}>{l.month}</td>
                    <td className={`${td} text-[11px]`}>{l.ok ? <Badge tone="emerald">{l.rows} employee(s)</Badge> : <span className="text-red-400">{l.error}</span>}</td>
                    <td className={`${td} text-[11px]`}>{l.by}</td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
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
          <p className="text-[11px] text-zinc-500 mb-3">FMS_ADMIN always has every permission. Changes take effect on the next request.</p>
          <Table head={<tr><th className={th}>Permission</th>{ROLES.filter((r) => r !== "FMS_ADMIN").map((r) => <th key={r} className={`${th} text-center`}>{r}</th>)}</tr>}>
            {Object.entries(s.catalog).map(([perm, label]) => (
              <tr key={perm} className={tr}>
                <td className={td}><div className="text-white">{label}</div><div className="text-[10px] font-mono text-zinc-600">{perm}</div></td>
                {ROLES.filter((r) => r !== "FMS_ADMIN").map((r) => (
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