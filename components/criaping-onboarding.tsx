"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AccountOption } from "@/components/account-select";
import {
  classifyRequestFailure,
  type RequestFailure,
} from "@/components/request-failure";
import { Button, Card, Skeleton } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n/provider";
import styles from "./onboarding.module.css";

type ConnectionState =
  | { status: "loading"; slow: boolean }
  | { status: "ready"; accounts: AccountOption[] }
  | { status: "error"; failure: RequestFailure };

export default function CriapingOnboarding({
  metaConfigured,
}: {
  metaConfigured: boolean;
}) {
  const [state, setState] = useState<ConnectionState>({
    status: "loading",
    slow: false,
  });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    const slowTimer = window.setTimeout(() => {
      setState((current) =>
        current.status === "loading" ? { status: "loading", slow: true } : current,
      );
    }, 8_000);

    fetch("/api/instagram/accounts", {
      cache: "no-store",
      signal: abort.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.success) {
          throw classifyRequestFailure(response.status);
        }
        if (abort.signal.aborted) return;
        setState({
          status: "ready",
          accounts: payload.data.instagramAccounts as AccountOption[],
        });
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return;
        setState({
          status: "error",
          failure:
            typeof failure === "string"
              ? (failure as RequestFailure)
              : "api",
        });
      })
      .finally(() => window.clearTimeout(slowTimer));

    return () => {
      abort.abort();
      window.clearTimeout(slowTimer);
    };
  }, [reload]);

  return (
    <CriapingOnboardingView
      state={state}
      metaConfigured={metaConfigured}
      onRetry={() => {
        setState({ status: "loading", slow: false });
        setReload((current) => current + 1);
      }}
    />
  );
}

export function CriapingOnboardingView({
  state,
  metaConfigured,
  onRetry,
}: {
  state: ConnectionState;
  metaConfigured: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const accounts = state.status === "ready" ? state.accounts : [];
  const connected = accounts.length > 0;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>{t("Welcome to CRIA PING")}</h1>
          <p>
            {t(
              "Connect your Instagram account and create your first campaign with real data.",
            )}
          </p>
        </div>
        <Link href="/dashboard" className={styles.secondaryLink}>
          {t("Back to dashboard")}
        </Link>
      </header>

      <ol className={styles.steps} aria-label={t("First steps")}>
        {[t("Welcome"), t("Instagram account"), t("Campaign")].map(
          (label, index) => (
            <li
              key={label}
              data-active={
                index === 0 ||
                (index === 1 && state.status !== "loading") ||
                (index === 2 && connected)
              }
            >
              <span>{index + 1}</span>
              {label}
            </li>
          ),
        )}
      </ol>

      {state.status === "loading" ? (
        <Card aria-live="polite" aria-busy="true">
          <Skeleton
            label={t("Checking your Instagram connection…")}
            className={styles.loading}
          />
          <h2>{t("Checking your Instagram connection…")}</h2>
          {state.slow ? (
            <p className={styles.muted}>
              {t(
                "This is taking longer than expected. Your data has not been replaced or estimated.",
              )}
            </p>
          ) : null}
        </Card>
      ) : state.status === "error" ? (
        <RequestFailureState failure={state.failure} onRetry={onRetry} />
      ) : connected ? (
        <Card>
          <div className={styles.statusRow}>
            <div>
              <h2>{t("Instagram connected")}</h2>
              <p className={styles.muted}>
                {t("Choose an account for your first campaign.")}
              </p>
            </div>
            <span className={styles.success}>{t("Connected")}</span>
          </div>
          <ul className={styles.accountList}>
            {accounts.map((account) => (
              <li key={account.id}>
                <div className={styles.accountIdentity}>
                  <strong>{account.name || `@${account.username}`}</strong>
                  <span>@{account.username}</span>
                </div>
                <Link
                  className={styles.primaryLink}
                  href={`/campaigns/new?${new URLSearchParams({ instagramAccountId: account.id })}`}
                >
                  {t("Create Campaign")}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Card>
          <div className={styles.statusRow}>
            <div>
              <h2>
                {metaConfigured
                  ? t("Connect Instagram")
                  : t("Meta is not configured")}
              </h2>
              <p className={styles.muted}>
                {metaConfigured
                  ? t(
                      "Connect an Instagram professional account to launch campaigns.",
                    )
                  : t(
                      "Instagram connection is unavailable until an administrator configures Meta.",
                    )}
              </p>
            </div>
            <span className={styles.warning}>{t("Not connected")}</span>
          </div>
          <div className={styles.actions}>
            {metaConfigured ? (
              <a className={styles.primaryLink} href="/api/instagram/connect">
                {t("Connect Instagram")}
              </a>
            ) : (
              <Link className={styles.primaryLink} href="/settings">
                {t("Go to settings")}
              </Link>
            )}
            <Link href="/dashboard" className={styles.secondaryLink}>
              {t("Back to dashboard")}
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}

function RequestFailureState({
  failure,
  onRetry,
}: {
  failure: RequestFailure;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const messages: Record<RequestFailure, string> = {
    api: t("We could not load your Instagram accounts. Try again."),
    external: t("Instagram is temporarily unavailable. Try again later."),
    permission: t(
      "Your account does not have permission to complete this action.",
    ),
    refused: t(
      "The operation was refused. Review the account status and try again.",
    ),
    session: t("Your session expired. Sign in again to continue."),
  };

  return (
    <Card role="alert">
      <h2>{t("Instagram accounts unavailable")}</h2>
      <p className={styles.muted}>{messages[failure]}</p>
      <div className={styles.actions}>
        {failure === "session" ? (
          <Link className={styles.primaryLink} href="/login">
            {t("Sign in again")}
          </Link>
        ) : (
          <Button onClick={onRetry}>{t("Try again")}</Button>
        )}
        <Link href="/dashboard" className={styles.secondaryLink}>
          {t("Back to dashboard")}
        </Link>
      </div>
    </Card>
  );
}
