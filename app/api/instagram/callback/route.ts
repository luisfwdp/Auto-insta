import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl, getInstagramLoginMode } from "@/lib/env";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import {
  getLongLivedToken,
  getUserInfo,
  resolveAssignedInstagramAccounts,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";
import type { InstagramUser } from "@/lib/meta/client";
import {
  OAUTH_NONCE_COOKIE,
  checkOAuthState,
  encryptToken,
  exchangeCodeForToken,
} from "@/lib/meta/oauth";
import { timingSafeEqual } from "node:crypto";
import { consumeOAuthNonce } from "@/lib/meta/oauth-nonce";
import { canManageWorkspace } from "@/lib/workspace-access";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const error = params.get("error");
  const stateCheck = checkOAuthState(params.get("state"));
  const baseUrl = getBaseUrl();
  // Rejections are only persisted for a signed-in user, so an anonymous loop
  // against this public URL cannot grow OperationalEvent.
  const session = await auth();
  const userId = session?.user?.id ?? null;

  if (error) {
    await recordCallbackRejection("denied", userId, {
      error: error.slice(0, 64),
      errorReason: params.get("error_reason")?.slice(0, 64) ?? null,
    });
    return finish(`${baseUrl}/settings?instagram=denied`);
  }

  if (!code || !stateCheck.ok) {
    // Say which part was missing or wrong, never its value: the code and the
    // state are credentials for the next few minutes.
    const reason = !code ? "missing_code" : `state_${stateCheck.ok ? "ok" : stateCheck.reason}`;
    await recordCallbackRejection(reason, userId, {
      hasCode: Boolean(code),
      hasState: params.has("state"),
      paramNames: [...new Set(params.keys())].slice(0, 12),
    });
    return finish(`${baseUrl}/settings?instagram=invalid&reason=${reason}`);
  }
  const state = stateCheck.payload;

  if (!userId) {
    return finish(`${baseUrl}/login`);
  }

  // The state is bound to the member who started the connect and to the
  // one-time nonce cookie set in their browser; both must match, and the
  // cookie is cleared on every response below, so the state cannot be
  // replayed from another session or used twice.
  const cookieNonce = request.cookies.get(OAUTH_NONCE_COOKIE)?.value ?? "";
  const bindingFailure =
    state.userId !== userId
      ? "state_user_mismatch"
      : !sameSecret(cookieNonce, state.nonce)
        ? "state_nonce_mismatch"
        : null;
  // Consume the server-side nonce atomically before touching Meta, so only
  // one callback per state can ever reach the code exchange.
  // A store outage fails closed with its own reason rather than "already used".
  const consumed = bindingFailure
    ? false
    : await consumeOAuthNonce(state.nonce, userId, state.workspaceId).catch(() => null);
  if (!bindingFailure && consumed === null) {
    await recordCallbackRejection("state_store_unavailable", userId, {});
    return finish(`${baseUrl}/settings?instagram=failed&reason=state_store_unavailable`);
  }
  if (!bindingFailure && !consumed) {
    await recordCallbackRejection("state_already_used", userId, {});
    return finish(`${baseUrl}/settings?instagram=invalid&reason=state_already_used`);
  }
  if (bindingFailure) {
    await recordCallbackRejection(bindingFailure, userId, {
      hasNonceCookie: Boolean(cookieNonce),
    });
    return finish(`${baseUrl}/settings?instagram=invalid&reason=${bindingFailure}`);
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId: state.workspaceId,
      userId,
    },
  });

  if (!membership || !canManageWorkspace(membership.role)) {
    return finish(`${baseUrl}/settings?instagram=forbidden`);
  }

  let unifiedDiagnostic:
    | {
        attempts: number;
        assignedAccountCount: number;
        clientBusinessId?: string;
        source?: string;
        grantedPermissions?: string[];
        lookups?: Record<string, number | string>;
      }
    | undefined;

  try {
    const redirectUri = `${baseUrl}/api/instagram/callback`;
    const { accessToken: exchangedToken } = await exchangeCodeForToken(
      code,
      redirectUri
    );
    const unifiedLogin = getInstagramLoginMode() === "unified";
    let accessToken = exchangedToken;
    let tokenExpiresAt: Date | null = null;
    let instagramId: string;
    let userInfo: InstagramUser;

    if (unifiedLogin) {
      const resolution = await resolveAssignedInstagramAccounts(accessToken);
      const assignedAccounts = resolution.accounts;
      unifiedDiagnostic = {
        attempts: resolution.attempts,
        assignedAccountCount: assignedAccounts.length,
        clientBusinessId: resolution.clientBusinessId,
        source: resolution.source,
        grantedPermissions: resolution.diagnostics?.grantedPermissions,
        lookups: resolution.diagnostics?.lookups,
      };
      if (assignedAccounts.length !== 1) {
        throw new Error(
          assignedAccounts.length === 0
            ? "No Instagram account was shared during login"
            : "Share exactly one Instagram account during login"
        );
      }
      instagramId = assignedAccounts[0].id;
      userInfo = await getUserInfo(accessToken, instagramId);
    } else {
      const longLived = await getLongLivedToken(exchangedToken);
      accessToken = longLived.accessToken;
      tokenExpiresAt = new Date(Date.now() + longLived.expiresIn * 1000);
      userInfo = await getUserInfo(accessToken);
      // Legacy Instagram Login returns an app-scoped id and the professional
      // account id as user_id. Webhooks and messages use the latter.
      instagramId = userInfo.user_id ?? userInfo.id;
    }
    const connection = await canConnectInstagramAccount({
      workspaceId: state.workspaceId,
      instagramId,
    });

    if (!connection.allowed) {
      return finish(
        `${baseUrl}/settings?instagram=already_connected`
      );
    }

    const encryptedToken = encryptToken(accessToken);

    let webhookSubscribed = false;
    try {
      const subscription = await subscribeInstagramAccountToWebhooks(
        instagramId,
        accessToken
      );
      webhookSubscribed = Boolean(subscription.success);
    } catch (subscriptionError) {
      console.warn(
        "[Instagram Callback] Webhook subscription failed:",
        subscriptionError
      );
    }

    const data = {
      username: userInfo.username,
      name: userInfo.name,
      accessToken: encryptedToken,
      tokenExpiresAt,
      webhookSubscribed,
    };
    const existing = await prisma.instagramAccount.findUnique({ where: { instagramId } });
    if (existing) {
      const updated = await prisma.instagramAccount.updateMany({
        where: { id: existing.id, workspaceId: state.workspaceId, provider: 'META' }, data,
      });
      if (!updated.count) return finish(`${baseUrl}/settings?instagram=already_connected`);
    } else {
      await prisma.instagramAccount.create({ data: { ...data, workspaceId: state.workspaceId, instagramId, provider: 'META' } });
    }

    return finish(`${baseUrl}/dashboard?connected=true`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Instagram Callback] Error:", err);
    // The message is the only diagnostic a self-hoster gets for a failed
    // connect, so persist it alongside the other operational events rather
    // than leaving it in server logs they may not be able to reach.
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: "Instagram connection failed",
          payload: {
            reason: message,
            ...(unifiedDiagnostic ? { unifiedLogin: unifiedDiagnostic } : {}),
          },
        },
      })
      .catch(() => {});

    // Only an allow-listed code goes in the URL (browser history, referrers,
    // screenshots); the sanitized detail stays in the operational event.
    return finish(
      `${baseUrl}/settings?instagram=failed&reason=${failureCode(message)}`
    );
  }
}

/**
 * Persists why a callback was turned away before any Meta call. The state
 * could not be trusted here, so the event is instance-wide (no workspace) and
 * only operators see it in Diagnostics.
 */
async function recordCallbackRejection(
  reason: string,
  userId: string | null,
  details: Record<string, unknown>
): Promise<void> {
  console.warn("[Instagram Callback] Rejected:", reason, details);
  if (!userId) return;
  await prisma.operationalEvent
    .create({
      data: {
        source: "SYSTEM",
        level: "WARNING",
        message: "Instagram callback rejected",
        payload: { reason, ...details },
      },
    })
    .catch(() => {});
}

/** Redirect that also clears the one-time nonce cookie. */
function finish(url: string): NextResponse {
  const response = NextResponse.redirect(url);
  response.cookies.set(OAUTH_NONCE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/api/instagram/callback",
    maxAge: 0,
  });
  return response;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function failureCode(message: string): string {
  if (message === "No Instagram account was shared during login") return "no_account_shared";
  if (message === "Share exactly one Instagram account during login") return "multiple_accounts_shared";
  if (/access[_ ]token|oauth|verification code/i.test(message)) return "token_exchange_failed";
  return "connection_failed";
}
