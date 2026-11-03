import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { HttpError } from "./auth";

/**
 * FMS storage: same AWS account/bucket as OMS but ONLY under FMS_S3_PREFIX (default "gog-fms/"),
 * private objects, SSE, server-side uploads, short-lived signed GET URLs after authorization.
 * Uses FMS-specific IAM credentials (never OMS keys).
 */
export const PREFIX = (process.env.FMS_S3_PREFIX || "gog-fms/").replace(/^\/+/, "").replace(/\/?$/, "/");
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
};

let client: S3Client | null = null;
function s3(): S3Client {
  if (client) return client;
  const accessKeyId = process.env.FMS_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.FMS_AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey || !process.env.AWS_BUCKET_NAME) {
    throw new HttpError(503, "File storage is not configured (FMS_AWS_* / AWS_BUCKET_NAME)");
  }
  client = new S3Client({ region: process.env.AWS_REGION || "ap-south-1", credentials: { accessKeyId, secretAccessKey } });
  return client;
}
const bucket = () => process.env.AWS_BUCKET_NAME as string;

/**
 * LOCAL STORAGE FALLBACK — if AWS S3 is not configured (FMS_AWS_* / AWS_BUCKET_NAME missing),
 * files are saved on this computer under ./.fms-storage (override: FMS_LOCAL_STORAGE_DIR).
 * Active automatically outside production; in production only if FMS_LOCAL_STORAGE=true
 * (note: Vercel's disk is read-only/temporary, so use real S3 there).
 */
const s3Configured = () => !!(process.env.FMS_AWS_ACCESS_KEY_ID && process.env.FMS_AWS_SECRET_ACCESS_KEY && process.env.AWS_BUCKET_NAME);
export const useLocalStorage = () => !s3Configured() && (process.env.NODE_ENV !== "production" || process.env.FMS_LOCAL_STORAGE === "true");
const localRoot = () => path.resolve(process.env.FMS_LOCAL_STORAGE_DIR || ".fms-storage");
function localPath(key: string): string {
  assertFmsKey(key);
  const root = localRoot();
  const p = path.resolve(root, key);
  if (!p.startsWith(root + path.sep)) throw new HttpError(400, "Invalid storage key");
  return p;
}
function localSecret(): string {
  const s = process.env.FMS_SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV !== "production") return "gog-fms-local-storage-dev-secret";
  throw new HttpError(503, "FMS_SESSION_SECRET must be set to use local file storage");
}
const localSig = (body: string) => createHmac("sha256", localSecret()).update(`fms.file.${body}`).digest("base64url");
export const LOCAL_FILE_ROUTE = "/api/files/local";

/** Short-lived (5 min) link to a locally stored file — issued only after the caller was authorized. */
function localDownloadUrl(key: string, fileName?: string, seconds = 300): string {
  const body = Buffer.from(JSON.stringify({ key, name: fileName ? sanitize(fileName) : undefined, exp: Math.floor(Date.now() / 1000) + Math.min(seconds, 300) }), "utf8").toString("base64url");
  return `${LOCAL_FILE_ROUTE}?t=${body}.${localSig(body)}`;
}
export function verifyLocalToken(token: string | null): { key: string; name?: string } | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  let expected: string;
  try { expected = localSig(body); } catch { return null; }
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { key: string; name?: string; exp: number };
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    assertFmsKey(p.key);
    return { key: p.key, name: p.name };
  } catch { return null; }
}
export async function readLocalFile(key: string): Promise<Buffer> {
  try { return await fs.readFile(localPath(key)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "File not found in local storage"); throw e; }
}

export function assertFmsKey(key: string) {
  if (!key || !key.startsWith(PREFIX) || key.includes("..")) throw new HttpError(400, "Invalid storage key");
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);

/** Magic-byte check so a renamed file can't pass as a PDF/image. */
export function sniffType(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return null;
}

export function buildKey(folder: string, fileName: string, contentType: string): string {
  const ext = ALLOWED_TYPES[contentType] ?? "bin";
  const base = sanitize(fileName.replace(/\.[^.]+$/, "")) || "file";
  const key = `${PREFIX}${folder.replace(/^\/+|\/+$/g, "")}/${Date.now()}_${randomUUID().slice(0, 8)}_${base}.${ext}`;
  assertFmsKey(key);
  return key;
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  assertFmsKey(key);
  if (useLocalStorage()) {
    const p = localPath(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
    return key;
  }
  await s3().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType, ServerSideEncryption: "AES256" }),
  );
  return key;
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  assertFmsKey(key);
  if (useLocalStorage()) return readLocalFile(key);
  const out = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const bytes = await out.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

export async function signedDownloadUrl(key: string, fileName?: string, seconds = 300): Promise<string> {
  assertFmsKey(key);
  if (useLocalStorage()) return localDownloadUrl(key, fileName, seconds);
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentDisposition: fileName ? `inline; filename="${sanitize(fileName)}"` : undefined,
    }),
    { expiresIn: Math.min(seconds, 300) },
  );
}

/** Parse + validate a multipart file field. */
export async function readUpload(form: FormData, field = "file"): Promise<{ buf: Buffer; type: string; name: string }> {
  const f = form.get(field);
  if (!f || typeof f === "string") throw new HttpError(400, "File is required");
  const file = f as File;
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "File exceeds 10 MB");
  const buf = Buffer.from(await file.arrayBuffer());
  const type = sniffType(buf);
  if (!type) throw new HttpError(415, "Only PDF, PNG or JPG files are allowed");
  return { buf, type, name: file.name || "document" };
}