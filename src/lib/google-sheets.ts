/**
 * Minimal Google Sheets client for FMS (service account, no extra npm package).
 *
 * .env.local (never commit, never share):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL=fms-sheets@your-project.iam.gserviceaccount.com
 *   GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
 * The Google Sheet must be shared (Editor) with GOOGLE_SERVICE_ACCOUNT_EMAIL.
 */
import { createSign } from "node:crypto";

const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const API = process.env.GOOGLE_SHEETS_API_BASE || "https://sheets.googleapis.com/v4/spreadsheets";

export class SheetsError extends Error {}

export function sheetsCredentials(): { email: string; key: string } | null {
  const email = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();
  const key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  return email && key.includes("PRIVATE KEY") ? { email, key } : null;
}

/** Accepts a full Google Sheets link or a bare spreadsheet id. */
export function parseSpreadsheetId(input: string): string | null {
  const s = String(input ?? "").trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : null;
}
export const sheetUrl = (id: string, gid?: number) => `https://docs.google.com/spreadsheets/d/${id}/edit${gid !== undefined ? `#gid=${gid}` : ""}`;

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");
let cached: { token: string; exp: number; email: string } | null = null;

async function accessToken(): Promise<string> {
  const cred = sheetsCredentials();
  if (!cred) throw new SheetsError("Google service account is not set in .env.local (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY)");
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.email === cred.email && cached.exp - 60 > now) return cached.token;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: cred.email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  let sig: string;
  try {
    sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(cred.key).toString("base64url");
  } catch {
    throw new SheetsError("GOOGLE_PRIVATE_KEY is not a valid private key (copy the whole private_key value from the JSON key file)");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` }),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !j.access_token) throw new SheetsError(`Google sign-in failed: ${j.error_description || j.error || res.status}`);
  cached = { token: j.access_token, exp: now + (j.expires_in ?? 3600), email: cred.email };
  return j.access_token;
}

async function gapi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
  if (!res.ok) {
    const m = j.error?.message || String(res.status);
    if (res.status === 403 || res.status === 404) throw new SheetsError(`Google Sheet not reachable (${m}). Share the sheet as Editor with ${sheetsCredentials()?.email}.`);
    throw new SheetsError(`Google Sheets error: ${m}`);
  }
  return j;
}

const colLetter = (n: number) => { let s = ""; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };

export interface SheetTable {
  title: string;
  columns: { label: string; money?: boolean; num?: boolean }[];
  rows: (string | number | null)[][];
}

/** Creates the tab if missing, then replaces its contents with the table (title row, header, rows, totals). */
export async function writeTab(spreadsheetId: string, tab: string, t: SheetTable): Promise<{ sheetId: number; rows: number }> {
  const id = encodeURIComponent(spreadsheetId);
  const meta = await gapi<{ sheets?: { properties: { sheetId: number; title: string } }[] }>(`/${id}?fields=sheets.properties(sheetId,title)`);
  let sheetId = meta.sheets?.find((x) => x.properties.title === tab)?.properties.sheetId;
  if (sheetId === undefined) {
    const r = await gapi<{ replies: { addSheet: { properties: { sheetId: number } } }[] }>(`/${id}:batchUpdate`, {
      method: "POST",
      body: { requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 3, frozenColumnCount: 1 } } } }] },
    });
    sheetId = r.replies[0].addSheet.properties.sheetId;
  }
  const range = encodeURIComponent(`'${tab.replace(/'/g, "''")}'`);
  await gapi(`/${id}/values/${range}:clear`, { method: "POST", body: {} });

  const first = 4, last = 3 + t.rows.length;
  const values: (string | number | null)[][] = [[t.title], [], t.columns.map((c) => c.label), ...t.rows];
  if (t.rows.length > 1) values.push(t.columns.map((c, i) => (i === 0 ? "TOTAL" : c.money || c.num ? `=SUM(${colLetter(i + 1)}${first}:${colLetter(i + 1)}${last})` : "")));
  await gapi(`/${id}/values/${range}?valueInputOption=USER_ENTERED`, { method: "PUT", body: { values } });

  const n = t.columns.length;
  const requests: unknown[] = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 3, frozenColumnCount: 1 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 13 } } }, fields: "userEnteredFormat.textFormat" } },
    { repeatCell: {
      range: { sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: n },
      cell: { userEnteredFormat: { backgroundColor: { red: 0.714, green: 0.843, blue: 0.659 }, textFormat: { bold: true }, horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" } },
      fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)",
    } },
    ...t.columns.flatMap((c, i) => (c.money ? [{ repeatCell: {
      range: { sheetId, startRowIndex: 3, startColumnIndex: i, endColumnIndex: i + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "₹#,##0.00" } } }, fields: "userEnteredFormat.numberFormat",
    } }] : [])),
    { autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: n } } },
  ];
  if (t.rows.length > 1) requests.push({ repeatCell: { range: { sheetId, startRowIndex: last, endRowIndex: last + 1, startColumnIndex: 0, endColumnIndex: n }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat" } });
  await gapi(`/${id}:batchUpdate`, { method: "POST", body: { requests } });
  return { sheetId, rows: t.rows.length };
}