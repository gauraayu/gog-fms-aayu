"use client";

import { useCallback, useEffect, useState } from "react";
import { Search, Eye } from "lucide-react";
import { api, qs } from "@/lib/client";
import { formatINR } from "@/lib/money";
import { Badge, Empty, Input, Notice, Page, PageHeader, Pagination, Select, Spinner, Table, td, th, tr } from "@/components/ui";
import { EmployeeDetail } from "@/components/EmployeeDetail";

interface Row {
  employeeId: string; name: string; dept: string; designation: string; location: string; status: string;
  payableDays: number; consideredDays: number; leavesApplied: number; leavesApproved: number; penaltyDays: number; penaltyAmount: number;
  lopDays: number; employedDays: number; provisional: boolean; hasStructure: boolean; monthlyGross: number | null; netSoFar: number | null; flags: string[];
}
interface Meta { departments: string[]; locations: { id: string; name: string }[]; currentMonth: string }

export default function EmployeesPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [month, setMonth] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  const [location, setLocation] = useState("");
  const [status, setStatus] = useState("active");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: Row[]; total: number; limit: number } | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { api<Meta>("/api/meta").then((m) => { setMeta(m); setMonth(m.currentMonth); }).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { const t = setTimeout(() => { setQ(search); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);

  const load = useCallback(() => {
    if (!month) return;
    setData(null);
    api<{ rows: Row[]; total: number; limit: number }>(`/api/employees${qs({ month, search: q, dept, location, status, page })}`).then(setData).catch((e) => setErr(e.message));
  }, [month, q, dept, location, status, page]);
  useEffect(load, [load]);

  const locName = (id: string) => meta?.locations.find((l) => l.id === id)?.name ?? id;

  return (
    <Page wide>
      <PageHeader title="Employee Management" subtitle="Live from OMS (read-only). Payable days, LOP and penalties are calculated exactly like OMS → Salary Management." />
      {err && <Notice kind="error" onClose={() => setErr("")}>{err}</Notice>}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-2">
        <div className="relative col-span-2">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or Employee ID" className="pl-8" />
        </div>
        <Input type="month" value={month} onChange={(e) => { setMonth(e.target.value); setPage(1); }} aria-label="Payroll month" />
        <Select value={dept} onChange={(e) => { setDept(e.target.value); setPage(1); }}>
          <option value="">All departments</option>
          {meta?.departments.map((d) => <option key={d}>{d}</option>)}
        </Select>
        <Select value={location} onChange={(e) => { setLocation(e.target.value); setPage(1); }}>
          <option value="">All locations</option>
          {meta?.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="active">Active</option>
          <option value="all">All statuses</option>
          <option value="Resigned">Resigned</option>
          <option value="Exited">Exited</option>
          <option value="Inactive">Inactive</option>
        </Select>
      </div>

      {!data ? <Spinner /> : data.rows.length === 0 ? <Empty text="No employees match these filters" /> : (
        <>
          <Table head={
            <tr>
              <th className={th}>Employee</th><th className={`${th} hidden lg:table-cell`}>Dept / Designation</th><th className={`${th} hidden xl:table-cell`}>Location</th>
              <th className={th}>Status</th><th className={th}>Payable Days</th><th className={`${th} hidden md:table-cell`}>Leaves (App/Appr)</th>
              <th className={th}>Penalties</th><th className={th}>LOP</th><th className={th}>Salary</th><th className={th}></th>
            </tr>
          }>
            {data.rows.map((r) => (
              <tr key={r.employeeId} className={tr}>
                <td className={td}><div className="font-semibold text-white truncate max-w-[180px]">{r.name}</div><div className="text-[10px] text-zinc-500">{r.employeeId}</div></td>
                <td className={`${td} hidden lg:table-cell`}><div className="truncate max-w-[160px]">{r.dept || "—"}</div><div className="text-[10px] text-zinc-500 truncate max-w-[160px]">{r.designation || "—"}</div></td>
                <td className={`${td} hidden xl:table-cell`}>{locName(r.location) || "—"}</td>
                <td className={td}><Badge>{r.status}</Badge></td>
                <td className={`${td} tabular-nums`}>{r.payableDays}<span className="text-zinc-600"> / {r.employedDays}</span>{r.provisional && <span className="ml-1 text-[10px] text-zinc-500">prov.</span>}{r.flags.some((f) => !["HR_ADJUSTED", "NO_SALARY_STRUCTURE", "MONTH_IN_PROGRESS"].includes(f)) && <span className="ml-1 text-amber-400" title={r.flags.join(", ")}>•</span>}</td>
                <td className={`${td} hidden md:table-cell tabular-nums`}>{r.leavesApplied} / {r.leavesApproved}</td>
                <td className={`${td} tabular-nums`}>{r.penaltyDays || r.penaltyAmount ? <>{r.penaltyDays ? `${r.penaltyDays}d` : ""}{r.penaltyAmount ? ` ${formatINR(r.penaltyAmount, { decimals: false })}` : ""}</> : <span className="text-zinc-600">—</span>}</td>
                <td className={`${td} tabular-nums`}>{r.lopDays || <span className="text-zinc-600">0</span>}</td>
                <td className={`${td} tabular-nums`}>{!r.hasStructure ? <Badge tone="amber">No structure</Badge> : r.monthlyGross !== null ? formatINR(r.monthlyGross, { decimals: false }) : "•••"}</td>
                <td className={td}><button onClick={() => setOpen(r.employeeId)} className="h-8 px-2.5 rounded-lg border border-zinc-800 text-zinc-300 hover:text-white inline-flex items-center gap-1"><Eye size={12} /> View</button></td>
              </tr>
            ))}
          </Table>
          <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />
        </>
      )}
      <EmployeeDetail employeeId={open} month={month} onClose={() => setOpen(null)} onChanged={load} />
    </Page>
  );
}