import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import LanguageSwitcher from "@/components/language-switcher";
import { I18nProvider } from "@/lib/i18n/provider";
import { getI18n } from "@/lib/i18n/server";
import { BILLING_PLANS, BILLING_PLAN_IDS } from "@/lib/billing/catalog";
import { isBillingEnabled } from "@/lib/billing/trial";
import { isBillingSalesEnabled } from "@/lib/billing/sales";
import styles from "./pricing.module.css";

export const metadata: Metadata = { title: "Preços | PING CHAT", description: "Planos de assinatura e teste de 3 dias sem cartão." };

export default async function PricingPage() {
  const { locale, t } = await getI18n();
  const enabled = isBillingEnabled();
  const selling = enabled && isBillingSalesEnabled();
  const amount = (cents: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "BRL" }).format(cents / 100);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const labels = {
    "essential-v1": { title: t("Essential"), audience: t("For your first Instagram automations.") },
    "pro-v1": { title: "Pro", audience: t("For creators and growing businesses.") },
    "agency-v1": { title: t("Agency"), audience: t("For teams managing multiple accounts.") },
  };
  return <I18nProvider locale={locale}>
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" aria-label="PING CHAT"><Image src="/brand/ping-chat/logo-horizontal.svg" alt="PING CHAT by Creator Lab School" width={195} height={52} priority /></Link>
        <div className={styles.headerActions}><Link className={styles.back} href="/">{t("Back to home")}</Link><LanguageSwitcher /></div>
      </header>
      <main className={styles.main}>
        <section className={styles.hero}>
          <span className={styles.eyebrow}>{t("Monthly subscriptions")}</span>
          <h1>{t("Choose a plan after your free trial.")}</h1>
          <p>{t("3 days free. No card required.")}</p>
        </section>
        {selling ? <section className={styles.grid} aria-label={t("Pricing plans")}>
          {BILLING_PLAN_IDS.map(id => {
            const plan = BILLING_PLANS[id];
            const featured = id === "pro-v1";
            const features = [
              t("Instagram accounts: {count}", { count: plan.accounts }),
              t("Team members: {count}", { count: plan.members }),
              t("DMs per period: {count}", { count: number(plan.dms) }),
              t("Publications per period: {count}", { count: number(plan.publications) }),
              t("Storage included: {size}", { size: `${number(plan.storageBytes / 1_000_000_000)} GB` }),
            ];
            return <article key={id} className={`${styles.card} ${featured ? styles.featured : ""}`}>
              <h2>{labels[id].title}</h2><p className={styles.audience}>{labels[id].audience}</p>
              <div className={styles.price}><strong>{amount(plan.amountCents)}</strong></div>
              <p>{t("{price} per month", { price: amount(plan.amountCents) })}</p>
              <ul className={styles.features}>{features.map(feature => <li key={feature}>{feature}</li>)}</ul>
              <Link className={styles.cta} href="/login?mode=signup">{t("Get started free")}</Link>
            </article>;
          })}
        </section> : <p className={styles.note} role="status">{t("New subscriptions are temporarily unavailable.")}</p>}
        <section className={styles.note}>
          <p>{t("Your trial starts when you activate it. No payment is required to register.")}</p>
          <p>{t("No automatic charge without a subscription.")}</p>
          <Link className={styles.cta} href={enabled ? "/login?mode=signup" : "/login"}>{enabled ? t("Get started free") : t("Sign in")}</Link>
        </section>
      </main>
    </div>
  </I18nProvider>;
}
