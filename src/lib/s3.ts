import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
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
  await s3().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType, ServerSideEncryption: "AES256" }),
  );
  return key;
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  assertFmsKey(key);
  const out = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const bytes = await out.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

export async function signedDownloadUrl(key: string, fileName?: string, seconds = 300): Promise<string> {
  assertFmsKey(key);
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
