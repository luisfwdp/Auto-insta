import Image from "next/image";
import Link from "next/link";
import LanguageSwitcher from "@/components/language-switcher";
import { I18nProvider } from "@/lib/i18n/provider";
import { getI18n } from "@/lib/i18n/server";
import { criapingInter } from "@/app/fonts/criaping";

export default async function CommercialHome() {
  const { locale, t } = await getI18n();
  const steps = [
    [t("Confirm your email"), t("Sign in with a secure email link. You do not need a password.")],
    [t("Activate your free trial"), t("Try the service for 72 hours without a card or an automatic charge.")],
    [t("Connect Instagram"), t("Connect your professional Instagram account to begin.")],
  ];
  return <I18nProvider locale={locale}>
    <div className={`or-landing ${criapingInter.className}`}>
      <header className="or-header">
        <div className="or-container or-nav">
          <Link href="/" aria-label="PING CHAT"><Image src="/brand/ping-chat/logo-horizontal.svg" alt="PING CHAT by Creator Lab School" width={195} height={52} priority /></Link>
          <nav aria-label={t("Pricing plans")}><Link href="/pricing">{t("Pricing plans")}</Link><LanguageSwitcher /><Link className="or-nav-signin" href="/login">{t("Sign in")}</Link></nav>
        </div>
      </header>
      <main>
        <section className="or-container or-hero">
          <div className="or-hero-copy">
            <h1>{t("Your Instagram workflow, in one place.")}</h1>
            <p className="or-lead">{t("Create automations, organize publications and follow your results.")}</p>
            <div className="or-actions"><Link className="or-button or-button-primary" href="/login?mode=signup">{t("Get started free")}</Link><Link className="or-text-link" href="/pricing">{t("See subscription plans")}</Link></div>
            <p className="or-hero-note">{t("3 days free. No card required.")}</p>
          </div>
          <div className="or-runtime" aria-label={t("3-day free trial")}>
            <div><strong>{t("3-day free trial")}</strong><span>{t("Your trial starts when you activate it. No payment is required to register.")}</span></div>
            <div><strong>{t("Official Instagram connection")}</strong><span>{t("Connect your professional Instagram account to begin.")}</span></div>
            <div><strong>{t("You control your subscription")}</strong><span>{t("Choose whether to subscribe. Cancel automatic renewal from your account.")}</span></div>
          </div>
        </section>
        <section className="or-container or-section or-how">
          <h2>{t("Create your account")}</h2>
          <ol className="or-steps">{steps.map(([title, text], index) => <li key={title}><span className="or-step-number">0{index + 1}</span><div><h3>{title}</h3><p>{text}</p></div></li>)}</ol>
        </section>
      </main>
      <footer className="or-footer"><div className="or-container"><nav><Link href="/privacy">{t("Privacy")}</Link>{" · "}<Link href="/terms">{t("Terms")}</Link></nav><p>{t("Based on OpenReply")} · <a href="https://github.com/diwenne/openreply">OpenReply</a> · <a href="https://diwenhuang.ca">Diwen Huang</a></p></div></footer>
    </div>
  </I18nProvider>;
}
