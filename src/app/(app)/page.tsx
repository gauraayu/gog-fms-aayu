"use client";

import { useEffect, useState } from "react";
import { IndianRupee, CalendarClock, Users, AlertOctagon } from "lucide-react";
import { api, qs } from "@/lib/client";
import { formatINR } from "@/lib/money";
import { monthLabel } from "@/lib/dates";
import { Page, PageHeader, KpiCard, Select, Notice } from "@/components/ui";
import { TrendChart } from "@/components/TrendChart";

type Point = { month: string; label: string; amount: number };
interface Dash {
  fy: string;
  kpis: { salaryDisbursedFY: number; salaryDisbursedPrevMonth: number; prevMonth: string; activeEmployees: number; penaltiesDeductedFY: number; violationsAssessedFY: number };
  charts: { salary: Point[]; epf: Point[]; tds: Point[]; gst: Point[] };
  definitions: { challanPaidStatuses: string[] };
}
interface Meta { locations: { id: string; name: string }[]; currentFY: string; policyConfirmed: boolean }

function fyOptions(cur: string) {
  const y = Number(cur.slice(0, 4));
  return [0, 1, 2, 3].map((i) => `${y - i}-${String((y - i + 1) % 100).padStart(2, "0")}`);
}

export default function DashboardPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [fy, setFy] = useState("");
  const [location, setLocation] = useState("");
  const [data, setData] = useState<Dash | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Meta>("/api/meta").then((m) => { setMeta(m); setFy(m.currentFY); }).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    if (!fy) return;
    setLoading(true);
    api<Dash>(`/api/dashboard${qs({ fy, location })}`).then(setData).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, [fy, location]);

  const k = data?.kpis;
  const paidDef = `Counts challans marked ${data?.definitions.challanPaidStatuses.join(" / ") ?? "Paid / Verified"} only.`;

  return (
    <Page wide>
      <PageHeader
        title="Finance Overview"
        subtitle="All figures come from recorded transactions — calculated or unpaid amounts are excluded."
        actions={
          <>
            <Select value={fy} onChange={(e) => setFy(e.target.value)} className="w-32" aria-label="Financial year">
              {meta && fyOptions(meta.currentFY).map((f) => <option key={f} value={f}>FY {f}</option>)}
            </Select>
            <Select value={location} onChange={(e) => setLocation(e.target.value)} className="w-44" aria-label="Location">
              <option value="">All campuses</option>
              {meta?.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </>
        }
      />
      {err && <Notice kind="error" onClose={() => setErr("")}>{err}</Notice>}
      {meta && !meta.policyConfirmed && (
        <Notice kind="warn">Payroll policy is not confirmed yet. Payroll can be previewed but not approved until a Founder confirms it in Settings.</Notice>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <KpiCard loading={loading} icon={<IndianRupee size={16} />} label={`Salary Disbursed — FY ${data?.fy ?? fy}`} value={formatINR(k?.salaryDisbursedFY ?? 0, { decimals: false })} hint="Recorded disbursements only" />
        <KpiCard loading={loading} tone="sky" icon={<CalendarClock size={16} />} label="Salary Disbursed — M-1" value={formatINR(k?.salaryDisbursedPrevMonth ?? 0, { decimals: false })} hint={k ? monthLabel(k.prevMonth) : ""} />
        <KpiCard loading={loading} tone="purple" icon={<Users size={16} />} label="Total Employees" value={k?.activeEmployees ?? 0} hint="Active in OMS (payroll-eligible)" />
        <KpiCard loading={loading} tone="red" icon={<AlertOctagon size={16} />} label="Penalties Deducted — FY" value={formatINR(k?.penaltiesDeductedFY ?? 0, { decimals: false })} hint={`${k?.violationsAssessedFY ?? 0} violations assessed (approved for payroll)`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TrendChart title="Salary Disbursed — Last 6 Months" data={data?.charts.salary ?? []} loading={loading} note="By disbursement date (IST)." />
        <TrendChart title="Total EPF Paid — Last 6 Months" color="#38bdf8" data={data?.charts.epf ?? []} loading={loading} note={paidDef} />
        <TrendChart title="Total TDS Paid — Last 6 Months" color="#a78bfa" data={data?.charts.tds ?? []} loading={loading} note={paidDef} />
        <TrendChart title="Total GST Paid — Last 6 Months" color="#fbbf24" data={data?.charts.gst ?? []} loading={loading} note={paidDef} />
      </div>
    </Page>
  );
}
