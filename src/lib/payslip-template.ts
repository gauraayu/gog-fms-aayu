/**
 * GOG salary slip — exact replica of the two approved designs
 * ("GoG_Salary_Slip_Without_EPF.pdf" and "GoG_Enhanced_EPF_Salary_Slip_.pdf").
 *
 * Geometry (column widths, row heights, colours, fonts, sizes) was measured from those PDFs
 * (A4, points). ONE layout definition drives BOTH renderers:
 *   - renderSlipPdf()  → the PDF attachment / "View PDF"
 *   - renderSlipHtml() → the email body and the in-app preview
 * so the slip looks the same everywhere.
 */
import { jsPDF } from "jspdf";
import { LOGO_JPEG, SANS_BOLD, SANS_REGULAR, SERIF_BOLD, SERIF_REGULAR } from "./payslip-assets";

/* ───────────────────────── data ───────────────────────── */

export type SlipTemplate = "EPF" | "NO_EPF";

export interface SlipData {
  template: SlipTemplate;
  month: string; // YYYY-MM
  monthTitle: string; // OCTOBER 2026
  monthYear: string; // 10 / 2026
  employee: {
    name: string; id: string; designation: string; department: string; location: string; joiningDate: string;
    bankName: string; bankAccount: string; pan: string; uan: string; pfAccountNo: string; esiNumber: string; pran: string; taxRegime: string;
  };
  paymentDate: string;
  paymentMode: string;
  days: { total: number; payable: number; paidLeave: number; present: number };
  earnings: { basic: number; hra: number; other: number; additional: number; gross: number }; // paise
  deductions: { epf: number; pt: number; ot: number; cs: number; unpaid: number; total: number }; // paise
  net: number; // paise
  netWords: string;
  generatedAt: string;
}

/**
 * Money shown on the slip, from the payroll calculation (paise).
 * "With EPF" design when any EPF / PT / TDS / other deduction / college amount exists, else "Without EPF".
 * Total deductions = gross − net, so the printed numbers always add up to the net (rounding included).
 */
export function slipMoney(c: {
  grossEarnings: number; netPay: number;
  fullMonthly: { basic: number; hra: number; otherAllowances: number };
  earnings: { otherEarnings: number };
  deductions: { epf: number; pt: number; tds: number; other: number; college?: number };
}) {
  const d = c.deductions;
  const cs = d.college ?? 0;
  const ot = d.other + d.tds;
  const template: SlipTemplate = d.epf + d.pt + ot + cs > 0 ? "EPF" : "NO_EPF";
  const total = c.grossEarnings - c.netPay;
  return {
    template,
    earnings: { basic: c.fullMonthly.basic, hra: c.fullMonthly.hra, other: c.fullMonthly.otherAllowances, additional: c.earnings.otherEarnings, gross: c.grossEarnings },
    deductions: { epf: d.epf, pt: d.pt, ot, cs, unpaid: template === "EPF" ? total - (d.epf + d.pt + ot + cs) : total, total },
    net: c.netPay,
  };
}

/* ───────────────────────── company ───────────────────────── */

export const COMPANY = {
  name: "SKILLSCAN EDTECH INDIA PRIVATE LIMITED",
  address: "04, 258/3D, 4th Main Road, Rajeev Gandhi Nagar, HSR Layout, Bengaluru",
  cinLine: "CIN: U85499KA2023PTC171600     |     hr@geeksofgurukul.com",
};

/* ───────────────────────── formatting ───────────────────────── */

export function rupees(paise: number): string {
  const neg = paise < 0;
  const v = Math.abs(Math.round(paise)) / 100;
  const s = v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${neg ? "-" : ""}₹${s}`;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function below1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) parts.push(r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ""}`);
  return parts.join(" ");
}
/** Indian numbering: Crore / Lakh / Thousand. */
export function numberToWordsIN(n: number): string {
  if (n === 0) return "Zero";
  const crore = Math.floor(n / 1e7), lakh = Math.floor((n % 1e7) / 1e5), thousand = Math.floor((n % 1e5) / 1e3), rest = n % 1e3;
  const p: string[] = [];
  if (crore) p.push(`${numberToWordsIN(crore)} Crore`);
  if (lakh) p.push(`${below1000(lakh)} Lakh`);
  if (thousand) p.push(`${below1000(thousand)} Thousand`);
  if (rest) p.push(below1000(rest));
  return p.join(" ");
}
export function amountInWords(paise: number): string {
  const p = Math.max(0, Math.round(paise));
  const r = Math.floor(p / 100), ps = p % 100;
  return `Rupees ${numberToWordsIN(r)}${ps ? ` and ${numberToWordsIN(ps)} Paise` : ""} Only`;
}

const days = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/* ───────────────────────── layout model ───────────────────────── */

type Font = "serif" | "sans";
interface Cell {
  span: number;
  rowspan?: number;
  text?: string;
  bg?: string;
  color?: string;
  font?: Font;
  bold?: boolean;
  size?: number;
  align?: "left" | "right" | "center";
  valign?: "bottom" | "middle";
}
interface Row { h: number; cells: Cell[] }
interface Header { h: number; logo: { x: number; y: number; w: number; h: number }; centerX: number; lines: { text: string; size: number; top: number }[] }
interface Layout { x0: number; y0: number; cols: number[]; header: Header; title: { h: number; size: number; text: string }; rows: Row[] }

const C = {
  teal: "#137b75", cream: "#fff5dc", label: "#eff3f7", mint: "#e9f5f3", dark: "#0c343d", green: "#38761d",
  ink: "#213547", ink2: "#273449", ink3: "#14243a", foot: "#596779", white: "#ffffff", black: "#000000",
};

const blankCells = (n: number, bg?: string): Cell[] => Array.from({ length: n }, () => ({ span: 1, bg }));

/* ── Design 1: WITHOUT EPF (measured from GoG_Salary_Slip_Without_EPF.pdf) ── */
function layoutNoEpf(d: SlipData): Layout {
  const S = 6.2; // body font size
  const lab = (text: string, span = 1, extra: Partial<Cell> = {}): Cell => ({ span, text, font: "serif", size: S, color: C.black, ...extra });
  const val = (text: string, span: number, extra: Partial<Cell> = {}): Cell => ({ span, text, font: "serif", size: S, color: C.black, bg: C.cream, ...extra });
  const amt = (paise: number, extra: Partial<Cell> = {}): Cell => ({ span: 3, text: rupees(paise), font: "serif", size: S, color: C.black, bg: C.cream, align: "right", ...extra });
  const section = (text: string): Row => ({ h: 14.2, cells: [{ span: 7, text, bg: C.teal, color: C.white, font: "serif", bold: true, size: S }] });
  const gap = (h = 14.2): Row => ({ h, cells: blankCells(7) });
  const e = d.employee;
  return {
    x0: 50.2, y0: 53.8,
    cols: [83.4, 79.6, 64.4, 22.7, 87.2, 79.6, 77.7],
    header: {
      h: 62.5, logo: { x: 50.4, y: 54.0, w: 131.2, h: 61.6 }, centerX: 345.3,
      lines: [{ text: COMPANY.name, size: 11.1, top: 68.9 }, { text: COMPANY.address, size: 8.6, top: 82.4 }, { text: COMPANY.cinLine, size: 8.6, top: 93.8 }],
    },
    title: { h: 28.4, size: 9.9, text: `${e.name.toUpperCase()} SALARY SLIP (${d.monthTitle})` },
    rows: [
      { h: 14.3, cells: [{ span: 3, text: "Salary Month / Year", bg: C.label, color: C.ink2, font: "serif", bold: true, size: S }, { span: 1 }, val(d.monthYear, 1, { font: "sans" }), val("", 1), val("", 1)] },
      gap(),
      section("EMPLOYEE DETAILS"),
      { h: 14.2, cells: [lab("Employee Name"), val(e.name, 2), { span: 1 }, lab("Employee ID"), val(e.id, 2)] },
      { h: 14.2, cells: [lab("Designation"), val(e.designation, 2), { span: 1 }, lab("Department / Function"), val(e.department, 2)] },
      { h: 14.2, cells: [lab("Work Location"), val(e.location, 2), { span: 1 }, lab("Date of Joining"), val(e.joiningDate, 2)] },
      { h: 14.2, cells: [lab("Bank Name"), val(e.bankName, 2), { span: 1 }, lab("Bank Account No."), val(e.bankAccount, 2)] },
      { h: 14.3, cells: [lab("Payment Date"), val(d.paymentDate, 2), { span: 1 }, lab("Payment Mode"), val(d.paymentMode, 2)] },
      gap(),
      section("ATTENDANCE SUMMARY"),
      { h: 14.2, cells: [lab("Total Days"), val(days(d.days.total), 1), lab("Payable Days"), val(days(d.days.payable), 1), lab("Paid Leave Days"), val(days(d.days.paidLeave), 1), { span: 1 }] },
      gap(),
      section("SALARY BREAKDOWN"),
      { h: 16.1, cells: [{ span: 3, text: "EARNINGS", bg: C.label, color: C.ink3, font: "serif", bold: true, size: S }, { span: 1 }, { span: 3, text: "AMOUNT (INR)", bg: C.label, color: C.ink3, font: "serif", bold: true, size: S }] },
      { h: 16.1, cells: [lab("Basic Salary", 3), { span: 1 }, amt(d.earnings.basic)] },
      { h: 16.2, cells: [lab("House Rent Allowance", 3), { span: 1 }, amt(d.earnings.hra)] },
      { h: 16.1, cells: [lab("Other Allowances", 3), { span: 1 }, amt(d.earnings.other)] },
      { h: 16.1, cells: [lab("Additional Earnings / Adjustments", 3), { span: 1 }, amt(d.earnings.additional)] },
      { h: 16.1, cells: [{ span: 3, text: "GROSS EARNINGS", bg: C.mint, color: C.ink3, font: "serif", bold: true, size: 6.8 }, { span: 1 }, amt(d.earnings.gross, { bg: C.mint })] },
      { h: 16.1, cells: blankCells(7) },
      { h: 16.1, cells: [lab("Unpaid Leave / Salary Adjustment", 3, { color: C.ink2 }), { span: 1 }, amt(d.deductions.unpaid)] },
      gap(),
      { h: 17.6, cells: [{ span: 3, rowspan: 2, text: "NET SALARY PAYABLE", bg: C.dark, color: C.white, font: "sans", bold: true, size: 8.0, valign: "middle" }, { span: 1 }, { span: 3, rowspan: 2, text: rupees(d.net), bg: C.dark, color: C.white, font: "serif", bold: true, size: 9.2, align: "right", valign: "middle" }] },
      { h: 17.5, cells: [{ span: 1 }] },
      gap(),
      { h: 14.2, cells: [{ span: 7 }] },
      { h: 14.2, cells: [...blankCells(4), { span: 3, text: `For ${COMPANY.name}`, font: "serif", bold: true, size: 5.5, color: C.ink2 }] },
      { h: 14.2, cells: [...blankCells(4), { span: 3, text: "Authorised Signatory", font: "serif", bold: true, size: S, color: C.ink2 }] },
      { h: 14.3, cells: [{ span: 7, text: "This is a computer-generated salary statement based on company payroll records.", font: "serif", size: 5.5, color: C.foot }] },
    ],
  };
}

/* ── Design 2: WITH EPF (measured from GoG_Enhanced_EPF_Salary_Slip_.pdf) ── */
function layoutEpf(d: SlipData): Layout {
  const S = 5.7;
  const lab = (text: string, span: number, extra: Partial<Cell> = {}): Cell => ({ span, text, font: "serif", size: S, color: C.ink, ...extra });
  const val = (text: string, span: number, extra: Partial<Cell> = {}): Cell => ({ span, text, font: "serif", size: S, color: C.black, bg: C.cream, ...extra });
  const amt = (paise: number, extra: Partial<Cell> = {}): Cell => ({ span: 3, text: rupees(paise), font: "serif", size: S, color: C.ink, bg: C.cream, align: "right", ...extra });
  const section = (text: string, h = 15.0): Row => ({ h, cells: [{ span: 7, text, bg: C.teal, color: C.white, font: "serif", bold: true, size: S }] });
  const blank = (h = 12.8, bg?: string): Row => ({ h, cells: [{ span: 7, bg }] });
  const lineRow = (label: string, paise: number): Row => ({ h: 14.1, cells: [lab(label, 4, { bg: C.label }), amt(paise)] });
  const statRow = (l1: string, v1: string, l2: string, v2: string, l1Font: Font, v2Extra: Partial<Cell> = {}): Row => ({
    h: 14.1,
    cells: [lab(l1, 2, { bg: C.label, bold: true, font: l1Font }), val(v1, 2), lab(l2, 2, { bg: C.label, bold: true }), val(v2, 1, v2Extra)],
  });
  const e = d.employee;
  return {
    x0: 50.2, y0: 53.8,
    cols: [88.2, 56.5, 56.4, 67.1, 91.7, 53.0, 49.4],
    header: {
      h: 62.6, logo: { x: 50.4, y: 54.0, w: 122.2, h: 57.3 }, centerX: 326.3,
      lines: [{ text: COMPANY.name, size: 10.3, top: 70.1 }, { text: COMPANY.address, size: 8.0, top: 82.7 }, { text: COMPANY.cinLine, size: 8.0, top: 93.2 }],
    },
    title: { h: 25.6, size: 7.5, text: `${e.name.toUpperCase()} SALARY SLIP (${d.monthTitle})` },
    rows: [
      { h: 12.8, cells: [{ span: 3, text: "Salary Month / Year", bg: C.label, color: C.ink2, font: "serif", bold: true, size: S }, { span: 1 }, val(d.monthYear, 1), val("", 1), val("", 1)] },
      blank(),
      section("EMPLOYEE DETAILS", 12.8),
      { h: 12.8, cells: [lab("Employee Name", 1), val(e.name, 2), val("", 1), lab("Employee ID", 1), val(e.id, 2)] },
      { h: 12.8, cells: [lab("Designation", 1), val(e.designation, 2), val("", 1), lab("Function / Department", 1), val(e.department, 2)] },
      { h: 12.7, cells: [lab("Work Location", 1), val(e.location, 2), val("", 1), lab("Date of Joining", 1), val(e.joiningDate, 2)] },
      { h: 12.8, cells: [lab("Bank Name / Details", 1), val(e.bankName, 2), val("", 1), lab("Bank Account No.", 1), val(e.bankAccount, 2)] },
      { h: 12.8, cells: [lab("Payment Date", 1), val(d.paymentDate, 2), val("", 1), lab("Payment Mode", 1), val(d.paymentMode, 2)] },
      blank(),
      section("STATUTORY / PAYROLL DETAILS"),
      statRow("Universal Account Number (UAN )", e.uan, "PF Account No.", e.pfAccountNo, "sans"),
      statRow("Income Tax Number (PAN)", e.pan, "ESI Number", e.esiNumber, "sans"),
      statRow("PR Account Number (PRAN)", e.pran, "Tax Regime", e.taxRegime, "sans", { color: C.teal }),
      blank(12.8, C.label),
      section("ATTENDANCE SUMMARY"),
      statRow("Total Days", days(d.days.total), "Present Days", days(d.days.present), "serif"),
      statRow("Paid Leave Days", days(d.days.paidLeave), "Payable Days", days(d.days.payable), "serif"),
      blank(),
      section("EARNINGS"),
      { h: 14.1, cells: [{ span: 4, text: "SALARY COMPONENT", bg: C.dark, color: C.white, font: "serif", bold: true, size: S }, { span: 3, text: "AMOUNT (INR)", bg: C.dark, color: C.white, font: "serif", bold: true, size: S }] },
      lineRow("Basic Salary", d.earnings.basic),
      lineRow("House Rent Allowance", d.earnings.hra),
      lineRow("Other Allowances", d.earnings.other),
      lineRow("Additional Earnings / Adjustments", d.earnings.additional),
      { h: 14.1, cells: [lab("GROSS EARNINGS", 4, { bg: C.mint, bold: true, color: C.teal }), amt(d.earnings.gross, { bg: C.mint, bold: true, color: C.teal })] },
      blank(),
      section("EPF & OTHER DEDUCTIONS"),
      { h: 14.1, cells: [{ span: 4, text: "DEDUCTION COMPONENT", bg: C.dark, color: C.white, font: "serif", bold: true, size: S }, { span: 3, text: "AMOUNT (INR)", bg: C.dark, color: C.white, font: "serif", bold: true, size: S }] },
      lineRow("Employee Provident Fund (EPF)", d.deductions.epf),
      lineRow("Professional Tax (PT)", d.deductions.pt),
      lineRow("Other Deduction (OT)", d.deductions.ot),
      lineRow("Salary to be Paid by College (CS)", d.deductions.cs),
      lineRow("Unpaid Leave / Salary Deduction", d.deductions.unpaid),
      { h: 14.1, cells: [lab("TOTAL DEDUCTIONS (TD)", 4, { bg: C.mint, bold: true, color: C.teal }), amt(d.deductions.total, { bg: C.mint, bold: true, color: C.teal })] },
      blank(),
      { h: 37.0, cells: [{ span: 4, text: "NET SALARY PAYABLE (NA)", bg: C.dark, color: C.white, font: "serif", bold: true, size: S, valign: "middle" }, { span: 3, text: rupees(d.net), bg: C.dark, color: C.white, font: "serif", bold: true, size: 9.7, align: "right", valign: "middle" }] },
      blank(),
      { h: 14.1, cells: [{ span: 7, text: "Amount in Words (INR):", bg: C.label, color: C.ink, font: "serif", bold: true, size: S }] },
      { h: 28.3, cells: [{ span: 7, text: d.netWords, bg: C.cream, color: C.ink, font: "serif", size: S, valign: "middle" }] },
      blank(12.7),
      { h: 14.2, cells: [...blankCells(4), { span: 3, text: `For ${COMPANY.name}`, font: "serif", bold: true, size: S, color: C.teal }] },
      { h: 14.1, cells: [...blankCells(4), { span: 3, text: "Authorised Signatory", font: "serif", size: S, color: C.ink }] },
      blank(),
      { h: 19.8, cells: [{ span: 7, text: "This computer-generated salary slip is based on approved payroll and statutory deduction records.", font: "serif", size: 5.2, color: C.ink }] },
    ],
  };
}

export const layoutFor = (d: SlipData): Layout => (d.template === "EPF" ? layoutEpf(d) : layoutNoEpf(d));

/** Place cells on the grid (handles colspan + rowspan) → absolute boxes in points. */
interface Box { x: number; y: number; w: number; h: number; cell: Cell; row: number }
function placeCells(L: Layout): { boxes: Box[]; tableTop: number; bottom: number } {
  const colX: number[] = [L.x0];
  for (const w of L.cols) colX.push(colX[colX.length - 1] + w);
  const tableTop = L.y0 + L.header.h + L.title.h;
  const rowY: number[] = [tableTop];
  for (const r of L.rows) rowY.push(rowY[rowY.length - 1] + r.h);
  const occupied: boolean[][] = L.rows.map(() => Array(L.cols.length).fill(false));
  const boxes: Box[] = [];
  L.rows.forEach((row, ri) => {
    let c = 0;
    for (const cell of row.cells) {
      while (c < L.cols.length && occupied[ri][c]) c++;
      const rs = cell.rowspan ?? 1;
      for (let rr = ri; rr < ri + rs && rr < L.rows.length; rr++) for (let cc = c; cc < c + cell.span; cc++) occupied[rr][cc] = true;
      boxes.push({ x: colX[c], y: rowY[ri], w: colX[c + cell.span] - colX[c], h: rowY[ri + rs] - rowY[ri], cell, row: ri });
      c += cell.span;
    }
  });
  return { boxes, tableTop, bottom: rowY[rowY.length - 1] };
}

/* ───────────────────────── PDF renderer ───────────────────────── */

const PAD = 1.6;
const LINE_W = 0.45;

export function renderSlipPdf(d: SlipData): Buffer {
  const L = layoutFor(d);
  const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
  doc.addFileToVFS("gs-r.ttf", SERIF_REGULAR); doc.addFont("gs-r.ttf", "GSerif", "normal");
  doc.addFileToVFS("gs-b.ttf", SERIF_BOLD); doc.addFont("gs-b.ttf", "GSerif", "bold");
  doc.addFileToVFS("ga-r.ttf", SANS_REGULAR); doc.addFont("ga-r.ttf", "GSans", "normal");
  doc.addFileToVFS("ga-b.ttf", SANS_BOLD); doc.addFont("ga-b.ttf", "GSans", "bold");
  doc.setLineWidth(LINE_W);
  doc.setDrawColor(0, 0, 0);
  const W = L.cols.reduce((a, b) => a + b, 0);
  const setFont = (f: Font = "serif", bold = false) => doc.setFont(f === "sans" ? "GSans" : "GSerif", bold ? "bold" : "normal");

  // header (logo + company lines)
  doc.rect(L.x0, L.y0, W, L.header.h, "S");
  const lg = L.header.logo;
  doc.addImage(`data:image/jpeg;base64,${LOGO_JPEG}`, "JPEG", lg.x, lg.y, lg.w, lg.h);
  doc.setTextColor(C.green);
  for (const ln of L.header.lines) {
    setFont("sans", true); doc.setFontSize(ln.size);
    doc.text(ln.text, L.header.centerX, ln.top, { align: "center", baseline: "top" });
  }
  // title
  const ty = L.y0 + L.header.h;
  doc.setFillColor(C.mint); doc.rect(L.x0, ty, W, L.title.h, "FD");
  setFont("sans", true); doc.setFontSize(L.title.size); doc.setTextColor(C.black);
  fitText(doc, L.title.text, L.title.size, W - 2 * PAD);
  doc.text(L.title.text, L.x0 + W / 2, ty + L.title.h / 2, { align: "center", baseline: "middle" });

  const { boxes } = placeCells(L);
  for (const b of boxes) {
    const cell = b.cell;
    if (cell.bg && cell.bg !== C.white) {
      doc.setFillColor(cell.bg);
      doc.rect(b.x, b.y, b.w, b.h, "FD");
    } else doc.rect(b.x, b.y, b.w, b.h, "S");
    if (!cell.text) continue;
    const size = cell.size ?? 6;
    setFont(cell.font, cell.bold); doc.setTextColor(cell.color ?? C.black);
    const fs = fitText(doc, cell.text, size, b.w - 2 * PAD);
    const text = clip(doc, cell.text, b.w - 2 * PAD);
    const x = cell.align === "right" ? b.x + b.w - PAD : cell.align === "center" ? b.x + b.w / 2 : b.x + PAD;
    const y = cell.valign === "middle" ? b.y + b.h / 2 + fs * 0.33 : b.y + b.h - fs * 0.68;
    doc.text(text, x, y, { align: cell.align ?? "left", baseline: "alphabetic" });
  }
  return Buffer.from(doc.output("arraybuffer"));
}

/** Shrink (down to 70 %) so long names / designations still fit the cell. */
function fitText(doc: jsPDF, text: string, size: number, maxW: number): number {
  let s = size;
  doc.setFontSize(s);
  while (doc.getTextWidth(text) > maxW && s > size * 0.7) { s -= 0.2; doc.setFontSize(s); }
  return s;
}
function clip(doc: jsPDF, text: string, maxW: number): string {
  if (doc.getTextWidth(text) <= maxW) return text;
  let t = text;
  while (t.length > 1 && doc.getTextWidth(`${t}…`) > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/* ───────────────────────── HTML renderer (email + preview) ───────────────────────── */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const FONT_CSS: Record<Font, string> = { serif: "'Times New Roman',Times,serif", sans: "Arial,Helvetica,sans-serif" };

/**
 * Email-safe HTML (tables + inline styles only) drawn from the same layout, scaled so the slip is ~760 px wide.
 * logoSrc: "cid:goglogo" for email, a data: URI for the in-app preview.
 */
export function renderSlipHtml(d: SlipData, logoSrc: string, targetWidth = 760): string {
  const L = layoutFor(d);
  const W = L.cols.reduce((a, b) => a + b, 0);
  const k = targetWidth / W;
  const px = (pt: number) => Math.round(pt * k * 10) / 10;
  const border = "1px solid #000000";
  const colgroup = `<colgroup>${L.cols.map((c) => `<col style="width:${px(c)}px" width="${Math.round(c * k)}">`).join("")}</colgroup>`;

  // header: logo left, 3 centred company lines (same centre as the PDF)
  const lg = L.header.logo;
  const logoW = px(lg.w), logoH = px(lg.h);
  const textCellW = px(W) - logoW;
  const centerRel = px(L.header.centerX - L.x0);
  const padRight = Math.max(0, Math.round(logoW + textCellW - 2 * centerRel));
  const lines = L.header.lines
    .map((ln, i) => `<div style="font-family:${FONT_CSS.sans};font-weight:bold;font-size:${px(ln.size)}px;line-height:${px(ln.size * 1.15)}px;color:${C.green};white-space:pre;${i ? `margin-top:${px(2.2)}px;` : ""}">${esc(ln.text)}</div>`)
    .join("");
  const header = `<tr style="height:${px(L.header.h)}px"><td colspan="${L.cols.length}" style="border:${border};padding:0;background:#ffffff;vertical-align:top;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;"><tr>
<td style="width:${logoW}px;padding:0;vertical-align:top;"><img src="${logoSrc}" width="${Math.round(logoW)}" height="${Math.round(logoH)}" alt="Geeks of Gurukul" style="display:block;border:0;width:${logoW}px;height:${logoH}px;"></td>
<td style="padding:${px(L.header.lines[0].top - L.y0 - 1)}px ${padRight}px 0 0;text-align:center;vertical-align:top;">${lines}</td>
</tr></table></td></tr>`;

  const title = `<tr style="height:${px(L.title.h)}px"><td colspan="${L.cols.length}" style="border:${border};background:${C.mint};text-align:center;vertical-align:middle;font-family:${FONT_CSS.sans};font-weight:bold;font-size:${px(L.title.size)}px;color:#000000;padding:0 ${px(PAD)}px;white-space:nowrap;overflow:hidden;">${esc(L.title.text)}</td></tr>`;

  const rows = L.rows
    .map((r) => {
      const tds = r.cells
        .map((c) => {
          const size = c.size ?? 6;
          const style = [
            `border:${border}`,
            `background:${c.bg ?? "#ffffff"}`,
            `font-family:${FONT_CSS[c.font ?? "serif"]}`,
            `font-size:${px(size)}px`,
            `font-weight:${c.bold ? "bold" : "normal"}`,
            `color:${c.color ?? "#000000"}`,
            `text-align:${c.align ?? "left"}`,
            `vertical-align:${c.valign ?? "bottom"}`,
            `padding:0 ${px(PAD)}px ${c.valign === "middle" ? 0 : px(size * 0.38)}px ${px(PAD)}px`,
            "white-space:nowrap",
            "overflow:hidden",
            "line-height:1.1",
          ].join(";");
          return `<td${c.span > 1 ? ` colspan="${c.span}"` : ""}${c.rowspan && c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ""} style="${style}">${c.text ? esc(c.text) : "&nbsp;"}</td>`;
        })
        .join("");
      return `<tr style="height:${px(r.h)}px">${tds}</tr>`;
    })
    .join("\n");

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${Math.round(px(W))}" style="border-collapse:collapse;table-layout:fixed;width:${px(W)}px;max-width:${px(W)}px;background:#ffffff;margin:0 auto;mso-table-lspace:0;mso-table-rspace:0;">
${colgroup}
${header}
${title}
${rows}
</table>`;
}

/** Full email body: short note + the slip (logo via CID). */
export function payslipEmailBody(d: SlipData, logoSrc: string): string {
  const first = d.employee.name.split(" ")[0] || d.employee.name;
  return `<div style="background:#f4f5f7;padding:16px 0;">
<div style="max-width:780px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#18181b;line-height:1.5;padding:0 10px 12px;">
<p style="margin:0 0 8px;">Dear ${esc(first)},</p>
<p style="margin:0 0 4px;">Please find your salary slip for <b>${esc(d.monthTitle)}</b> below. A PDF copy is attached.</p>
</div>
${renderSlipHtml(d, logoSrc)}
<div style="max-width:780px;margin:12px auto 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#71717a;padding:0 10px;">
This email and its attachment are confidential and intended only for you. If you received it in error, please inform HR and delete it.<br>Regards, HR &amp; Finance — Geeks of Gurukul
</div></div>`;
}

export const LOGO_DATA_URI = `data:image/jpeg;base64,${LOGO_JPEG}`;
export const logoBuffer = () => Buffer.from(LOGO_JPEG, "base64");