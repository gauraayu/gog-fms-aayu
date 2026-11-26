import { connectDB } from "./db";
import { FmsSettings } from "@/models/fms";
import { mergePolicy, type PayrollPolicy } from "./policy";
import { mergeSalaryDefaults, type SalaryDefaults } from "./salary-structure";

export async function getSetting<T>(key: string): Promise<T | null> {
  await connectDB();
  const doc = await FmsSettings.findOne({ key }).lean();
  return (doc?.value as T) ?? null;
}

export async function setSetting(key: string, value: unknown, by: string) {
  await connectDB();
  await FmsSettings.updateOne({ key }, { $set: { value, updatedBy: by } }, { upsert: true });
}

export async function getPolicy(): Promise<PayrollPolicy> {
  return mergePolicy(await getSetting<Partial<PayrollPolicy>>("payrollPolicy"));
}

export async function getPermissionOverrides(): Promise<Record<string, string[]> | null> {
  return getSetting<Record<string, string[]>>("permissions");
}

/** Company salary defaults (EPF auto rule, PT default) — Settings → Salary Defaults. */
export async function getSalaryDefaults(): Promise<SalaryDefaults> {
  return mergeSalaryDefaults(await getSetting<Partial<SalaryDefaults>>("salaryDefaults"));
}