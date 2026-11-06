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
  checkOAuthState,
  encryptToken,
  exchangeCodeForToken,
} from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const error = params.get("error");
  const stateCheck = checkOAuthState(params.get("state"));
  const baseUrl = getBaseUrl();

  if (error) {
    await recordCallbackRejection("denied", {
      error: error.slice(0, 64),
      errorReason: params.get("error_reason")?.slice(0, 64) ?? null,
    });
    return NextResponse.redirect(`${baseUrl}/settings?instagram=denied`);
  }

  if (!code || !stateCheck.ok) {
    // Say which part was missing or wrong, never its value: the code and the
    // state are credentials for the next few minutes.
    const reason = !code ? "missing_code" : `state_${stateCheck.ok ? "ok" : stateCheck.reason}`;
    await recordCallbackRejection(reason, {
      hasCode: Boolean(code),
      hasState: params.has("state"),
      paramNames: [...new Set(params.keys())].slice(0, 12),
    });
    return NextResponse.redirect(
      `${baseUrl}/settings?instagram=invalid&reason=${reason}`
    );
  }
  const state = stateCheck.payload;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId: state.workspaceId,
      userId: session.user.id,
    },
  });

  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?instagram=forbidden`);
  }

  let unifiedDiagnostic:
    | {
        attempts: number;
        assignedAccountCount: number;
        clientBusinessId?: string;
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
      return NextResponse.redirect(
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
      if (!updated.count) return NextResponse.redirect(`${baseUrl}/settings?instagram=already_connected`);
    } else {
      await prisma.instagramAccount.create({ data: { ...data, workspaceId: state.workspaceId, instagramId, provider: 'META' } });
    }

    return NextResponse.redirect(`${baseUrl}/dashboard?connected=true`);
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

    return NextResponse.redirect(
      `${baseUrl}/settings?instagram=failed&reason=${encodeURIComponent(
        message.slice(0, 200)
      )}`
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
  details: Record<string, unknown>
): Promise<void> {
  console.warn("[Instagram Callback] Rejected:", reason, details);
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
