import { test } from "node:test";
import assert from "node:assert/strict";
import { amountInWords, numberToWordsIN, rupees, slipMoney, renderSlipPdf, renderSlipHtml, type SlipData } from "../src/lib/payslip-template";
import { computeSalary } from "../src/lib/payroll-calc";
import { computePayableDays } from "../src/lib/payable-days";
import { DEFAULT_POLICY, mergePolicy } from "../src/lib/policy";
import { listMonthDates, weekdayOf } from "../src/lib/dates";

const P = mergePolicy({ ...DEFAULT_POLICY, confirmed: true });
const att = (absent: string[] = []) => computePayableDays({
  month: "2026-10", employee: { id: "E1" },
  attendance: listMonthDates("2026-10").filter((d) => weekdayOf(d) !== 0 && !absent.includes(d)).map((d) => ({ date: d, status: "Present", clockIn: "09:30" })),
  leaves: [], holidays: [], violations: [], removed: new Map(), corrections: new Map(), monetaryPenalties: [], fines: [], policy: P,
});

test("Indian amount in words", () => {
  assert.equal(numberToWordsIN(1234567), "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven");
  assert.equal(numberToWordsIN(120000000), "Twelve Crore");
  assert.equal(amountInWords(3733333), "Rupees Thirty Seven Thousand Three Hundred Thirty Three and Thirty Three Paise Only");
  assert.equal(amountInWords(1000000), "Rupees Ten Thousand Only");
  assert.equal(rupees(3733333), "₹37,333.33");
  assert.equal(rupees(123456789), "₹12,34,567.89");
});

test("no EPF / PT / TDS / college → 'Without EPF' slip; amounts add up to net", () => {
  const c = computeSalary({ structure: { employeeId: "E1", effectiveFrom: "2026-01", basic: 1000000, hra: 400000, otherAllowances: 100000 }, attendance: att(["2026-10-06", "2026-10-07"]), policy: P });
  const m = slipMoney(c);
  assert.equal(m.template, "NO_EPF");
  assert.equal(m.earnings.gross, 1500000);
  assert.equal(m.earnings.gross - m.deductions.unpaid, m.net);
});

test("EPF present → 'EPF' slip; EPF+PT+OT+CS+Unpaid = Total = Gross − Net", () => {
  const c = computeSalary({
    structure: { employeeId: "E1", effectiveFrom: "2026-01", basic: 1000000, hra: 400000, otherAllowances: 100000,
      epf: { mode: "PERCENT_OF_EARNED_BASIC", percent: 12 }, pt: { mode: "FIXED", amount: 20000 }, tds: { mode: "FIXED", amount: 5000 }, collegePaid: 300000 },
    attendance: att(["2026-10-06"]), policy: P,
  });
  assert.equal(c.deductions.college, 300000);
  const m = slipMoney(c);
  assert.equal(m.template, "EPF");
  const d = m.deductions;
  assert.equal(d.epf + d.pt + d.ot + d.cs + d.unpaid, d.total);
  assert.equal(m.earnings.gross - d.total, m.net);
  assert.equal(d.ot, 5000); // TDS shown under "Other Deduction (OT)"
});

const sample = (t: "EPF" | "NO_EPF"): SlipData => ({
  template: t, month: "2026-10", monthTitle: "OCTOBER 2026", monthYear: "10 / 2026",
  employee: { name: "Test Employee", id: "EMP1", designation: "Dev", department: "Tech", location: "Bhopal", joiningDate: "01/10/2026", bankName: "HDFC", bankAccount: "XXXX1234", pan: "ABCDE1234F", uan: "1", pfAccountNo: "2", esiNumber: "", pran: "", taxRegime: "Regular" },
  paymentDate: "", paymentMode: "Bank Transfer", days: { total: 31, payable: 30, paidLeave: 1, present: 29 },
  earnings: { basic: 100000, hra: 0, other: 0, additional: 0, gross: 100000 }, deductions: { epf: 0, pt: 0, ot: 0, cs: 0, unpaid: 3226, total: 3226 },
  net: 96774, netWords: amountInWords(96774), generatedAt: "",
});

test("slip renders as PDF and email HTML for both designs", () => {
  for (const t of ["EPF", "NO_EPF"] as const) {
    const pdf = renderSlipPdf(sample(t));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 20000);
    const html = renderSlipHtml(sample(t), "cid:goglogo");
    assert.match(html, /TEST EMPLOYEE SALARY SLIP \(OCTOBER 2026\)/);
    assert.match(html, /₹967\.74/);
    assert.ok(t === "EPF" ? html.includes("EPF &amp; OTHER DEDUCTIONS") : html.includes("Unpaid Leave / Salary Adjustment"));
  }
});