# Plano incremental: PING CHAT no Claude via MCP

**Status:** plano técnico; este PR é documentação apenas.
**Pré-requisito:** aprovação da arquitetura e das decisões de OAuth, workspace e efeito real.

## Escopo do primeiro lançamento

O MVP transforma linguagem natural em uma campanha de comentário para DM já suportada pelo
PING CHAT. Ele cobre conta, Reel/post, keyword, resposta pública, opening DM, mensagem, até
dois links rastreados, follow gate, follow-up, preview, aprovação e ativação futura.

Não fazem parte do MVP:

- disparos frios, envio retroativo ou tool de DM imediata;
- scraping/login automatizado do Instagram;
- clonagem de contratos, UI ou implementação do ChatFyre;
- publicação de conteúdo no feed;
- atribuição de receita sem webhook e modelo próprios;
- automação de aprovação ou migração em produção.

## Entregas por fase

| Fase | Entrega | Critério de saída | Esforço |
| --- | --- | --- | ---: |
| 0 | Contratos e decisões | Threat model, scopes, schemas e ADRs aprovados | 2–3 dias |
| 1 | Domínio compartilhado | REST e UI usam schema/`CampaignService`; comportamento atual preservado | 4–6 dias |
| 2 | Draft/approval/audit | Migração aditiva testada, version/hash e idempotência cobertos | 4–6 dias |
| 3 | OAuth + gateway MCP | Discovery, PKCE, audience, scopes, revogação e Streamable HTTP em staging | 7–10 dias |
| 4 | Tools de leitura | Contas, capabilities, post, campanhas e analytics workspace-scoped | 4–6 dias |
| 5 | Tools de draft | Create/update/validate/preview com conflitos e URLs seguras | 5–7 dias |
| 6 | Aprovação e ativação | Revisão web, approval single-use, activate/pause e audit end-to-end | 6–9 dias |
| 7 | Hardening e observabilidade | Teste Claude, carga, segurança, alertas, runbook e kill switch | 5–8 dias |
| 8 | Beta controlado | Piloto com contas próprias, métricas e go/no-go humano | 3–5 dias |

**Estimativa total:** 40–60 engineer-days. Uma pessoa: aproximadamente 9–13 semanas; duas
pessoas com backend e interface em paralelo: 6–9 semanas de calendário, incluindo revisão e
estabilização. Não inclui prazo externo de Meta App Review, contratação/configuração de IdP
nem um produto completo de atribuição de vendas.

## Sequência de PRs

Cada PR é independente, abre como draft e não faz merge automático.

1. `docs/f0-chatfyre-rea` — pesquisa, arquitetura e plano (este PR).
2. `refactor/f0-campaign-domain` — schema/normalização/service com characterization tests;
   sem MCP e sem mudança de comportamento.
3. `feat/f0-campaign-drafts` — modelos aditivos, migration única e API interna de draft;
   revisão humana obrigatória, sem executar produção.
4. `feat/f0-mcp-auth` — resource server, discovery, OAuth, scopes, revogação e auditoria.
5. `feat/f0-mcp-read-tools` — capabilities, contas, post resolver, list/get/performance.
6. `feat/f0-mcp-draft-tools` — create/update/validate/preview.
7. `feat/f0-mcp-approval` — tela de revisão e workflow de approval.
8. `feat/f0-mcp-activation` — activate/pause com idempotência e feature flag.
9. `test/f0-mcp-hardening` — contrato com Claude, E2E, segurança, carga e runbooks.

Mudanças em banco, autenticação, Meta/provider, filas e worker seguem as responsabilidades e
revisões definidas em `AGENTS.md`. Alterações no motor de DMs não são necessárias para o
primeiro corte; o objetivo é reutilizar o caminho existente.

## Fase 0 — decisões antes de código

- Escolher authorization server e confirmar suporte a RFC 8414/9728, PKCE S256, audience,
  JWKS, revogação e Client ID Metadata Documents/fallback do Claude.
- Aprovar scopes, papéis mínimos e experiência de seleção do workspace.
- Definir TTL de draft/approval, retenção de audit e base legal LGPD.
- Decidir conflito: uma keyword/post já coberta bloqueia, alerta ou exige override explícito.
- Congelar schema v1 das tools e catálogo de erros.
- Revalidar documentação Meta e capabilities por provider.
- Registrar ADRs para transporte stateless, approval fora do modelo e ausência de `send_dm`.

## Fase 1 — extrair o domínio existente

Objetivo: uma única regra de negócio para a UI e os futuros adapters.

- Mover os Zod schemas locais da rota para `lib/campaigns/schema.ts`.
- Consolidar normalização e limites hoje duplicados no builder/validação/rota.
- Implementar `CampaignService` workspace-scoped para create/update/activate/pause.
- Preservar a API atual com adapter fino e characterization tests.
- Criar preview canônico e serialização estável para hash.
- Adicionar detector de conflitos por conta, escopo do post e keyword.
- Resolver permalink somente contra mídias da conta autorizada.

Gate: diff funcional esperado zero para campanhas existentes; typecheck, lint, unit, DB e
build verdes.

## Fase 2 — persistência segura

- Adicionar `CampaignDraft`, `CampaignApproval`, `McpGrant` e `AuditEvent` ou equivalentes.
- Migration aditiva e reversível do ponto de vista de aplicação; uma migration no PR.
- Índices por `workspaceId`, status/expiração, grant e idempotency key.
- Optimistic concurrency por `version` e unique constraints de consumo/idempotência.
- Job de expiração e retenção sem apagar campanha/analytics existentes.
- Testes reais com dois workspaces provando que IDs cruzados retornam not found.

Nenhuma migration é executada em produção pelo agente. O rollout é uma decisão humana com
backup, janela, observação e rollback de aplicação.

## Fase 3 — OAuth e MCP Gateway

- Publicar HTTPS e metadata de protected resource/authorization server.
- Validar token por JWKS, `iss`, `aud/resource`, `exp`, `scope` e `jti` quando aplicável.
- Consentimento mostra produto, OAuth client, workspace e scopes.
- Short-lived access token, refresh rotativo, revogação por usuário/admin e rotação de chaves.
- Middleware cria `McpAuthContext` e revalida membership/role em toda chamada.
- Streamable HTTP stateless, body/time/concurrency limits, Host/Origin e CORS mínimos.
- Feature flag global e por workspace; kill switch não depende de deploy.
- Logs estruturados redigidos, traces e métricas sem PII.

Gate: suíte de auth negativa (token de outro audience, issuer, workspace, scope, papel,
expirado/revogado) e conexão real de teste no Claude.

## Fases 4 e 5 — tools

### Leitura primeiro

Entregar `get_campaign_capabilities`, `list_instagram_accounts`, `resolve_instagram_post`,
`list_campaigns`, `get_campaign` e `get_campaign_performance`. Essa fase valida auth e tenant
sem permitir ativação.

### Draft depois

Entregar `create_campaign_draft`, `update_campaign_draft`, `validate_campaign_draft` e
`preview_campaign_draft`. O servidor deve:

- aceitar objetivo `SALES`, `PLAYLIST`, `LEADS` ou `FOLLOWERS`;
- retornar warnings honestos para métricas ainda indisponíveis;
- nunca aceitar `is_active: true` no draft;
- marcar texto de post/perfil como untrusted content;
- exibir host final dos links e impacto/conflitos;
- invalidar approval em qualquer mudança.

Gate: prompt completo gera preview correto, mas zero `Automation.isActive` e zero job/DM.

## Fase 6 — revisão e efeito real

- `prepare_campaign_activation` congela hash/version e cria approval `PENDING`.
- Link curto leva à tela PING CHAT autenticada; não contém segredo de ativação.
- Tela mostra conta, post, keywords, cópias, ordem de DMs, links, follow gate, warnings,
  conflitos e frase inequívoca sobre eventos futuros.
- Approve/reject exige role atual. Reautenticação pode ser exigida para risco alto.
- `activate_campaign` consome somente `APPROVED`, com idempotency key e transação.
- `pause_campaign` usa confirmação própria e preserva histórico.
- Audit registra prepare, view, approve/reject, activate/pause e falhas.

Gate: alterar um caractere, trocar role, expirar TTL ou repetir payload com outra chave impede
ativação indevida.

## Estratégia de testes

### Unitários

- normalização de keyword/diacríticos/placeholders e limites;
- canonicalização/hash e optimistic concurrency;
- matriz objetivo → defaults/warnings;
- URL parsing, redirect, IP privado, IDN e UTM;
- scopes, role e catálogo de erros;
- approval state machine e idempotência.

### Banco e integração

- isolamento entre pelo menos dois workspaces em toda tool;
- role removido entre prepare e activate;
- draft modificado após approval;
- mesma idempotency key concorrente;
- account/post de outro tenant;
- transaction rollback sem campanha parcial;
- expiração, revogação e retenção.

### Contrato MCP

- initialize/negociação, `tools/list`, JSON schemas e respostas estruturadas;
- 401 discovery, consentimento, refresh/revocation e 403 por scope;
- Claude Pro/Max e workspace Claude autorizado em staging;
- retry de network sem duplicar draft ou activation;
- respostas grandes, malformed JSON e timeout.

### E2E seguro

- provider fake por padrão: nenhum request real à Meta;
- conta Instagram de teste própria somente na etapa beta humana;
- comentário e DM de teste feitos manualmente após aprovação explícita;
- verificar fila, dedupe, logs, tracked redirect, CTR e pause;
- nunca usar seguidores ou dados de terceiros como massa de teste.

### Segurança e operação

- threat-model review, dependency audit e secret scan;
- testes de IDOR, SSRF, OAuth mix-up/token substitution, replay e prompt injection;
- carga por usuário/workspace e backpressure;
- alertas, dashboards, runbook de revogação/kill switch e restore testado.

## Cenário de aceitação principal

### Pré-condições

- creator autenticado no PING CHAT;
- workspace selecionado no consentimento do Claude;
- conta profissional conectada via Meta oficial e capabilities saudáveis;
- Reel pertence à conta autorizada;
- usuário tem ADMIN ou OWNER e scopes necessários.

### Conversa esperada

1. Creator fornece permalink e pede playlist, keyword `PAGODE`, incentivo a follow e clicks.
2. Claude lista contas/capabilities e resolve o permalink.
3. Claude cria draft `PLAYLIST` com keyword, resposta pública, opening DM, follow gate, mensagem
   e link rastreado.
4. Claude valida e apresenta warnings/conflitos.
5. Claude gera preview e link de revisão. Nenhuma mensagem foi enviada.
6. Creator abre o PING CHAT, revisa o hash visual e aprova.
7. Claude chama activation com idempotency key; a campanha passa a ativa uma única vez.
8. Somente um comentário futuro que corresponda a `PAGODE` entra no worker existente.
9. O link usa redirect rastreado; performance retorna clicks/CTR sem dados pessoais.
10. Pausa impede novos matches sem apagar logs.

### Critérios mensuráveis

- zero campanha ativa antes da aprovação;
- zero cross-workspace em testes automatizados;
- 100% das ativações com `approvedBy`, hash, request e idempotency ID;
- repetição da call não duplica campanha;
- copy/post/link exibidos na aprovação são idênticos ao payload ativado;
- constraints Meta/provider aparecem antes, não depois, da autorização;
- revogação do grant bloqueia a chamada seguinte.

## Rollout

1. Ambiente local com IdP e provider fake.
2. Staging interno, somente tools de leitura.
3. Staging com drafts e approval, activation desabilitada.
4. Conta Instagram própria e activation sob feature flag por workspace.
5. Piloto de poucos creators com logs/alertas e suporte manual.
6. Go/no-go humano com base em erro, abandono na aprovação, duplicate attempts e entregas.
7. Disponibilidade gradual; kill switch e revogação testados antes de ampliar.

## Dependências

- decisão de IdP/authorization server e domínio TLS;
- SDK MCP/versão comprovadamente interoperável com Claude;
- PostgreSQL, Redis/BullMQ e worker existentes;
- app Meta e permissões aprovadas para as capacidades usadas;
- capabilities confiáveis do provider Meta/Zernio;
- serviço de e-mail/login atual para a revisão web;
- revisão jurídica/LGPD de consentimento, audit e retenção;
- produto/analytics para definição de lead e venda antes dessas métricas.

## Riscos de cronograma

- Meta App Review e diferenças de capability entre contas/providers;
- integração do authorization server com identidade/membership atuais;
- edge cases de permalink e paginação de mídia;
- conflito entre campanhas e única private reply por comentário;
- compatibilidade do Claude com registration/metadata escolhidos;
- escopo adicional de vendas, CRM ou A/B estatístico.

Esses riscos devem virar spikes pequenos e decisões explícitas; não justificam enfraquecer
isolamento, aprovação ou API oficial.
