import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isTrustedBrowserOrigin } from "@/lib/api/origin";
import { canManageBilling, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { isBillingEnabled } from "./trial";
import { BillingError, hasBillingProviderScope } from "./config";

export function billingJson(data: unknown, status = 200) {
  return NextResponse.json({ success: true, data }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Never serialize upstream/Prisma exceptions, input or secret-bearing messages. */
export function billingFailure(error: unknown) {
  const known = error instanceof BillingError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    && Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599;
  return NextResponse.json({ success: false, error: known ? error.code : "BILLING_UNAVAILABLE" },
    { status: known ? error.httpStatus : 503, headers: { "Cache-Control": "no-store" } });
}

export async function requireBillingOwner(request: NextRequest, { write = false, cancellation = false }: { write?: boolean; cancellation?: boolean } = {}) {
  if (write && (!request.headers.get("origin") || !isTrustedBrowserOrigin(request))) throw new BillingError("FORBIDDEN", 403);
  const context = await getCurrentWorkspaceContext();
  if (!context) throw new BillingError("UNAUTHORIZED", 401);
  if (!canManageBilling(context.role)) throw new BillingError("FORBIDDEN", 403);
  if (!isBillingEnabled() && !(cancellation && hasBillingProviderScope())) throw new BillingError("BILLING_DISABLED", 404);
  return context;
}

/** Enforce actual streamed bytes before parsing; Content-Length is only a hint. */
export async function readBillingJson(request: NextRequest): Promise<unknown> {
  const maximum = 4 * 1024;
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) throw new BillingError("BODY_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new BillingError("INVALID_REQUEST", 400);
  let bytes = 0, text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel().catch(() => {});
        throw new BillingError("BODY_TOO_LARGE", 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError("INVALID_REQUEST", 400);
  } finally { reader.releaseLock(); }
}

export function billingResourceId(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const ids = params.getAll("id");
  if (ids.length !== 1 || [...params.keys()].some(key => key !== "id") || !z.uuid().safeParse(ids[0]).success) throw new BillingError("INVALID_REQUEST", 400);
  return ids[0];
}
