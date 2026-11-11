import { NextRequest, NextResponse } from "next/server";
import { revokeMcpToken } from "@/lib/mcp/oauth";

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const token = form?.get("token");
  if (typeof token === "string" && token.length <= 256) await revokeMcpToken(token);
  return new NextResponse(null, { status: 200, headers: { "cache-control": "no-store" } });
}
