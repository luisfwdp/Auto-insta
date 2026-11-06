import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isFeatureEnabled } from "@/lib/feature-flags";
import styles from "../preview.module.css";

export const metadata: Metadata = {
  title: "PING CHAT | Revisão de marca",
  robots: { index: false, follow: false },
};

const assets = [
  ["Horizontal", "/brand/ping-chat/logo-horizontal.svg", 390, 104],
  ["Compacta", "/brand/ping-chat/logo-compact.svg", 260, 164],
  ["Símbolo", "/brand/ping-chat/symbol.svg", 96, 96],
] as const;

export default function PingChatBrandPage() {
  if (!isFeatureEnabled("newDesign")) notFound();
  return (
    <main lang="pt-BR" className={styles.preview}>
      <a className={styles.skip} href="#propostas">Pular para as propostas</a>
      <div className={styles.container}>
        <header className={styles.header}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/ping-chat/logo-horizontal.svg" width="390" height="104" alt="PING CHAT by Creator Lab School" />
          <span className={styles.eyebrow}>Revisão de marca · não publicada</span>
        </header>
        <section className={styles.hero} aria-labelledby="intro">
          <p className={styles.eyebrow}>Creator Lab School</p>
          <h1 id="intro">Conversa que ativa.<br /><span>Automação que conecta.</span></h1>
          <p>O balão representa conversa; as ondas, velocidade e automação. A seta negativa do recorte sugere continuidade sem copiar símbolos de concorrentes.</p>
          <a className={styles.action} href="#propostas">Revisar aplicações <span aria-hidden="true">→</span></a>
          <p className={styles.note}>Proposta vetorial para validação. A marca ativa e a produção permanecem inalteradas.</p>
        </section>
        <div id="propostas" className={styles.grid}>
          <section className={styles.panel} aria-labelledby="family">
            <h2 id="family">Família responsiva</h2>
            <div className={styles.logos}>
              {assets.map(([name, src, width, height]) => (
                <figure key={src}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} width={width} height={height} alt={`PING CHAT — versão ${name.toLowerCase()}`} />
                  <figcaption className={styles.note}>{name}</figcaption>
                </figure>
              ))}
            </div>
          </section>
          <section className={styles.panel} aria-labelledby="mono">
            <h2 id="mono">Monocromática</h2>
            <div style={{ color: "var(--cp-white)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/ping-chat/logo-monochrome.svg" width="340" height="96" alt="PING CHAT — versão monocromática" />
            </div>
            <p className={styles.note}>O arquivo usa <code>currentColor</code> e funciona em fundos claros ou escuros.</p>
          </section>
          <section className={styles.panel} aria-labelledby="rules">
            <h2 id="rules">Direção visual</h2>
            <p className={styles.sora}>Sora <span>títulos e métricas</span></p>
            <p className={styles.inter}>Inter <span>interface e leitura</span></p>
            <p className={styles.note}>Preto #0B0B0B · Verde-limão #C7FF2F · Grafite #1A1A1A · Branco #F5F5F5</p>
          </section>
          <section className={styles.panel} aria-labelledby="status">
            <h2 id="status">Limites desta proposta</h2>
            <p>Sem alteração de metadata, manifest, favicon, sidebar ou telas operacionais. A aprovação visual deve preceder qualquer substituição de marca.</p>
          </section>
        </div>
        <footer className={styles.footer}>PING CHAT <span>by Creator Lab School</span></footer>
      </div>
    </main>
  );
}
