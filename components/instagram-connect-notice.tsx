"use client";

import type { StaticMessageKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { useSearchParams } from "next/navigation";

type Tone = "error" | "warning" | "success";

export interface InstagramConnectFeedback {
  tone: Tone;
  title: StaticMessageKey;
  detail: StaticMessageKey;
  action?: StaticMessageKey;
  actionHref?: string;
}

const TONE_CLASSES: Record<Tone, string> = {
  error: "border-error/20 bg-error/10 text-error",
  warning: "border-warning/20 bg-warning/10 text-warning",
  success: "border-success/20 bg-success/10 text-success",
};

const MESSAGES: Record<string, InstagramConnectFeedback> = {
  connected: {
    tone: "success",
    title: "Instagram account connected",
    detail: "The professional account is now available in this workspace.",
    action: "Create Campaign",
    actionHref: "/campaigns/new",
  },
  denied: {
    tone: "warning",
    title: "Instagram connection cancelled",
    detail:
      "You declined the permission prompt on Instagram. Start again and accept all requested permissions.",
    action: "Try again",
    actionHref: "/api/instagram/connect",
  },
  invalid: {
    tone: "error",
    title: "OAuth return incomplete",
    detail:
      "The authorization return was incomplete or the signed login session expired. Start a new connection attempt.",
    action: "Try again",
    actionHref: "/api/instagram/connect",
  },
  forbidden: {
    tone: "error",
    title: "Not permitted",
    detail:
      "Only workspace owners and admins can connect an Instagram account.",
  },
  already_connected: {
    tone: "warning",
    title: "Account already connected",
    detail:
      "That Instagram account is connected to another workspace. Disconnect it there first, or connect a different account.",
  },
};

export function resolveInstagramConnectFeedback(
  status: string | null,
  reason: string | null,
): InstagramConnectFeedback | null {
  if (!status || status === "misconfigured") return null;
  if (status !== "failed") return MESSAGES[status] ?? null;

  const normalized = (reason ?? "").toLowerCase();
  if (normalized.includes("no instagram account was shared") || normalized.includes("professional account")) {
    return {
      tone: "error",
      title: "Professional Instagram account not found",
      detail: "Meta did not return a shared professional account. Confirm that the account is professional and selected during authorization.",
      action: "Try again",
      actionHref: "/api/instagram/connect",
    };
  }
  if (normalized.includes("share exactly one") || normalized.includes("permission")) {
    return {
      tone: "error",
      title: "Instagram permission is insufficient",
      detail: "The required account or permissions were not shared. Start again and select one professional account.",
      action: "Try again",
      actionHref: "/api/instagram/connect",
    };
  }
  if (normalized.includes("token exchange") || normalized.includes("redirect") || normalized.includes("authorization code")) {
    return {
      tone: "error",
      title: "Meta configuration needs attention",
      detail: "The authorization could not be validated. Review the Meta redirect URI and app configuration in Diagnostics.",
      action: "Open diagnostics",
      actionHref: "/diagnostics",
    };
  }
  if (normalized.includes("temporar") || normalized.includes("rate limit") || normalized.includes("meta api")) {
    return {
      tone: "warning",
      title: "Meta is temporarily unavailable",
      detail: "The connection could not be completed right now. Wait a moment and try again.",
      action: "Try again",
      actionHref: "/api/instagram/connect",
    };
  }
  return {
    tone: "error",
    title: "Instagram connection failed",
    detail: "The login was accepted, but the connection could not be completed. No account was marked as connected.",
    action: "Open diagnostics",
    actionHref: "/diagnostics",
  };
}

export function InstagramConnectNotice() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const status = searchParams.get("instagram");

  if (!status) return null;

  if (status === "misconfigured") {
    const missing = (searchParams.get("missing") ?? "")
      .split(",")
      .filter(Boolean);

    return (
      <Notice tone="error" title={t("Instagram app not configured")}>
        <p>
          {t("Set")}{" "}
          {missing.length > 0
            ? t("these environment variables")
            : t("the required environment variables")}{" "}
          {t("and restart the server:")}
        </p>
        {missing.length > 0 && (
          <ul className="mt-2 space-y-1">
            {missing.map((name) => (
              <li key={name} className="font-mono text-xs">
                {name}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2">
          {t("See")} <span className="font-mono text-xs">docs/setup.md</span> {t("for how to obtain each value. Note that")}{" "}
          <span className="font-mono text-xs">ENCRYPTION_KEY</span> {t("must be a 64-character hex string.")}
        </p>
        <a className="mt-3 inline-flex rounded border border-current/30 px-3 py-2 font-medium hover:bg-black/5" href="/diagnostics">
          {t("Open diagnostics")}
        </a>
      </Notice>
    );
  }

  const known = resolveInstagramConnectFeedback(status, searchParams.get("reason"));
  if (!known) return null;

  return (
    <Notice tone={known.tone} title={t(known.title)}>
      <p>{t(known.detail)}</p>
      {known.action && known.actionHref && (
        <a className="mt-3 inline-flex rounded border border-current/30 px-3 py-2 font-medium hover:bg-black/5" href={known.actionHref}>
          {t(known.action)}
        </a>
      )}
    </Notice>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded border p-4 text-sm ${TONE_CLASSES[tone]}`}
      role={tone === "success" ? "status" : "alert"}
      aria-live={tone === "success" ? "polite" : "assertive"}
    >
      <p className="font-semibold">{title}</p>
      <div className="mt-1 opacity-90">{children}</div>
    </div>
  );
}
