import type { Metadata } from "next";
import "./landing.css";
import Link from "next/link";
import Image from "next/image";
import { DemoNotice } from "@/components/demo-notice";
import { zernioLink } from "@/lib/zernio-links";
import { criapingInter } from "@/app/fonts/criaping";
import LanguageSwitcher from "@/components/language-switcher";
import { I18nProvider } from "@/lib/i18n/provider";
import { getI18n } from "@/lib/i18n/server";

const GITHUB_URL = "https://github.com/luisfwdp/Auto-insta";
const SETUP_DOCS_URL = `${GITHUB_URL}/blob/main/docs/setup.md`;
const ZERNIO_DOCS_URL = `${GITHUB_URL}/blob/main/docs/zernio.md`;

function formatStars(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toLocaleString();
}

const githubIconPath =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z";

async function getGitHubStars(): Promise<number | null> {
  try {
    const res = await fetch("https://api.github.com/repos/diwenne/openreply", {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number"
      ? data.stargazers_count
      : null;
  } catch {
    return null;
  }
}

export const metadata: Metadata = {
  title: "PING CHAT — Automação de comentários e DMs no Instagram",
  description:
    "Transforme comentários com palavras-chave em conversas e mensagens privadas automáticas no Instagram.",
};

function SponsorCredit({ placement, lang }: { placement: string; lang: "pt" | "en" }) {
  return (
    <a
      className="or-sponsor-credit"
      href={zernioLink({ placement })}
      target="_blank"
      rel="sponsored noopener noreferrer"
    >
      <span>{lang === "pt" ? "Com apoio de" : "Supported by"}</span>
      <Image
        src="/brand/zernio-primary.svg"
        alt="Zernio"
        width={76}
        height={24}
      />
      <span className="or-sponsor-disclosure">
        {lang === "pt" ? "Provedor pago opcional" : "Optional paid provider"}
      </span>
    </a>
  );
}

function ReplyPreview({ lang }: { lang: "pt" | "en" }) {
  const tr = (pt: string, en: string) => (lang === "en" ? en : pt);
  return (
    <figure
      className="or-preview"
      aria-label={tr("Campanha de exemplo: um comentário GUIA dispara uma resposta privada com link", "Example campaign: a GUIDE comment triggers a private reply with a guide link")}
    >
      <div className="or-preview-top">
        <span className="or-wordmark">PING <span>CHAT</span></span>
        <span className="or-mono">{tr("Prévia da campanha", "Campaign preview")}</span>
      </div>
      <div className="or-preview-body">
        <div className="or-preview-heading">
          <span className="or-avatar">S</span>
          <div>
            <strong>Sunday studio</strong>
            <span>@sunday.studio · Instagram</span>
          </div>
          <span className="or-active">{tr("Ativa", "Active")}</span>
        </div>
        <div className="or-post">
          <span className="or-mono">{tr("Campanha: Novo lançamento", "Campaign: New drop")}</span>
          <p>
            {tr("Comente GUIA abaixo", "Comment GUIDE below")}
            <br />{tr("e eu envio o link para você.", "and I’ll send you the link.")}
          </p>
          <span>{tr("Palavra-chave: GUIA", "Keyword: GUIDE")}</span>
          <div className="or-post-lines" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
        <div className="or-comment">
          <span className="or-avatar or-avatar-small">M</span>
          <div>
            <strong>maya.creates</strong>
            <p>{tr("GUIA! preciso disso 😍", "GUIDE! need this 😍")}</p>
          </div>
        </div>
        <div className="or-match">
          <span aria-hidden="true">↓</span>
          <span>
            {tr("Palavra-chave", "Keyword")} <code>{tr("GUIA", "GUIDE")}</code> {tr("encontrada", "matched")}
          </span>
          <span className="or-match-line" />
          <span>{tr("Resposta privada", "Private reply")}</span>
        </div>
        <div className="or-message">
          <span className="or-mono">Sunday studio → Maya</span>
          <p>{tr("Oi, Maya! Aqui está o link 👇", "Hey Maya! Here’s the link 👇")}</p>
          <span className="or-message-link">
            {tr("Ver o lançamento", "Shop the new drop")} <span aria-hidden="true">↗</span>
          </span>
        </div>
        <div className="or-delivered">
          <span aria-hidden="true">✓</span> {tr("Enviada pela API oficial do Instagram", "Sent through the official Instagram API")}
        </div>
      </div>
      <figcaption>
        {tr("Conteúdo de exemplo. Suas palavras-chave, sua mensagem, seus links.", "Example content. Your keywords, your message, your links.")}
      </figcaption>
    </figure>
  );
}

const steps = [
  [
    { pt:"Conecte sua conta", en:"Connect your account" },
    { pt:"Use sua própria integração Meta ou o provedor opcional e conecte uma conta profissional do Instagram.", en:"Choose Zernio or your own Meta app, then connect an Instagram Business or Creator account." },
  ],
  [
    { pt:"Crie uma campanha", en:"Set up a campaign" },
    { pt:"Escolha uma publicação ou reel, defina palavras-chave e escreva a resposta privada, a resposta pública e os links.", en:"Pick a post or reel, add keywords, and write the private reply. Add a public reply or tracked link buttons if you need them." },
  ],
  [
    { pt:"PING CHAT cuida do restante", en:"PING CHAT handles the rest" },
    { pt:"As interações ativam suas campanhas. O sistema organiza a fila, respeita limites, registra envios e tenta novamente quando necessário.", en:"Incoming events trigger your campaigns. A background worker queues, rate-limits, and logs each send, with retries and comment reconciliation." },
  ],
];
const features = [
  [
    { pt:"Mensagens personalizadas", en:"Custom reply messages" },
    { pt:"Escreva suas mensagens, personalize com o nome do usuário e adicione links rastreados.", en:"Write your own messages, personalize with a username, and use up to two tracked link buttons." },
  ],
  [
    { pt:"Gatilhos relevantes", en:"Relevant triggers" },
    { pt:"Ative campanhas a partir de comentários e conversas compatíveis com a integração disponível.", en:"Trigger campaigns from comments and supported conversations available through your connection." },
  ],
  [
    { pt:"Caixa de entrada", en:"Inbox" },
    { pt:"Leia conversas e responda pelo PING CHAT dentro da janela de mensagens do Instagram.", en:"Read conversations and reply from PING CHAT, within Instagram’s messaging window." },
  ],
  [
    { pt:"Logs de entrega", en:"Delivery logs" },
    { pt:"Veja mensagens enviadas, ignoradas e com falha. Relacione cliques em links às campanhas.", en:"See sent, skipped, and failed messages, with reasons. Follow tracked link clicks back to a campaign." },
  ],
];

export default async function Home() {
  const stars = await getGitHubStars();
  const { locale } = await getI18n();
  const lang = locale === "en" ? "en" : "pt";
  const tr = (pt: string, en: string) => lang === "en" ? en : pt;
  return <I18nProvider locale={locale}>
    <div id="top" className={`or-landing ${criapingInter.className}`}>
      <a className="or-skip" href="#main">
        {tr("Ir para o conteúdo", "Skip to content")}
      </a>
      <DemoNotice variant="banner" />
      <header className="or-header">
        <div className="or-container or-nav">
          <a className="or-wordmark" href="#top" aria-label="PING CHAT home">
            <Image src="/brand/ping-chat/logo-horizontal.svg" alt="PING CHAT by Creator Lab School" width={195} height={52} priority />
          </a>
          <nav aria-label="Main navigation">
            <a href="#how">{tr("Como funciona", "How it works")}</a>
            <Link href="/pricing">{tr("Preços", "Pricing")}</Link>
            <a
              className="or-stars"
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="View PING CHAT on GitHub"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d={githubIconPath} />
              </svg>
              {stars !== null && <span>{formatStars(stars)}</span>}
            </a>
          </nav>
          <div className="or-nav-cta">
            <LanguageSwitcher />
            <a className="or-nav-signin" href="/login">
              {tr("Entrar", "Sign in")}
            </a>
            <a className="or-button or-button-small" href="/login">
              {tr("Começar", "Get started")} <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </header>
      <main id="main">
        <section className="or-container or-hero">
          <div className="or-hero-copy">
            <h1>
              {tr("Conversa que ativa.", "Conversation that activates.")}
              <br />
              <span>{tr("Automação que conecta.", "Automation that connects.")}</span>
            </h1>
            <p className="or-lead">
              {tr("Transforme comentários em conversas: detecte palavras-chave, responda publicamente e envie uma DM automaticamente.", "Turn comments into conversations: detect keywords, reply publicly and send a DM automatically.")}
            </p>
            <div className="or-actions">
              <a className="or-button or-button-primary" href={SETUP_DOCS_URL}>
                {tr("Começar com PING CHAT", "Start with PING CHAT")} <span aria-hidden="true">↗</span>
              </a>
              <a className="or-text-link" href="#how">
                {tr("Ver como funciona", "See how it works")} <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p className="or-hero-note">
              {tr("Software aberto. Sua infraestrutura.", "Open software. Your infrastructure.")}
            </p>
            <SponsorCredit placement="landing-hero" lang={lang} />
          </div>
          <ReplyPreview lang={lang} />
        </section>
        <div className="or-container or-principles">
          <span>{tr("Licença MIT", "MIT licensed")}</span>
          <span>{tr("API oficial do Instagram", "Official Instagram API")}</span>
          <span>{tr("Sem compartilhar senhas", "No password sharing")}</span>
          <span>{tr("Suas campanhas, no seu banco", "Your campaigns, in your database")}</span>
        </div>
        <div className="or-container">
          <div className="or-sheet">
            <section id="how" className="or-section or-how">
              <div>
                <h2>{tr("Como funciona", "How it works")}</h2>
                <p>
                  {tr("Envie um link de produto, compartilhe um material ou entregue seu guia. Você decide o que inicia a conversa e o que acontece depois.", "Send a product link, share a resource, or deliver your latest guide. You decide what starts the conversation and what happens next.")}
                </p>
              </div>
              <ol className="or-steps">
                {steps.map(([title, description], index) => (
                  <li key={title.en}>
                    <span className="or-step-number">0{index + 1}</span>
                    <div>
                      <h3>{title[lang]}</h3>
                      <p>{description[lang]}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            <section id="features" className="or-section">
              <div className="or-section-intro">
                <h2>{tr("Recursos", "Features")}</h2>
              </div>
              <div className="or-feature-grid">
                {features.map(([title, description]) => (
                  <article key={title.en}>
                    <h3>{title[lang]}</h3>
                    <p>{description[lang]}</p>
                  </article>
                ))}
              </div>
            </section>
            <section className="or-technical">
              <div>
                <h2>
                  {tr("Código aberto.", "Open code.")}
                  <br />{tr("Um sistema que você pode inspecionar.", "A system you can inspect.")}
                </h2>
                <p>
                  {tr("O PING CHAT controla campanhas, palavras-chave, filas, tentativas, logs e caixa de entrada. Seu provedor de conexão cuida da API do Instagram.", "PING CHAT owns campaigns, keyword matching, queues, retries, logs and inbox. Your connection provider handles the Instagram API.")}
                </p>
                <a href={GITHUB_URL} className="or-text-link">
                  {tr("Explorar o código", "Explore the source")} <span aria-hidden="true">↗</span>
                </a>
              </div>
              <div className="or-runtime">
                <div>
                  <span className="or-mono">{tr("Aplicação web", "Web app")}</span>
                  <strong>Next.js + React</strong>
                  <span>{tr("Painel e eventos recebidos", "Dashboard & incoming events")}</span>
                </div>
                <div>
                  <span className="or-mono">{tr("Processamento em segundo plano", "Background worker")}</span>
                  <strong>Node.js + BullMQ</strong>
                  <span>{tr("Fila de envios e reconciliação", "Queued delivery & reconciliation")}</span>
                </div>
                <div>
                  <span className="or-mono">{tr("Seus dados", "Your data")}</span>
                  <strong>PostgreSQL + Redis</strong>
                  <span>{tr("Campanhas, contas, logs e fila", "Campaigns, accounts, logs & queue")}</span>
                </div>
              </div>
            </section>
            <section id="setup" className="or-section">
              <div className="or-section-intro">
                <h2>{tr("Configure o PING CHAT e escolha sua conexão.", "Set up PING CHAT and choose your connection.")}</h2>
                <p>{tr("As duas opções precisam da sua aplicação web, processamento em segundo plano, PostgreSQL e Redis. O PING CHAT é software livre; hospedagem e provedores são cobrados separadamente.", "Both options need your own web app, background worker, PostgreSQL, and Redis. PING CHAT is free software; hosting and provider costs are separate.")}</p>
              </div>
              <div className="or-provider-grid">
                <article className="or-provider-zernio">
                  <div className="or-provider-title">
                    <h3>{tr("Conectar com Zernio", "Connect with Zernio")}</h3>
                    <span>{tr("Recomendado para configuração simplificada", "Recommended for simpler setup")}</span>
                  </div>
                  <p>{tr("Use a conexão gerenciada do Zernio em vez de criar e submeter seu próprio aplicativo Meta. Salve uma chave de API em Configurações, escolha um perfil e conecte sua conta.", "Use Zernio’s managed Instagram connection instead of creating and reviewing your own Meta app. Save an API key in Settings, choose a profile, and connect your account.")}</p>
                  <ul>
                    <li>{tr("Sem segredos do aplicativo Meta no PING CHAT", "No Meta app secrets to configure in PING CHAT")}</li>
                    <li>{tr("O PING CHAT registra o webhook para você", "PING CHAT registers the webhook for you")}</li>
                    <li>{tr("Serviço pago opcional e patrocinador do projeto", "Optional paid service and project sponsor")}</li>
                  </ul>
                  <a
                    className="or-text-link"
                    href={zernioLink({ placement: "landing-setup" })}
                    rel="sponsored noopener noreferrer"
                    target="_blank"
                  >
                    {tr("Conhecer o Zernio", "Explore Zernio")} <span aria-hidden="true">↗</span>
                  </a>
                  <a className="or-provider-guide" href={ZERNIO_DOCS_URL}>
                    {tr("Ver configuração e limites", "Read setup & feature limits")}
                  </a>
                </article>
                <article>
                  <div className="or-provider-title">
                    <h3>{tr("Usar seu próprio aplicativo Meta", "Use your own Meta app")}</h3>
                    <span>{tr("Conexão direta", "Direct connection")}</span>
                  </div>
                  <p>{tr("Mantenha a integração direta com a Meta. Crie seu aplicativo, configure o Login do Instagram e os webhooks e gerencie as credenciais da plataforma.", "Keep the existing direct Meta integration. Create your app, configure Instagram Login and webhooks, and manage platform credentials yourself.")}</p>
                  <ul>
                    <li>{tr("Use seu aplicativo Meta e suas credenciais", "Bring your own Meta app and secrets")}</li>
                    <li>{tr("Faça a análise do aplicativo quando necessário", "Handle App Review where required")}</li>
                    <li>{tr("Sem conta ou assinatura do Zernio", "No Zernio account or subscription needed")}</li>
                  </ul>
                  <a
                    className="or-text-link"
                    href={`${SETUP_DOCS_URL}#the-meta-app`}
                  >
                    {tr("Seguir o guia direto da Meta", "Follow the direct Meta guide")}{" "}
                    <span aria-hidden="true">↗</span>
                  </a>
                </article>
              </div>
              <p className="or-setup-note">
                {tr("Os requisitos de conta, permissões, janelas de mensagens e limites do Instagram valem para os dois provedores. Contas existentes nunca são migradas automaticamente.", "Instagram’s account requirements, permissions, messaging windows, and rate limits apply with either provider. Existing accounts are never automatically migrated.")}
              </p>
            </section>
            <section className="or-section or-faq">
              <div>
                <h2>{tr("Dúvidas frequentes", "FAQ")}</h2>
              </div>
              <div>
                <details>
                  <summary>{tr("O PING CHAT é gratuito?", "Is PING CHAT free?")}</summary>
                  <p>{tr("Sim. O código do PING CHAT usa licença MIT. Você paga pela sua infraestrutura e pelos serviços opcionais que escolher. Os planos comerciais são ofertas de acesso antecipado e ainda não têm cobrança ativa.", "Yes. PING CHAT is MIT-licensed software. You pay for your infrastructure and optional services. Commercial plans are early-access offers and billing is not active yet.")}</p>
                </details>
                <details>
                  <summary>{tr("Posso usar a demonstração pública para enviar DMs?", "Can I use the public demo to send DMs?")}</summary>
                  <p>
                    {tr("Não. Primeiro, implante sua própria instância. A demonstração mostra a interface e não é um serviço hospedado de automação. Consulte o ", "No. Deploy your own instance first. The public demo shows the interface; it is not a hosted automation service. Read the ")}
                    <a href={SETUP_DOCS_URL}>{tr("guia de configuração", "setup guide")}</a>
                    {tr(" para conhecer os processos, bancos de dados e provedores.", " for the processes, databases, and provider choices.")}
                  </p>
                </details>
                <details>
                  <summary>{tr("Preciso do Zernio?", "Do I need Zernio?")}</summary>
                  <p>
                    {tr("Não. O Zernio é um provedor pago opcional e patrocinador. Ele evita a configuração do seu próprio aplicativo Meta, enquanto o PING CHAT continua na sua infraestrutura. A conexão direta com a Meta permanece disponível. ", "No. Zernio is an optional paid connection provider and sponsor. It can spare you setting up your own Meta app, while PING CHAT still runs on your infrastructure. The direct Meta path stays available. ")}
                    <a
                      href={zernioLink({ placement: "landing-faq" })}
                      rel="sponsored noopener noreferrer"
                      target="_blank"
                    >
                      {tr("Conhecer o Zernio", "Learn about Zernio")}
                    </a>
                    .
                  </p>
                </details>
                <details>
                  <summary>{tr("Quais contas do Instagram posso conectar?", "Which Instagram accounts can I connect?")}</summary>
                  <p>{tr("Contas profissionais e de criador do Instagram. Contas pessoais não são compatíveis. As conexões usam a API oficial e seguem as políticas da plataforma.", "Instagram Business and Creator accounts. Personal accounts are not supported. Connections use the official API, and Instagram’s platform policies still apply.")}</p>
                </details>
                <details>
                  <summary>{tr("Existem diferenças entre os provedores?", "Are there differences between providers?")}</summary>
                  <p>
                    {tr("Sim. Com o Zernio, o seletor mostra as 25 publicações mais recentes. Relatórios exigem o complemento de análise e dados sincronizados. Leia o ", "Yes. With Zernio, the post picker shows the latest 25 posts. Reporting needs its analytics add-on and synced data. Read the ")}
                    <a href={ZERNIO_DOCS_URL}>{tr("guia do provedor", "provider guide")}</a>
                    {tr(" antes de escolher.", " before choosing.")}
                  </p>
                </details>
              </div>
            </section>
          </div>
        </div>
        <section className="or-container or-closing">
          <h2>
            {tr("Crie sua primeira campanha", "Set up your first campaign")}
          </h2>
          <p>{tr("Entre, conecte o Instagram e escreva sua primeira resposta.", "Sign in, connect Instagram and write your first reply.")}</p>
          <div className="or-actions">
            <a className="or-button or-button-primary" href={SETUP_DOCS_URL}>
              {tr("Começar com PING CHAT", "Start with PING CHAT")} <span aria-hidden="true">↗</span>
            </a>
            <a className="or-text-link" href={GITHUB_URL}>
              {tr("Ver no GitHub", "View on GitHub")} <span aria-hidden="true">↗</span>
            </a>
          </div>
        </section>
      </main>
      <footer className="or-footer">
        <div className="or-container">
          <div className="or-footer-top">
            <div>
              <Link href="/" className="or-wordmark" aria-label="PING CHAT home">
                <Image src="/brand/ping-chat/logo-horizontal.svg" alt="PING CHAT by Creator Lab School" width={195} height={52} />
              </Link>
              <p>{tr("Automação de comentários para DMs no Instagram.", "Instagram comment-to-DM automation.")}</p>
            </div>
            <nav aria-label="Footer navigation">
              <a href={GITHUB_URL}>GitHub</a>
              <Link href="/pricing">{tr("Preços", "Pricing")}</Link>
              <a href={SETUP_DOCS_URL}>{tr("Guia de configuração", "Setup guide")}</a>
              <Link href="/privacy">{tr("Privacidade", "Privacy")}</Link>
              <Link href="/terms">{tr("Termos", "Terms")}</Link>
              <Link href="/data-deletion">{tr("Exclusão de dados", "Data deletion")}</Link>
            </nav>
          </div>
          <div className="or-footer-bottom">
            <span>
              {tr("Licença MIT · Criado por", "MIT licensed · Built by")}{" "}
              <a href="https://diwenhuang.ca">Diwen Huang</a>
            </span>
            <SponsorCredit placement="landing-footer" lang={lang} />
          </div>
        </div>
      </footer>
    </div>
  </I18nProvider>;
}
