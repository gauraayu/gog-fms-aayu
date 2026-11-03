import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { connectDB } from "./db";
import { FmsChallan, FmsInvoice, FmsPayrollEntry, FmsPayrollRun } from "@/models/fms";
import { fyRange, monthLabel } from "./dates";
import type { Permission } from "./permissions";

export type Col = { key: string; label: string; money?: boolean };
export interface Report { title: string; columns: Col[]; rows: Record<string, unknown>[] }

export const REPORT_TYPES: Record<string, { label: string; perm: Permission }> = {
  "monthly-salary": { label: "Monthly Salary Report", perm: "salary.view" },
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
    case "payable-days":
    case "penalties": {
      if (!p.month) throw new Error("month required");
      const entries = await FmsPayrollEntry.find(entryFilter({ month: p.month })).select("-attendance.days").sort({ "employee.name": 1 }).lean();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (e: any) => e.calc ?? {};
      if (type === "monthly-salary") {
        return {
          title: `Monthly Salary Report — ${monthLabel(p.month)}`,
          columns: [
            { key: "employeeId", label: "Emp ID" }, { key: "name", label: "Name" }, { key: "dept", label: "Dept" },
            { key: "payable", label: "Payable Days" }, { key: "gross", label: "Gross", money: true }, { key: "lop", label: "LOP", money: true },
            { key: "epf", label: "EPF", money: true }, { key: "pt", label: "PT", money: true }, { key: "tds", label: "TDS", money: true },
            { key: "pen", label: "Penalties", money: true }, { key: "net", label: "Net Pay", money: true },
          ],
          rows: entries.map((e) => ({
            employeeId: e.employeeId, name: e.employee?.name, dept: e.employee?.dept, payable: c(e).payableDays,
            gross: c(e).grossEarnings, lop: c(e).deductions?.lop, epf: c(e).deductions?.epf, pt: c(e).deductions?.pt,
            tds: c(e).deductions?.tds, pen: c(e).deductions?.penalties, net: e.netPay,
          })),
        };
      }
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
      const agg = await FmsPayrollEntry.aggregate([
        { $match: entryFilter({ month: { $in: fyRange(p.fy).months }, status: { $in: ["Finalized", "Disbursed"] } }) },
        type === "yearly-salary"
          ? { $group: { _id: "$month", employees: { $sum: 1 }, gross: { $sum: "$calc.grossEarnings" }, deductions: { $sum: "$calc.totalDeductions" }, net: { $sum: "$netPay" } } }
          : { $group: { _id: "$employeeId", name: { $first: "$employee.name" }, dept: { $first: "$employee.dept" }, months: { $sum: 1 }, gross: { $sum: "$calc.grossEarnings" }, deductions: { $sum: "$calc.totalDeductions" }, net: { $sum: "$netPay" } } },
        { $sort: { _id: 1 } },
      ]);
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
  for (const row of r.rows) ws.addRow(r.columns.map((c) => (c.money ? rupees(row[c.key]) : (row[c.key] ?? ""))));
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(10, c.label.length + 4);
    if (c.money) col.numFmt = "₹#,##0.00";
  });
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