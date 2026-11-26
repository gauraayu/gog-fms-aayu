/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Field-level encryption for FMS money data (salary, payroll, payslips, invoices …).
 *
 * In MongoDB the protected fields are stored as   enc:v1:<keyId>:<iv>:<tag>:<data>
 * (AES-256-GCM, a fresh random IV per value). Anyone who opens the database
 * (Atlas UI, Compass, an OMS developer, a DB backup) sees only that text.
 * FMS decrypts automatically when it reads, with the key in FMS_DATA_KEY.
 *
 *  - FMS_DATA_KEY           32-byte key, base64 (or 64 hex chars). REQUIRED to write money data.
 *  - FMS_DATA_KEY_PREVIOUS  optional old key(s), comma separated — still decrypts after a key change.
 *
 * Losing FMS_DATA_KEY = the encrypted data can never be read again. Keep a copy in a safe place.
 * Values written before encryption was switched on (plain numbers) are still read as they are,
 * and `scripts/encrypt-existing.ts` encrypts them.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Schema } from "mongoose";

export const ENC_PREFIX = "enc:v1:";

export class DataKeyError extends Error {
  name = "DataKeyError";
}

interface Key { id: string; key: Buffer }

function parseKey(raw: string): Buffer | null {
  const s = raw.trim();
  if (!s) return null;
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  return buf.length === 32 ? buf : null;
}
const keyId = (k: Buffer) => createHash("sha256").update(k).digest("hex").slice(0, 8);

let cache: { raw: string; current: Key | null; all: Map<string, Buffer> } | null = null;
function keys() {
  const raw = `${process.env.FMS_DATA_KEY ?? ""}|${process.env.FMS_DATA_KEY_PREVIOUS ?? ""}`;
  if (cache?.raw === raw) return cache;
  const all = new Map<string, Buffer>();
  let current: Key | null = null;
  if (process.env.FMS_DATA_KEY) {
    const k = parseKey(process.env.FMS_DATA_KEY);
    if (!k) throw new DataKeyError("FMS_DATA_KEY is invalid: it must be 32 bytes in base64 (44 characters) or 64 hex characters.");
    current = { id: keyId(k), key: k };
    all.set(current.id, k);
  }
  for (const part of String(process.env.FMS_DATA_KEY_PREVIOUS ?? "").split(",")) {
    const k = parseKey(part);
    if (k) all.set(keyId(k), k);
  }
  cache = { raw, current, all };
  return cache;
}

export const isEncrypted = (v: unknown): v is string => typeof v === "string" && v.startsWith(ENC_PREFIX);
export const dataKeyConfigured = () => !!keys().current;

export function encryptValue(value: unknown): string {
  if (isEncrypted(value)) return value;
  const { current } = keys();
  if (!current) {
    throw new DataKeyError("FMS_DATA_KEY is not set. Salary and invoice data is stored encrypted — add FMS_DATA_KEY to .env.local (see .env.example) and restart.");
  }
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", current.key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(value === undefined ? null : value), "utf8"), c.final()]);
  return `${ENC_PREFIX}${current.id}:${iv.toString("base64url")}:${c.getAuthTag().toString("base64url")}:${data.toString("base64url")}`;
}

export function decryptValue<T = unknown>(value: unknown): T {
  if (!isEncrypted(value)) return value as T; // plain (written before encryption) → as it is
  const [kid, ivS, tagS, dataS] = value.slice(ENC_PREFIX.length).split(":");
  const key = keys().all.get(kid);
  if (!key) throw new DataKeyError(`Cannot decrypt FMS data: the key it was encrypted with (id ${kid}) is not in FMS_DATA_KEY / FMS_DATA_KEY_PREVIOUS.`);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivS, "base64url"));
  d.setAuthTag(Buffer.from(tagS, "base64url"));
  const out = Buffer.concat([d.update(Buffer.from(dataS, "base64url")), d.final()]).toString("utf8");
  return JSON.parse(out) as T;
}

/* ───────────── Mongoose plugin ───────────── */

const has = (o: any, k: string) => o != null && Object.prototype.hasOwnProperty.call(o, k);

/** Encrypt the protected top-level fields of a plain object (in place). */
export function encryptDoc(obj: any, paths: readonly string[]) {
  if (!obj || typeof obj !== "object") return obj;
  for (const p of paths) if (has(obj, p) && obj[p] !== undefined && obj[p] !== null) obj[p] = encryptValue(obj[p]);
  return obj;
}
/** Decrypt the protected top-level fields of a plain object (in place). */
export function decryptDoc(obj: any, paths: readonly string[]) {
  if (!obj || typeof obj !== "object") return obj;
  for (const p of paths) if (has(obj, p) && isEncrypted(obj[p])) obj[p] = decryptValue(obj[p]);
  return obj;
}

const SET_OPS = new Set(["$set", "$setOnInsert"]);
const SAFE_OPS = new Set(["$unset", "$currentDate"]);
/** Encrypt protected fields inside an update; refuse operators that cannot work on encrypted data. */
export function encryptUpdate(update: any, paths: readonly string[], model = "FMS") {
  if (!update || typeof update !== "object") return update;
  if (Array.isArray(update)) {
    if (JSON.stringify(update).match(new RegExp(`\\$(${paths.join("|")})\\b`))) throw new Error(`${model}: pipeline updates on encrypted fields are not supported`);
    return update;
  }
  const touches = (k: string) => paths.find((p) => k === p || k.startsWith(`${p}.`));
  for (const k of Object.keys(update)) {
    if (!k.startsWith("$")) {
      const p = touches(k);
      if (p && k !== p) throw new Error(`${model}: "${k}" — encrypted field "${p}" must be replaced as a whole`);
      if (p && update[k] != null) update[k] = encryptValue(update[k]);
      continue;
    }
    const body = update[k];
    if (!body || typeof body !== "object") continue;
    for (const f of Object.keys(body)) {
      const p = touches(f);
      if (!p) continue;
      if (SAFE_OPS.has(k)) continue;
      if (!SET_OPS.has(k)) throw new Error(`${model}: ${k} cannot be used on encrypted field "${p}"`);
      if (f !== p) throw new Error(`${model}: "${f}" — encrypted field "${p}" must be replaced as a whole`);
      if (body[f] != null) body[f] = encryptValue(body[f]);
    }
  }
  return update;
}

/** Refuse filters / sorts on encrypted fields (they could never match). */
function checkFilter(filter: any, paths: readonly string[], model: string) {
  if (!filter || typeof filter !== "object") return;
  const walk = (o: any) => {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      if (paths.some((p) => k === p || k.startsWith(`${p}.`))) throw new Error(`${model}: cannot filter on encrypted field "${k}"`);
      if (k === "$or" || k === "$and" || k === "$nor") (o[k] as any[]).forEach(walk);
    }
  };
  walk(filter);
}

/**
 * Mongoose plugin: the listed top-level paths (declared as Mixed) are encrypted on every write
 * (save / create, updateOne / updateMany / findOneAndUpdate, insertMany, bulkWrite)
 * and decrypted on every read (documents and .lean()).
 */
export function encryptedFields(schema: Schema, opts: { paths: readonly string[]; model: string }) {
  const { paths, model } = opts;
  const s = schema as any;

  s.pre("save", function (this: any) {
    for (const p of paths) {
      const v = this.get(p);
      if (v !== undefined && v !== null && !isEncrypted(v)) {
        this.$locals.__plain = this.$locals.__plain || {};
        this.$locals.__plain[p] = v;
        this.set(p, encryptValue(v));
        this.markModified(p);
      }
    }
  });
  const restore = function (this: any) {
    for (const p of paths) {
      const v = this.get(p);
      if (isEncrypted(v)) {
        this.set(p, decryptValue(v));
        this.unmarkModified(p);
      }
    }
  };
  s.post("save", restore);
  s.post("init", restore);

  for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"]) {
    s.pre(op, function (this: any) {
      checkFilter(this.getFilter(), paths, model);
      const u = this.getUpdate();
      if (op === "replaceOne" || op === "findOneAndReplace") encryptDoc(u, paths);
      else encryptUpdate(u, paths, model);
      this.setUpdate(u);
    });
  }
  for (const op of ["find", "findOne", "countDocuments", "deleteOne", "deleteMany", "findOneAndDelete"]) {
    s.pre(op, function (this: any) {
      checkFilter(this.getFilter(), paths, model);
      const sort = this.getOptions?.().sort;
      if (sort && typeof sort === "object") checkFilter(sort, paths, model);
    });
  }
  const decryptResult = (res: any) => {
    if (!res) return;
    const one = (d: any) => {
      if (!d || typeof d !== "object" || typeof d.$isMongooseDocument === "boolean") return; // documents: handled by init
      decryptDoc(d, paths);
    };
    if (Array.isArray(res)) res.forEach(one);
    else if (res.value !== undefined && res.ok !== undefined) one(res.value);
    else one(res);
  };
  for (const op of ["find", "findOne", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace"]) {
    s.post(op, function (res: any) {
      decryptResult(res);
    });
  }

  s.pre("insertMany", function (this: any, ...args: any[]) {
    const docs = args.find((a) => Array.isArray(a)) ?? args.find((a) => a && typeof a === "object" && !a.ordered);
    for (const d of Array.isArray(docs) ? docs : docs ? [docs] : []) encryptDoc(d, paths);
  });
  s.pre("bulkWrite", function (this: any, ...args: any[]) {
    const ops = args.find((a) => Array.isArray(a)) ?? [];
    for (const o of ops) {
      if (o.insertOne) encryptDoc(o.insertOne.document, paths);
      for (const k of ["updateOne", "updateMany"]) if (o[k]) { checkFilter(o[k].filter, paths, model); encryptUpdate(o[k].update, paths, model); }
      if (o.replaceOne) encryptDoc(o.replaceOne.replacement, paths);
    }
  });
  s.pre("aggregate", function (this: any) {
    const used = JSON.stringify(this.pipeline());
    const hit = paths.find((p) => used.includes(`"$${p}`) || used.includes(`"${p}"`) || used.includes(`"${p}.`));
    if (hit) throw new Error(`${model}: aggregate cannot use encrypted field "${hit}" — load the documents and compute in code`);
  });
}

/** Payroll entries: drop the per-day trace (large) from a decrypted entry. */
export function stripDays<T>(e: T): T {
  const a = (e as { attendance?: { days?: unknown } }).attendance;
  if (a && typeof a === "object") delete a.days;
  return e;
}