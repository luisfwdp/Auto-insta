import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Guards the Vercel cron routes. Vercel sends `Authorization: Bearer
 * <CRON_SECRET>` only when the project has a CRON_SECRET variable, so the
 * secret is required: without it every scheduled run would be refused, and
 * falling back to another value (the session secret used to be the fallback)
 * would turn that secret into a bearer token. Returns the response to send
 * when the request is not authorized, or null to continue.
 */
export function rejectUnauthorizedCron(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron] CRON_SECRET is not set; refusing to run scheduled jobs");
    return NextResponse.json(
      { success: false, error: "Cron is not configured" },
      { status: 503 }
    );
  }

  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(request.headers.get("authorization") ?? "");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  return null;
}
