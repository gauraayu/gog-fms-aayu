"use client";

import { useEffect, useState } from "react";
import { FileSpreadsheet, FileDown, Play } from "lucide-react";
import { api, qs } from "@/lib/client";
import { formatINR } from "@/lib/money";
import { useAuth } from "@/components/AuthContext";
import { Button, Card, Empty, Field, Input, Notice, Page, PageHeader, Select, Spinner, Table, td, th, tr } from "@/components/ui";
import type { Permission } from "@/lib/permissions";

const TYPES: { value: string; label: string; needs: "month" | "fy"; perm: Permission }[] = [
  { value: "monthly-salary", label: "Monthly Salary Report (Payroll Sheet — same as Payroll Management)", needs: "month", perm: "salary.view" },
  { value: "yearly-salary", label: "Yearly Salary Report", needs: "fy", perm: "salary.view" },
  { value: "employee-payroll", label: "Employee Payroll Summary", needs: "fy", perm: "salary.view" },
  { value: "payable-days", label: "Payable Days, Leave & LOP", needs: "month", perm: "payroll.view" },
  { value: "penalties", label: "Penalty Report", needs: "month", perm: "payroll.view" },
  { value: "invoices", label: "Client Invoice Summary", needs: "fy", perm: "invoices.view" },
  { value: "challans", label: "EPF / GST / PT / TDS Payment Summary", needs: "fy", perm: "challans.view" },
];
interface Report { title: string; columns: { key: string; label: string; money?: boolean }[]; rows: Record<string, unknown>[] }

export default function ReportsPage() {
  const { can } = useAuth();
  const allowed = TYPES.filter((t) => can(t.perm));
  const [type, setType] = useState(allowed[0]?.value ?? "");
  const [month, setMonth] = useState("");
  const [fy, setFy] = useState("");
  const [dept, setDept] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [challanType, setChallanType] = useState("");
  const [depts, setDepts] = useState<string[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { api<{ currentMonth: string; currentFY: string; departments: string[] }>("/api/meta").then((m) => { setMonth(m.currentMonth); setFy(m.currentFY); setDepts(m.departments); }); }, []);
  const def = TYPES.find((t) => t.value === type);
  const params = { type, month: def?.needs === "month" ? month : undefined, fy: def?.needs === "fy" ? fy : undefined, dept, employeeId, challanType: type === "challans" ? challanType : undefined };

  async function run() {
    setLoading(true); setErr("");
    try { setReport(await api<Report>(`/api/reports${qs(params)}`)); } catch (e) { setErr((e as Error).message); setReport(null); } finally { setLoading(false); }
  }
  const download = (format: "xlsx" | "pdf") => { window.location.href = `/api/reports${qs({ ...params, format })}`; };

  return (
    <Page wide>
      <PageHeader title="Financial Reports" subtitle="Salary reports include Finalized / Disbursed payroll only. Exports follow the same permissions as the screens." />
      {err && <Notice kind="error" onClose={() => setErr("")}>{err}</Notice>}
      <Card>
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 items-end">
          <div className="col-span-2"><Field label="Report"><Select value={type} onChange={(e) => { setType(e.target.value); setReport(null); }}>{allowed.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></Field></div>
          {def?.needs === "month" ? <Field label="Month"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
            : <Field label="Financial year"><Input value={fy} onChange={(e) => setFy(e.target.value)} placeholder="2026-27" /></Field>}
          {!["invoices", "challans"].includes(type) && <Field label="Department"><Select value={dept} onChange={(e) => setDept(e.target.value)}><option value="">All</option>{depts.map((d) => <option key={d}>{d}</option>)}</Select></Field>}
          {!["invoices", "challans", "yearly-salary"].includes(type) && <Field label="Employee ID"><Input value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} placeholder="optional" /></Field>}
          {type === "challans" && <Field label="Type"><Select value={challanType} onChange={(e) => setChallanType(e.target.value)}><option value="">All</option>{["EPF", "GST", "PT", "TDS"].map((t) => <option key={t}>{t}</option>)}</Select></Field>}
          <Button onClick={run} loading={loading}><Play size={12} /> Run</Button>
        </div>
      </Card>

      {loading ? <Spinner /> : report && (
        <Card title={report.title} actions={<div className="flex gap-2"><Button variant="outline" onClick={() => download("xlsx")}><FileSpreadsheet size={12} /> Excel</Button><Button variant="outline" onClick={() => download("pdf")}><FileDown size={12} /> PDF</Button></div>}>
          {report.rows.length === 0 ? <Empty text="No data for these filters" /> : (
            <Table head={<tr>{report.columns.map((c) => <th key={c.key} className={`${th} ${c.money ? "text-right" : ""}`}>{c.label}</th>)}</tr>}>
              {report.rows.map((r, i) => (
                <tr key={i} className={tr}>{report.columns.map((c) => <td key={c.key} className={`${td} ${c.money ? "text-right tabular-nums" : ""}`}>{c.money ? formatINR(Number(r[c.key] ?? 0)) : String(r[c.key] ?? "")}</td>)}</tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </Page>
  );
}