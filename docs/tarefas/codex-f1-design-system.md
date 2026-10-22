# Tarefa Codex — F1: design tokens e componentes base Auto Insta

> Responsável principal: **Codex**. Revisão: Claude Code. Regras gerais em `AGENTS.md`.
> Roda em paralelo com o MVP, sem afetar produção: tudo atrás da flag `newDesign`
> (`lib/feature-flags.ts`), **desligada em produção**.

## Contexto

- PRD §3 (design system) e roadmap F1: `docs/AUTO_INSTA_PRD.md`, `docs/ROADMAP.md`.
- Identidade: preto `#090909`, verde-limão `#CAFF18` (texto sobre ele sempre `#090909`),
  grafite `#202020`, branco `#F5F5F5`. Tema escuro como padrão, claro opcional, contraste
  WCAG AA.

## Escopo (PRs pequenos, nesta ordem)

1. `feat/f1-design-tokens`: os tokens do PRD §3.1 em `app/globals.css`, aplicados **só com
   `newDesign` ligada**. Por exemplo, `data-design="v2"` no `<html>`, decidido no layout
   servidor com `isFeatureEnabled("newDesign")`. Sem a flag, o visual atual não muda.
2. `feat/f1-ui-primitives`: `components/ui/` com Button, Input/Textarea/Select, Card, Badge,
   Dialog, Toast, EmptyState, Skeleton e DataTable (PRD §3.3). Sem dependências novas.
3. `feat/f1-app-shell`: sidebar, topbar e navegação inferior no mobile com o logo Auto Insta,
   também atrás da flag.

## Regras

- Não tocar em `lib/queue/**`, `lib/meta/**`, `lib/instagram/**`, `prisma/**`, autenticação
  ou rotas de API.
- Textos novos nos catálogos de `lib/i18n/` (pt-BR revisado; zh-TW com as mesmas chaves).
- Screenshots desktop e mobile, com a flag ligada e desligada, em cada PR.
- `npm run typecheck && npm run lint && npm test` antes de abrir; PR em rascunho; merge
  sempre humano.
- Não renomear arquivos ou estruturas existentes (compatibilidade com o upstream OpenReply).

## Pronto quando

Com `FEATURE_FLAGS=newDesign` no Preview, painel e login aparecem com a identidade Auto Insta;
sem a flag, a produção fica idêntica à atual.
