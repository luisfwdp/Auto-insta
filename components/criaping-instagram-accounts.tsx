"use client";

import Link from "next/link";
import type { AccountOption } from "@/components/account-select";
import type { RequestFailure } from "@/components/request-failure";
import { Button, Card, EmptyState, Skeleton } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n/provider";
import styles from "./onboarding.module.css";

export type InstagramAccountSummary = AccountOption & {
  provider?: "META" | "ZERNIO";
  tokenExpiresAt: string | null;
  webhookSubscribed: boolean;
};

export function CriapingInstagramAccounts({
  accounts,
  loading,
  busyAccountId,
  failure,
  onDisconnect,
  onRetry,
}: {
  accounts: InstagramAccountSummary[];
  loading: boolean;
  busyAccountId: string | null;
  failure: RequestFailure | null;
  onDisconnect: (accountId: string) => void;
  onRetry: () => void;
}) {
  const { t, locale } = useI18n();

  return (
    <Card
      aria-labelledby="instagram-accounts-title"
      aria-busy={loading || undefined}
    >
      <div className={styles.statusRow}>
        <div>
          <h2 id="instagram-accounts-title">{t("Instagram accounts")}</h2>
          <p className={styles.muted}>
            {accounts.length === 1
              ? t("{count} connected Instagram profile", { count: 1 })
              : t("{count} connected Instagram profiles", {
                  count: accounts.length,
                })}
          </p>
        </div>
        <span className={accounts.length ? styles.success : styles.warning}>
          {accounts.length ? t("Connected") : t("Not connected")}
        </span>
      </div>

      {loading ? (
        <Skeleton
          label={t("Checking your Instagram connection…")}
          className={styles.accountLoading}
        />
      ) : failure ? (
        <div className={styles.inlineError} role="alert">
          <p>{failureMessage(failure, t)}</p>
          {failure === "session" ? (
            <Link href="/login" className={styles.secondaryLink}>
              {t("Sign in again")}
            </Link>
          ) : (
            <Button variant="secondary" onClick={onRetry}>
              {t("Try again")}
            </Button>
          )}
        </div>
      ) : null}

      {!loading && accounts.length === 0 && !failure ? (
        <div className={styles.emptyAccount}>
          <EmptyState
            title={t("No Instagram account connected")}
            description={t(
              "Connect an Instagram professional account to launch campaigns.",
            )}
            action={
              <a className={styles.primaryLink} href="/api/instagram/connect">
                {t("Connect Instagram")}
              </a>
            }
          />
        </div>
      ) : !loading && accounts.length > 0 ? (
        <ul className={styles.accountList}>
          {accounts.map((account) => {
            const busy = busyAccountId === account.id;
            return (
              <li key={account.id}>
                <div className={styles.accountIdentity}>
                  <strong>{account.name || `@${account.username}`}</strong>
                  <span>@{account.username}</span>
                  <small>
                    {account.provider === "ZERNIO"
                      ? t("Connected via Zernio")
                      : `${t("Token expires")} ${
                          account.tokenExpiresAt
                            ? new Intl.DateTimeFormat(locale).format(
                                new Date(account.tokenExpiresAt),
                              )
                            : t("not available")
                        }`}
                    {" · "}
                    {account.webhookSubscribed
                      ? t("Webhook ready")
                      : t("Webhook pending")}
                  </small>
                </div>
                <div className={styles.accountActions}>
                  <Link
                    className={styles.secondaryLink}
                    href={`/campaigns/new?${new URLSearchParams({ instagramAccountId: account.id })}`}
                  >
                    {t("Create Campaign")}
                  </Link>
                  <Button
                    variant="danger"
                    loading={busy}
                    onClick={() => onDisconnect(account.id)}
                  >
                    {busy ? t("Disconnecting…") : t("Disconnect")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {!loading && accounts.length ? (
        <div className={styles.actions}>
          <a className={styles.primaryLink} href="/api/instagram/connect">
            {t("Connect another Instagram account")}
          </a>
        </div>
      ) : null}
    </Card>
  );
}

function failureMessage(
  failure: RequestFailure,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (failure === "session")
    return t("Your session expired. Sign in again to continue.");
  if (failure === "permission")
    return t("Your account does not have permission to complete this action.");
  if (failure === "external")
    return t("Instagram is temporarily unavailable. Try again later.");
  if (failure === "refused")
    return t(
      "The operation was refused. Review the account status and try again.",
    );
  return t("We could not load your Instagram accounts. Try again.");
}
