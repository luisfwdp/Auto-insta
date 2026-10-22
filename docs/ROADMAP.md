# CRIA PING — Roadmap incremental

> Complementa o [PRD](AUTO_INSTA_PRD.md). IDs entre colchetes (MC-1, CP-3…) remetem aos
> requisitos do PRD. Cada fase entrega valor sozinha, deixa `main` verde e pode ser lançada.

## Prioridade atual: trilha MVP (desenvolvimento contínuo, produção antecipada)

Decisão de 2026-10-22: colocar um MVP operacional em produção **antes** das fases F1–F9,
com o código atual do OpenReply (já funcional) e uma única conta real. As fases continuam
valendo e passam a entrar em produção atrás de feature flags (`docs/feature-flags.md`).
Operação e rollback em `docs/PRODUCAO.md`.

| Etapa | Entrega | PRs | Gate para avançar |
| --- | --- | --- | --- |
| **M0 — Base segura** | build sem migração, CI com banco, testes de isolamento, flags, convenções, guia de produção | #4, #3, #5, #6, #1, #2, #7 | CI verde na `main`; nenhum vazamento entre workspaces |
| **M1 — Infra de produção** | Postgres e Redis gerenciados, worker fora da Railway, variáveis por ambiente, `ALLOWED_EMAILS` | configuração (sem código) | `/api/health` ok com `worker.healthy`; login restrito testado |
| **M2 — Migrações em produção** | `db:migrate` com backup | — | **aprovação específica** do responsável |
| **M3 — Primeira conta** | 1 conta profissional; roteiro de 7 etapas do `docs/PRODUCAO.md` §8 | — | **aprovação específica** antes de cada envio real; todas as etapas `SENT` |
| **M4 — Endurecimento pós-MVP** | achados da auditoria de isolamento (validar conta selecionada nas estatísticas; Diagnóstico só para ADMIN+), modo somente convite [SG-3], rate limit [SG-4], auditoria [SG-2] | PRs pequenos de F3 | — |
| **M5 — Fases do roadmap atrás de flags** | F1 (`newDesign`), F2 (`workspaceSwitcher`), F4… | conforme a sequência abaixo | cada flag liga primeiro no Preview, depois em produção |

Ordem de merge da M0 (cada PR é independente; a ordem minimiza retrabalho):

1. **#4** `fix/deploy-separate-migrations`: destrava o deploy da Vercel.
2. **#3** `chore/f0-ci-db-tests`: liga o job "Database checks".
3. **#5** `test/f0-workspace-isolation`: passa a rodar no job do #3 (atualizar o branch com a `main` antes).
4. **#6** `feat/f0-feature-flags`.
5. **#1** `docs/f0-prd-roadmap` → **#2** `chore/f0-collab-conventions` (links do #2 apontam para o #1) → **#7** `docs/f0-production-runbook`.

Regras durante a trilha MVP: produção sem `FEATURE_FLAGS`; nada de mudança no motor de DMs
sem revisão específica; rollback documentado em todo PR.

## Visão geral das fases

| Fase | Tema | Resultado visível | Depende de |
| --- | --- | --- | --- |
| F0 | Fundação | Docs, convenções de colaboração, CI reforçado | — |
| F1 | Marca e design system | CRIA PING escuro, verde-limão, pt-BR padrão | F0 |
| F2 | Multi-workspace e multi-conta | Seletores, página Contas, saúde por conta | F1 |
| F3 | Segurança base | Auditoria, somente convite, rate limit, retenção | F0 (paralela a F1/F2) |
| F4 | Campanhas v2 | Prioridade, agenda, conflitos, editor em etapas | F1, F3 (auditoria) |
| F5 | Contatos e caixa de entrada | Entidade Contato, tags, filtros, LGPD | F2 |
| F6 | Comentários | Central de comentários e moderação | F5 (`Contact`) |
| F7 | Follow gate v2 | Funil mensurável e política configurável | F5 |
| F8 | Relatórios | Consolidado, comparação, CSV/PDF, relatório por cliente | F6, F7 |
| F9 | Polimento v1.0 | Acessibilidade, performance, E2E, docs de instalação pt-BR | todas |

---

## F0 — Fundação

- PRD e roadmap (este PR).
- `AGENTS.md`: convenções para Claude Code e Codex (seção "Colaboração" abaixo), mantendo o
  aviso existente sobre a versão do Next.js.
- CI: Node 22, job com serviços Postgres e Redis para rodar `*.db.test.ts` [SG-8].
- Template de PR (`.github/pull_request_template.md`) com checklist de segurança, i18n e Meta.

**Pronto quando:** CI roda testes de banco; template de PR em uso.

## F1 — Marca e design system

1. Tokens de cor/tipografia em `app/globals.css`, tema escuro padrão + claro; Geist [PRD §3].
2. `components/ui/*`: Button, Input, Card, Badge, Dialog, Toast, EmptyState, Skeleton, DataTable.
3. Shell: sidebar, topbar, navegação mobile inferior, logo CRIA PING, `manifest.ts`, favicon.
4. Migrar páginas existentes para os componentes (uma página por PR: Painel, Campanhas,
   Editor, Caixa de entrada, Registros, Configurações, Diagnóstico, Login).
5. pt-BR como idioma padrão (`lib/i18n`), revisão de tom do catálogo, e-mail de login em pt-BR.
6. Rebrand de textos: README (mantendo créditos e licença), metadata, páginas legais;
   links de patrocínio removidos da UI (decisão §8 do PRD sobre Zernio).

**Pronto quando:** nenhuma ocorrência de "OpenReply"/"ManyChat Alternative" visível ao
usuário; contraste AA verificado; screenshots mobile/desktop no PR.

## F2 — Multi-workspace e multi-conta

1. Workspace ativo por cookie + `WorkspaceSwitcher` [MC-1, MC-2].
2. `AccountSwitcher` global e filtro por conta nas páginas [MC-3].
3. Página `/accounts` com saúde por conta, movendo conectar/desconectar de Configurações [MC-4].
4. Apelido e cor por conta [MC-5].
5. Escopo de MEMBER por conta [MC-6] (P1, pode deslizar para F9).

**Pronto quando:** usuário com 2 workspaces alterna sem vazar dados (teste de isolamento);
token expirando aparece como alerta no Painel.

## F3 — Segurança base (paralelizável)

1. `proxy.ts` cobrindo todo o painel + teste que varre `app/api/**` exigindo contexto de
   workspace nas rotas privadas [SG-1].
2. `AuditLog` e helper `recordAudit()` chamado em campanhas, contas, membros [SG-2].
3. Modo somente convite [SG-3].
4. Rate limit de rotas (reaproveita padrão Redis de `lib/utils/rate-limiter.ts`) [SG-4].
5. Job de retenção no worker [SG-5]; cabeçalhos de segurança [SG-6].

## F4 — Campanhas v2

1. `priority`, ordenação no worker preservando o comportamento atual (default 0) [CP-1].
2. Detecção de conflito (função pura em `lib/campaigns/conflicts.ts` + aviso no editor) [CP-2].
3. `startsAt`/`endsAt` [CP-3]; `excludeKeywords` [CP-4]; `dailyLimit` [CP-5].
4. Editor em etapas, quebrando `campaign-builder.tsx` sem mudar o contrato da API [PRD §4.1].
5. Templates pt-BR [CP-6].

**Pronto quando:** testes do worker cobrem prioridade, janela de agenda e exclusão; todos os
testes existentes de `dm-worker.test.ts` continuam passando sem alteração de expectativa.

## F5 — Contatos e caixa de entrada

1. Modelo `Contact` + `DmLog.contactId`; worker faz upsert do contato [DM-1].
2. Backfill opcional a partir de `DmLog` (script idempotente).
3. Tags/notas e tag automática por campanha [DM-2].
4. Caixa de entrada com filtros, janela de 24h e painel do contato [DM-3].
5. Excluir/anonimizar contato (LGPD) [DM-7]; respostas salvas [DM-4]; atribuição [DM-5];
   exportação [DM-6].

## F6 — Comentários

1. Modelo `Comment`, gravado em `process-webhook.ts` e no reconciliador; remove
   `ProcessedComment` [CM-1, CM-6].
2. Página `/comments` [CM-2].
3. Resposta pública manual [CM-3]; ocultar/excluir via Graph API [CM-4]; disparo manual [CM-5].

**Atenção Meta:** cada nova chamada (`hide`, `DELETE /{comment-id}`) validada na documentação
oficial e coberta por teste com fixture real anonimizada em `__tests__/`.

## F7 — Follow gate v2

1. `FollowGateEvent` gravado nos pontos já existentes do worker (`dm-worker.ts:640,972,1406`) [FG-1].
2. Relatório de funil [FG-2]; política fail-closed [FG-3]; máximo de re-perguntas [FG-4];
   textos pt-BR [FG-5].

## F8 — Relatórios

1. `DailyMetric` + agregação incremental no worker [RP-7].
2. `/reports` consolidado com comparação de período; `/overview` redireciona [RP-1, RP-2].
3. Exportação CSV [RP-3]; relatório compartilhável por conta [RP-4]; PDF/impressão [RP-5].

## F9 — Polimento v1.0

- Playwright E2E (login simulado, criar campanha, ver relatório) usando o Chromium já
  disponível no ambiente.
- Auditoria de acessibilidade e Lighthouse.
- `docs/setup.md` em pt-BR (ou `docs/instalacao.md`), mantendo a seção Meta intacta.
- Notas de versão v1.0.

---

## Colaboração Claude Code × Codex: branches e PRs

### Regras gerais

- `main` sempre verde e implantável. Nenhum push direto em `main`.
- **Um PR = uma entrega revisável** (idealmente < 400 linhas de diff, excluindo catálogo i18n
  e migrações geradas). PRs abertos como **draft** até CI verde.
- Nome de branch: `<tipo>/f<fase>-<slug>` — ex.: `feat/f2-workspace-switcher`,
  `fix/f4-priority-order`, `docs/f0-prd`, `chore/f0-ci-node22`.
- Commits no padrão Conventional Commits (já usado no repo: `feat(i18n): …`, `fix(worker): …`).
- Antes de abrir PR: `npm run typecheck && npm run lint && npm test` (e `npm run build`
  quando tocar em rotas/config).
- Rebase ou merge de `main` antes do review; resolver conflitos no branch do próprio autor.
- Revisão cruzada: PR do Claude é revisado pelo Codex e vice-versa; mudanças em
  `lib/queue/*`, `lib/meta/*`, `lib/instagram/*`, `prisma/` ou auth exigem também aprovação humana.

### Divisão de responsabilidades (reduz conflitos)

| Área | Dono principal | Motivo |
| --- | --- | --- |
| `prisma/schema.prisma` e migrações | **Claude** (uma por vez, serializadas) | Migrações concorrentes conflitam e quebram a ordem |
| Worker, webhook, provedores Meta/Zernio (`lib/queue`, `lib/meta`, `lib/instagram`, `lib/polling`) | **Claude** | Código sensível a regras da Meta |
| Auth, acesso a workspace, segurança (`lib/auth.ts`, `lib/workspace-access.ts`, `proxy.ts`) | **Claude** | Isolamento entre tenants |
| Design system `components/ui/*`, shell, migração visual de páginas | **Codex** | Trabalho paralelizável por página |
| Novas páginas de UI sobre APIs já mescladas | **Codex** | Depende só de contratos estáveis |
| Catálogos i18n (`lib/i18n/*.json`) | quem toca a UI, **sempre no fim do PR** | Ponto quente de conflito; manter chaves ordenadas |
| Testes | cada autor cobre o próprio PR | |

Fluxo por funcionalidade de ponta a ponta: **Claude** abre o PR de schema + API + testes
(contrato), e só depois de mesclado o **Codex** abre o PR de UI consumindo o contrato.

### Sequência de PRs planejada

A coluna `#` é a ordem planejada, não o número do PR no GitHub. Os PRs reais da trilha MVP
(#4 a #7) estão na tabela da seção "Prioridade atual".

| # | Branch | Dono | Conteúdo | Depende de |
| --- | --- | --- | --- | --- |
| 1 | `docs/f0-prd-roadmap` | Claude | PRD + roadmap | — |
| 2 | `chore/f0-collab-conventions` | Claude | AGENTS.md (colaboração), template de PR | 1 |
| 3 | `chore/f0-ci-db-tests` | Claude | Node 22, Postgres/Redis no CI | — |
| 4 | `feat/f1-design-tokens` | Codex | Tokens, tema escuro/claro, Geist | 2 |
| 5 | `feat/f1-ui-primitives` | Codex | `components/ui/*` | 4 |
| 6 | `feat/f1-app-shell` | Codex | Sidebar, topbar, nav mobile, logo, manifest | 5 |
| 7 | `feat/f1-ptbr-default` | Claude | pt-BR padrão, e-mail de login pt-BR | 2 |
| 8–14 | `feat/f1-page-<nome>` | Codex | Uma página migrada por PR | 6 |
| 15 | `chore/f1-rebrand-copy` | Claude | README/metadata/legal, créditos e licença mantidos | 6 |
| 16 | `feat/f3-route-guard` | Claude | proxy + teste de rotas | 3 |
| 17 | `feat/f3-audit-log` | Claude | `AuditLog` + helper | 3 |
| 18 | `feat/f3-invite-only-ratelimit` | Claude | Somente convite + rate limit | 16 |
| 19 | `feat/f3-retention` | Claude | Job de retenção, headers | 17 |
| 20 | `feat/f2-active-workspace` | Claude | Cookie + contexto | 16 |
| 21 | `feat/f2-switchers-ui` | Codex | Workspace/AccountSwitcher | 6, 20 |
| 22 | `feat/f2-accounts-api` | Claude | Saúde por conta, apelido/cor | 20 |
| 23 | `feat/f2-accounts-page` | Codex | `/accounts` | 21, 22 |
| 24 | `feat/f4-campaign-rules-api` | Claude | priority/agenda/exclusão/limite + worker | 17 |
| 25 | `feat/f4-campaign-wizard` | Codex | Editor em etapas + avisos de conflito | 24 |
| 26 | `feat/f4-ptbr-templates` | Codex | Templates pt-BR | 25 |
| 27 | `feat/f5-contacts-model` | Claude | `Contact`, upsert no worker, backfill | 24 |
| 28 | `feat/f5-contacts-ui` | Codex | `/contacts`, painel na caixa de entrada | 27 |
| 29 | `feat/f5-lgpd-delete` | Claude | Anonimização em cascata | 27 |
| 30 | `feat/f6-comments-model` | Claude | `Comment`, remove `ProcessedComment` | 27 |
| 31 | `feat/f6-comment-moderation-api` | Claude | ocultar/excluir/responder | 30 |
| 32 | `feat/f6-comments-page` | Codex | `/comments` | 31 |
| 33 | `feat/f7-follow-gate-funnel` | Claude | `FollowGateEvent`, política | 27 |
| 34 | `feat/f8-daily-metrics` | Claude | `DailyMetric` + agregação | 30, 33 |
| 35 | `feat/f8-reports-page` | Codex | `/reports`, CSV, compartilhamento | 34 |
| 36 | `test/f9-e2e` | Codex | Playwright | 35 |
| 37 | `docs/f9-instalacao-ptbr` | Claude | Guia de instalação pt-BR | 35 |

Faixas paralelas: F3 (Claude) corre junto com F1 (Codex); a partir de F4 o padrão
"contrato do Claude → UI do Codex" mantém as duas frentes ocupadas sem tocar os mesmos arquivos.

### Checklist de PR (vai para o template)

- [ ] Escopo de um único item do roadmap; descrição cita os IDs do PRD.
- [ ] Typecheck, lint, testes e build passando localmente.
- [ ] Toda query nova filtra por `workspaceId`; rota mutável checa papel.
- [ ] Nenhuma mudança que contorne a API oficial da Meta ou a verificação de assinatura.
- [ ] Migração aditiva, com default compatível, e uma só por PR.
- [ ] Textos novos em pt-BR no catálogo (e chaves equivalentes nos demais idiomas).
- [ ] Screenshots desktop e mobile para mudanças visuais.
- [ ] `LICENSE` e créditos do upstream intactos.
