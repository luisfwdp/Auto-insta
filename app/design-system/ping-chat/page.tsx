/* eslint-disable @next/next/no-img-element -- SVG review board needs exact source assets and optical pixel sizes. */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isFeatureEnabled } from "@/lib/feature-flags";
import styles from "./brand-preview.module.css";

export const metadata: Metadata = {
  title: "PING CHAT | Revisão de marca",
  robots: { index: false, follow: false },
};

const sizes = [16, 24, 32, 48] as const;

function BrandLockup({ onLight = false, compact = false }: { onLight?: boolean; compact?: boolean }) {
  return <div className={`${styles.lockup} ${compact ? styles.lockupCompact : ""}`} data-on-light={onLight || undefined}>
    <img src={compact ? "/brand/ping-chat/favicon.svg" : "/brand/ping-chat/symbol.svg"} alt="" width={compact ? 32 : 56} height={compact ? 32 : 56} />
    <span><strong>PING <em>CHAT</em></strong><small>by Creator Lab School</small></span>
  </div>;
}

function ApplicationPreviews() {
  return <section className={styles.applications} aria-labelledby="applications-title">
    <div className={styles.sectionHeading}><p>Aplicações controladas</p><h2 id="applications-title">A marca no produto, sem alterar o produto</h2><span>Mockups estáticos; nenhuma destas telas substitui componentes ativos.</span></div>
    <div className={styles.mockGrid}>
      <article className={`${styles.mock} ${styles.sidebarMock}`}><div className={styles.mockLabel}>Sidebar</div><BrandLockup compact /><nav><b>Visão geral</b><span>Campanhas</span><span>Conversas</span><span>Relatórios</span></nav><div className={styles.mockProfile}><i>CL</i><span>Creator Lab<small>Workspace</small></span></div></article>
      <article className={`${styles.mock} ${styles.loginMock}`}><div className={styles.mockLabel}>Login</div><BrandLockup /><div className={styles.loginCard}><p>Acesse sua conta</p><span>Automação oficial para conversas que convertem.</span><label>E-mail<input aria-label="E-mail de demonstração" readOnly placeholder="voce@empresa.com" /></label><button type="button" tabIndex={-1}>Continuar</button></div></article>
      <article className={`${styles.mock} ${styles.dashboardMock}`}><div className={styles.mockLabel}>Dashboard</div><header><BrandLockup compact /><span>Visão geral</span><i>LP</i></header><div className={styles.dashboardBody}><p>Performance hoje</p><h3>Conversas que viram resultados.</h3><div className={styles.metrics}><span><small>Automações ativas</small><b>12</b></span><span><small>Conversas iniciadas</small><b>284</b></span><span><small>Taxa de resposta</small><b>68%</b></span></div><div className={styles.chart} aria-hidden="true">{[38, 58, 45, 74, 62, 88, 76].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div></div></article>
    </div>
  </section>;
}

export default function PingChatBrandPage() {
  if (!isFeatureEnabled("newDesign")) notFound();
  return <main lang="pt-BR" className={styles.page}>
    <a className={styles.skip} href="#validation">Pular para a validação</a>
    <header className={styles.topbar}><BrandLockup /><span>Revisão de marca · não publicada</span></header>
    <section className={styles.hero}><p>Sistema de identidade v0.2</p><h1>Conversa que ativa.<br /><em>Automação que conecta.</em></h1><span>A evolução preserva o balão de conversa e reserva as ondas de “ping” para tamanhos onde elas permanecem legíveis.</span></section>

    <section id="validation" className={styles.validation} aria-labelledby="validation-title">
      <div className={styles.sectionHeading}><p>Validação óptica</p><h2 id="validation-title">Uma família, quatro escalas</h2><span>Em 16 px, detalhes secundários são removidos; em 24 px ou mais, o sinal de movimento retorna progressivamente.</span></div>
      <div className={styles.sizeGrid}>{sizes.map((size) => <figure key={size}><div className={styles.checker}><img src={size === 16 ? "/brand/ping-chat/symbol-16.svg" : size < 48 ? "/brand/ping-chat/favicon.svg" : "/brand/ping-chat/symbol.svg"} width={size} height={size} alt={`Símbolo PING CHAT em ${size} pixels`} /></div><figcaption><b>{size} px</b><span>{size === 16 ? "Essencial" : size < 48 ? "Compacto" : "Completo"}</span></figcaption></figure>)}</div>
    </section>

    <section className={styles.surfaces} aria-labelledby="surfaces-title"><div className={styles.sectionHeading}><p>Contraste</p><h2 id="surfaces-title">Fundos claros e escuros</h2><span>As variantes são explícitas; não dependem de herança de cor dentro de imagens externas.</span></div><div className={styles.surfaceGrid}><div className={styles.darkSurface}><BrandLockup /></div><div className={styles.lightSurface}><BrandLockup onLight /></div></div></section>

    <section className={styles.family} aria-labelledby="family-title"><div className={styles.sectionHeading}><p>Arquivos editáveis</p><h2 id="family-title">Família consistente</h2><span>Horizontal, compacta, monocromática e favicon compartilham o mesmo balão, recorte e ritmo.</span></div><div className={styles.assetGrid}>{[
      ["Horizontal — fundo escuro", "/brand/ping-chat/logo-horizontal.svg", false], ["Horizontal — fundo claro", "/brand/ping-chat/logo-horizontal-on-light.svg", true], ["Compacta", "/brand/ping-chat/logo-compact.svg", false], ["Monocromática clara", "/brand/ping-chat/logo-monochrome-light.svg", false], ["Monocromática escura", "/brand/ping-chat/logo-monochrome-dark.svg", true], ["Favicon", "/brand/ping-chat/favicon.svg", false],
    ].map(([label, src, light]) => <figure key={String(src)} className={light ? styles.assetLight : ""}><img src={String(src)} alt={`PING CHAT — ${label}`} /><figcaption>{label}</figcaption></figure>)}</div></section>

    <section className={styles.type} aria-labelledby="type-title"><div className={styles.sectionHeading}><p>Tipografia e licença</p><h2 id="type-title">Sora lidera. Inter explica.</h2></div><div className={styles.typeGrid}><div><strong className={styles.sora}>PING CHAT</strong><span>Sora 700 · títulos, marca e métricas</span></div><div><strong className={styles.inter}>Conversas claras, decisões rápidas.</strong><span>Inter 400–600 · interface, labels e leitura</span></div><p>Ambas são hospedadas localmente, usam <code>font-display: swap</code> e possuem licença SIL Open Font License 1.1 versionada no repositório. Texto principal sobre preto: 18,05:1. Preto sobre verde-limão: 16,66:1.</p></div></section>

    <ApplicationPreviews />
    <footer><BrandLockup compact /><span>Referência aprovada para refinamento. A identidade ativa permanece intacta.</span></footer>
  </main>;
}
