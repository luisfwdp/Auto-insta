import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isFeatureEnabled } from "@/lib/feature-flags";
import styles from "./preview.module.css";

export const metadata: Metadata = {
  title: "CRIA PING | Fundamentos visuais",
  robots: { index: false, follow: false },
};

// Visual review fixture only: no accounts, metrics, API calls or product claims.
export default function DesignSystemPage() {
  if (!isFeatureEnabled("newDesign")) notFound();
  return (
    <main lang="pt-BR" className={styles.preview}>
      <a className={styles.skip} href="#foundations">Pular para os fundamentos</a>
      <div className={styles.container}>
        <header className={styles.header}>
          {/* SVG wordmarks are outlined so they never depend on installed fonts. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/criaping/logo-horizontal.svg" width="300" height="64" alt="CRIA PING by Creator Lab Connect" />
          <span className={styles.eyebrow}>Identidade visual · PR A</span>
        </header>
        <section className={styles.hero} aria-labelledby="intro">
          <p className={styles.eyebrow}>Creator Lab Connect</p>
          <h1 id="intro">Automação inteligente<br />para <span>criadores.</span></h1>
          <p>Uma base visual para criar com clareza, agilidade e personalidade.</p>
          <a className={styles.action} href="#foundations">Explorar os fundamentos <span aria-hidden="true">→</span></a>
          <p className={styles.note}>Página de inspeção visual. Não representa novas funcionalidades do produto.</p>
        </section>
        <div id="foundations" className={styles.grid}>
          <section className={styles.panel} aria-labelledby="palette">
            <h2 id="palette">Paleta oficial</h2>
            <div className={styles.swatches}>
              {[
                ["Preto profundo", "#0B0B0B", "var(--cp-black)"],
                ["Cinza carvão", "#1A1A1A", "var(--cp-charcoal)"],
                ["Verde neon", "#C7FF2F", "var(--cp-neon)"],
                ["Branco soft", "#F5F5F5", "var(--cp-white)"],
              ].map(([name, hex, color]) => (
                <div key={hex}>
                  <div className={styles.swatch} style={{ background: color }} />
                  <h3>{name}</h3><code>{hex}</code>
                </div>
              ))}
            </div>
          </section>
          <section className={styles.panel} aria-labelledby="type">
            <h2 id="type">Tipografia</h2>
            <p className={styles.sora}>Sora <span>Bold / SemiBold</span></p>
            <p className={styles.inter}>Inter <span>Regular / Medium</span></p>
            <p className={styles.sample}>Conversas com intenção.<br />Informação com clareza.</p>
            <p className={styles.note}>Criação, automação, conexão · 0123456789</p>
          </section>
          <section className={styles.panel} aria-labelledby="brand">
            <h2 id="brand">Uma marca, diferentes espaços</h2>
            <div className={styles.logos}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/criaping/logo-stacked.svg" width="240" height="143" alt="CRIA PING — versão empilhada" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/criaping/symbol.svg" width="112" height="96" alt="Símbolo: balão com dois pontos e ondas de transmissão" />
            </div>
            <p className={styles.note}>Sem gradientes ou brilho. Assinatura preservada.</p>
          </section>
          <section className={styles.panel} aria-labelledby="states">
            <h2 id="states">Estados e contraste</h2>
            <p className={styles.note}>Amostras de tokens; os controles reutilizáveis chegam no PR B.</p>
            <div className={styles.states}>
              <span style={{ color: "var(--cp-success)" }}>✓ Sucesso</span>
              <span style={{ color: "var(--cp-error)" }}>! Erro</span>
              <span style={{ color: "var(--cp-warning)" }}>△ Atenção</span>
              <span style={{ color: "var(--cp-info)" }}>ⓘ Informação</span>
              <span className={styles.disabled}>Indisponível</span>
            </div>
            <p className={styles.note}>Ações usam texto preto sobre verde. Foco visível pelo teclado.</p>
          </section>
        </div>
        <footer className={styles.footer}>CRIA PING <span>by Creator Lab Connect</span></footer>
      </div>
    </main>
  );
}
