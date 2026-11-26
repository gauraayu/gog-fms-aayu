import { stripDays } from "./field-crypto";
import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { connectDB } from "./db";
import { FmsChallan, FmsInvoice, FmsPayrollEntry, FmsPayrollRun, FmsSalaryStructure } from "@/models/fms";
import { OmsEmployee, OmsExit } from "@/models/oms-readonly";
import { fyRange, monthLabel } from "./dates";
import type { Permission } from "./permissions";

export type Col = { key: string; label: string; money?: boolean; num?: boolean };
export interface Report { title: string; columns: Col[]; rows: Record<string, unknown>[] }

export const REPORT_TYPES: Record<string, { label: string; perm: Permission }> = {
  // Same 17-column sheet as Payroll Management → Download Excel
  "monthly-salary": { label: "Monthly Salary Report (Payroll Sheet)", perm: "salary.view" },
  "payroll-sheet": { label: "Payroll Sheet (all salary columns)", perm: "salary.view" },
  "yearly-salary": { label: "Yearly Salary Report", perm: "salary.view" },
  "employee-payroll": { label: "Employee Payroll Summary", perm: "salary.view" },
  "payable-days": { label: "Payable Days, Leave & LOP Report", perm: "payroll.view" },
  "penalties": { label: "Penalty Report", perm: "payroll.view" },
  "invoices": { label: "Client Invoice Summary", perm: "invoices.view" },
  "challans": { label: "Statutory Payment Summary (EPF/GST/PT/TDS)", perm: "challans.view" },
};

export async function buildReport(type: string, p: { month?: string; fy?: string; dept?: string; employeeId?: string; challanType?: string }): Promise<Report> {
  await connectDB();
  const entryFilter = (extra: Record<string, unknown>) => ({
    excluded: { $ne: true },
    ...(p.dept ? { "employee.dept": p.dept } : {}),
    ...(p.employeeId ? { employeeId: p.employeeId } : {}),
    ...extra,
  });

  switch (type) {
    case "monthly-salary":
    case "payroll-sheet": {
      if (!p.month) throw new Error("month required");
      // full entries (with the per-day trace, for the WFH count) — amounts are decrypted by FMS
      const entries = await FmsPayrollEntry.find(entryFilter({ month: p.month })).sort({ "employee.name": 1 }).lean();
      const ids = entries.map((e) => e.employeeId);
      const [emps, exits, structures] = await Promise.all([
        OmsEmployee.find({ id: { $in: ids } }).select("id joiningDate noticePeriod").lean(),
        OmsExit.find({ employeeId: { $in: ids } }).select("employeeId lastWorkingDay").lean(),
        FmsSalaryStructure.find({ _id: { $in: entries.map((e) => e.structureId).filter(Boolean) } }).select("config epf").lean(),
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const empBy = new Map(emps.map((e: any) => [String(e.id), e]));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const exitBy = new Map(exits.map((x: any) => [String(x.employeeId), String(x.lastWorkingDay ?? "")]));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stBy = new Map(structures.map((s: any) => [String(s._id), s]));
      const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const dmy = (v?: unknown) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "")); return m ? `${m[3]}-${MON[Number(m[2]) - 1]}-${m[1]}` : ""; };
      return {
        title: `Payroll Sheet — ${monthLabel(p.month)}`,
        columns: [
          { key: "name", label: "Name" }, { key: "position", label: "Position" }, { key: "joining", label: "Joining Date" },
          { key: "exit", label: "Last Date (If exited)" }, { key: "epfApplicable", label: "EPF Applicable?" },
          { key: "wfh", label: "WFH in Month", num: true }, { key: "leaves", label: "Leaves in Month", num: true },
          { key: "penalty", label: "Total Penalty in Month", money: true }, { key: "lop", label: "Days of LOP", num: true },
          { key: "payable", label: "Total Payable Days", num: true }, { key: "salary", label: "Gross Salary", money: true },
          { key: "grossAfter", label: "Gross Salary after Leave Calculation", money: true }, { key: "toPay", label: "Salary to be Paid", money: true },
          { key: "college", label: "Salary to be paid by College", money: true }, { key: "tds", label: "TDS", money: true },
          { key: "epf", label: "EPF", money: true }, { key: "pt", label: "PT", money: true },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rows: entries.map((e: any) => {
          const c = e.calc ?? {}, a = e.attendance ?? {}, d = c.deductions ?? {};
          const emp = empBy.get(e.employeeId);
          const exit = emp?.noticePeriod?.lastWorkingDay || exitBy.get(e.employeeId) || "";
          const st = e.structureId ? stBy.get(String(e.structureId)) : null;
          const epfOn = st?.config?.epfApplicable ?? (st ? st.epf?.mode && st.epf.mode !== "NONE" : (d.epf ?? 0) > 0);
          const days: { attendance?: string; kind?: string }[] = Array.isArray(a.days) ? a.days : [];
          return {
            name: e.employee?.name ?? e.employeeId,
            position: e.employee?.designation ?? "",
            joining: dmy(emp?.joiningDate),
            exit: dmy(exit),
            epfApplicable: !st ? "" : epfOn ? "Yes" : "No", // blank = no salary structure yet
            wfh: days.filter((x) => /^wfh$/i.test(String(x.attendance ?? ""))).length,
            leaves: Math.round(((a.paidLeaveDays ?? 0) + (a.unpaidLeaveDays ?? 0)) * 100) / 100,
            penalty: d.penalties ?? 0,
            lop: c.lopDays ?? a.lopDays ?? 0,
            payable: c.payableDays ?? a.payableDays ?? 0,
            salary: c.fullMonthly?.gross ?? 0,
            grossAfter: c.earnedGross ?? 0,
            toPay: e.netPay ?? 0,
            college: d.college ?? 0,
            tds: d.tds ?? 0,
            epf: d.epf ?? 0,
            pt: d.pt ?? 0,
          };
        }),
      };
    }
    case "payable-days":
    case "penalties": {
      if (!p.month) throw new Error("month required");
      const entries = (await FmsPayrollEntry.find(entryFilter({ month: p.month })).sort({ "employee.name": 1 }).lean()).map(stripDays);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (e: any) => e.calc ?? {};
      if (type === "payable-days") {
        return {
          title: `Payable Days, Leave & LOP — ${monthLabel(p.month)}`,
          columns: [
            { key: "employeeId", label: "Emp ID" }, { key: "name", label: "Name" }, { key: "present", label: "Present" },
            { key: "paidLeave", label: "Paid Leave" }, { key: "unpaidLeave", label: "Unpaid Leave" }, { key: "absent", label: "Absent" },
            { key: "lop", label: "LOP Days" }, { key: "payable", label: "Payable Days" }, { key: "flags", label: "Flags" },
          ],
          rows: entries.map((e) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const a: any = e.attendance ?? {};
            return {
              employeeId: e.employeeId, name: e.employee?.name, present: a.presentDays, paidLeave: a.paidLeaveDays,
              unpaidLeave: a.unpaidLeaveDays, absent: a.absentDays, lop: c(e).lopDays ?? a.lopDays,
              payable: c(e).payableDays ?? a.payableDays, flags: (e.flags ?? []).join(", "),
            };
          }),
        };
      }
      return {
        title: `Penalty Report — ${monthLabel(p.month)}`,
        columns: [
          { key: "employeeId", label: "Emp ID" }, { key: "name", label: "Name" }, { key: "violations", label: "Approved Violations" },
          { key: "days", label: "Penalty Days" }, { key: "amount", label: "Penalty Deducted", money: true },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rows: entries.filter((e) => (c(e).deductions?.penalties ?? 0) > 0 || (e.attendance as any)?.violationCount > 0).map((e) => ({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          employeeId: e.employeeId, name: e.employee?.name, violations: (e.attendance as any)?.violationCount,
          days: c(e).penaltyDays, amount: c(e).deductions?.penalties ?? 0,
        })),
      };
    }
    case "yearly-salary":
    case "employee-payroll": {
      if (!p.fy) throw new Error("fy required");
      // Only employees whose payroll is Finalized / Disbursed (per-employee status).
      // Amounts are encrypted in MongoDB → load the rows and add them up here.
      const list = await FmsPayrollEntry.find(entryFilter({ month: { $in: fyRange(p.fy).months }, status: { $in: ["Finalized", "Disbursed"] } }))
        .select("month employeeId employee calc netPay").sort({ month: 1 }).lean();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (e: any) => (e.calc ?? {}) as { grossEarnings?: number; totalDeductions?: number };
      type Agg = { _id: string; name?: string; dept?: string; employees: number; months: number; gross: number; deductions: number; net: number };
      const groups = new Map<string, Agg>();
      for (const e of list) {
        const k = type === "yearly-salary" ? e.month : e.employeeId;
        const g = groups.get(k) ?? { _id: k, name: e.employee?.name ?? undefined, dept: e.employee?.dept ?? undefined, employees: 0, months: 0, gross: 0, deductions: 0, net: 0 };
        g.employees++; g.months++;
        g.gross += c(e).grossEarnings ?? 0;
        g.deductions += c(e).totalDeductions ?? 0;
        g.net += typeof e.netPay === "number" ? e.netPay : 0;
        groups.set(k, g);
      }
      const agg = [...groups.values()].sort((a, b) => a._id.localeCompare(b._id));
      return type === "yearly-salary"
        ? {
            title: `Yearly Salary Report — FY ${p.fy} (Finalized/Disbursed payroll)`,
            columns: [{ key: "month", label: "Month" }, { key: "employees", label: "Employees" }, { key: "gross", label: "Gross", money: true }, { key: "deductions", label: "Deductions", money: true }, { key: "net", label: "Net", money: true }],
            rows: agg.map((a) => ({ month: monthLabel(a._id), employees: a.employees, gross: a.gross, deductions: a.deductions, net: a.net })),
          }
        : {
            title: `Employee Payroll Summary — FY ${p.fy}`,
            columns: [{ key: "employeeId", label: "Emp ID" }, { key: "name", label: "Name" }, { key: "dept", label: "Dept" }, { key: "months", label: "Months Paid" }, { key: "gross", label: "Gross", money: true }, { key: "deductions", label: "Deductions", money: true }, { key: "net", label: "Net", money: true }],
            rows: agg.map((a) => ({ employeeId: a._id, name: a.name, dept: a.dept, months: a.months, gross: a.gross, deductions: a.deductions, net: a.net })),
          };
    }
    case "invoices": {
      const f: Record<string, unknown> = {};
      if (p.fy) {
        const y = Number(p.fy.slice(0, 4));
        f.$or = [{ billingYear: y, billingMonth: { $gte: 4 } }, { billingYear: y + 1, billingMonth: { $lte: 3 } }];
      }
      const rows = await FmsInvoice.find(f).sort({ billingYear: 1, billingMonth: 1, clientName: 1 }).lean();
      return {
        title: `Client Invoice Summary${p.fy ? ` — FY ${p.fy}` : ""}`,
        columns: [
          { key: "period", label: "Billing" }, { key: "invoiceNumber", label: "Invoice #" }, { key: "client", label: "Client" },
          { key: "location", label: "Location" }, { key: "total", label: "Total", money: true }, { key: "received", label: "Received", money: true }, { key: "status", label: "Status" },
        ],
        rows: rows.map((r) => ({
          period: `${r.billingYear}-${String(r.billingMonth).padStart(2, "0")}`, invoiceNumber: r.invoiceNumber, client: r.clientName,
          location: r.clientLocation, total: r.totalAmount, received: r.amountReceived, status: r.status,
        })),
      };
    }
    case "challans": {
      const f: Record<string, unknown> = {};
      if (p.fy) f.financialYear = p.fy;
      if (p.challanType) f.type = p.challanType;
      const rows = await FmsChallan.find(f).sort({ year: 1, month: 1, type: 1 }).lean();
      return {
        title: `${p.challanType ?? "EPF/GST/PT/TDS"} Payment Summary${p.fy ? ` — FY ${p.fy}` : ""}`,
        columns: [
          { key: "period", label: "Period" }, { key: "type", label: "Type" }, { key: "ref", label: "Reference" },
          { key: "amount", label: "Amount", money: true }, { key: "paymentDate", label: "Paid On" }, { key: "status", label: "Status" },
        ],
        rows: rows.map((r) => ({
          period: `${r.year}-${String(r.month).padStart(2, "0")}`, type: r.type, ref: r.referenceNumber, amount: r.amount,
          paymentDate: r.paymentDate, status: r.paymentStatus,
        })),
      };
    }
    default:
      throw new Error("Unknown report type");
  }
}

const rupees = (v: unknown) => (typeof v === "number" ? v / 100 : null);

export async function reportToXlsx(r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GOG FMS";
  const ws = wb.addWorksheet("Report");
  ws.addRow([r.title]).font = { bold: true, size: 13 };
  ws.addRow([]);
  const head = ws.addRow(r.columns.map((c) => c.label));
  head.font = { bold: true };
  head.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  head.height = 32;
  head.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB6D7A8" } };
    cell.border = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
  });
  const first = ws.rowCount + 1;
  for (const row of r.rows) ws.addRow(r.columns.map((c) => (c.money ? rupees(row[c.key]) : (row[c.key] ?? ""))));
  const last = ws.rowCount;
  // totals row for money / number columns
  if (r.rows.length > 1 && r.columns.some((c) => c.money)) {
    const tot = ws.addRow(r.columns.map((c, i) => {
      if (i === 0) return "TOTAL";
      if (!c.money && !c.num) return "";
      const L = ws.getColumn(i + 1).letter;
      return { formula: `SUM(${L}${first}:${L}${last})` };
    }));
    tot.font = { bold: true };
    tot.eachCell((cell) => { cell.border = { top: { style: "thin" } }; });
  }
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    const longest = Math.max(...r.rows.slice(0, 200).map((row) => String(row[c.key] ?? "").length), 0);
    col.width = Math.min(40, Math.max(12, c.money ? 14 : 0, Math.min(c.label.length, 22) + 2, longest + 2));
    if (c.money) col.numFmt = "₹#,##0.00";
  });
  ws.views = [{ state: "frozen", ySplit: 3, xSplit: 1 }];
  if (r.rows.length) ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: last, column: r.columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function reportToPdf(r: Report): Buffer {
  const doc = new jsPDF({ orientation: r.columns.length > 7 ? "landscape" : "portrait", unit: "pt", format: "a4" });
  doc.setFontSize(13);
  doc.text(r.title, 36, 40);
  doc.setFontSize(8);
  doc.text(`Geeks of Gurukul · GOG FMS · generated ${new Date().toISOString().slice(0, 10)} · amounts in INR`, 36, 54);
  autoTable(doc, {
    startY: 66,
    head: [r.columns.map((c) => c.label)],
    body: r.rows.map((row) =>
      r.columns.map((c) => (c.money ? (rupees(row[c.key]) ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 }) : String(row[c.key] ?? ""))),
    ),
    styles: { fontSize: 7.5, cellPadding: 3 },
    headStyles: { fillColor: [16, 185, 129], textColor: [2, 44, 34] },
  });
  return Buffer.from(doc.output("arraybuffer"));
}