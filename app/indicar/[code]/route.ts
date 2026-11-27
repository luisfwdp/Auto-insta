import { NextResponse } from "next/server";
import { BATIDA_REFERRAL_COOKIE, verifiedBatidaReferral } from "@/lib/billing/batida-affiliate";

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const current = new URL(request.url);
  const response = NextResponse.redirect(new URL("/pricing", current));
  if (verifiedBatidaReferral(code, current.searchParams)) {
    response.cookies.set(BATIDA_REFERRAL_COOKIE, code, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/api/billing/checkout",
      maxAge: 30 * 24 * 60 * 60,
    });
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
