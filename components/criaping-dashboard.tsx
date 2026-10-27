"use client";

import Link from "next/link";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import { Card, EmptyState, Skeleton } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n/provider";

export interface CriapingDashboardStats {
  userName: string | null;
  totalAutomations: number;
  activeAutomations: number;
  totalDMs: number;
  totalClicks: number;
  instagramAccounts: AccountOption[];
  dailyDMs: { date: string; count: number }[];
}

interface Props {
  stats: CriapingDashboardStats | null;
  loading: boolean;
  error: boolean;
  selectedAccountId: string;
  onAccountChange: (id: string) => void;
  onRetry: () => void;
}

const metricClasses = "rounded-[20px] border border-[#494949] bg-[#1A1A1A] p-5";
const actionClasses = "inline-flex min-h-11 items-center justify-center rounded-xl bg-[#C7FF2F] px-5 font-semibold text-[#0B0B0B] hover:bg-[#D5FF68] focus-visible:outline-[#C7FF2F]";

export default function CriapingDashboard({ stats, loading, error, selectedAccountId, onAccountChange, onRetry }: Props) {
  const { t, label } = useI18n();

  if (loading) {
    return <div aria-label={t("Loading dashboard")} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {[0, 1, 2, 3].map((item) => <Skeleton key={item} label={t("Loading dashboard")} className="min-h-32" />)}
    </div>;
  }

  if (error || !stats) {
    return <EmptyState title={t("Dashboard unavailable")} description={t("We could not load your real data. Nothing estimated was shown.")} action={<button type="button" onClick={onRetry} className={actionClasses}>{t("Try again")}</button>} />;
  }

  const noAccount = stats.instagramAccounts.length === 0;
  const noCampaign = stats.totalAutomations === 0;
  const metrics = [
    [t("Automations"), stats.totalAutomations],
    [t("Messages sent"), stats.totalDMs],
    [t("Active Campaigns"), stats.activeAutomations],
    [t("Results available"), stats.totalClicks],
  ] as const;
  const max = Math.max(...stats.dailyDMs.map((day) => day.count), 1);

  return <div className="space-y-8 font-[family-name:var(--cp-font-body)]">
    <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#C7FF2F]">CRIA PING</p>
        <h1 className="font-[family-name:var(--cp-font-heading)] text-3xl font-bold tracking-tight sm:text-4xl">
          {t("Hello, {name}!", { name: stats.userName ?? t("there") })}
        </h1>
        <p className="mt-2 text-sm text-[#B5B5B5]">{t("Real results from your connected Instagram accounts.")}</p>
      </div>
      {stats.instagramAccounts.length > 1 && <AccountSelect newDesign accounts={stats.instagramAccounts} value={selectedAccountId} onChange={onAccountChange} />}
    </header>

    {noAccount ? <EmptyState title={t("Connect Instagram")} description={t("Connect an Instagram professional account to launch campaigns.")} action={<a href="/api/instagram/connect" className={actionClasses}>{t("Connect Instagram")}</a>} /> : noCampaign ? <EmptyState title={t("No campaigns yet")} description={t("Create your first comment-to-DM campaign to turn a post or reel into a measurable conversation flow.")} action={<Link href="/campaigns/new" className={actionClasses}>{t("Create Campaign")}</Link>} /> : null}

    <section aria-label={t("Dashboard")} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map(([name, value]) => <article key={name} className={metricClasses}>
        <p className="text-sm text-[#B5B5B5]">{name}</p>
        <p className="mt-3 font-[family-name:var(--cp-font-heading)] text-3xl font-bold tabular-nums">{value}</p>
      </article>)}
    </section>

    <Card title={t("DMs — Last 7 Days")}>
      <div className="flex h-48 items-end gap-2" aria-label={t("DMs — Last 7 Days")}>
        {stats.dailyDMs.map((day) => <div key={day.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2">
          <span className="text-xs tabular-nums text-[#B5B5B5]">{day.count}</span>
          <div className="flex min-h-0 w-full flex-1 items-end"><div className="w-full rounded-t bg-[#C7FF2F]" style={{ height: `${Math.max((day.count / max) * 100, 3)}%` }} /></div>
          <span className="w-full truncate text-center text-xs text-[#B5B5B5]">{label(day.date)}</span>
        </div>)}
      </div>
    </Card>
  </div>;
}
