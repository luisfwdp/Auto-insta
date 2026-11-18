import type { NextRequest } from "next/server";
import { z } from "zod";
import { requestSubscriptionCancellation, readCancellation } from "@/lib/billing/cancellation";
import { BillingError } from "@/lib/billing/config";
import { billingFailure, billingJson, billingResourceId, readBillingJson, requireBillingOwner } from "@/lib/billing/http";

const cancellationRequest = z.object({ requestId: z.uuid() }).strict();

export async function POST(request: NextRequest) {
  try {
    const context = await requireBillingOwner(request, { write: true, cancellation: true });
    const parsed = cancellationRequest.safeParse(await readBillingJson(request));
    if (!parsed.success) throw new BillingError("INVALID_REQUEST", 400);
    const data = await requestSubscriptionCancellation(context.workspaceId, parsed.data.requestId);
    return billingJson({ id: data.id, status: data.status }, 202);
  } catch (error) { return billingFailure(error); }
}

export async function GET(request: NextRequest) {
  try {
    const context = await requireBillingOwner(request, { cancellation: true });
    const data = await readCancellation(context.workspaceId, billingResourceId(request));
    return billingJson({ id: data.id, status: data.status });
  } catch (error) { return billingFailure(error); }
}
