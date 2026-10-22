# Auto Insta — PRD (Documento de Requisitos de Produto)

> Status: rascunho v1 · Data: 2026-10-22 · Base: fork do OpenReply (`main` em `dca8713`)
> Escopo deste documento: diagnóstico do código atual, visão de produto, design system,
> telas, modelo de dados alvo e requisitos por módulo. O plano de entrega incremental,
> branches e PRs está em [ROADMAP.md](ROADMAP.md).

---

## 0. Princípios não negociáveis

1. **Integração oficial da Meta preservada.** Instagram API com Instagram Login, webhooks
   assinados, `instagram_business_*`. Nada de scraping, automação de navegador ou senha
   de Instagram. Nenhum PR pode remover ou contornar `lib/meta/*`, `lib/instagram/*`
   ou a verificação de assinatura em `lib/meta/webhook.ts`.
2. **Licença MIT preservada.** `LICENSE` (Anish Raj, Diwen Huang) permanece intacto. O
   rebrand para Auto Insta mantém a seção de créditos do upstream (README e página "Sobre").
   Novos arquivos herdam a MIT; não introduzir dependências com licença incompatível
   (GPL/AGPL/SSPL) sem decisão explícita.
3. **Reutilizar antes de reescrever.** O worker (`lib/queue/dm-worker.ts`, ~1.650 linhas)
   tem anos-equivalente de correções de casos de borda da Meta (entrega não confirmada,
   código 1, postback durável, recuperação de conversa). Evoluir por extensão, nunca por
   reescrita.
4. **Segurança por padrão.** Tokens cifrados (AES via `ENCRYPTION_KEY`), checagem de papel
   em toda rota mutável, isolamento por workspace em toda query, LGPD.
5. **100% pt-BR na interface do Auto Insta.** pt-BR como idioma padrão; o mecanismo i18n
   existente continua (en/zh-TW permanecem como opcionais para não quebrar o upstream).

---

## 1. Diagnóstico — inventário do que existe

Linha de base verificada nesta sessão: `vitest` 26 arquivos / 322 testes passando
(15 pulados, que exigem banco), `tsc --noEmit` limpo.

### 1.1 Arquitetura

| Camada | Tecnologia | Onde |
| --- | --- | --- |
| Web + API + webhooks | Next.js 16 (App Router, `proxy.ts` no lugar de middleware), React 19, React Compiler | `app/` |
| Worker de envio | BullMQ sobre Redis, processo Node separado (`npm run worker`) | `worker/dm-worker.ts`, `lib/queue/*` |
| Reconciliador de comentários | Varredura periódica dentro do worker | `lib/polling/comment-reconciler.ts` |
| Banco | PostgreSQL + Prisma 7 (adapter `pg`, client gerado em `app/generated/prisma`) | `prisma/schema.prisma`, 23 migrações |
| Auth | Auth.js v5 beta, magic link (Resend ou SMTP), `ALLOWED_EMAILS` opcional | `lib/auth.ts` |
| Provedores Instagram | `META` (app próprio) e `ZERNIO` (provedor pago opcional) atrás de uma interface comum | `lib/instagram/provider.ts`, `lib/zernio/*` |
| Crons | refresh de token, snapshot de seguidores, anexar próximo reel | `app/api/cron/*`, `vercel.json`, `scripts/cron.sh` |
| UI | Tailwind 4, Recharts, fonte Geist local | `components/`, `app/globals.css` |
| CI | typecheck, lint, test, build (Node 20) | `.github/workflows/ci.yml` |

### 1.2 Funcionalidades atuais

| Área | O que já funciona | Arquivos-chave |
| --- | --- | --- |
| **Contas** | Várias contas profissionais por workspace; conexão OAuth Meta ou importação Zernio; refresh diário de token; flag `webhookSubscribed` | `app/api/instagram/*`, `lib/instagram-accounts.ts` |
| **Workspaces** | Papéis OWNER/ADMIN/MEMBER, convites por link com expiração | `lib/workspace*.ts`, `app/api/workspace/*` |
| **Campanhas** | Palavra-chave → DM; um post, qualquer post ou "próximo reel"; palavra inteira/parcial; DM inicial com botão (abertura de janela); até 2 botões de link rastreado; resposta pública com variações; follow-up com atraso; gatilho por DM/resposta a Story; duplicar; importar CSV; templates | `components/campaign-builder.tsx`, `app/api/automations/*`, `lib/templates/*` |
| **Comentários** | Webhook `comments` + reconciliador para comentários perdidos; filtro de autocomentário; deduplicação "uma resposta privada por comentário" entre campanhas | `lib/queue/process-webhook.ts`, `lib/queue/dm-worker.ts:500` |
| **DMs** | Caixa de entrada (leitura/resposta dentro da janela de 24h, cache); logs de DM com motivo; recuperação de conversa; postback durável | `app/(dashboard)/inbox`, `lib/instagram/read-inbox.ts`, `docs/conversation-recovery.md` |
| **Follow gate** | Pede para seguir, verifica `is_user_follow_business` no toque do botão, re-pergunta, *fail-open* em erro | `lib/queue/dm-worker.ts:640,972,1406`, `lib/meta/client.ts:269` |
| **Rate limit** | 750 respostas privadas/hora por conta (Redis), overflow enfileirado | `lib/utils/rate-limiter.ts` |
| **Relatórios** | Dashboard (stats), Overview (insights + histórico de seguidores), relatório público compartilhável por campanha, cliques únicos por destinatário, CTR | `lib/reports/*`, `lib/tracking/*`, `app/reports/[shareSlug]` |
| **Operação** | `/api/health` (DB, Redis, fila, heartbeat do worker), página de diagnóstico, `OperationalEvent` | `app/api/health`, `app/(dashboard)/diagnostics` |
| **i18n** | en / zh-TW / pt-BR (448 chaves), cookie de idioma, chaves tipadas em compile time | `lib/i18n/*`, `docs/localization.md` |
| **Deploy** | Vercel + Railway, Docker, Dokploy | `Dockerfile`, `docs/deploy-dokploy.md` |

### 1.3 Lacunas e riscos

**Marca e UX**
- G1. Marca ainda é OpenReply/"ManyChat Alternative" em README, metadata, landing, sidebar,
  e-mails, `manifest.ts`, comentários do schema; links de patrocínio Zernio na UI.
- G2. Design system atual é claro, laranja `#f97316`, sem tema escuro, com aliases legados
  (`.glass`, `.gradient-mesh`). Não há biblioteca de componentes: botões, inputs e cards
  são classes Tailwind repetidas por página.
- G3. Idioma padrão é inglês; landing, páginas legais, SEO e e-mails de login ficam em inglês
  por design (`docs/localization.md`).
- G4. Navegação mistura "Dashboard" e "Overview" (sobreposição) e "Automations" (rota legada)
  com "Campaigns".

**Múltiplas contas / workspaces**
- G5. `getCurrentWorkspaceContext()` sempre pega a **primeira** associação do usuário
  (`lib/workspace-access.ts`) — não há seletor de workspace. Uma agência convidada para
  vários clientes só vê um.
- G6. Não há seletor global de conta Instagram nem visão consolidada "todas as contas";
  não há saúde por conta (token expirando, webhook não assinado, limite atingido) em
  um único lugar.
- G7. Papel MEMBER não tem escopo por conta (ex.: operador de atendimento só de um cliente).

**Campanhas**
- G8. Conflito entre campanhas é resolvido implicitamente pela mais antiga (`orderBy createdAt`)
  — sem prioridade explícita nem aviso de sobreposição no editor. Respostas públicas de
  todas as campanhas coincidentes saem.
- G9. Sem agendamento (início/fim), sem limite por campanha, sem pausa automática,
  sem teste A/B de mensagens, sem histórico de versões.
- G10. Sem "regras negativas" (palavras que bloqueiam), lista de bloqueio de usuários ou
  janela de silêncio.

**Comentários**
- G11. Não há central de comentários: o usuário não vê comentários que **não** casaram.
- G12. Sem moderação (ocultar/excluir/responder manualmente) — permitido por
  `instagram_business_manage_comments`, mas não implementado.

**DMs / Contatos**
- G13. Não existe entidade **Contato**: o comentador vive só em `DmLog`. Sem tags, notas,
  histórico unificado, segmentação ou exportação.
- G14. Caixa de entrada sem atribuição, status (aberto/resolvido), respostas salvas ou filtros.

**Follow gate**
- G15. Sem métricas de funil (pediu → tocou → seguiu → recebeu link), sem política
  configurável de *fail-open/fail-closed*, sem limite de re-pergunta visível.

**Relatórios**
- G16. Sem relatório consolidado multi-conta, comparação de períodos, exportação CSV/PDF
  ou envio agendado. Relatório compartilhável é por campanha apenas.

**Segurança e operação**
- G17. `proxy.ts` protege só `/dashboard`, `/automations`, `/logs`, `/settings`. As demais
  rotas do grupo `(dashboard)` são protegidas pelo `layout.tsx`, mas a defesa em
  profundidade está inconsistente.
- G18. Sem log de auditoria (quem criou/editou/excluiu campanha, conectou conta, convidou).
- G19. Sem rate limit nas rotas de API próprias (login por magic link, criação de campanha).
- G20. `ALLOWED_EMAILS` é opcional: instância self-hosted aberta cria workspace para qualquer
  e-mail. Para Auto Insta deve ser obrigatório ou substituído por "cadastro só por convite".
- G21. Sem fluxo LGPD de exportação/exclusão de dados do contato (só a página estática
  `data-deletion`), sem política de retenção para `WebhookEvent`/`DmLog`.
- G22. Resíduos: `ProcessedComment` sem uso, `canManageBilling`, `SKIPPED_PLAN_LIMIT`,
  campos de uso `dmsSentThisPeriod` remanescentes da remoção de billing.
- G23. CI em Node 20; nenhum teste E2E de UI; testes de banco pulados no CI.

---

## 2. Visão de produto

**Auto Insta** é a central de automação self-hosted para quem opera **várias contas de
Instagram** — agências, social media e marcas com múltiplos perfis — usando apenas a API
oficial da Meta. Ela transforma comentários e DMs em conversas, leads e relatórios, sem
mensalidade por conta.

### 2.1 Personas

| Persona | Necessidade | Métrica de sucesso |
| --- | --- | --- |
| **Dono(a) de agência** | Ver todos os clientes em um painel, provar resultado | Relatório mensal por cliente em < 2 min |
| **Social media / operador** | Criar campanha de "comenta LINK" rápido, responder DMs | Campanha no ar em < 3 min |
| **Criador(a) / marca** | Crescer seguidores com follow gate e medir conversão | Taxa comentário → seguidor |
| **Admin técnico** | Instalar, manter seguro, diagnosticar | Health verde, zero vazamento entre workspaces |

### 2.2 Objetivos (v1.0)

1. Rebrand completo e interface premium, responsiva, 100% pt-BR.
2. Operação multi-workspace e multi-conta de primeira classe.
3. Campanhas com prioridade, agendamento e regras de exclusão.
4. Central de comentários e de contatos.
5. Follow gate mensurável.
6. Relatórios consolidados e exportáveis.
7. Endurecimento de segurança (auditoria, convite obrigatório, rate limit, LGPD).

### 2.3 Fora de escopo (v1.0)

- Billing/planos pagos (removido no upstream; manter removido).
- Publicação/agendamento de posts (exige outras permissões e App Review).
- Envio em massa (*broadcast*) fora da janela de 24h — viola as políticas de mensagens da Meta.
- Outros canais (WhatsApp, Messenger, TikTok).
- IA generativa de respostas (candidato a v1.x, atrás de feature flag).

### 2.4 Restrições da plataforma Meta a respeitar em todo requisito

- Uma única resposta privada por comentário (já tratado no worker).
- Mensagens só dentro da janela de 24h após interação do usuário (botões/postbacks renovam).
- Teto documentado de 750 respostas privadas/hora por conta (já tratado).
- Conta precisa ser Business/Creator; contas de terceiros exigem App Review (Advanced Access).
- Dono da conversa: outra ferramenta conectada quebra postbacks (`docs/setup.md`).
- Toda nova chamada de Graph API deve ser validada na documentação oficial e coberta por
  teste com payload real anonimizado.

---

## 3. Design system

### 3.1 Tokens de cor

Tema **escuro como padrão** (identidade da marca), com tema claro opcional.

| Token | Escuro (padrão) | Claro | Uso |
| --- | --- | --- | --- |
| `--color-background` | `#090909` | `#F5F5F5` | Fundo da aplicação |
| `--color-surface` | `#202020` | `#FFFFFF` | Cards, painéis, sidebar |
| `--color-surface-raised` | `#2A2A2A` | `#FAFAFA` | Hover, popovers, modais |
| `--color-border` | `#2E2E2E` | `#E2E2E2` | Divisores, bordas de campo |
| `--color-foreground` | `#F5F5F5` | `#090909` | Texto principal |
| `--color-muted` | `#9A9A9A` | `#5C5C5C` | Texto secundário (contraste ≥ 4.5:1) |
| `--color-accent` | `#CAFF18` | `#CAFF18` | CTA primário, foco, estado ativo |
| `--color-accent-foreground` | `#090909` | `#090909` | Texto sobre o verde-limão (nunca branco) |
| `--color-accent-subtle` | `#CAFF18` @ 12% | `#CAFF18` @ 20% | Fundo de badge/realce |
| `--color-success` | `#4ADE80` | `#15803D` | Enviado, ativo |
| `--color-warning` | `#FBBF24` | `#B45309` | Atenção, limite próximo |
| `--color-error` | `#F87171` | `#B91C1C` | Falha |
| `--color-info` | `#60A5FA` | `#1D4ED8` | Informativo |

Regras:
- `#CAFF18` **nunca** como cor de texto sobre fundo claro (contraste insuficiente); no tema
  claro o acento aparece como preenchimento com texto `#090909`.
- Máximo de um botão primário (verde) por área de tela.
- Cores de estado não dependem só de cor: sempre ícone ou rótulo.
- Os tokens substituem o bloco `@theme inline` em `app/globals.css`; aliases legados
  (`.glass`, `.gradient-mesh`) são removidos depois que nenhuma página os usar.

### 3.2 Tipografia, espaço e forma

- Fonte: **Geist** (já empacotada em `public/fonts`, licença OFL) para UI; Geist Mono para
  IDs, slugs e números tabulares.
- Escala: 12 / 14 / 16 / 20 / 24 / 32 / 40 px; corpo 14px no desktop, 16px em campos no
  mobile (regra iOS já existente).
- Espaçamento base 4px; raio: 8px (campos), 12px (cards), 999px (pills/badges).
- Elevação por contraste de superfície, não sombra; sombra apenas em modais.
- Movimento: 150–200ms, `prefers-reduced-motion` respeitado.

### 3.3 Componentes (`components/ui/`)

Primitivos sem dependência externa nova (Tailwind + React), testáveis isoladamente:

| Componente | Variantes / notas |
| --- | --- |
| `Button` | primary (verde), secondary (grafite), ghost, danger; tamanhos sm/md/lg; `loading` |
| `IconButton` | com `aria-label` obrigatório |
| `Input`, `Textarea`, `Select`, `Switch`, `Checkbox`, `RadioGroup` | label, ajuda, erro, contador de caracteres |
| `KeywordInput` | evolução de `components/keyword-input.tsx` (chips) |
| `Card`, `Panel`, `Section` | cabeçalho, ações, rodapé |
| `Badge` / `StatusBadge` | evolução de `components/status-badge.tsx`; mapeia `DmStatus` |
| `StatCard` | evolução de `components/stat-card.tsx`; valor, delta, sparkline |
| `Table` / `DataTable` | ordenação, paginação, estado vazio, colapsa em lista no mobile |
| `Tabs`, `SegmentedControl` | |
| `Dialog`, `Drawer`, `ConfirmDialog` | foco preso, `Esc`, retorno de foco |
| `Toast` | sucesso/erro, `aria-live` |
| `EmptyState`, `Skeleton`, `ErrorState` | toda lista tem os três |
| `AccountSwitcher` | avatar + @usuário; "Todas as contas" |
| `WorkspaceSwitcher` | lista de workspaces do usuário |
| `PhonePreview` | evolução de `components/campaign-preview.tsx` (prévia da DM no estilo Instagram) |
| `Chart` wrappers | Recharts com paleta da marca, tema escuro/claro |
| `Logo` | wordmark "Auto Insta" + ícone (SVG), favicon e ícones PWA |

### 3.4 Layout e responsividade

- **Desktop (≥1024px):** sidebar fixa 248px (grafite), topbar com WorkspaceSwitcher,
  AccountSwitcher, busca e menu do usuário; conteúdo com largura máxima 1280px.
- **Tablet (640–1023px):** sidebar recolhível em trilho de ícones.
- **Mobile (<640px):** gaveta lateral (já existente) + barra inferior com 4 atalhos
  (Painel, Campanhas, Caixa de entrada, Mais); tabelas viram listas de cards; ações
  primárias em botão fixo inferior.
- Acessibilidade: WCAG 2.2 AA, foco visível verde, navegação por teclado, alvos ≥ 44px.

---

## 4. Mapa de telas

Navegação principal (pt-BR):

| Item | Rota | Status | Conteúdo |
| --- | --- | --- | --- |
| Painel | `/dashboard` | existe → redesenhar | KPIs do período (comentários, DMs, cliques, novos seguidores), saúde das contas, campanhas em destaque, alertas |
| Contas | `/accounts` *(nova)* | nova | Cards por conta: status do token, webhook, uso do limite/hora, seguidores; conectar/desconectar (sai de Configurações) |
| Campanhas | `/campaigns` | existe | Lista com filtros por conta/status, prioridade, agendamento; editor em etapas |
| Comentários | `/comments` *(nova)* | nova | Feed de comentários por post: casou/não casou, campanha, ações de moderação |
| Caixa de entrada | `/inbox` | existe → evoluir | Conversas com filtros, atribuição, status, respostas salvas, painel do contato |
| Contatos | `/contacts` *(nova)* | nova | Lista, tags, histórico, exportação, exclusão LGPD |
| Relatórios | `/reports` *(nova, absorve `/overview`)* | nova | Consolidado multi-conta, por conta, por campanha, funil do follow gate, exportação |
| Registros | `/logs` | existe | Logs de envio (renomear "DM Logs" → "Registros de envio") |
| Configurações | `/settings` | existe | Workspace, membros e permissões, idioma/tema, integrações (Meta/Zernio), segurança, auditoria |
| Diagnóstico | `/diagnostics` | existe | Health, eventos operacionais, webhooks recentes (só ADMIN+) |

Rotas legadas: `/overview` redireciona para `/reports`; `/automations` redireciona para
`/campaigns` (mantidas por compatibilidade de links).

### 4.1 Editor de campanha (em etapas)

1. **Gatilho** — conta, onde (post específico, qualquer post, próximo reel, DM/Story),
   palavras-chave, palavras de exclusão, correspondência.
2. **Mensagem** — DM inicial opcional, mensagem com `{username}`, até 2 botões de link
   rastreado, follow gate.
3. **Resposta pública** — variações.
4. **Follow-up** — mensagem e atraso.
5. **Agenda e regras** — início/fim, prioridade, limite diário.
6. **Revisão** — prévia no celular, avisos de conflito com outras campanhas, ativar.

Reaproveita `campaign-builder.tsx` quebrando-o em componentes por etapa; a API
`app/api/automations/route.ts` continua a fonte de verdade de validação (zod).

---

## 5. Requisitos por módulo

Prioridade: **P0** = v1.0 obrigatório · **P1** = v1.0 desejável · **P2** = pós-v1.

### 5.1 Múltiplas contas e workspaces

| ID | Requisito | Prioridade |
| --- | --- | --- |
| MC-1 | Seletor de workspace na topbar; workspace ativo persistido em cookie HTTP-only validado no servidor contra `WorkspaceMember` | P0 |
| MC-2 | `getCurrentWorkspaceContext()` passa a respeitar o workspace ativo (fallback: primeira associação, comportamento atual) | P0 |
| MC-3 | Seletor de conta Instagram global ("Todas as contas" ou uma) filtrando Painel, Campanhas, Comentários, Caixa de entrada, Relatórios | P0 |
| MC-4 | Página Contas com saúde: token expira em < 7 dias, webhook não assinado, limite/hora > 80%, último evento recebido | P0 |
| MC-5 | Apelido e cor por conta para distinguir clientes | P1 |
| MC-6 | Escopo de MEMBER por conta (`WorkspaceMemberAccount`) — operador só vê contas atribuídas | P1 |
| MC-7 | Papel novo `VIEWER` (só leitura, ex.: cliente final vendo relatório) | P2 |

### 5.2 Campanhas

| ID | Requisito | Prioridade |
| --- | --- | --- |
| CP-1 | Campo `priority` (int); worker ordena por `priority desc, createdAt asc` (preserva comportamento atual com default 0) | P0 |
| CP-2 | Aviso no editor quando outra campanha ativa da mesma conta casa as mesmas palavras/post | P0 |
| CP-3 | `startsAt` / `endsAt`; worker ignora fora da janela; badge "Agendada"/"Encerrada" | P0 |
| CP-4 | Palavras de exclusão (`excludeKeywords`) | P1 |
| CP-5 | Limite diário de DMs por campanha | P1 |
| CP-6 | Templates em pt-BR (lead magnet, cupom, link na bio, sorteio, lista VIP) | P0 |
| CP-7 | Histórico de alterações via log de auditoria | P1 |
| CP-8 | Teste A/B de mensagem (2 variantes, divisão 50/50, vencedor por CTR) | P2 |

### 5.3 Comentários

| ID | Requisito | Prioridade |
| --- | --- | --- |
| CM-1 | Persistir todo comentário recebido (webhook ou reconciliador) em `Comment`, com resultado do casamento (casou/sem campanha/ignorado) | P0 |
| CM-2 | Central de comentários por conta e post, com filtros e busca | P0 |
| CM-3 | Responder publicamente a partir da central (usa a mesma rota de envio do worker) | P1 |
| CM-4 | Ocultar/mostrar e excluir comentário via Graph API (`instagram_business_manage_comments`), com confirmação e auditoria | P1 |
| CM-5 | Disparar manualmente uma campanha para um comentário que não casou (respeitando "uma resposta privada por comentário") | P1 |
| CM-6 | Retenção configurável (padrão 90 dias) | P0 |

> `ProcessedComment` (sem uso) é removido e substituído por `Comment` em migração dedicada.

### 5.4 DMs, caixa de entrada e contatos

| ID | Requisito | Prioridade |
| --- | --- | --- |
| DM-1 | Entidade `Contact` (por conta Instagram + IGSID), criada/atualizada pelo worker em cada interação; `DmLog` ganha `contactId` | P0 |
| DM-2 | Tags e notas no contato; tag automática por campanha ("veio da campanha X") | P0 |
| DM-3 | Caixa de entrada: filtros (conta, não lidas, status, tag), indicador da janela de 24h, painel lateral do contato | P0 |
| DM-4 | Respostas salvas com variáveis | P1 |
| DM-5 | Atribuição de conversa a membro e status aberto/resolvido | P1 |
| DM-6 | Exportar contatos (CSV) com consentimento e auditoria | P1 |
| DM-7 | Excluir/anonimizar contato (LGPD), em cascata em `DmLog`, `LinkClick`, `Comment` | P0 |

### 5.5 Follow gate

| ID | Requisito | Prioridade |
| --- | --- | --- |
| FG-1 | Registrar etapas do funil por envio: `PROMPTED`, `TAPPED`, `FOLLOW_CONFIRMED`, `LINK_SENT`, `FAILED_OPEN` | P0 |
| FG-2 | Relatório de funil por campanha e conta | P0 |
| FG-3 | Política configurável por campanha: *fail-open* (padrão atual) ou *fail-closed* com mensagem de tentar novamente | P1 |
| FG-4 | Máximo de re-perguntas configurável, exibido no editor | P1 |
| FG-5 | Textos padrão em pt-BR para pedido e botão | P0 |

### 5.6 Relatórios

| ID | Requisito | Prioridade |
| --- | --- | --- |
| RP-1 | Relatório consolidado do workspace: por conta e por campanha, período selecionável, comparação com período anterior | P0 |
| RP-2 | KPIs: comentários recebidos, casados, DMs enviadas/falhas, cliques únicos, CTR, novos seguidores, conversão do follow gate | P0 |
| RP-3 | Exportação CSV (reaproveita `lib/utils/csv.ts`) | P0 |
| RP-4 | Relatório compartilhável por **conta** (cliente), além do por campanha atual, com slug revogável | P1 |
| RP-5 | Exportação PDF / impressão com marca | P1 |
| RP-6 | Envio agendado por e-mail (semanal/mensal) | P2 |
| RP-7 | Agregações diárias materializadas (`DailyMetric`) para não varrer `DmLog`/`LinkClick` em períodos longos | P1 |

### 5.7 Segurança, privacidade e operação

| ID | Requisito | Prioridade |
| --- | --- | --- |
| SG-1 | `proxy.ts` cobre todas as rotas do painel; testes garantem que toda rota em `app/api/**` (exceto webhook, cron, health, `r/`, relatórios públicos) chama `getCurrentWorkspaceContext` | P0 |
| SG-2 | Log de auditoria (`AuditLog`: ator, ação, alvo, workspace, IP com hash, data) | P0 |
| SG-3 | Modo "somente convite": novo usuário só entra com convite ou e-mail em `ALLOWED_EMAILS`; documentado como padrão do Auto Insta | P0 |
| SG-4 | Rate limit (Redis) em login por magic link, criação de convites e rotas mutáveis | P0 |
| SG-5 | Retenção: `WebhookEvent` 30 dias, `OperationalEvent` 30 dias, `Comment` 90 dias, configuráveis por env | P0 |
| SG-6 | Cabeçalhos de segurança (CSP, HSTS, `frame-ancestors`) em `next.config.ts` | P1 |
| SG-7 | Remover resíduos de billing (`canManageBilling`, uso por período) após confirmar que nenhum caminho os lê | P1 |
| SG-8 | CI em Node 22 LTS, job com Postgres+Redis para rodar os testes `*.db.test.ts` | P1 |
| SG-9 | Rotação de `ENCRYPTION_KEY` documentada (re-cifrar tokens) | P2 |

---

## 6. Modelo de dados alvo (incremental)

Todas as mudanças são **aditivas** e com default compatível; nenhuma coluna existente é
renomeada na v1.0. Uma migração por PR, na ordem do roadmap.

```prisma
// Workspace ativo é cookie; sem mudança de schema para MC-1/MC-2.

model InstagramAccount {
  // + nickname String?   + color String?
}

model Automation {
  // + priority Int @default(0)
  // + startsAt DateTime?  + endsAt DateTime?
  // + excludeKeywords String[] @default([])
  // + dailyLimit Int?
  // + followGateFailClosed Boolean @default(false)
  // + followGateMaxPrompts Int @default(3)
}

model Contact {
  id                 String   @id @default(cuid())
  workspaceId        String
  instagramAccountId String
  igsid              String   // ID do usuário no escopo da conta
  username           String?
  firstSeenAt        DateTime @default(now())
  lastInteractionAt  DateTime?
  followsBusiness    Boolean?
  notes              String?
  anonymizedAt       DateTime?
  tags               ContactTag[]
  @@unique([instagramAccountId, igsid])
  @@index([workspaceId])
}

model Tag        { id String @id @default(cuid()); workspaceId String; name String; color String?; @@unique([workspaceId, name]) }
model ContactTag { contactId String; tagId String; createdAt DateTime @default(now()); @@id([contactId, tagId]) }

model Comment {
  id                 String   @id @default(cuid())
  workspaceId        String
  instagramAccountId String
  commentId          String   @unique
  mediaId            String
  contactId          String?
  text               String
  source             String   // WEBHOOK | POLLING
  matchResult        String   // MATCHED | NO_CAMPAIGN | SELF | IGNORED
  automationId       String?
  hiddenAt           DateTime?
  receivedAt         DateTime @default(now())
  @@index([instagramAccountId, mediaId, receivedAt])
}

model FollowGateEvent {
  id String @id @default(cuid())
  dmLogId String
  stage   String // PROMPTED | TAPPED | FOLLOW_CONFIRMED | LINK_SENT | FAILED_OPEN
  createdAt DateTime @default(now())
  @@index([dmLogId])
}

model AuditLog {
  id String @id @default(cuid())
  workspaceId String
  actorUserId String?
  action String      // campaign.create, account.connect, member.invite, comment.hide, contact.delete…
  targetType String
  targetId String?
  metadata Json?
  ipHash String?
  createdAt DateTime @default(now())
  @@index([workspaceId, createdAt])
}

model DailyMetric {
  workspaceId String; instagramAccountId String; automationId String?; date DateTime @db.Date
  comments Int @default(0); matched Int @default(0); dmsSent Int @default(0); dmsFailed Int @default(0)
  uniqueClicks Int @default(0); followConfirmed Int @default(0)
  @@id([instagramAccountId, date, automationId])
}

// DmLog: + contactId String?
// WorkspaceMemberAccount (P1): memberId + instagramAccountId
```

Regras de isolamento: toda tabela nova carrega `workspaceId` e toda query filtra por ele;
helpers em `lib/workspace-access.ts` são o único ponto de entrada.

---

## 7. Métricas de sucesso do produto

- Tempo até a primeira campanha ativa após conectar conta: **< 5 min**.
- Taxa de entrega (SENT / casados elegíveis): **≥ 97%**.
- Zero incidente de vazamento entre workspaces (testes de isolamento no CI).
- 100% das strings do painel em pt-BR (teste de catálogo + verificação de chaves sem tradução).
- Lighthouse mobile ≥ 90 em Painel e Campanhas; WCAG AA.

## 8. Decisões em aberto (para o responsável pelo produto)

1. **Zernio:** manter como provedor opcional escondido em "Integrações avançadas" (recomendado:
   preserva compatibilidade e é código já testado) ou remover? Remover os links de patrocínio
   da UI do Auto Insta é independente dessa decisão.
2. **Upstream:** continuar puxando correções do OpenReply? Se sim, o rebrand deve tocar o mínimo
   possível de arquivos do worker e manter nomes internos (pacote, enums) para reduzir conflitos.
3. **Idiomas:** manter en/zh-TW como opcionais (recomendado, custo baixo) ou remover?
4. **Páginas públicas de SEO** (`manychat-alternative`, etc.): reescrever em pt-BR ou remover?
