import mongoose, { Schema, type Model, type InferSchemaType } from "mongoose";

/** All FMS-owned collections are prefixed `fms_` and are the ONLY collections FMS writes to. */
function model<T extends Schema>(name: string, schema: T): Model<InferSchemaType<T>> {
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

/* ── Salary structures (effective-dated, immutable versions) ────────── */
const DeductionRule = new Schema(
  {
    mode: { type: String, enum: ["NONE", "FIXED", "PERCENT_OF_EARNED_BASIC"], default: "NONE" },
    amount: { type: Number, default: 0 }, // paise when FIXED
    percent: { type: Number, default: 0 }, // entered by Accounts — FMS never assumes a statutory rate
  },
  { _id: false },
);
const SalaryStructureSchema = new Schema(
  {
    employeeId: { type: String, required: true },
    effectiveFrom: { type: String, required: true }, // YYYY-MM (applies from that payroll month)
    basic: { type: Number, required: true, min: 0 }, // monthly, paise
    hra: { type: Number, default: 0, min: 0 },
    otherAllowances: { type: Number, default: 0, min: 0 },
    epf: { type: DeductionRule, default: () => ({}) },
    pt: { type: DeductionRule, default: () => ({}) },
    tds: { type: DeductionRule, default: () => ({}) },
    otherDeductions: { type: Number, default: 0, min: 0 },
    collegePaid: { type: Number, default: 0, min: 0 }, // "Salary to be Paid by College (CS)", paise / month
    statutory: {
      uan: String, pfAccountNo: String, esiNumber: String, pran: String,
      pan: String, // optional override; otherwise PAN is read from OMS employees.panNumber
      taxRegime: { type: String, default: "Regular" },
    },
    notes: String,
    createdBy: String,
    supersededAt: Date,
  },
  opts("fms_salary_structures"),
);
SalaryStructureSchema.index({ employeeId: 1, effectiveFrom: -1 }, { unique: true });
export const FmsSalaryStructure = model("FmsSalaryStructure", SalaryStructureSchema);

/* ── Payroll runs & entries ─────────────────────────────────────────── */
export const PAYROLL_STATUSES = ["Draft", "Under Review", "Approved", "Finalized", "Disbursed"] as const;
const PayrollRunSchema = new Schema(
  {
    month: { type: String, required: true, unique: true }, // YYYY-MM
    status: { type: String, enum: PAYROLL_STATUSES, default: "Draft" },
    policySnapshot: Schema.Types.Mixed,
    totals: {
      employees: { type: Number, default: 0 },
      gross: { type: Number, default: 0 },
      deductions: { type: Number, default: 0 },
      net: { type: Number, default: 0 },
      missingStructure: { type: Number, default: 0 },
      flagged: { type: Number, default: 0 },
    },
    computedAt: Date,
    computedBy: String,
    lastSync: Schema.Types.Mixed, // OMS auto-sync status / drift after lock
    statusCounts: Schema.Types.Mixed, // employees per stage (Draft / Under Review / …)
    history: [{ _id: false, from: String, to: String, by: String, byRole: String, at: Date, note: String }],
  },
  opts("fms_payroll_runs"),
);
export const FmsPayrollRun = model("FmsPayrollRun", PayrollRunSchema);

const PayrollEntrySchema = new Schema(
  {
    runId: { type: Schema.Types.ObjectId, required: true, index: true },
    month: { type: String, required: true },
    employeeId: { type: String, required: true },
    employee: { name: String, email: String, dept: String, designation: String, location: String },
    structureId: Schema.Types.ObjectId,
    attendance: Schema.Types.Mixed, // computed payable-days summary (with per-day trace)
    adjustmentsApplied: [{ _id: false, field: String, from: Number, to: Number, adjustmentId: Schema.Types.ObjectId }],
    calc: Schema.Types.Mixed, // full salary breakdown in paise + trace lines
    netPay: { type: Number, default: 0 },
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
export const FmsPayrollEntry = model("FmsPayrollEntry", PayrollEntrySchema);

/* ── HR adjustments (original OMS data is never touched) ────────────── */
export const ADJUSTABLE_FIELDS = ["payableDays", "lopDays", "penaltyDays", "penaltyAmount", "otherEarnings", "otherDeductions"] as const;
const AdjustmentSchema = new Schema(
  {
    employeeId: { type: String, required: true },
    month: { type: String, required: true },
    field: { type: String, enum: ADJUSTABLE_FIELDS, required: true },
    originalValue: { type: Number, required: true },
    systemValue: Number, // OMS-derived value at the time of this edit (detects later OMS changes)
    updatedValue: { type: Number, required: true },
    reason: { type: String, required: true, minlength: 10 },
    modifiedBy: { type: String, required: true },
    modifiedByName: String,
    modifiedByRole: String,
    voided: { type: Boolean, default: false },
  },
  opts("fms_payroll_adjustments"),
);
AdjustmentSchema.index({ employeeId: 1, month: 1, field: 1, createdAt: -1 });
export const FmsAdjustment = model("FmsAdjustment", AdjustmentSchema);

/* ── Payslips ───────────────────────────────────────────────────────── */
const PayslipSchema = new Schema(
  {
    employeeId: { type: String, required: true },
    month: { type: String, required: true },
    entryId: Schema.Types.ObjectId,
    runId: Schema.Types.ObjectId,
    s3Key: { type: String, required: true },
    netPay: Number,
    template: String, // EPF | NO_EPF
    data: Schema.Types.Mixed, // exact SlipData used for the PDF, preview and email
    generatedBy: String,
    version: { type: Number, default: 1 },
  },
  opts("fms_payslips"),
);
PayslipSchema.index({ employeeId: 1, month: 1 }, { unique: true });
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
    amount: { type: Number, required: true, min: 0 }, // paise
    taxAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    amountReceived: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: INVOICE_STATUSES, default: "Issued" },
    s3Key: String,
    fileName: String,
    uploadedBy: String,
    notes: String,
  },
  opts("fms_client_invoices"),
);
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
    amount: { type: Number, required: true, min: 0 }, // paise
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
export const FmsChallan = model("FmsChallan", ChallanSchema);

/* ── Financial transactions (salary disbursements) ──────────────────── */
const TxnSchema = new Schema(
  {
    type: { type: String, enum: ["SALARY_DISBURSEMENT"], required: true },
    month: String, // payroll month
    employeeId: String,
    location: String,
    amount: { type: Number, required: true }, // paise
    disbursedOn: { type: String, required: true }, // YYYY-MM-DD (IST)
    reference: String,
    idempotencyKey: { type: String, required: true, unique: true },
    recordedBy: String,
  },
  opts("fms_financial_transactions"),
);
TxnSchema.index({ type: 1, disbursedOn: 1 });
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
    netPay: Number,
    sentS3Key: String,
    sentVersion: Number,
    sentBy: String,
    sentByName: String,
    sentHistory: [{ _id: false, at: Date, s3Key: String, version: Number, to: String, by: String }],
  },
  opts("fms_email_logs"),
);
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
export const FmsAudit = model("FmsAudit", AuditSchema);

/* ── Job runs (idempotent scheduled work) ───────────────────────────── */
const JobRunSchema = new Schema(
  { key: { type: String, required: true, unique: true }, status: String, summary: Schema.Types.Mixed },
  opts("fms_job_runs"),
);
export const FmsJobRun = model("FmsJobRun", JobRunSchema);