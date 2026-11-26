/**
 * The 13 test cases of the doc "OMS → FMS: Payable Days aur Penalty ke Niyam"
 * (numbers produced by running OMS calculatePayableDays). Month Nov 2026 (30 days),
 * every working day Present, no leave / holiday unless the case says so.
 * FMS must give exactly these numbers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePayableDays, type PdAttendance, type PdViolation, type OmsCorrection, type PdFullAttire } from "../src/lib/payable-days";
import { computeSalary } from "../src/lib/payroll-calc";
import { DEFAULT_POLICY, mergePolicy } from "../src/lib/policy";
import { listMonthDates, weekdayOf } from "../src/lib/dates";
import { holidaysFor, istDay } from "../src/lib/oms-read";

const M = "2026-11";
const P = mergePolicy({ ...DEFAULT_POLICY, confirmed: true });
const present = (except: string[] = []): PdAttendance[] =>
  listMonthDates(M)
    .filter((d) => weekdayOf(d) !== 0 && !except.includes(d))
    .map((d) => ({ _id: `A-${d}`, date: d, status: "Present", clockIn: "09:25:00", clockOut: "18:35:00" }));
const run = (o: Partial<Parameters<typeof computePayableDays>[0]> = {}) =>
  computePayableDays({
    month: M, asOf: undefined,
    employee: { id: "EMP-1", location: "college-a" },
    attendance: present(), leaves: [], holidays: [], violations: [],
    removed: new Map(), corrections: new Map(), monetaryPenalties: [], fines: [],
    policy: P, ...o,
  });
const late = (dates: string[]): PdViolation[] => dates.map((d, i) => ({ id: `L${i + 1}`, date: d, type: "LATE_IN", instance: 99, proposedDeduction: "None", hrStatus: "Pending HR Verification" }));
const expect = (r: ReturnType<typeof run>, payable: number, lop: number, pen: number, fines: number[] = []) => {
  assert.equal(r.payableDays, payable, "payable");
  assert.equal(r.lopDays, lop, "lop");
  assert.equal(r.violationDays, pen, "penalty days");
  assert.deepEqual(r.percentFines.map((f) => f.percent), fines, "% fines");
};
const LATE4 = ["2026-11-05", "2026-11-10", "2026-11-12", "2026-11-18"];

test("case 0: all present → 30 / 0 / 0", () => expect(run(), 30, 0, 0));

test("case 1: Late ×4 → 3rd Half, 4th Full (automatic, no HR approval)", () => expect(run({ violations: late(LATE4) }), 28.5, 1.5, 1.5));

test("case 2: same 4 Late, first flag removed → renumbered", () =>
  expect(run({ violations: late(LATE4), removed: new Map([["VIO:L1", { removedByName: "HR" }]]) }), 29.5, 0.5, 0.5));

test("case 3: Late ×5 → 5th = 2 days", () => expect(run({ violations: late([...LATE4, "2026-11-20"]) }), 26.5, 3.5, 3.5));

test("case 4: Late ×4, third has pending justification → on hold, not counted", () => {
  const r = run({ violations: late(LATE4), lateJustificationPending: new Set(["2026-11-12"]) });
  expect(r, 29.5, 0.5, 0.5);
  assert.match(r.penalties.find((p) => p.date === "2026-11-12")!.status, /On Hold/);
});

const dress = (dates: string[]) => present().map((a) => (dates.includes(a.date) ? { ...a, dressCodeStatus: "Rejected" } : a));
test("case 5: Dress Code ×5 (5,6,7,9,10 Nov) → no days, 10/20/30% fine", () =>
  expect(run({ attendance: dress(["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-09", "2026-11-10"]) }), 30, 0, 0, [10, 20, 30]));

test("case 6: Dress Code ×5 (2–6 Nov, two before 04/11) → no days, 10/20/30% fine", () =>
  expect(run({ attendance: dress(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]) }), 30, 0, 0, [10, 20, 30]));

test("case 7: approved leave 16–17 Nov, no attendance → 1 paid, 1 LOP", () =>
  expect(run({ attendance: present(["2026-11-16", "2026-11-17"]), leaves: [{ startDate: "2026-11-16", endDate: "2026-11-17", days: 2, status: "Approved", type: "Casual" }] }), 29, 1, 0));

test("case 8: half-day leave 16 Nov, no attendance → 0.5 LOP", () =>
  expect(run({ attendance: present(["2026-11-16"]), leaves: [{ startDate: "2026-11-16", endDate: "2026-11-16", days: 0.5, status: "Approved", type: "Casual" }] }), 29.5, 0.5, 0));

test("case 9: 16 Nov Absent + HR Half Day Payable", () => {
  const att = present().map((a) => (a.date === "2026-11-16" ? { ...a, status: "Absent", clockIn: "" } : a));
  const corr = new Map<string, OmsCorrection>([["2026-11-16", { id: "PC-1", direction: "TO_PAYABLE", payableType: "HALF" }]]);
  const r = run({ attendance: att, corrections: corr });
  expect(r, 29.5, 0.5, 0);
  assert.equal(r.days.find((d) => d.date === "2026-11-16")!.payable, 0.5);
});

test("case 9b: Half Day Payable on a payable day brings it down to 0.5", () => {
  const corr = new Map<string, OmsCorrection>([["2026-11-16", { id: "PC-2", direction: "TO_NON_PAYABLE", payableType: "HALF" }]]);
  expect(run({ corrections: corr }), 29.5, 0.5, 0);
});

test("case 10: Missing Clock-Out, HR Rejected → nothing deducted", () =>
  expect(run({ violations: [{ id: "MO1", date: "2026-11-10", type: "MISSING_OUT", proposedDeduction: "Full-Day", hrStatus: "Rejected" }] }), 30, 0, 0));

test("case 11: joining 16 Nov → 15 payable", () => {
  const r = run({ employee: { id: "EMP-1", joiningDate: "2026-11-16" } });
  expect(r, 15, 0, 0);
  assert.equal(r.employedDays, 15);
});

test("case 12: Early-Out 4th, HR Approved for Payroll → Half-Day", () => {
  const v: PdViolation[] = ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"].map((d, i) => ({
    id: `E${i + 1}`, date: d, type: "EARLY_OUT", instance: 1, proposedDeduction: "None", hrStatus: i === 3 ? "Approved for Payroll" : "Not Required",
  }));
  expect(run({ violations: v }), 29.5, 0.5, 0.5);
});

/* ───────── other rules of the doc ───────── */

test("Early-Out 4th not yet approved → Pending HR Verification, no deduction", () => {
  const v: PdViolation[] = ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"].map((d, i) => ({ id: `E${i}`, date: d, type: "EARLY_OUT", proposedDeduction: "None", hrStatus: "" }));
  const r = run({ violations: v });
  expect(r, 30, 0, 0);
  assert.equal(r.penalties.find((p) => p.date === "2026-11-10")!.status, "Pending HR Verification");
});

test("Late before 04/11 counts towards the counter (2 Nov = 1st, so 5 Nov = 2nd)", () =>
  // 2 Nov (old rule, not approved → 0), 5 Nov 2nd → 0, 10 Nov 3rd → 0.5, 12 Nov 4th → 1
  expect(run({ violations: late(["2026-11-02", "2026-11-05", "2026-11-10", "2026-11-12"]) }), 28.5, 1.5, 1.5));

test("Late before 04/11 deducts only when Approved for Payroll (old rule)", () =>
  expect(run({ violations: [{ id: "OLD", date: "2026-11-03", type: "LATE_IN", proposedDeduction: "Half-Day", hrStatus: "Approved for Payroll" }] }), 29.5, 0.5, 0.5));

test("Full Attire: own counter, only from 04/11, date = submission IST day", () => {
  const fa: PdFullAttire[] = ["2026-11-02", "2026-11-05", "2026-11-06", "2026-11-07"].map((d, i) => ({ id: `F${i}`, date: d }));
  const r = run({ fullAttire: fa, attendance: dress(["2026-11-09", "2026-11-10", "2026-11-11"]) });
  // Full Attire 2 Nov ignored → 5, 6, 7 Nov = 1, 2, 3 → 10%; Dress Code 3rd → 10%
  expect(r, 30, 0, 0, [10, 10]);
  assert.equal(istDay("2026-11-04T20:00:00.000Z"), "2026-11-05"); // 01:30 IST next day
});

test("2-day penalty on a HR-corrected day is not taken", () => {
  const corr = new Map<string, OmsCorrection>([["2026-11-20", { id: "PC", direction: "TO_PAYABLE" }]]);
  expect(run({ violations: late([...LATE4, "2026-11-20"]), corrections: corr }), 28.5, 1.5, 1.5);
});

test("holiday scope: employeeIds only them, excludedEmployeeIds not them", () => {
  const hol = [
    { date: "2026-11-09", forAll: true, excludedEmployeeIds: ["EMP-1"] },
    { date: "2026-11-10", employeeIds: ["EMP-2"] },
    { date: "2026-11-11", employeeIds: ["EMP-1"] },
    { date: "2026-11-12", collegeIds: ["college-a"] },
  ];
  assert.deepEqual(holidaysFor(hol, "college-a", "EMP-1"), ["2026-11-11", "2026-11-12"]);
  assert.deepEqual(holidaysFor(hol, "college-b", "EMP-2"), ["2026-11-09", "2026-11-10"]);
});

test("salary: % fine = percent of one day's gross; penalty days once", () => {
  const att = run({ attendance: dress(["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-09", "2026-11-10"]) });
  // ₹30,000 / 30 days = ₹1,000 a day → 10% + 20% + 30% = ₹600
  const c = computeSalary({ structure: { employeeId: "EMP-1", effectiveFrom: "2026-01", basic: 3000000 }, attendance: att, policy: mergePolicy({ ...P, rounding: "PAISE" }) });
  assert.deepEqual(c.fineLines.map((f) => f.amount), [10000, 20000, 30000]);
  assert.equal(c.deductions.penalties, 60000);
  assert.equal(c.netPay, 2940000);
});