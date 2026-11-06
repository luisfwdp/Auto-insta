"use client";

import type { AccountOption } from "@/components/account-select";
import { useI18n } from "@/lib/i18n/provider";

export type InstagramConnectionAccount = AccountOption & {
  provider?: "META" | "ZERNIO";
  tokenExpiresAt: string | null;
  webhookSubscribed: boolean;
};

interface InstagramConnectionPanelProps {
  accounts: InstagramConnectionAccount[];
  busyAccountId?: string | null;
  error?: boolean;
  loading?: boolean;
  onDisconnect?: (accountId: string) => void;
  onRetry?: () => void;
}

export function InstagramConnectionPanel({
  accounts,
  busyAccountId = null,
  error = false,
  loading = false,
  onDisconnect,
  onRetry,
}: InstagramConnectionPanelProps) {
  const { t, locale } = useI18n();

  if (loading) {
    return (
      <section id="instagram-connection" className="panel rounded p-4 sm:p-6" role="status" aria-busy="true" aria-label={t("Loading Instagram connection status")}>
        <div className="h-5 w-44 animate-pulse rounded bg-surface" />
        <div className="mt-6 h-20 animate-pulse rounded bg-surface" />
      </section>
    );
  }

  return (
    <section id="instagram-connection" className="panel rounded p-4 sm:p-6">
      <h2 className="mb-6 text-base font-semibold">{t("Instagram Connection")}</h2>
      {error ? (
        <div className="rounded border border-error/20 bg-error/10 p-4 text-sm text-error" role="alert">
          <p className="font-semibold">{t("Connection status unavailable")}</p>
          <p className="mt-1 opacity-90">{t("We could not verify your Instagram connection. No connection status was assumed.")}</p>
          {onRetry && <button type="button" className="mt-3 rounded border border-error/30 px-3 py-2 font-medium hover:bg-error/10" onClick={onRetry}>{t("Reload")}</button>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 border-b border-border py-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t("Status")}</p>
              <p className="mt-0.5 text-xs text-muted">{t("Comment webhooks and private replies depend on this connection.")}</p>
            </div>
            <span className={`rounded-full px-3 py-1.5 text-xs font-medium ${accounts.length > 0 ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>
              {accounts.length > 0 ? t("Connected") : t("Not connected")}
            </span>
          </div>
          {accounts.length === 0 ? (
            <div className="py-3"><p className="text-sm text-muted">{t("Connect an Instagram professional account to launch campaigns.")}</p></div>
          ) : (
            <div className="space-y-3 py-3">
              {accounts.map((account) => (
                <div key={account.id} className="flex flex-col gap-3 rounded border border-border bg-surface/70 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-foreground">@{account.username}</p>
                    <p className="mt-1 text-xs text-muted">
                      {account.provider === "ZERNIO" ? t("Connected via Zernio") : <>{t("Token expires")} {account.tokenExpiresAt ? new Date(account.tokenExpiresAt).toLocaleDateString(locale) : t("not available")}</>}{" "}
                      · {account.webhookSubscribed ? t("Webhook ready") : t("Webhook pending")}
                    </p>
                  </div>
                  {onDisconnect && <button type="button" onClick={() => onDisconnect(account.id)} disabled={busyAccountId === account.id} className="inline-flex items-center justify-center rounded border border-error/20 px-4 py-2 text-sm font-medium text-error transition-all hover:border-error/40 hover:bg-error/10 disabled:opacity-50">{busyAccountId === account.id ? t("Disconnecting...") : t("Disconnect")}</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {!error && <div className="mt-6 flex gap-3 border-t border-border pt-4"><a href="/api/instagram/connect" className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover">{accounts.length > 0 ? t("Connect another Instagram account") : t("Connect using your own Meta app")}</a></div>}
    </section>
  );
}
