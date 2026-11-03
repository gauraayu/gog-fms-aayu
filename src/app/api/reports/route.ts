import { NextResponse } from "next/server";
import { can, handle, HttpError, requireUser } from "@/lib/auth";
import { buildReport, REPORT_TYPES, reportToPdf, reportToXlsx } from "@/lib/reports";
import { audit } from "@/lib/audit";

/** Exports follow the same permission checks as the screens (REPORT_TYPES[type].perm). */
export const GET = handle(async (req: Request) => {
  const user = await requireUser("reports.view");
  const u = new URL(req.url);
  const type = u.searchParams.get("type") || "";
  const def = REPORT_TYPES[type];
  if (!def) throw new HttpError(400, "Unknown report type");
  if (!can(user, def.perm)) throw new HttpError(403, `Missing permission: ${def.perm}`);
  const format = u.searchParams.get("format") || "json";
  let report;
  try {
    report = await buildReport(type, {
      month: u.searchParams.get("month") || undefined,
      fy: u.searchParams.get("fy") || undefined,
      dept: u.searchParams.get("dept") || undefined,
      employeeId: u.searchParams.get("employeeId") || undefined,
      challanType: u.searchParams.get("challanType") || undefined,
    });
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  if (format === "json") return NextResponse.json(report);
  await audit(user, "report.export", { entity: "report", entityId: type, updatedValue: { format, params: Object.fromEntries(u.searchParams) } });
  const safe = type.replace(/[^a-z-]/g, "");
  if (format === "xlsx") {
    return new Response(new Uint8Array(await reportToXlsx(report)), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="gog-fms-${safe}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  }
  if (format === "pdf") {
    return new Response(new Uint8Array(reportToPdf(report)), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="gog-fms-${safe}.pdf"`, "Cache-Control": "no-store" },
    });
  }
  throw new HttpError(400, "format must be json, xlsx or pdf");
});
