import { createHash } from "node:crypto";
import { z } from "zod";
import type { InstagramContext } from "@/lib/instagram/context";
import { DeliveryUnconfirmedError, isConfirmedSendRejection } from "@/lib/instagram/delivery-errors";
import { ZernioApiError } from "@/lib/zernio/client";
import { assertCommercialAccountUsable } from "./commercial-capacity";
import { findCommercialUsageOperation, reserveCommercialUsage, beginCommercialDispatch, finishCommercialDispatch, readCommercialUsageReceipt } from "./commercial-usage";
import { BillingError } from "./config";
import { isBillingEnabled } from "./trial";

const providerId = z.string().min(1).max(2048).regex(/^[!-~]+$/);
const sendReceipt = z.object({ message_id: providerId, recipient_id: providerId.optional() }).strict();
const savedReceipt = z.object({ messageId: providerId, recipientId: providerId.optional() }).strict();
type MessageResult = z.infer<typeof sendReceipt>;
type MessageKind = "private_plain" | "private_button" | "private_link" | "direct_plain" | "direct_button" | "direct_link";
const uncertain = () => new DeliveryUnconfirmedError(new Error("Commercial message delivery needs reconciliation"));
function workspace(context: InstagramContext) {
  if (!context.workspaceId) throw new BillingError("COMMERCIAL_MESSAGE_CONTEXT_REQUIRED", 400);
  return context.workspaceId;
}

/** Public replies require usable account/access but consume no DM allocation. */
export async function assertCommercialPublicReply(context: InstagramContext) {
  if (!isBillingEnabled()) return;
  await assertCommercialAccountUsable(workspace(context), context.instagramId);
}

/** One reservation per effective DM call, shared by Meta and Zernio. Only a real
 * provider receipt may complete/replay it. A lost response or persistence failure
 * remains held; no synthetic IDs, release timer or automatic resend is allowed.
 */
export async function executeCommercialMessage(input: {
  context: InstagramContext;
  instagramAccountId: string;
  kind: MessageKind;
  targetId: string;
  payload: unknown;
}, send: () => Promise<MessageResult>): Promise<MessageResult> {
  if (!isBillingEnabled()) return send();
  const { context } = input, workspaceId = workspace(context);
  if (context.instagramId !== input.instagramAccountId) throw new BillingError("COMMERCIAL_MESSAGE_ACCOUNT_MISMATCH", 403);
  if (typeof context.operationId !== "string" || !context.operationId.trim() || context.operationId.length > 512)
    throw new BillingError("COMMERCIAL_MESSAGE_OPERATION_REQUIRED", 400);
  const manual = context.operationId.startsWith("manual:");
  const requestId = manual ? z.uuid().safeParse(context.operationId.slice("manual:".length)) : null;
  if (manual && !requestId?.success) throw new BillingError("COMMERCIAL_MESSAGE_OPERATION_REQUIRED", 400);
  const operationId = requestId?.success ? `manual:${requestId.data.toLowerCase()}` : context.operationId;
  // Automated operations retain their existing identity, including payload and
  // kind (a proven button rejection may fall back to a separate plain call).
  // A manual UUID identifies ONE immutable intent: changing body/account/target
  // must conflict with that UUID rather than allocate a second send identity.
  // Payload/target stay in process memory only; the ledger receives digests.
  const intent = createHash("sha256").update(JSON.stringify({ version: 1, instagramId: input.instagramAccountId,
    operationId, kind: input.kind, target: input.targetId, payload: input.payload })).digest("hex");
  const key = manual ? createHash("sha256").update(JSON.stringify({ version: 1, operationId })).digest("hex") : intent;
  const replay = async (reservationId: string): Promise<MessageResult> => {
    try {
      const receipt = savedReceipt.safeParse(await readCommercialUsageReceipt(workspaceId, reservationId));
      if (!receipt.success) throw uncertain();
      return { message_id: receipt.data.messageId, ...(receipt.data.recipientId ? { recipient_id: receipt.data.recipientId } : {}) };
    } catch { throw uncertain(); }
  };
  const previous = manual
    ? await findCommercialUsageOperation(workspaceId, "DM", `message:${key}`, 1, intent)
    : await findCommercialUsageOperation(workspaceId, "DM", `message:${key}`, 1);
  if (previous?.status === "COMMITTED") return replay(previous.reservationId);
  if (previous && !["RESERVED", "REJECTED"].includes(previous.status)) throw uncertain();
  // Reject unusable/expired accounts before creating or rearming any hold.
  await assertCommercialAccountUsable(workspaceId, context.instagramId);
  const reservation = manual
    ? await reserveCommercialUsage(workspaceId, "DM", `message:${key}`, 1, intent)
    : await reserveCommercialUsage(workspaceId, "DM", `message:${key}`, 1);
  if (reservation.mode === "legacy") return send();
  // Another worker may have committed between the lookup and reservation CAS.
  if (reservation.status === "COMMITTED") return replay(reservation.reservationId);
  if (reservation.status !== "RESERVED") throw uncertain();
  const claim = await beginCommercialDispatch(workspaceId, reservation.reservationId);
  if (!claim) throw uncertain();
  let result: MessageResult;
  try {
    result = await send();
  } catch (error) {
    // HTTP408/409 cannot prove a Zernio side effect did not happen. Do not turn
    // these into reusable dispatches even if a generic classifier accepts4xx.
    const rejected = isConfirmedSendRejection(error) && !(error instanceof ZernioApiError && [408, 409].includes(error.code));
    let finished: boolean;
    try {
      finished = await finishCommercialDispatch(workspaceId, reservation.reservationId, claim.dispatchToken, rejected ? "DEFINITELY_REJECTED" : "UNKNOWN");
    } catch { throw uncertain(); }
    if (rejected && finished) throw error;
    throw uncertain();
  }
  const receipt = sendReceipt.safeParse(result);
  if (!receipt.success) {
    await finishCommercialDispatch(workspaceId, reservation.reservationId, claim.dispatchToken, "UNKNOWN").catch(() => {});
    throw uncertain();
  }
  try {
    const finished = await finishCommercialDispatch(workspaceId, reservation.reservationId, claim.dispatchToken, "CONFIRMED", {
      messageId: receipt.data.message_id, ...(receipt.data.recipient_id ? { recipientId: receipt.data.recipient_id } : {}) });
    if (!finished) throw uncertain();
  } catch { throw uncertain(); }
  return receipt.data;
}
