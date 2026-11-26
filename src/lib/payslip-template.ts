/**
 * GOG salary slip — exact replica of "GoG_Salary_Slip.xlsx" (24/11/2026):
 *   sheet "GoG EPF Salary Slip"            → template "EPF"
 *   sheet "GoG without EPF Salary Slip"    → template "NO_EPF"
 *
 * Geometry is taken 1:1 from the workbook: column widths (Excel width × 7 px → pt), row heights (pt),
 * merged cells, Arial 12 / 14 pt, green section fill #B6D7A8, thin black borders, logo position
 * (new logo in A1:A4, fitted and centred), and the print setup
 * (A4 landscape, fit to one page, centred horizontally, margins L 0.37" · T 0.21" · B 0.25").
 *
 * ONE layout drives BOTH renderers, so the slip looks the same everywhere:
 *   - renderSlipPdf()  → PDF attachment / "View PDF"
 *   - renderSlipHtml() → email body and in-app preview
 */
import { jsPDF } from "jspdf";
import { LOGO_JPEG, SANS_BOLD, SANS_ITALIC, SANS_REGULAR } from "./payslip-assets";

/* ───────────────────────── data ───────────────────────── */

export type SlipTemplate = "EPF" | "NO_EPF";
/** Version of the slip design stored with every generated payslip. */
export const SLIP_DESIGN = 2;

export interface SlipData {
  design: number; // SLIP_DESIGN
  template: SlipTemplate;
  month: string; // YYYY-MM
  monthTitle: string; // OCTOBER 2026
  employee: {
    name: string; id: string; designation: string; department: string; location: string; joiningDate: string; // 10-Jan-2025
    pan: string; uan: string; pfAccountNo: string; esiNumber: string; pran: string; taxRegime: string;
  };
  days: { payable: number; paidLeave: number };
  /** EPF slip: full monthly amounts. Without-EPF slip: amounts after unpaid leave (there is no unpaid-leave line). */
  earnings: { basic: number; hra: number; other: number; additional: number; gross: number }; // paise
  /** ot = other deductions + TDS (the EPF design has no separate TDS line) */
  deductions: { epf: number; pt: number; ot: number; cs: number; unpaid: number; penalty: number; total: number }; // paise
  net: number; // paise
  netWords: string;
  generatedAt: string;
}

/**
 * Money printed on the slip, from the payroll calculation (paise). The printed numbers always add up:
 *   EPF slip:      Gross (full) − (EPF + PT + OT + CS + Unpaid + Penalty) = Net   (rounding goes into "Unpaid")
 *   Without EPF:   Basic + HRA + Other + Additional (after unpaid leave) − Penalty = Net (rounding goes into Basic)
 * "EPF" design when any EPF / PT / TDS / other deduction / college amount exists, else "Without EPF".
 */
export function slipMoney(c: {
  grossEarnings: number; netPay: number;
  fullMonthly: { basic: number; hra: number; otherAllowances: number };
  earnings: { otherEarnings: number };
  deductions: { epf: number; pt: number; tds: number; other: number; college?: number; lop?: number; penalties?: number };
}) {
  const d = c.deductions;
  const cs = d.college ?? 0;
  const ot = d.other + d.tds;
  const penalty = Math.max(0, d.penalties ?? 0);
  const template: SlipTemplate = d.epf + d.pt + ot + cs > 0 ? "EPF" : "NO_EPF";
  const f = c.fullMonthly;
  const additional = c.earnings.otherEarnings;
  if (template === "EPF") {
    let total = c.grossEarnings - c.netPay;
    let unpaid = total - (d.epf + d.pt + ot + cs + penalty);
    let add = additional, gross = c.grossEarnings;
    if (unpaid < 0) { add -= unpaid; gross -= unpaid; total -= unpaid; unpaid = 0; } // net rounded up → shown as an adjustment
    return {
      template,
      earnings: { basic: f.basic, hra: f.hra, other: f.otherAllowances, additional: add, gross },
      deductions: { epf: d.epf, pt: d.pt, ot, cs, unpaid, penalty, total },
      net: c.netPay,
    };
  }
  // Without EPF: no unpaid-leave line → show the earned (prorated) components.
  const gross = c.netPay + penalty;
  const fullComp = f.basic + f.hra + f.otherAllowances;
  const compTotal = gross - additional;
  const k = fullComp > 0 ? compTotal / fullComp : 0;
  const hra = Math.round(f.hra * k), other = Math.round(f.otherAllowances * k);
  const basic = compTotal - hra - other;
  return {
    template,
    earnings: { basic, hra, other, additional, gross },
    deductions: { epf: 0, pt: 0, ot: 0, cs: 0, unpaid: 0, penalty, total: penalty },
    net: c.netPay,
  };
}

/* ───────────────────────── company ───────────────────────── */

export const COMPANY = {
  name: "SKILLSCAN EDTECH INDIA PRIVATE LIMITED",
  address1: "04, 258/3D, 4th Main Road, Rajeev Gandhi Nagar,",
  address2: "HSR Layout, Bangaluru",
  cin: "CIN: U85499KA2023PTC171600",
  email: "E-Mail : hr@geeksofgurukul.com",
};

/* ───────────────────────── formatting ───────────────────────── */

/** ₹37,333.33 (Indian grouping) */
export function rupees(paise: number): string {
  const neg = paise < 0;
  const v = Math.abs(Math.round(paise)) / 100;
  const s = v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${neg ? "-" : ""}₹${s}`;
}
/** Slip cell format, as in the workbook ("₹ "#,##0.00): ₹ 37,333.33 */
export const slipRupees = (paise: number) => (paise < 0 ? `-₹ ${rupees(-paise).slice(1)}` : `₹ ${rupees(paise).slice(1)}`);

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
/** 2025-01-10 → 10-Jan-2025 (the workbook's dd-mmm-yyyy) */
export function dMonY(ymd?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? "");
  if (!m) return "";
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${m[3]}-${MON[Number(m[2]) - 1]}-${m[1]}`;
}
const days = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
/** HRA / Other Allowances / Additional Earnings: "N/A" when there is none (as in the workbook) */
const amtOrNA = (paise: number) => (paise ? slipRupees(paise) : "N/A");

/* ───────────────────────── layout (workbook geometry) ───────────────────────── */

type Align = "left" | "center" | "right";
type VAlign = "top" | "middle" | "bottom";
interface Cell {
  r: number; c: number; rs?: number; cs?: number; // 0-based row / column, row-span / col-span
  lines?: { text: string; size: number }[]; // several lines (header)
  text?: string;
  size?: number; bold?: boolean; italic?: boolean;
  align?: Align; valign?: VAlign; wrap?: boolean;
  bg?: string;
  border?: { t?: boolean; b?: boolean; l?: boolean; r?: boolean }; // default: all four
  logo?: boolean;
}
interface Layout { cols: number[]; rows: number[]; cells: Cell[] }

const GREEN = "#b6d7a8";
const PX = 0.75; // 1 px = 0.75 pt
/** A–F widths from the workbook (Excel width × 7 px) in points */
const COLS = [37.43, 13.0, 16.0, 36.14, 17.0, 16.0].map((w) => Math.round(w * 7) * PX);
/** Logo (GoG_Salary_Slip_1.xlsx, new Geeks of Gurukul logo, white margins trimmed):
 *  fitted inside the A1:A4 box (196.5 × 87 pt) with 6 pt side padding, centred vertically. */
const LOGO_RATIO = 900 / 282; // trimmed image width / height
const LOGO = (() => { const w = 184.5, h = Math.round((w / LOGO_RATIO) * 100) / 100; return { x: 6, y: Math.round(((87 - h) / 2) * 100) / 100, w, h }; })();

function buildLayout(d: SlipData): Layout {
  const e = d.employee;
  const epf = d.template === "EPF";
  const rows: number[] = [];
  const cells: Cell[] = [];
  const S = 12;
  let r = 0;
  const row = (h: number) => { rows.push(h); return r++; };

  // ── header: logo (A1:A4) + company block (B1:F4, no inner lines)
  const r1 = row(37.5), r2 = row(16.5), r3 = row(16.5), r4 = row(16.5);
  cells.push({ r: r1, c: 0, rs: 4, logo: true });
  cells.push({ r: r1, c: 1, cs: 5, lines: [{ text: COMPANY.name, size: 14 }, { text: COMPANY.address1, size: 14 }], bold: true, align: "center", valign: "bottom", border: { t: true, l: true, r: true } });
  cells.push({ r: r2, c: 1, cs: 5, text: COMPANY.address2, size: S, bold: true, align: "center", valign: "bottom", border: { l: true, r: true } });
  cells.push({ r: r3, c: 1, cs: 5, text: COMPANY.cin, size: S, bold: true, align: "center", valign: "bottom", border: { l: true, r: true } });
  cells.push({ r: r4, c: 1, cs: 5, text: COMPANY.email, size: S, bold: true, align: "center", valign: "bottom", border: { l: true, r: true, b: true } });

  // ── title
  cells.push({ r: row(30.0), c: 0, cs: 6, text: `SALARY SLIP FOR THE MONTH OF ${d.monthTitle}`, size: S, bold: true, align: "center" });

  const section = (text: string, h: number) => cells.push({ r: row(h), c: 0, cs: 6, text, size: S, bold: true, bg: GREEN });
  const info = (h: number, l1: string, v1: string, l2: string, v2: string, boldVal = true) => {
    const rr = row(h);
    cells.push({ r: rr, c: 0, text: l1, size: S });
    cells.push({ r: rr, c: 1, cs: 2, text: v1, size: S, bold: boldVal });
    cells.push({ r: rr, c: 3, text: l2, size: S });
    cells.push({ r: rr, c: 4, cs: 2, text: v2, size: S, bold: boldVal });
  };
  /** body table row: label | amount (B:C) | label | amount (E:F); null = empty merged D:F */
  const money = (h: number, l1: string, v1: string, l2: string | null, v2 = "", bold = false, bg?: string) => {
    const rr = row(h);
    cells.push({ r: rr, c: 0, text: l1, size: S, bold, bg, align: "center" });
    cells.push({ r: rr, c: 1, cs: 2, text: v1, size: S, bold, bg, align: "center" });
    if (l2 === null) cells.push({ r: rr, c: 3, cs: 3 });
    else {
      cells.push({ r: rr, c: 3, text: l2, size: S, bold, bg, align: "center" });
      cells.push({ r: rr, c: 4, cs: 2, text: v2, size: S, bold, bg, align: "center" });
    }
  };

  section("EMPLOYEE DETAILS", 21.75);
  info(21.0, "Employee Name", e.name, "Employee ID", e.id);
  info(21.0, "Designation", e.designation, "Function / Department", e.department);
  info(21.0, "Work Location", e.location, "Date of Joining", e.joiningDate);

  const E = d.earnings, D = d.deductions;
  if (epf) {
    section("STATUTORY / PAYROLL DETAILS", 21.75);
    info(21.0, "Universal Account Number (UAN)", e.uan, "PF Account No.", e.pfAccountNo);
    info(21.0, "Income Tax Number (PAN)", e.pan, "ESI Number", e.esiNumber);
    info(21.0, "PR Account Number (PRAN)", e.pran, "Tax Regime", e.taxRegime || "Regular");
    section("ATTENDANCE SUMMARY", 21.75);
    info(21.0, "Payable Days", days(d.days.payable), "Paid Leave Days", days(d.days.paidLeave), false);
    money(21.75, "DEDUCTIONS", "AMOUNT (₹)", "EARNINGS", "AMOUNT (₹)", true, GREEN);
    money(21.0, "Employee Provident Fund (EPF)", slipRupees(D.epf), "Basic Salary", slipRupees(E.basic));
    money(21.0, "Professional Tax (PT)", slipRupees(D.pt), "House Rent Allowance (HRA)", amtOrNA(E.hra));
    money(21.0, "Other Deduction (OT)", slipRupees(D.ot), "Other Allowances", amtOrNA(E.other));
    money(21.0, "Salary to be Paid by College (CS)", slipRupees(D.cs), "Additional Earnings / Adjustments", amtOrNA(E.additional));
    money(21.0, "Unpaid Leave / Salary Deduction", slipRupees(D.unpaid), null);
    money(21.0, "Penalty", slipRupees(D.penalty), null);
    money(24.0, "TOTAL DEDUCTIONS", slipRupees(D.total), "GROSS EARNINGS", slipRupees(E.gross), true, GREEN);
  } else {
    section("ATTENDANCE SUMMARY", 21.75);
    info(21.0, "Payable Days", days(d.days.payable), "Paid Leave Days", days(d.days.paidLeave), false);
    section("SALARY BREAKDOWN", 21.0);
    money(21.0, "Basic Salary", slipRupees(E.basic), "Other Allowances", amtOrNA(E.other));
    money(21.0, "House Rent Allowance (HRA)", amtOrNA(E.hra), "Additional Earnings / Adjustments", amtOrNA(E.additional));
    money(21.0, "Penalty", slipRupees(D.penalty), null);
    money(24.0, "TOTAL DEDUCTIONS", slipRupees(D.total), "GROSS EARNINGS", slipRupees(E.gross), true, GREEN);
  }

  // ── net, words, signatory, footer
  const rn = row(30.0);
  cells.push({ r: rn, c: 0, cs: 4, text: "NET SALARY PAYABLE  (Gross Earnings − Total Deductions)", size: S, bold: true });
  cells.push({ r: rn, c: 4, cs: 2, text: slipRupees(d.net), size: S, bold: true, align: epf ? "center" : "right" });
  const rw = row(24.0), rw2 = row(15.75);
  cells.push({ r: rw, c: 0, cs: 4, text: "Amount in Words", size: S });
  cells.push({ r: rw, c: 4, cs: 2, rs: 2, text: "Authorised Signatory", size: S, bold: true, align: "center", valign: "bottom" });
  cells.push({ r: rw2, c: 0, cs: 4, text: d.netWords, size: S, italic: true });
  cells.push({ r: row(27.75), c: 0, cs: 6, text: "This is a computer-generated salary slip based on approved payroll and statutory deduction records.", size: S, italic: true, align: "center", wrap: true });

  return { cols: COLS, rows, cells };
}
export const layoutFor = buildLayout;

/** Every grid cell must be covered exactly once (guards the layout above). */
export function checkLayout(L: Layout) {
  const seen = L.rows.map(() => L.cols.map(() => 0));
  for (const c of L.cells) for (let rr = c.r; rr < c.r + (c.rs ?? 1); rr++) for (let cc = c.c; cc < c.c + (c.cs ?? 1); cc++) seen[rr][cc]++;
  const bad = seen.flatMap((row, ri) => row.map((n, ci) => (n === 1 ? null : `${String.fromCharCode(65 + ci)}${ri + 1}×${n}`))).filter(Boolean);
  if (bad.length) throw new Error(`Slip layout grid error: ${bad.join(", ")}`);
}

interface Box { x: number; y: number; w: number; h: number; cell: Cell }
function place(L: Layout, x0: number, y0: number, k: number): Box[] {
  const colX = [x0]; for (const w of L.cols) colX.push(colX[colX.length - 1] + w * k);
  const rowY = [y0]; for (const h of L.rows) rowY.push(rowY[rowY.length - 1] + h * k);
  return L.cells.map((cell) => ({
    x: colX[cell.c], y: rowY[cell.r], w: colX[cell.c + (cell.cs ?? 1)] - colX[cell.c], h: rowY[cell.r + (cell.rs ?? 1)] - rowY[cell.r], cell,
  }));
}
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

/* ───────────────────────── PDF renderer ───────────────────────── */

const PAGE = { w: 841.89, h: 595.28, ml: 0.3747728649303453 * 72, mr: 0, mt: 0.20853603490646475 * 72, mb: 0.24984857662023022 * 72 };
const PAD = 2.25; // 3 px cell padding
const LINE_W = 0.5;
/** Arial-like vertical metrics (fraction of the font size) */
const ASC = 0.905, DESC = 0.212;

export function renderSlipPdf(d: SlipData): Buffer {
  const L = buildLayout(d);
  checkLayout(L);
  const W = sum(L.cols), H = sum(L.rows);
  // Excel "fit to 1 page": shrink only when needed, centred horizontally
  const k = Math.min(1, (PAGE.w - PAGE.ml - PAGE.mr) / W, (PAGE.h - PAGE.mt - PAGE.mb) / H);
  const x0 = PAGE.ml + (PAGE.w - PAGE.ml - PAGE.mr - W * k) / 2;
  const y0 = PAGE.mt;

  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape", compress: true });
  doc.addFileToVFS("ga-r.ttf", SANS_REGULAR); doc.addFont("ga-r.ttf", "GArial", "normal");
  doc.addFileToVFS("ga-b.ttf", SANS_BOLD); doc.addFont("ga-b.ttf", "GArial", "bold");
  doc.addFileToVFS("ga-i.ttf", SANS_ITALIC); doc.addFont("ga-i.ttf", "GArial", "italic");
  doc.setLineWidth(LINE_W * k);
  doc.setDrawColor(0, 0, 0);
  const font = (c: Cell) => doc.setFont("GArial", c.bold ? "bold" : c.italic ? "italic" : "normal");

  const boxes = place(L, x0, y0, k);
  // fills first, then text, then borders (so lines are never covered)
  for (const b of boxes) if (b.cell.bg) { doc.setFillColor(b.cell.bg); doc.rect(b.x, b.y, b.w, b.h, "F"); }
  for (const b of boxes) {
    const c = b.cell;
    if (c.logo) { doc.addImage(`data:image/jpeg;base64,${LOGO_JPEG}`, "JPEG", b.x + LOGO.x * k, b.y + LOGO.y * k, LOGO.w * k, LOGO.h * k); continue; }
    const lines = c.lines ?? (c.text ? [{ text: c.text, size: c.size ?? 12 }] : []);
    if (!lines.length) continue;
    font(c); doc.setTextColor(0, 0, 0);
    const maxW = b.w - 2 * PAD * k;
    // wrap (footer) or shrink-to-fit (long names) — never overflow the cell
    let laid: { text: string; size: number }[] = [];
    for (const ln of lines) {
      let size = ln.size * k;
      doc.setFontSize(size);
      if (c.wrap) {
        for (const t of doc.splitTextToSize(ln.text, maxW) as string[]) laid.push({ text: t, size });
        continue;
      }
      while (doc.getTextWidth(ln.text) > maxW && size > ln.size * k * 0.6) { size -= 0.2; doc.setFontSize(size); }
      laid.push({ text: ln.text, size });
    }
    if (c.wrap && laid.length * laid[0].size * 1.15 > b.h) laid = laid.slice(0, Math.max(1, Math.floor(b.h / (laid[0].size * 1.15))));
    const lineH = (s: number) => s * 1.15;
    const blockH = sum(laid.map((l) => lineH(l.size)));
    const va = c.valign ?? "middle";
    let y = va === "bottom" ? b.y + b.h - blockH - 1.2 * k : va === "top" ? b.y + 1.2 * k : b.y + (b.h - blockH) / 2;
    for (const l of laid) {
      doc.setFontSize(l.size);
      const base = y + (lineH(l.size) - (ASC + DESC) * l.size) / 2 + ASC * l.size;
      const x = c.align === "right" ? b.x + b.w - PAD * k : c.align === "center" ? b.x + b.w / 2 : b.x + PAD * k;
      doc.text(l.text, x, base, { align: c.align ?? "left", baseline: "alphabetic" });
      y += lineH(l.size);
    }
  }
  for (const b of boxes) {
    const br = b.cell.border ?? { t: true, b: true, l: true, r: true };
    if (br.t) doc.line(b.x, b.y, b.x + b.w, b.y);
    if (br.b) doc.line(b.x, b.y + b.h, b.x + b.w, b.y + b.h);
    if (br.l) doc.line(b.x, b.y, b.x, b.y + b.h);
    if (br.r) doc.line(b.x + b.w, b.y, b.x + b.w, b.y + b.h);
  }
  return Buffer.from(doc.output("arraybuffer"));
}

/* ───────────────────────── HTML renderer (email + preview) ───────────────────────── */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Email-safe HTML (tables + inline styles only) from the same layout, scaled to `targetWidth` px.
 * logoSrc: "cid:goglogo" for email, a data: URI for the in-app preview.
 */
export function renderSlipHtml(d: SlipData, logoSrc: string, targetWidth = 900): string {
  const L = buildLayout(d);
  checkLayout(L);
  const W = sum(L.cols);
  const k = targetWidth / W; // px per pt
  const px = (pt: number) => Math.round(pt * k * 10) / 10;
  const line = "1px solid #000000";
  const colgroup = `<colgroup>${L.cols.map((c) => `<col style="width:${px(c)}px" width="${Math.round(c * k)}">`).join("")}</colgroup>`;

  const byRow = L.rows.map((_, ri) => L.cells.filter((c) => c.r === ri).sort((a, b) => a.c - b.c));
  const tr = L.rows.map((h, ri) => {
    const tds = byRow[ri].map((c) => {
      const br = c.border ?? { t: true, b: true, l: true, r: true };
      const cellH = sum(L.rows.slice(c.r, c.r + (c.rs ?? 1)));
      const attrs = `${(c.cs ?? 1) > 1 ? ` colspan="${c.cs}"` : ""}${(c.rs ?? 1) > 1 ? ` rowspan="${c.rs}"` : ""}`;
      const style = [
        `border-top:${br.t ? line : "0"}`, `border-bottom:${br.b ? line : "0"}`, `border-left:${br.l ? line : "0"}`, `border-right:${br.r ? line : "0"}`,
        `background:${c.bg ?? "#ffffff"}`,
        "font-family:Arial,Helvetica,'Liberation Sans',sans-serif", "color:#000000",
        `font-size:${px(c.size ?? 12)}px`, `font-weight:${c.bold ? "bold" : "normal"}`, `font-style:${c.italic ? "italic" : "normal"}`,
        `text-align:${c.align ?? "left"}`, `vertical-align:${c.valign ?? "middle"}`,
        `padding:0 ${px(PAD)}px`, c.wrap ? "white-space:normal" : "white-space:nowrap", "overflow:hidden", "line-height:1.15",
      ].join(";");
      if (c.logo) {
        return `<td${attrs} style="${style};vertical-align:top;padding:${px(LOGO.y)}px 0 0 ${px(LOGO.x)}px;height:${px(cellH)}px"><img src="${logoSrc}" width="${Math.round(px(LOGO.w))}" height="${Math.round(px(LOGO.h))}" alt="Geeks of Gurukul" style="display:block;border:0;width:${px(LOGO.w)}px;height:${px(LOGO.h)}px;"></td>`;
      }
      const body = c.lines
        ? c.lines.map((l) => `<div style="font-size:${px(l.size)}px;line-height:1.15">${esc(l.text)}</div>`).join("")
        : c.text ? esc(c.text) : "&nbsp;";
      return `<td${attrs} style="${style}">${body}</td>`;
    }).join("");
    return `<tr style="height:${px(h)}px">${tds}</tr>`;
  }).join("\n");

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${Math.round(px(W))}" style="border-collapse:collapse;table-layout:fixed;width:${px(W)}px;max-width:${px(W)}px;background:#ffffff;margin:0 auto;mso-table-lspace:0;mso-table-rspace:0;">
${colgroup}
${tr}
</table>`;
}

/** Full email body: short note + the slip (logo via CID). */
export function payslipEmailBody(d: SlipData, logoSrc: string): string {
  const first = d.employee.name.split(" ")[0] || d.employee.name;
  return `<div style="background:#f4f5f7;padding:16px 0;">
<div style="max-width:920px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#18181b;line-height:1.5;padding:0 10px 12px;">
<p style="margin:0 0 8px;">Dear ${esc(first)},</p>
<p style="margin:0 0 4px;">Please find your salary slip for <b>${esc(d.monthTitle)}</b> below. A PDF copy is attached.</p>
</div>
${renderSlipHtml(d, logoSrc)}
<div style="max-width:920px;margin:12px auto 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#71717a;padding:0 10px;">
This email and its attachment are confidential and intended only for you. If you received it in error, please inform HR and delete it.<br>Regards, HR &amp; Finance — Geeks of Gurukul
</div></div>`;
}

export const LOGO_DATA_URI = `data:image/jpeg;base64,${LOGO_JPEG}`;
export const logoBuffer = () => Buffer.from(LOGO_JPEG, "base64");