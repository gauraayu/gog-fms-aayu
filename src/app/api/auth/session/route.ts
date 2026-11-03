import { NextResponse } from "next/server";
import { getSessionUser, handle } from "@/lib/auth";

export const GET = handle(async () => {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ authenticated: false }, { status: 401 });
  return NextResponse.json({ authenticated: true, user });
});
