import { handle, HttpError, getSessionUser } from "@/lib/auth";
import { readLocalFile, useLocalStorage, verifyLocalToken } from "@/lib/s3";

/**
 * Serves a file from LOCAL storage (used only when AWS S3 is not configured).
 * Needs BOTH a logged-in FMS session AND a valid, unexpired signed token that was issued
 * by an already-authorized API (payslip / invoice / challan download).
 */
export const GET = handle(async (req: Request) => {
  if (!useLocalStorage()) throw new HttpError(404, "Not found");
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, "Not authenticated");
  const t = verifyLocalToken(new URL(req.url).searchParams.get("t"));
  if (!t) throw new HttpError(403, "Link expired or invalid");
  const buf = await readLocalFile(t.key);
  const ext = t.key.split(".").pop()?.toLowerCase();
  const type = ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "jpg" ? "image/jpeg" : "application/octet-stream";
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `inline; filename="${t.name ?? "file"}"`,
      "Cache-Control": "private, no-store",
    },
  });
});