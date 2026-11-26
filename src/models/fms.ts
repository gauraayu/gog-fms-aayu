import mongoose, { Schema, type Model, type InferSchemaType } from "mongoose";
import { encryptedFields, isEncrypted } from "@/lib/field-crypto";

/** Encrypted money field (stored as "enc:v1:…"); validated as a non-negative number before encryption. */
const money = (extra: Record<string, unknown> = {}) => ({
  type: Schema.Types.Mixed,
  validate: { validator: (v: unknown) => v == null || isEncrypted(v) || (typeof v === "number" && Number.isFinite(v) && v >= 0), message: "{PATH} must be a non-negative amount" },
  ...extra,
});
const rule = () => ({ type: Schema.Types.Mixed, default: () => ({ mode: "NONE", amount: 0, percent: 0 }) });

/** All FMS-owned collections are prefixed `fms_` and are the ONLY collections FMS writes to. */
function model<T extends Schema>(name: string, schema: T): Model<InferSchemaType<T>> {
  // In `npm run dev`, a file change re-runs this module: drop the cached model so the NEW schema
  // (e.g. encryption plugin) is used, instead of silently keeping the old one until a restart.
  if (process.env.NODE_ENV !== "production" && mongoose.models[name]) mongoose.deleteModel(name);
  return (mongoose.models[name] as Model<InferSchemaType<T>>) || mongoose.model(name, schema);
}
const opts = (collection: string) => ({ collection, timestamps: true, versionKey: false as const });

/* ── Access ─────────────────────────────────────────────────────────── */
const AccessSchema = new Schema(
  {
    employeeId: { type: String, required: true, unique: true }, // OMS employees.id
    email: { type: String, required: true, lowercase: true, trim: true },
    name: String,
    role: { type: String, enum: ["FMS_ADMIN", "FOUNDER", "HR", "ACCOUNTS"], required: true },
    active: { type: Boolean, default: true },
    grantedBy: String,
    revokedBy: String,
    revokedAt: Date,
  },
  opts("fms_access"),
);
AccessSchema.index({ email: 1 });
export const FmsAccess = model("FmsAccess", AccessSchema);

/* ── Settings (permission matrix overrides, payroll policy) ─────────── */
const SettingsSchema = new Schema(
  { key: { type: String, required: true, unique: true }, value: Schema.Types.Mixed, updatedBy: String },
  opts("fms_settings"),
);
export const FmsSettings = model("FmsSettings", SettingsSchema);

/* ── Login attempts (rate limit, auto-expire) ───────────────────────── */
const LoginAttemptSchema = new Schema(
  { key: { type: String, required: true }, success: Boolean, at: { type: Date, default: Date.now } },
  { collection: "fms_login_attempts", versionKey: false },
);
LoginAttemptSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 });
LoginAttemptSchema.index({ key: 1, at: -1 });
export const FmsLoginAttempt = model("FmsLoginAttempt", LoginAttemptSchema);

/* ── Login OTP (email OTP after the password; only a hash of the code is stored) ── */
const LoginOtpSchema = new Schema(
  {
    challengeHash: { type: String, required: true, unique: true }, // sha256 of the browser's challenge cookie
    uid: { type: String, required: true }, // OMS employees._id
    employeeId: { type: String, required: true },
    email: { type: String, required: true },
    role: { type: String, required: true },
    accessSource: String,
    codeHash: { type: String, required: true }, // HMAC of the 6-digit code — the code itself is never saved
    attempts: { type: Number, default: 0 },
    sends: { type: Number, default: 1 },
    sentAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    ip: String,
    purgeAt: { type: Date, required: true }, // document deleted automatically (TTL)
  },
  { collection: "fms_login_otps", versionKey: false, timestamps: true },
);
LoginOtpSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
LoginOtpSchema.index({ employeeId: 1, createdAt: -1 });
export const FmsLoginOtp = model("FmsLoginOtp", LoginOtpSchema);

/* ── Salary structures (effective-dated, immutable versions) ────────── */
const SalaryStructureSchema = new Schema(
  {
    employeeId: { type: String, required: true },
    effectiveFrom: { type: String, required: true }, // YYYY-MM (applies from that payroll month)
    // ENCRYPTED (FMS_DATA_KEY): every amount, deduction rule, statutory IDs and notes
    basic: money({ required: true }), // monthly, paise
    hra: money({ default: 0 }),
    otherAllowances: money({ default: 0 }),
    epf: rule(), // { mode: NONE | FIXED | PERCENT_OF_EARNED_BASIC, amount (paise), percent }
    pt: rule(),
    tds: rule(),
    otherDeductions: money({ default: 0 }),
    collegePaid: money({ default: 0 }), // "Salary to be Paid by College (CS)", paise / month
    // { uan, pfAccountNo, esiNumber, pran, pan (optional override of OMS panNumber), taxRegime }
    statutory: { type: Schema.Types.Mixed, default: () => ({ taxRegime: "Regular" }) },
    notes: Schema.Types.Mixed,
    // Salary package (25/11/2026) — ENCRYPTED. Basic = monthlySalary − HRA − allowances.
    annualPackage: money(), // paise / year (as entered by HR)
    monthlySalary: money(), // paise / month (annual ÷ 12, or HR override) — monthly gross used by payroll
    monthlyOverride: Schema.Types.Mixed, // true = HR changed the monthly salary by hand
    config: Schema.Types.Mixed, // { epfApplicable, epfSetting: AUTO|FIXED|PERCENT|NONE, ptSetting: AUTO|FIXED|NONE, defaults used }
    employerEpf: Schema.Types.Mixed, // { mode, amount, percent, base, monthly } — company cost, never deducted from the employee
    changeReason: Schema.Types.Mixed,
    updatedBy: String,
    createdBy: String,
    supersededAt: Date,
  },
  opts("fms_salary_structures"),
);
SalaryStructureSchema.index({ employeeId: 1, effectiveFrom: -1 }, { unique: true });
SalaryStructureSchema.plugin(encryptedFields, { model: "FmsSalaryStructure", paths: ["basic", "hra", "otherAllowances", "epf", "pt", "tds", "otherDeductions", "collegePaid", "statutory", "notes", "annualPackage", "monthlySalary", "monthlyOverride", "config", "employerEpf", "changeReason"] });
export const FmsSalaryStructure = model("FmsSalaryStructure", SalaryStructureSchema);

/* ── Payroll runs & entries ─────────────────────────────────────────── */
export const PAYROLL_STATUSES = ["Draft", "Under Review", "Approved", "Finalized", "Disbursed"] as const;
const PayrollRunSchema = new Schema(
  {
    month: { type: String, required: true, unique: true }, // YYYY-MM
    status: { type: String, enum: PAYROLL_STATUSES, default: "Draft" },
    policySnapshot: Schema.Types.Mixed,
    // ENCRYPTED: { employees, gross, deductions, net, missingStructure, flagged }
    totals: { type: Schema.Types.Mixed, default: () => ({ employees: 0, gross: 0, deductions: 0, net: 0, missingStructure: 0, flagged: 0 }) },
    computedAt: Date,
    computedBy: String,
    lastSync: Schema.Types.Mixed, // OMS auto-sync status / drift after lock
    statusCounts: Schema.Types.Mixed, // employees per stage (Draft / Under Review / …)
    history: [{ _id: false, from: String, to: String, by: String, byRole: String, at: Date, note: String }],
  },
  opts("fms_payroll_runs"),
);
PayrollRunSchema.plugin(encryptedFields, { model: "FmsPayrollRun", paths: ["totals"] });
export const FmsPayrollRun = model("FmsPayrollRun", PayrollRunSchema);

const PayrollEntrySchema = new Schema(
  {
    runId: { type: Schema.Types.ObjectId, required: true, index: true },
    month: { type: String, required: true },
    employeeId: { type: String, required: true },
    employee: { name: String, email: String, dept: String, designation: String, location: String },
    structureId: Schema.Types.ObjectId,
    attendance: Schema.Types.Mixed, // computed payable-days summary (with per-day trace)
    adjustmentsApplied: { type: Schema.Types.Mixed, default: () => [] }, // [{ field, from, to, adjustmentId }]
    calc: Schema.Types.Mixed, // full salary breakdown in paise + trace lines
    netPay: money({ default: 0 }),
    flags: [String],
    excluded: { type: Boolean, default: false },
    status: { type: String, enum: PAYROLL_STATUSES }, // per-employee payroll stage
    history: [{ _id: false, from: String, to: String, by: String, byRole: String, at: Date, note: String }],
    omsSync: Schema.Types.Mixed, // { at, before } when OMS changes updated this entry
    adjustmentsSuperseded: Schema.Types.Mixed, // FMS adjustments overridden by later OMS changes
    disbursement: { status: { type: String, default: "Pending" }, transactionId: Schema.Types.ObjectId },
  },
  opts("fms_payroll_entries"),
);
PayrollEntrySchema.index({ month: 1, employeeId: 1 }, { unique: true });
PayrollEntrySchema.plugin(encryptedFields, { model: "FmsPayrollEntry", paths: ["attendance", "adjustmentsApplied", "calc", "netPay", "omsSync", "adjustmentsSuperseded"] });
export const FmsPayrollEntry = model("FmsPayrollEntry", PayrollEntrySchema);

/* ── HR adjustments (original OMS data is never touched) ────────────── */
export const ADJUSTABLE_FIELDS = ["payableDays", "lopDays", "penaltyDays", "penaltyAmount", "otherEarnings", "otherDeductions"] as const;
const AdjustmentSchema = new Schema(
  {
    employeeId: { type: String, required: true },
    month: { type: String, required: true },
    field: { type: String, enum: ADJUSTABLE_FIELDS, required: true },
    originalValue: { type: Schema.Types.Mixed, required: true }, // ENCRYPTED
    systemValue: Schema.Types.Mixed, // ENCRYPTED — OMS-derived value at the time of this edit (detects later OMS changes)
    updatedValue: { type: Schema.Types.Mixed, required: true }, // ENCRYPTED
    reason: { type: String, required: true, minlength: 10 },
    modifiedBy: { type: String, required: true },
    modifiedByName: String,
    modifiedByRole: String,
    voided: { type: Boolean, default: false },
  },
  opts("fms_payroll_adjustments"),
);
AdjustmentSchema.index({ employeeId: 1, month: 1, field: 1, createdAt: -1 });
AdjustmentSchema.plugin(encryptedFields, { model: "FmsAdjustment", paths: ["originalValue", "systemValue", "updatedValue"] });
export const FmsAdjustment = model("FmsAdjustment", AdjustmentSchema);

/* ── Payslips ───────────────────────────────────────────────────────── */
const PayslipSchema = new Schema(
  {
    employeeId: { type: String, required: true },
    month: { type: String, required: true },
    entryId: Schema.Types.ObjectId,
    runId: Schema.Types.ObjectId,
    s3Key: { type: String, required: true },
    netPay: Schema.Types.Mixed, // ENCRYPTED
    template: String, // EPF | NO_EPF
    data: Schema.Types.Mixed, // exact SlipData used for the PDF, preview and email
    generatedBy: String,
    version: { type: Number, default: 1 },
  },
  opts("fms_payslips"),
);
PayslipSchema.index({ employeeId: 1, month: 1 }, { unique: true });
PayslipSchema.plugin(encryptedFields, { model: "FmsPayslip", paths: ["netPay", "data"] });
export const FmsPayslip = model("FmsPayslip", PayslipSchema);

/* ── Client invoices ────────────────────────────────────────────────── */
export const INVOICE_STATUSES = ["Draft", "Issued", "Partially Paid", "Paid", "Overdue", "Cancelled"] as const;
const InvoiceSchema = new Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true, trim: true },
    clientName: { type: String, required: true, trim: true },
    clientLocation: { type: String, required: true, trim: true },
    invoiceDate: { type: String, required: true }, // YYYY-MM-DD
    dueDate: String,
    billingMonth: { type: Number, required: true, min: 1, max: 12 },
    billingYear: { type: Number, required: true },
    // ENCRYPTED: amount, taxAmount, totalAmount, amountReceived, notes (paise)
    amount: money({ required: true }),
    taxAmount: money({ default: 0 }),
    totalAmount: money({ required: true }),
    amountReceived: money({ default: 0 }),
    status: { type: String, enum: INVOICE_STATUSES, default: "Issued" },
    s3Key: String,
    fileName: String,
    uploadedBy: String,
    notes: Schema.Types.Mixed,
  },
  opts("fms_client_invoices"),
);
InvoiceSchema.plugin(encryptedFields, { model: "FmsInvoice", paths: ["amount", "taxAmount", "totalAmount", "amountReceived", "notes"] });
InvoiceSchema.index({ billingYear: -1, billingMonth: -1, clientName: 1, clientLocation: 1 });
export const FmsInvoice = model("FmsInvoice", InvoiceSchema);

/* ── Statutory challans ─────────────────────────────────────────────── */
export const CHALLAN_TYPES = ["EPF", "GST", "PT", "TDS"] as const;
export const CHALLAN_STATUSES = ["Uploaded", "Paid", "Verified"] as const;
const ChallanSchema = new Schema(
  {
    type: { type: String, enum: CHALLAN_TYPES, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    financialYear: { type: String, required: true },
    referenceNumber: { type: String, trim: true },
    amount: money({ required: true }), // ENCRYPTED, paise
    paymentDate: String,
    paymentStatus: { type: String, enum: CHALLAN_STATUSES, default: "Uploaded" },
    s3Key: String,
    fileName: String,
    versions: [{ _id: false, s3Key: String, fileName: String, replacedAt: Date, replacedBy: String, reason: String }],
    uploadedBy: String,
    notes: String,
  },
  opts("fms_statutory_challans"),
);
ChallanSchema.index({ type: 1, year: 1, month: 1 }, { unique: true });
ChallanSchema.plugin(encryptedFields, { model: "FmsChallan", paths: ["amount"] });
export const FmsChallan = model("FmsChallan", ChallanSchema);

/* ── Financial transactions (salary disbursements) ──────────────────── */
const TxnSchema = new Schema(
  {
    type: { type: String, enum: ["SALARY_DISBURSEMENT"], required: true },
    month: String, // payroll month
    employeeId: String,
    location: String,
    amount: money({ required: true }), // ENCRYPTED, paise
    disbursedOn: { type: String, required: true }, // YYYY-MM-DD (IST)
    reference: String,
    idempotencyKey: { type: String, required: true, unique: true },
    recordedBy: String,
  },
  opts("fms_financial_transactions"),
);
TxnSchema.index({ type: 1, disbursedOn: 1 });
TxnSchema.plugin(encryptedFields, { model: "FmsTransaction", paths: ["amount"] });
export const FmsTransaction = model("FmsTransaction", TxnSchema);

/* ── Email logs ─────────────────────────────────────────────────────── */
const EmailLogSchema = new Schema(
  {
    key: { type: String, required: true, unique: true }, // payslip:<emp>:<YYYY-MM>
    kind: { type: String, enum: ["PAYSLIP", "FINANCE_ALERT"], required: true },
    employeeId: String,
    month: String,
    to: String,
    subject: String,
    status: { type: String, enum: ["Queued", "Sending", "Sent", "Failed"], default: "Queued" },
    trigger: { type: String, enum: ["MANUAL", "SCHEDULED"], default: "MANUAL" },
    attempts: [{ _id: false, at: Date, ok: Boolean, error: String, messageId: String, by: String }],
    lastError: String,
    sentAt: Date,
    // Archive of what was actually mailed (latest send + full history for resends)
    employeeName: String,
    netPay: Schema.Types.Mixed, // ENCRYPTED
    sentS3Key: String,
    sentVersion: Number,
    sentBy: String,
    sentByName: String,
    sentHistory: [{ _id: false, at: Date, s3Key: String, version: Number, to: String, by: String }],
  },
  opts("fms_email_logs"),
);
EmailLogSchema.plugin(encryptedFields, { model: "FmsEmailLog", paths: ["netPay"] });
export const FmsEmailLog = model("FmsEmailLog", EmailLogSchema);

/* ── Audit (insert-only) ────────────────────────────────────────────── */
const AuditSchema = new Schema(
  {
    userId: String,
    userName: String,
    userRole: String,
    action: { type: String, required: true },
    entity: String,
    entityId: String,
    previousValue: Schema.Types.Mixed,
    updatedValue: Schema.Types.Mixed,
    reason: String,
    ip: String,
    at: { type: Date, default: Date.now },
  },
  { collection: "fms_audit_logs", versionKey: false },
);
AuditSchema.index({ at: -1 });
AuditSchema.index({ entity: 1, entityId: 1, at: -1 });
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (AuditSchema as any).pre(op, function () {
    throw new Error("Audit log is append-only");
  });
}
AuditSchema.plugin(encryptedFields, { model: "FmsAudit", paths: ["previousValue", "updatedValue"] }); // old / new values can hold salaries
export const FmsAudit = model("FmsAudit", AuditSchema);

/* ── Job runs (idempotent scheduled work) ───────────────────────────── */
const JobRunSchema = new Schema(
  { key: { type: String, required: true, unique: true }, status: String, summary: Schema.Types.Mixed },
  opts("fms_job_runs"),
);
export const FmsJobRun = model("FmsJobRun", JobRunSchema);