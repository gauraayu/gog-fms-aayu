/**
 * Configurable FMS permission matrix.
 * Defaults live here; Founders/Admins can override per role in Settings
 * (stored in fms_settings key "permissions"). OMS role ≠ FMS access:
 * a user needs an explicit fms_access grant to log in at all.
 */
export const FMS_ROLES = ["FMS_ADMIN", "FOUNDER", "HR", "ACCOUNTS"] as const;
export type FmsRole = (typeof FMS_ROLES)[number];

export const PERMISSIONS = {
  "dashboard.view": "View finance dashboard",
  "employees.view": "View employee payroll records",
  "salary.view": "View salary structures and amounts",
  "salary.manage": "Create salary structure versions",
  "adjustments.manage": "Create payroll adjustments (with reason)",
  "payroll.view": "View payroll runs",
  "payroll.prepare": "Create/recompute payroll, submit for review",
  "payroll.approve": "Approve payroll",
  "payroll.finalize": "Finalize payroll",
  "payroll.disburse": "Record salary disbursement",
  "payslips.view": "View/download payslips",
  "payslips.generate": "Generate payslips",
  "payslips.email": "Send payslip emails",
  "invoices.view": "View client invoices",
  "invoices.manage": "Upload/edit client invoices",
  "challans.view": "View statutory challans",
  "challans.manage": "Upload/edit statutory challans",
  "reports.view": "View/export reports",
  "emails.view": "View email history",
  "audit.view": "View audit history",
  "settings.manage": "Manage payroll policy, access and permissions",
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const DEFAULT_MATRIX: Record<FmsRole, Permission[]> = {
  FMS_ADMIN: ALL_PERMISSIONS,
  FOUNDER: [
    "dashboard.view", "employees.view", "salary.view", "payroll.view", "payroll.approve", "payroll.finalize",
    "payslips.view", "invoices.view", "challans.view", "reports.view", "emails.view", "audit.view", "settings.manage",
  ],
  HR: [
    "dashboard.view", "employees.view", "salary.view", "adjustments.manage", "payroll.view", "payroll.prepare",
    "payslips.view", "payslips.generate", "payslips.email", "reports.view", "emails.view", "audit.view",
  ],
  ACCOUNTS: [
    "dashboard.view", "employees.view", "salary.view", "salary.manage", "payroll.view", "payroll.prepare",
    "payroll.disburse", "payslips.view", "payslips.generate", "payslips.email", "invoices.view", "invoices.manage",
    "challans.view", "challans.manage", "reports.view", "emails.view", "audit.view",
  ],
};

export function resolvePermissions(role: string, overrides?: Partial<Record<string, string[]>> | null): Permission[] {
  if (role === "FMS_ADMIN") return ALL_PERMISSIONS; // admin can never lock itself out
  const fromOverride = overrides?.[role];
  const list = (fromOverride ?? DEFAULT_MATRIX[role as FmsRole] ?? []) as string[];
  return list.filter((p): p is Permission => p in PERMISSIONS);
}
