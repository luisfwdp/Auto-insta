import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import LanguageSwitcher from "@/components/language-switcher";
import { I18nProvider } from "@/lib/i18n/provider";
import { getI18n } from "@/lib/i18n/server";
import styles from "./pricing.module.css";

export const metadata: Metadata = {
  title: "Preços | PING CHAT",
  description: "Planos acessíveis para automação de comentários e DMs no Instagram.",
};

const plans = {
  "pt-BR": [
    { name:"Essencial", audience:"Para começar a vender e entregar conteúdo pelo Instagram.", price:"R$ 29", features:["1 conta do Instagram","Automações de comentário para DM","Respostas públicas e links rastreados","Logs de entrega"] },
    { name:"Pro", audience:"Para creators e negócios com mais campanhas e conversas.", price:"R$ 59", featured:true, features:["Até 3 contas do Instagram","Campanhas ilimitadas","Inbox e métricas de campanhas","Rascunhos, pausa e ativação"] },
    { name:"Agência", audience:"Para equipes que operam várias contas e clientes.", price:"R$ 129", features:["Até 10 contas do Instagram","Membros no workspace","Relatórios compartilháveis","Gestão de múltiplas contas"] },
  ],
  en: [
    { name:"Essential", audience:"For getting started with sales and content delivery on Instagram.", price:"BRL 29", features:["1 Instagram account","Comment-to-DM automations","Public replies and tracked links","Delivery logs"] },
    { name:"Pro", audience:"For creators and businesses running more campaigns and conversations.", price:"BRL 59", featured:true, features:["Up to 3 Instagram accounts","Unlimited campaigns","Inbox and campaign metrics","Draft, pause and activation controls"] },
    { name:"Agency", audience:"For teams operating multiple accounts and clients.", price:"BRL 129", features:["Up to 10 Instagram accounts","Workspace members","Shareable reports","Multiple-account management"] },
  ],
} as const;

export default async function PricingPage() {
  const { locale } = await getI18n();
  const en = locale === "en";
  const selected = en ? plans.en : plans["pt-BR"];
  return <I18nProvider locale={locale}>
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" aria-label="PING CHAT"><Image src="/brand/ping-chat/logo-horizontal.svg" alt="PING CHAT by Creator Lab School" width={195} height={52} priority /></Link>
        <div className={styles.headerActions}><Link className={styles.back} href="/">{en ? "Back to home" : "Voltar ao início"}</Link><LanguageSwitcher /></div>
      </header>
      <main className={styles.main}>
        <section className={styles.hero}>
          <span className={styles.eyebrow}>{en ? "Simple, predictable pricing" : "Preço simples e previsível"}</span>
          <h1>{en ? <>More conversations. <span>Less cost.</span></> : <>Mais conversas. <span>Menos custo.</span></>}</h1>
          <p>{en ? "Plans designed to make official Instagram automation accessible to creators and growing teams." : "Planos pensados para tornar a automação oficial do Instagram acessível para creators e equipes em crescimento."}</p>
        </section>
        <section className={styles.grid} aria-label={en ? "Pricing plans" : "Planos e preços"}>
          {selected.map((plan) => { const featured = "featured" in plan && plan.featured; return <article key={plan.name} className={`${styles.card} ${featured ? styles.featured : ""}`}>
            {featured && <span className={styles.badge}>{en ? "Best value" : "Melhor custo-benefício"}</span>}
            <h2>{plan.name}</h2><p className={styles.audience}>{plan.audience}</p>
            <div className={styles.price}><strong>{plan.price}</strong><span>{en ? "/ month" : "/ mês"}</span></div>
            <ul className={styles.features}>{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
            <Link className={styles.cta} href="/login">{en ? "Start now" : "Começar agora"}</Link>
          </article>; })}
        </section>
        <p className={styles.note}>{en ? "Early-access pricing. Billing is not active yet; prices, included features and limits will be confirmed before any subscription is charged. Infrastructure or optional connection-provider costs are separate." : "Preços de acesso antecipado. A cobrança ainda não está ativa; valores, recursos e limites serão confirmados antes de qualquer assinatura. Custos de infraestrutura ou de provedor de conexão opcional são separados."}</p>
        <section className={styles.research}>
          <h2>{en ? "Why these prices?" : "Por que esses preços?"}</h2>
          <p>{en ? <>Official references checked on November 7, 2026: ManyChat Essential starts at US$17/month and Pro at US$39/month. Broader platforms can start near US$99/month. See <a href="https://help.manychat.com/en/articles/17742191-essential-plan">ManyChat Essential</a>, <a href="https://manychat.com/blog/how-to-get-started-with-instagram-automation/">ManyChat Pro</a> and <a href="https://respond.io/pricing">respond.io</a>.</> : <>Referências oficiais consultadas em 7 de novembro de 2026: o ManyChat Essential parte de US$ 17/mês e o Pro de US$ 39/mês. Plataformas mais amplas podem começar perto de US$ 99/mês. Consulte <a href="https://help.manychat.com/en/articles/17742191-essential-plan">ManyChat Essential</a>, <a href="https://manychat.com/blog/how-to-get-started-with-instagram-automation/">ManyChat Pro</a> e <a href="https://respond.io/pricing">respond.io</a>.</>}</p>
        </section>
      </main>
    </div>
  </I18nProvider>;
}
