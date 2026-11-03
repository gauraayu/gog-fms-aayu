import mongoose, { Schema, type Model } from "mongoose";

/**
 * READ-ONLY views of GOG OMS collections (names verified in handover §5).
 *  - strict:false  → we read whatever OMS stores, no schema assumptions enforced
 *  - autoIndex/autoCreate:false → FMS never creates/changes OMS indexes/collections
 *  - every write middleware throws → a bug can never modify OMS data
 * Always query with .lean() and never select `password` (except in auth/login).
 */
const WRITE_OPS = [
  "save", "updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne",
  "deleteOne", "deleteMany", "findOneAndDelete", "insertMany", "bulkWrite",
] as const;

export class OmsWriteBlockedError extends Error {
  constructor(coll: string) {
    super(`FMS is read-only on OMS collection "${coll}"`);
  }
}

function readOnlyModel(name: string, collection: string): Model<Record<string, unknown>> {
  if (mongoose.models[name]) return mongoose.models[name] as Model<Record<string, unknown>>;
  const schema = new Schema({}, { strict: false, autoIndex: false, autoCreate: false, collection, versionKey: false });
  for (const op of WRITE_OPS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (schema as any).pre(op, function () {
      throw new OmsWriteBlockedError(collection);
    });
  }
  return mongoose.model<Record<string, unknown>>(name, schema);
}

export const OmsEmployee = readOnlyModel("OmsEmployee", "employees");
export const OmsAttendance = readOnlyModel("OmsAttendance", "attendances");
export const OmsLeave = readOnlyModel("OmsLeave", "leaverequests");
export const OmsHoliday = readOnlyModel("OmsHoliday", "holidays");
export const OmsSchedule = readOnlyModel("OmsSchedule", "workschedules");
export const OmsViolation = readOnlyModel("OmsViolation", "attendanceviolations");
export const OmsLocation = readOnlyModel("OmsLocation", "locations");
export const OmsExit = readOnlyModel("OmsExit", "exitrecords");
export const OmsWfh = readOnlyModel("OmsWfh", "workfromhomes");
// Collections used by OMS payableForMany (salary-module.ts:66-77)
export const OmsPayableCorrection = readOnlyModel("OmsPayableCorrection", "payablecorrections");
export const OmsFlagRemoval = readOnlyModel("OmsFlagRemoval", "flagremovals");
export const OmsLocationJustification = readOnlyModel("OmsLocationJustification", "locationjustifications");

/** Fields FMS is allowed to read from `employees` (never password / ID numbers / bank details). */
export const EMPLOYEE_SAFE_FIELDS =
  "_id id name email role dept designation current_designation_at_gog location status joiningDate noticePeriod reportsTo fines isRemoved linkedEmployeeIds";