import { createHash, randomUUID } from "node:crypto";
import * as meta from "@/lib/meta/client";
import {
  zernioRequest,
  ZernioApiError,
  ZernioDeliveryUnconfirmedError,
} from "@/lib/zernio/client";
import type { InstagramContext, ZernioContext } from "./context";
import { executeCommercialMessage, assertCommercialPublicReply } from "@/lib/billing/commercial-messaging";

type Button =
  | { type: "url"; title: string; url: string }
  | { type: "postback"; title: string; payload: string };

async function sendZernioMessage({
  context,
  recipientId,
  commentId,
  postId,
  text,
  buttons,
}: {
  context: ZernioContext;
  recipientId?: string;
  commentId?: string;
  postId?: string;
  text: string;
  buttons?: Button[];
}) {
  const path = commentId
    ? `/inbox/comments/${encodeURIComponent(postId ?? commentId)}/${encodeURIComponent(commentId)}/private-reply`
    : `/inbox/conversations/${encodeURIComponent(recipientId!)}/messages`;
  const body = {
    accountId: context.accountId,
    message: buttons ? text.slice(0, 640) : text,
    ...(buttons ? { buttons } : {}),
  };
  const idempotencyKey = createHash("sha256")
    .update(
      JSON.stringify({
        operationId: context.operationId ?? randomUUID(),
        path,
        body,
      })
    )
    .digest("hex");
  const result = await zernioRequest<{
    messageId?: string;
    data?: { messageId: string };
  }>({
    apiKey: context.apiKey,
    path,
    method: "POST",
    body,
    ...(commentId ? {} : { idempotencyKey }),
  }).catch((error: unknown) => {
    // A send may have succeeded upstream before a network/5xx failure. The
    // service releases idempotency claims on non-2xx, so do not auto-resend.
    if (error instanceof ZernioApiError && error.code >= 500)
      throw new ZernioDeliveryUnconfirmedError();
    throw error;
  });
  const messageId = result?.messageId ?? result?.data?.messageId;
  if (!messageId) throw new ZernioDeliveryUnconfirmedError();
  return {
    message_id: messageId,
    ...(recipientId ? { recipient_id: recipientId } : {}),
  };
}

function linkButtons(buttons: meta.LinkButton[]): Button[] {
  return buttons
    .slice(0, 3)
    .map(({ title, url }) => ({ type: "url", title: title.slice(0, 20), url }));
}

export async function sendPrivateReply({
  context,
  instagramAccountId,
  commentId,
  message,
  postId,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  commentId: string;
  message: string;
  postId?: string;
}) {
  return executeCommercialMessage({ context, instagramAccountId, kind: "private_plain", targetId: commentId, payload: { message, postId } }, async () => {
    if (context.provider === "META")
      return meta.sendPrivateReply(
        context.accessToken,
        instagramAccountId,
        commentId,
        message
      );
    return sendZernioMessage({ context, commentId, postId, text: message });
  });
}

export async function sendPrivateReplyWithButton({
  context,
  instagramAccountId,
  commentId,
  text,
  buttonTitle,
  payload,
  postId,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  commentId: string;
  text: string;
  buttonTitle: string;
  payload: string;
  postId?: string;
}) {
  return executeCommercialMessage({ context, instagramAccountId, kind: "private_button", targetId: commentId, payload: { text: text.slice(0, 640), buttonTitle: buttonTitle.slice(0, 20), payload, postId } }, async () => {
    if (context.provider === "META")
      return meta.sendPrivateReplyWithButton(
        context.accessToken,
        instagramAccountId,
        commentId,
        text,
        buttonTitle,
        payload
      );
    return sendZernioMessage({
      context,
      commentId,
      postId,
      text: text,
      buttons: [{ type: "postback", title: buttonTitle.slice(0, 20), payload }],
  });
  });
}

export async function sendDirectMessageWithButton({
  context,
  instagramAccountId,
  userId,
  text,
  buttonTitle,
  payload,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  text: string;
  buttonTitle: string;
  payload: string;
}) {
  return executeCommercialMessage({ context, instagramAccountId, kind: "direct_button", targetId: userId, payload: { text: text.slice(0, 640), buttonTitle: buttonTitle.slice(0, 20), payload } }, async () => {
    if (context.provider === "META")
      return meta.sendDirectMessageWithButton(
        context.accessToken,
        instagramAccountId,
        userId,
        text,
        buttonTitle,
        payload
      );
    return sendZernioMessage({
      context,
      recipientId: userId,
      text: text,
      buttons: [{ type: "postback", title: buttonTitle.slice(0, 20), payload }],
  });
  });
}

export async function sendPrivateReplyWithLinkButton({
  context,
  instagramAccountId,
  commentId,
  text,
  buttons,
  postId,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  commentId: string;
  text: string;
  buttons: meta.LinkButton[];
  postId?: string;
}) {
  return executeCommercialMessage({ context, instagramAccountId, kind: "private_link", targetId: commentId, payload: { text: text.slice(0, 640), buttons: linkButtons(buttons), postId } }, async () => {
    if (context.provider === "META")
      return meta.sendPrivateReplyWithLinkButton(
        context.accessToken,
        instagramAccountId,
        commentId,
        text,
        buttons
      );
    return sendZernioMessage({
      context,
      commentId,
      postId,
      text: text,
      buttons: linkButtons(buttons),
  });
  });
}

export async function sendDirectMessage({
  context,
  instagramAccountId,
  userId,
  message,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  message: string;
}) {
  return executeCommercialMessage({ context, instagramAccountId, kind: "direct_plain", targetId: userId, payload: { message } }, async () => {
    if (context.provider === "META")
      return meta.sendDirectMessage(
        context.accessToken,
        instagramAccountId,
        userId,
        message
      );
    return sendZernioMessage({ context, recipientId: userId, text: message });
  });
}

export async function sendDirectMessageWithLinkButton({
  context,
  instagramAccountId,
  userId,
  text,
  buttons,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  text: string;
  buttons: meta.LinkButton[];
}) {
  return executeCommercialMessage({ context, instagramAccountId, kind: "direct_link", targetId: userId, payload: { text: text.slice(0, 640), buttons: linkButtons(buttons) } }, async () => {
    if (context.provider === "META")
      return meta.sendDirectMessageWithLinkButton(
        context.accessToken,
        instagramAccountId,
        userId,
        text,
        buttons
      );
    return sendZernioMessage({
      context,
      recipientId: userId,
      text: text,
      buttons: linkButtons(buttons),
  });
  });
}

export async function sendCommentReply({
  context,
  commentId,
  message,
  postId,
}: {
  context: InstagramContext;
  commentId: string;
  message: string;
  postId?: string;
}) {

  await assertCommercialPublicReply(context);
  if (context.provider === "META")
    return meta.sendCommentReply(context.accessToken, commentId, message);
  const result = await zernioRequest<{ data: { commentId: string } }>({
    apiKey: context.apiKey,
    path: `/inbox/comments/${encodeURIComponent(postId ?? commentId)}`,
    method: "POST",
    body: { accountId: context.accountId, commentId, message },
  }).catch((error: unknown) => {
    if (error instanceof ZernioApiError && error.code >= 500) throw new ZernioDeliveryUnconfirmedError();
    throw error;
  });
  if (!result?.data?.commentId) throw new ZernioDeliveryUnconfirmedError();
  return { id: result.data.commentId };
}
