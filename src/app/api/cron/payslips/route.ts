import { NextResponse } from "next/server";

/**
 * Automatic payslip emailing is DISABLED by decision (3 Nov 2026):
 * payslips are emailed only when HR / Accounts clicks "Send" in Payslip Management
 * (after previewing). This route is kept only so an old Vercel cron call gets a clear answer.
 */
export async function GET() {
  return NextResponse.json({ skipped: "Automatic payslip email is disabled. Use Payslip Management → Preview → Send." });
}