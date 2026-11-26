import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { connectDB } from "@/lib/db";
import { OmsEmployee } from "@/models/oms-readonly";
import { handle } from "@/lib/auth";
import { OTP_COOKIE, findChallenge, resendOtp } from "@/lib/login-otp";

/** Send a new OTP for the same sign-in (after 60 seconds). */
export const POST = handle(async () => {
  await connectDB();
  const challenge = (await cookies()).get(OTP_COOKIE)?.value;
  const ch = await findChallenge(challenge);
  const emp = ch ? await OmsEmployee.findOne({ _id: ch.uid }).select("name").lean() : null;
  return NextResponse.json(await resendOtp(challenge, emp?.name ? String(emp.name) : undefined));
});