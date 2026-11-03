import { test } from "node:test";
import assert from "node:assert/strict";
import { computePayableDays, type PdAttendance, type OmsCorrection } from "../src/lib/payable-days";
import { computeSalary } from "../src/lib/payroll-calc";
import { DEFAULT_POLICY, mergePolicy, type PayrollPolicy } from "../src/lib/policy";
import { listMonthDates, weekdayOf, financialYearOf, fyRange } from "../src/lib/dates";
import { correctionDirection, holidaysFor, isOnSalaryList } from "../src/lib/oms-read";

const P = (o: Partial<PayrollPolicy> = {}) => mergePolicy({ ...DEFAULT_POLICY, confirmed: true, ...o });
const present = (month: string, except: string[] = []): PdAttendance[] =>
  listMonthDates(month)
    .filter((d) => weekdayOf(d) !== 0 && !except.includes(d))
    .map((d) => ({ _id: `A-${d}`, date: d, status: "Present", clockIn: "09:25:00", clockOut: "18:35:00" }));

const calc = (month: string, over: Partial<Parameters<typeof computePayableDays>[0]> = {}) =>
  computePayableDays({
    month,
    asOf: undefined, // past month → final (OMS)
    employee: { id: "EMP-0001", location: "college-a" },
    attendance: present(month),
    leaves: [], holidays: [], violations: [],
    removed: new Map(), corrections: new Map(), monetaryPenalties: [], fines: [],
    policy: P(),
    ...over,
  });
const day = (r: ReturnType<typeof calc>, date: string) => r.days.find((d) => d.date === date)!;
const struct = (basicRs: number, extra: Record<string, unknown> = {}) => ({ employeeId: "EMP-0001", effectiveFrom: "2026-01", basic: basicRs * 100, ...extra });

/* ───────── payable days = OMS calculatePayableDays ───────── */

test("full attendance, Sundays paid weekly off → 31/31 payable", () => {
  const r = calc("2026-10");
  assert.equal(r.payableDays, 31);
  assert.equal(r.lopDays, 0);
  assert.equal(r.weeklyOffs, 4);
  assert.equal(day(r, "2026-10-04").payableStatus, "Payable"); // Sunday
});

test("OMS: working day with NO attendance = Non-Payable (loss of pay)", () => {
  const r = calc("2026-10", { attendance: present("2026-10", ["2026-10-07"]) });
  assert.equal(r.lopDays, 1);
  assert.equal(day(r, "2026-10-07").payableStatus, "Non-Payable");
  assert.equal(day(r, "2026-10-07").source, "No attendance on a working day (loss of pay)");
});

test("OMS example (b): HR-marked Absent → Non-Payable 'Absent (loss of pay)'", () => {
  const r = calc("2026-10", { attendance: [...present("2026-10", ["2026-10-07"]), { date: "2026-10-07", status: "Absent" }] });
  assert.equal(day(r, "2026-10-07").source, "Absent (loss of pay)");
  assert.equal(r.payableDays, 30);
});

test("OMS: missing clock-out / Late / WFH are payable", () => {
  const att = present("2026-10", ["2026-10-05", "2026-10-06", "2026-10-08"]);
  att.push({ date: "2026-10-05", status: "Present", clockIn: "09:30" }, { date: "2026-10-06", status: "Late", clockIn: "10:10" }, { date: "2026-10-08", workMode: "WFH", clockIn: "09:30" });
  const r = calc("2026-10", { attendance: att });
  assert.equal(r.lopDays, 0);
  assert.equal(day(r, "2026-10-08").attendance, "WFH");
});

test("OMS: 1 paid leave per month, further approved leave is LOP (even if type says Paid)", () => {
  const r = calc("2026-10", {
    attendance: present("2026-10", ["2026-10-07", "2026-10-08"]),
    leaves: [{ startDate: "2026-10-07", endDate: "2026-10-08", days: 2, status: "Approved", type: "Casual Leave" }],
  });
  assert.equal(r.paidLeaveDays, 1);
  assert.equal(r.unpaidLeaveDays, 1);
  assert.equal(r.payableDays, 30);
});

test("OMS: half-day leave + present for the other half = payable 1", () => {
  const r = calc("2026-10", { leaves: [{ startDate: "2026-10-07", endDate: "2026-10-07", days: 0.5, status: "Approved", type: "Casual Leave" }] });
  assert.equal(r.payableDays, 31);
  assert.equal(r.paidLeaveDays, 0.5);
});

test("OMS: short leave ignored; pending leave without attendance = LOP + flagged", () => {
  const r = calc("2026-10", {
    attendance: present("2026-10", ["2026-10-14"]),
    leaves: [
      { startDate: "2026-10-14", endDate: "2026-10-14", days: 1, status: "Pending HOI Approval", type: "Sick Leave" },
      { startDate: "2026-10-15", endDate: "2026-10-15", days: 0.25, status: "Approved", type: "Short Leave" },
    ],
  });
  assert.equal(r.lopDays, 1);
  assert.equal(r.pendingLeaveDays, 1);
  assert.ok(r.flags.includes("PENDING_LEAVE"));
  assert.equal(day(r, "2026-10-15").payable, 1);
});

test("OMS holiday filter: forAll, empty collegeIds, or employee's college", () => {
  const hol = [
    { date: "2026-10-02", forAll: true },
    { date: "2026-10-20", forAll: false, collegeIds: ["college-b"] },
    { date: "2026-10-21", forAll: false, collegeIds: [] },
  ];
  assert.deepEqual(holidaysFor(hol, "college-a"), ["2026-10-02", "2026-10-21"]);
  const r = calc("2026-10", { attendance: present("2026-10", ["2026-10-02", "2026-10-21"]), holidays: holidaysFor(hol, "college-a") });
  assert.equal(r.holidays, 2);
  assert.equal(r.payableDays, 31);
});

test("OMS example (d): LATE_IN Half-Day 'Approved for Payroll' → day Partly Payable 0.5", () => {
  const r = calc("2026-10", {
    violations: [
      { id: "VIO-0004", date: "2026-10-20", type: "LATE_IN", instance: 4, level: "HALF_DAY", proposedDeduction: "Half-Day", hrStatus: "Approved for Payroll" },
      { id: "VIO-0005", date: "2026-10-22", type: "LATE_IN", instance: 5, level: "FULL_DAY", proposedDeduction: "Full-Day", hrStatus: "Waived" },
      { id: "VIO-0006", date: "2026-10-23", type: "LATE_IN", instance: 6, level: "FULL_DAY", proposedDeduction: "Full-Day", hrStatus: "Pending HR Verification" },
    ],
  });
  assert.equal(day(r, "2026-10-20").payableStatus, "Partly Payable");
  assert.equal(day(r, "2026-10-20").payable, 0.5);
  assert.equal(day(r, "2026-10-22").payable, 1);
  assert.equal(day(r, "2026-10-23").payable, 1);
  assert.equal(r.violationDays, 0.5);
  assert.equal(r.payableDays, 30.5);
  assert.equal(r.pendingPenalties, 1);
});

test("OMS: removed flag → no deduction; penalty on Sunday never applied", () => {
  const r = calc("2026-10", {
    violations: [
      { id: "V1", date: "2026-10-20", type: "EARLY_OUT", proposedDeduction: "Full-Day", hrStatus: "Approved for Payroll" },
      { id: "V2", date: "2026-10-04", type: "LATE_IN", proposedDeduction: "Full-Day", hrStatus: "Approved for Payroll" },
    ],
    removed: new Map([["VIO:V1", { removedByName: "HR" }]]),
  });
  assert.equal(r.payableDays, 31);
});

test("OMS: dress code ladder — 4th rejected photo Half-Day, 5th Full-Day, automatic", () => {
  const att = present("2026-10");
  const rej = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
  for (const a of att) if (rej.includes(a.date)) a.dressCodeStatus = "Rejected";
  const r = calc("2026-10", { attendance: att });
  assert.equal(day(r, "2026-10-08").payable, 0.5);
  assert.equal(day(r, "2026-10-09").payable, 0);
  assert.equal(r.violationDays, 1.5);
});

test("OMS example (c): HR payable correction TO_PAYABLE / TO_NON_PAYABLE (also on Sunday)", () => {
  const corr = new Map<string, OmsCorrection>([
    ["2026-10-07", { id: "PC-1", direction: "TO_PAYABLE", correctionCategory: "Clock-In / Clock-Out Technical Issue", correctedByName: "HR User", correctedByRole: "HR" }],
    ["2026-10-08", { id: "PC-2", direction: "TO_NON_PAYABLE", correctionCategory: "Unauthorised absence" }],
    ["2026-10-11", { id: "PC-3", direction: "TO_NON_PAYABLE" }],
  ]);
  const r = calc("2026-10", { attendance: present("2026-10", ["2026-10-07"]), corrections: corr });
  assert.equal(day(r, "2026-10-07").payableStatus, "Payable");
  assert.match(day(r, "2026-10-07").source, /^Marked payable by HR User \(HR\)/);
  assert.equal(day(r, "2026-10-07").flag, "HR_CORRECTED_IN_OMS");
  assert.equal(day(r, "2026-10-08").payableStatus, "Non-Payable");
  assert.equal(day(r, "2026-10-11").payable, 0);
  assert.equal(r.correctedDays, 1);
  assert.equal(r.hrDeductedDays, 2);
  assert.equal(r.payableDays, 29);
  assert.ok(r.flags.includes("HR_CORRECTED_IN_OMS"));
});

test("OMS correctionDirection also reads older records", () => {
  assert.equal(correctionDirection({ updatedPayableStatus: "Non-Payable" }), "TO_NON_PAYABLE");
  assert.equal(correctionDirection({ adjustment: -1 }), "TO_NON_PAYABLE");
  assert.equal(correctionDirection({ adjustment: 1 }), "TO_PAYABLE");
});

test("OMS: current month → future days Upcoming, projected payable (provisional)", () => {
  const r = calc("2026-10", { asOf: "2026-10-15", attendance: present("2026-10").filter((a) => a.date <= "2026-10-15") });
  assert.equal(r.futureDays, 16);
  assert.equal(r.payableDays, 31);
  assert.ok(r.provisional);
  assert.equal(day(r, "2026-10-20").payableStatus, "Upcoming");
});

test("OMS: before joining / after exit = Not Employed", () => {
  const r = calc("2026-10", { employee: { id: "EMP-0001", joiningDate: "2026-10-16", exitDate: "2026-10-25" } });
  assert.equal(r.employedDays, 10);
  assert.equal(r.payableDays, 10);
});

test("OMS salary list: no founders, joined by month end, exit not before month", () => {
  assert.equal(isOnSalaryList({ role: "FOUNDER", status: "Active" }, "2026-10"), false);
  assert.equal(isOnSalaryList({ role: "HR", status: "Active", joiningDate: "2026-11-02" }, "2026-10"), false);
  assert.equal(isOnSalaryList({ role: "TL", status: "Resigned", noticeLastWorkingDay: "2026-10-20" }, "2026-10"), true);
  assert.equal(isOnSalaryList({ role: "TL", status: "Resigned", noticeLastWorkingDay: "2026-09-20" }, "2026-10"), false);
  assert.equal(isOnSalaryList({ role: "TL", status: "Active" }, "2026-10"), true);
});

/* ───────── salary (FMS) on top of OMS days ───────── */

test("spec example: ₹40,000 × 28 / 30 = ₹37,333.33 (fixed divisor 30, 2 days no attendance)", () => {
  const att = calc("2026-09", { attendance: present("2026-09", ["2026-09-07", "2026-09-08"]) });
  assert.equal(att.payableDays, 28);
  const c = computeSalary({ structure: struct(40000), attendance: att, policy: P({ divisorMode: "FIXED", fixedDivisor: 30, rounding: "PAISE" }) });
  assert.equal(c.netPay, 3733333);
  assert.equal(c.deductions.lop, 266667);
});

test("penalty days are deducted ONCE (already inside OMS LOP), shown as Penalties line", () => {
  const att = calc("2026-10", { violations: [{ id: "V", date: "2026-10-20", type: "LATE_IN", proposedDeduction: "Half-Day", hrStatus: "Approved for Payroll" }] });
  const c = computeSalary({ structure: struct(31000), attendance: att, policy: P({ rounding: "PAISE" }) });
  assert.equal(c.netPay, 3050000); // 31,000 − 0.5 day (1,000/day)
  assert.equal(c.deductions.penalties, 50000);
  assert.equal(c.deductions.lop, 0);
  assert.equal(c.totalDeductions, 50000);
});

test("₹ location-mismatch penalty (OMS monetaryPenalties) is deducted in rupees", () => {
  const att = calc("2026-10", { monetaryPenalties: [{ id: "LOC-0001", date: "2026-10-23", amount: 200, source: "Location Mismatch" }] });
  assert.equal(att.finesPaise, 20000);
  assert.equal(att.payableDays, 31);
  const c = computeSalary({ structure: struct(31000), attendance: att, policy: P() });
  assert.equal(c.netPay, 3080000);
});

test("employees.fines ignored by default (OMS does not use them); optional", () => {
  const fines = [{ amount: 500, date: "2026-10-15", reason: "Excessive MAP" }];
  assert.equal(calc("2026-10", { fines }).finesPaise, 0);
  assert.equal(calc("2026-10", { fines, policy: P({ includeOmsFines: true }) }).finesPaise, 50000);
});

test("FMS HR adjustment: payable days override; penalty-days edit moves days, no double count", () => {
  const att = calc("2026-10", { violations: [{ id: "V", date: "2026-10-20", type: "LATE_IN", proposedDeduction: "Full-Day", hrStatus: "Approved for Payroll" }] });
  assert.equal(att.payableDays, 30);
  const waived = computeSalary({ structure: struct(31000), attendance: att, adjustments: { penaltyDays: 0 }, policy: P() });
  assert.equal(waived.payableDays, 31);
  assert.equal(waived.netPay, 3100000);
  const over = computeSalary({ structure: struct(31000), attendance: att, adjustments: { payableDays: 29 }, policy: P() });
  assert.equal(over.netPay, 2900000);
});

test("EPF % of earned basic, fixed PT/TDS, nearest-rupee rounding", () => {
  const c = computeSalary({
    structure: struct(25000, { hra: 1000000, otherAllowances: 333333, epf: { mode: "PERCENT_OF_EARNED_BASIC", percent: 12 }, pt: { mode: "FIXED", amount: 20000 }, tds: { mode: "FIXED", amount: 150050 } }),
    attendance: calc("2026-10"),
    policy: P(),
  });
  assert.equal(c.deductions.epf, 300000);
  assert.equal(c.netPay, Math.round((2500000 + 1000000 + 333333 - 300000 - 20000 - 150050) / 100) * 100);
});

test("negative net is clamped to 0 and flagged", () => {
  const c = computeSalary({ structure: struct(1000), attendance: calc("2026-10"), adjustments: { penaltyAmount: 500000 }, policy: P() });
  assert.equal(c.netPay, 0);
  assert.ok(c.flags.includes("NEGATIVE_NET_CLAMPED"));
});

test("financial year helpers", () => {
  assert.equal(financialYearOf("2026-10"), "2026-27");
  assert.equal(financialYearOf("2027-02"), "2026-27");
  assert.deepEqual(fyRange("2026-27").months.slice(0, 2), ["2026-04", "2026-05"]);
});