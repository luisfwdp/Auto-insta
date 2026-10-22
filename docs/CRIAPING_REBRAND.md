# CRIA PING — auditoria de nomes (Auto Insta / OpenReply)

> Marca: **CRIA PING — by Creator Lab Connect**. Slogan: "Automação inteligente para criadores".
> Paleta: `#0B0B0B` (fundo), `#1A1A1A` (superfícies), `#C7FF2F` (destaque), `#F5F5F5` (texto).
> Levantamento feito com `grep` na `main` (732d925). Nada foi renomeado neste PR.

## Regras

1. Trocar só o que o usuário vê. Identificadores internos ficam como estão, para manter compatibilidade com o upstream e evitar migrações.
2. Domínio e URLs mudam só junto com o redirect OAuth e o webhook da Meta, na mesma janela.
3. Serviços, banco e repositório não são renomeados automaticamente.
4. Os créditos ao OpenReply ficam: `LICENSE` (MIT, copyright original), menção no README e na página "Sobre/Créditos".

## Pode trocar (texto visível)

| Onde | Hoje | Proposta | Responsável |
| --- | --- | --- | --- |
| `app/layout.tsx` (title, Open Graph) | "OpenReply - Open source Instagram…" | "CRIA PING — Automação inteligente para criadores" | Claude |
| `app/manifest.ts` (`name`, `short_name`) | "OpenReply" | "CRIA PING" | Claude |
| `components/sidebar.tsx:65` | "OpenReply" | Logo/nome CRIA PING | Codex (visual) |
| `lib/auth.ts:11` (padrão de `EMAIL_FROM`) | "OpenReply <login@example.com>" | "CRIA PING <login@example.com>". Em produção vale a variável de ambiente | Claude |
| Template do e-mail de login | Texto do Auth.js/OpenReply | Texto pt-BR CRIA PING | Claude (texto) + Codex (HTML) |
| `lib/i18n/pt-BR.json`, `zh-TW.json`, `index.ts` | 16 ocorrências por catálogo | Trocar por CRIA PING onde é nome do produto | Claude |
| `app/page.tsx` (landing, 21 ocorrências), `lib/seo-pages.ts` (7), páginas SEO | OpenReply / "ManyChat alternative" | Reescrever (decisão já aprovada) | Codex |
| `app/privacy`, `app/terms`, `app/data-deletion` | OpenReply (5–6 ocorrências) | CRIA PING + controlador dos dados (Creator Lab Connect). **Revisão jurídica sua**: a Meta exige essas páginas no app review | Claude (rascunho) |
| `lib/feature-flags.ts:22` (comentário) | "Auto Insta visual design system" | "CRIA PING" | Claude |
| `fly.toml:1` (comentário) | "Auto Insta worker" | "CRIA PING worker" | Claude |
| Docs (`docs/*.md`) | OpenReply / Auto Insta | Atualizar aos poucos, mantendo "baseado no OpenReply" | Claude |

## Manter (interno ou com dependência externa)

| Onde | Valor | Motivo |
| --- | --- | --- |
| `package.json` `name` | `openreply` | Interno; facilita merges do upstream |
| `lib/import-queue.ts` | `openreply-import-queue`, `openreply-import-account` | Chaves de localStorage; trocar perde estado dos usuários |
| `components/demo-notice.tsx` `DISMISS_KEY` | `openreply:demo-notice-dismissed` | Chave de localStorage |
| `lib/env.ts` `DEMO_HOST` | `openreply.diwen.dev` | Só ativa no domínio de demonstração do upstream; não afeta o CRIA PING |
| `components/demo-notice.tsx` link de setup | GitHub do upstream | Só aparece no host de demonstração |
| `lib/zernio-links.ts` (`utm_source=openreply`) | Atribuição de parceiro | Integração opcional; mudar pode quebrar a atribuição. Revisar com a Zernio |
| `lib/zernio/manage-remote.ts` (nome do webhook "OpenReply") | Nome remoto | Trocar só se ninguém depender desse nome para encontrar webhooks antigos |
| `prisma/schema.prisma`, migrações, nomes de fila BullMQ | — | Renomear exige migração e drenar filas |
| `docker-compose.yml`, `.github/workflows/ci.yml` (`openreply`, `openreply_ci`) | Bancos locais/CI | Descartáveis; sem ganho |
| `.github/workflows/docker-publish.yml` `IMAGE_NAME: openreply` | Imagem Docker Hub | Trocar só se você publicar uma imagem própria |
| `fly.toml` `app = "auto-insta-worker"` | Nome do app no Fly | Ainda não existe; dá para criar já como `criaping-worker`. **Decisão sua antes do primeiro deploy** |
| Projeto Vercel `auto-insta`, projeto Supabase `auto-insta`, repositório `Auto-insta` | Recursos externos | Não renomear automaticamente. O nome do projeto não aparece para o usuário com domínio próprio |

## Domínio

O domínio de produção define `NEXTAUTH_URL`, o redirect OAuth do Instagram e o callback do webhook da Meta. Proposta:

1. Escolher o domínio CRIA PING (ex.: `app.<dominio>`) **antes** de cadastrar o app Meta, para não precisar migrar.
2. Apontar o domínio na Vercel, definir `NEXTAUTH_URL` e cadastrar o redirect e o webhook na Meta no mesmo dia.
3. Manter a URL `*.vercel.app` com proteção da Vercel para previews.

Se o app Meta já estiver cadastrado com outra URL, adicionar a nova URL como redirect extra, trocar o webhook e só depois remover a antiga.
