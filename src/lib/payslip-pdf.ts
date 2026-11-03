import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { monthLabel } from "./dates";
import type { SalaryCalc } from "./payroll-calc";

/** Server-side payslip PDF (jsPDF runs in Node). Amounts in paise. */
export interface PayslipData {
  employee: { id: string; name: string; dept?: string; designation?: string; location?: string; email?: string };
  month: string;
  calc: SalaryCalc;
  generatedAt: Date;
}

const inr = (p: number) =>
  "Rs. " + (p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function renderPayslipPdf(d: PayslipData): Buffer {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const c = d.calc;

  doc.setFillColor(10, 10, 10);
  doc.rect(0, 0, W, 78, "F");
  doc.setTextColor(16, 185, 129);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Geeks of Gurukul", 40, 38);
  doc.setTextColor(228, 228, 231);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`Payslip — ${monthLabel(d.month)}`, 40, 58);
  doc.text("CONFIDENTIAL", W - 40, 58, { align: "right" });

  doc.setTextColor(24, 24, 27);
  autoTable(doc, {
    startY: 100,
    theme: "plain",
    styles: { fontSize: 9.5, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 110 }, 2: { fontStyle: "bold", cellWidth: 110 } },
    body: [
      ["Employee Name", d.employee.name, "Employee ID", d.employee.id],
      ["Department", d.employee.dept || "—", "Designation", d.employee.designation || "—"],
      ["Payroll Month", monthLabel(d.month), "Location", d.employee.location || "—"],
      ["Payable Days", `${c.payableDays} / ${c.calendarDays}`, "LOP Days", String(c.lopDays)],
    ],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const y = (doc as any).lastAutoTable.finalY + 16;
  const earnings: [string, number][] = [
    ["Basic Salary", c.fullMonthly.basic],
    ["HRA", c.fullMonthly.hra],
    ["Allowances", c.fullMonthly.otherAllowances],
    ["Other Earnings", c.earnings.otherEarnings],
  ];
  const deductions: [string, number][] = [
    ["EPF", c.deductions.epf],
    ["Professional Tax", c.deductions.pt],
    ["TDS", c.deductions.tds],
    ["Penalties", c.deductions.penalties],
    ["Loss of Pay", c.deductions.lop],
    ["Other Deductions", c.deductions.other],
  ];
  const rows = Math.max(earnings.length, deductions.length);
  const body = Array.from({ length: rows }, (_, i) => [
    earnings[i]?.[0] ?? "", earnings[i] ? inr(earnings[i][1]) : "",
    deductions[i]?.[0] ?? "", deductions[i] ? inr(deductions[i][1]) : "",
  ]);
  body.push(["Gross Earnings", inr(c.grossEarnings), "Total Deductions", inr(c.totalDeductions)]);

  autoTable(doc, {
    startY: y,
    head: [["Earnings", "Amount", "Deductions", "Amount"]],
    body,
    theme: "grid",
    styles: { fontSize: 9.5, cellPadding: 5 },
    headStyles: { fillColor: [16, 185, 129], textColor: [2, 44, 34] },
    columnStyles: { 1: { halign: "right" }, 3: { halign: "right" } },
    didParseCell: (h) => {
      if (h.section === "body" && h.row.index === body.length - 1) h.cell.styles.fontStyle = "bold";
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const y2 = (doc as any).lastAutoTable.finalY + 18;
  doc.setFillColor(236, 253, 245);
  doc.roundedRect(40, y2, W - 80, 40, 6, 6, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Net Payable Salary", 54, y2 + 25);
  doc.text(inr(c.netPay), W - 54, y2 + 25, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(113, 113, 122);
  doc.text(
    `Computed with ${c.divisorMode === "FIXED" ? `fixed divisor ${c.divisor}` : "calendar-day divisor"}. System-generated payslip; no signature required.`,
    40, y2 + 64,
  );
  doc.text(`Generated ${d.generatedAt.toISOString().slice(0, 10)} · GOG FMS`, 40, y2 + 76);

  return Buffer.from(doc.output("arraybuffer"));
}
