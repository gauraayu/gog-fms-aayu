import { connectDB } from "./db";
import { computePayableDays, type PayableDaysResult } from "./payable-days";
import { computeSalary, pickStructure, type AdjustmentMap, type SalaryCalc, type SalaryStructureLite } from "./payroll-calc";
import { holidaysFor, loadMonthInputs, type OmsEmployeeView } from "./oms-read";
import { FmsAdjustment, FmsSalaryStructure } from "@/models/fms";
import type { PayrollPolicy } from "./policy";
import { monthEnd, todayIST } from "./dates";

export interface EmployeeMonthResult {
  employee: OmsEmployeeView;
  attendance: PayableDaysResult;
  adjustments: AdjustmentMap;
  adjustmentsApplied: { field: string; from: number; to: number; adjustmentId: unknown }[];
  /** FMS adjustments NOT applied because OMS data changed after HR made them (OMS value wins). */
  adjustmentsSuperseded: { field: string; adjustedTo: number; omsAtEdit: number; omsNow: number; adjustmentId: unknown }[];
  structure: SalaryStructureLite | null;
  calc: SalaryCalc | null;
  flags: string[];
}

/** Fields whose "system value" comes from OMS data (attendance/leave/violations/fines). */
export const OMS_DERIVED_FIELDS = new Set(["payableDays", "lopDays", "penaltyDays", "penaltyAmount"]);

/**
 * Latest non-voided adjustment per field wins, and we remember the OMS-derived
 * value that was in effect when HR made it (systemValue, or the chain's first originalValue).
 */
export async function loadAdjustments(employeeIds: string[], month: string) {
  const rows = await FmsAdjustment.find({ employeeId: { $in: employeeIds }, month, voided: { $ne: true } })
    .sort({ createdAt: 1 })
    .lean();
  type Row = (typeof rows)[number];
  const map = new Map<string, Map<string, { row: Row; systemValueAtEdit: number }>>();
  for (const r of rows) {
    const m = map.get(r.employeeId) ?? new Map();
    const prev = m.get(r.field);
    const sv = typeof r.systemValue === "number" ? r.systemValue : prev?.systemValueAtEdit ?? r.originalValue;
    m.set(r.field, { row: r, systemValueAtEdit: sv });
    map.set(r.employeeId, m);
  }
  return map;
}

export async function loadStructures(employeeIds: string[]) {
  const rows = await FmsSalaryStructure.find({ employeeId: { $in: employeeIds } }).lean();
  const map = new Map<string, SalaryStructureLite[]>();
  for (const r of rows) {
    const arr = map.get(r.employeeId) ?? [];
    arr.push(r as unknown as SalaryStructureLite);
    map.set(r.employeeId, arr);
  }
  return map;
}

/**
 * Compute payable days + salary for many employees for one month.
 * mode "soFar": counts only dates up to today (Employee Management page).
 * mode "payroll": counts the whole month; future dates in a running month are flagged.
 */
export async function computeForEmployees(
  employees: OmsEmployeeView[],
  month: string,
  policy: PayrollPolicy,
  mode: "soFar" | "payroll",
): Promise<EmployeeMonthResult[]> {
  await connectDB();
  const ids = employees.map((e) => e.id);
  const [inputs, adjMap, structMap] = await Promise.all([loadMonthInputs(ids, month), loadAdjustments(ids, month), loadStructures(ids)]);
  // OMS rule: current month → asOf = today (later days "Upcoming", projected payable); past month → final.
  void mode;

  return employees.map((employee) => {
    const attendance = computePayableDays({
      month,
      asOf: inputs.asOf,
      employee: {
        id: employee.id,
        location: employee.location,
        joiningDate: employee.joiningDate || undefined,
        exitDate: employee.noticeLastWorkingDay || inputs.exits.get(employee.id) || undefined,
      },
      attendance: inputs.attendance.get(employee.id) ?? [],
      leaves: inputs.leaves.get(employee.id) ?? [],
      holidays: holidaysFor(inputs.holidays, employee.location),
      violations: inputs.violations.get(employee.id) ?? [],
      removed: inputs.removed.get(employee.id) ?? new Map(),
      corrections: inputs.corrections.get(employee.id) ?? new Map(),
      monetaryPenalties: inputs.monetary.get(employee.id) ?? [],
      fines: employee.fines,
      policy,
    });
    const adjRows = adjMap.get(employee.id) ?? new Map();
    const adjustments: AdjustmentMap = {};
    const adjustmentsApplied: EmployeeMonthResult["adjustmentsApplied"] = [];
    const adjustmentsSuperseded: EmployeeMonthResult["adjustmentsSuperseded"] = [];
    for (const [field, { row, systemValueAtEdit }] of adjRows) {
      if (OMS_DERIVED_FIELDS.has(field)) {
        const omsNow = systemValueFor(field, attendance);
        if (round2(omsNow) !== round2(systemValueAtEdit)) {
          // HR changed the underlying data in OMS after this FMS edit → the fresh OMS value applies.
          adjustmentsSuperseded.push({ field, adjustedTo: row.updatedValue, omsAtEdit: systemValueAtEdit, omsNow, adjustmentId: row._id });
          continue;
        }
      }
      (adjustments as Record<string, number>)[field] = row.updatedValue;
      adjustmentsApplied.push({ field, from: row.originalValue, to: row.updatedValue, adjustmentId: row._id });
    }
    const structure = pickStructure(structMap.get(employee.id) ?? [], month);
    const calc = structure ? computeSalary({ structure, attendance, adjustments, policy }) : null;
    const flags = [...attendance.flags, ...(calc?.flags ?? [])];
    if (!structure) flags.push("NO_SALARY_STRUCTURE");
    if (adjustmentsApplied.length) flags.push("HR_ADJUSTED");
    if (adjustmentsSuperseded.length) flags.push("OMS_UPDATED_AFTER_HR_ADJUSTMENT");
    return { employee, attendance, adjustments, adjustmentsApplied, adjustmentsSuperseded, structure, calc, flags };
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** OMS-derived (system-computed) value of an adjustable field. */
export function systemValueFor(field: string, a: PayableDaysResult): number {
  switch (field) {
    case "payableDays": return a.payableDays;
    case "lopDays": return a.lopDays;
    case "penaltyDays": return a.violationDays;
    case "penaltyAmount": return a.finesPaise;
    default: return 0; // otherEarnings / otherDeductions are FMS-only
  }
}

/** Original (system-computed) value for an adjustable field — stored with every adjustment. */
export function originalValueFor(field: string, r: EmployeeMonthResult): number {
  return systemValueFor(field, r.attendance);
}