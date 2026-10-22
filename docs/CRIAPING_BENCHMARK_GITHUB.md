# CRIA PING — benchmark de projetos open source

> CRIA PING — by Creator Lab Connect. Base técnica: fork do [OpenReply](https://github.com/diwenne/openreply) (MIT).
> Pesquisa feita em 2026-10-22 a partir de clones locais dos repositórios. Nenhum código de terceiros foi executado nem copiado; as conclusões vêm da leitura do código, das migrações e dos testes. README não foi tratado como prova.

Este documento é só pesquisa. Nada aqui foi implementado.

## 1. Diagnóstico do MVP

| Item | Estado verificado |
| --- | --- |
| Código do MVP (login, conectar conta, campanha comentário → resposta pública → DM → botão → link) | Completo na `main` (herdado do OpenReply) |
| Isolamento entre workspaces | Coberto por `__tests__/workspace-isolation.db.test.ts` contra Postgres real (PRs #5 e #8) |
| Login restrito | `ALLOWED_EMAILS` + `ALLOWED_EMAILS_REQUIRED=true` fecham o login quando a lista está vazia (#9) |
| Diagnóstico de instância | Só para `OPERATOR_EMAILS`; vazio = ninguém (#8) |
| Feature flags | `lib/feature-flags.ts` (#6); novidades nascem desligadas |
| Pooler Supabase | Prisma 7 + adapter-pg validado em PgBouncer modo transação; `npm run db:check` para o banco real (#12) |
| Node | 24.x em CI, Docker e Vercel (#13) |
| Worker | `fly.toml` + `Dockerfile.worker` prontos, nada criado no Fly (#10) |
| CI na `main` (732d925, após #10) | TypeScript checks + Database checks verdes |
| Vercel produção (732d925) | Deploy `READY`. Build ok não significa app funcional: faltam variáveis de banco, Redis e e-mail |

**O que falta para o primeiro login** é configuração, não código: banco Supabase com migrações aplicadas (precisa da sua autorização), segredos na Vercel e provedor de e-mail. Detalhes na seção 7.

## 2. Projetos auditados

| Projeto | Licença / autoria | Último commit | Stack | Testes |
| --- | --- | --- | --- | --- |
| **OpenReply** (upstream, diwenne/openreply) | MIT | 2026-10-05 (`dca8713`, igual à nossa base: nada novo para portar) | Next 16, Prisma 7, BullMQ, Auth.js | ~30 arquivos Vitest |
| **OpenInstaDM** (Xeven777/openinstadm) | MIT, mesmo ancestral do OpenReply | 2026-10-05, ativo | Next 16.3, Prisma 7.9, BullMQ, Auth.js, AI SDK | 21 arquivos, incluindo IA e janela de mensagens |
| **InstaPushDM / InstaAuto** (sirdonvin/instapushdm) | MIT, © flexhunt | 2026-08-23 | Next 16.0, Supabase, sem fila | 4 arquivos, pouca cobertura |
| **AutoDMX** (Qaxlabs/AutoDMX) | MIT, © Qaxlabs, autor único | 2026-09-04 | Next 14.2, Supabase, fila via cron HTTP | Nenhum teste automatizado |
| **open-autoDM** (harshithgangone/open-autodm) | MIT, © Harshith Gangone, autor único, 20 commits | 2026-10-05 | Next 15.5, Supabase, Cloudflare (opennext), pg_cron | Nenhum teste automatizado; só roteiro manual em `docs/TESTING.md` |

Todos são MIT, então ideias e trechos curtos com crédito são compatíveis. Mesmo assim, a recomendação é **reimplementar** no nosso modelo de dados, sem transplantar módulos. Nenhum deles tem workspaces com papéis como o OpenReply.

### 2.1 Segurança e confiabilidade (verificado no código)

| Aspecto | OpenReply / CRIA PING | OpenInstaDM | InstaPushDM | AutoDMX | open-autoDM |
| --- | --- | --- | --- | --- | --- |
| Só API oficial Meta | Sim | Sim | Sim | Sim | Sim |
| Assinatura do webhook | HMAC + comparação em tempo constante | Igual ao OpenReply | HMAC com `timingSafeEqual`, **mas existe a flag `DISABLE_WEBHOOK_SIGNATURE_CHECK`** | HMAC, **comparação com `!==`** (não é tempo constante) | HMAC no corpo bruto + `safeCompare` |
| Token Instagram | AES-256-GCM | AES-256-GCM | **Texto puro** em `users` e `dm_queue` | AES-256-GCM (chave derivada por SHA-256) | AES-256-GCM; App Secret também cifrado |
| Fila / concorrência | BullMQ + worker dedicado | BullMQ | Tabela `dm_queue` declarada, **sem processador encontrado** | Cron lê 50 linhas `sent=false` **sem lock**: duas execuções simultâneas podem enviar em dobro | `claim_due_jobs` com `FOR UPDATE SKIP LOCKED` |
| Idempotência | `ProcessedComment` + chaves únicas | Igual | Parcial (RPC) | `processed_comments` por `comment_id` | Índices únicos `(automation_id, trigger_event_id)` e `(automation_id, trigger_user_id)` |
| Limite de envio | Limites por conta no worker | Igual + orçamento de IA por hora no Redis | Não encontrado | 200/h por conta, contado na aplicação | Janela deslizante 180/h no Postgres |
| Janela de 24h | Erro da Meta mostrado | **Rastreada no Redis e checada antes do envio** | Não | Não | Não |
| Isolamento | Workspaces com papéis, testado | Workspaces + permissões granulares (`WorkspacePermission`) | Um usuário por conta IG | **RLS desligado em todas as tabelas** por migração posterior | RLS por `user_id`, mas **qualquer usuário autenticado pode sobrescrever o App Secret da instância** (`POST /api/setup`) |
| Outros riscos | — | — | Bucket público com INSERT/DELETE; base URL de IA definida pelo usuário (SSRF); `supabase/.temp` versionado | Logs versionados no repositório | Cadastro aberto + setup global = risco de sequestro da instância |

**Conclusão de segurança:** o motor do OpenReply (que já é o nosso) é o mais sólido junto com o OpenInstaDM. Dos outros três, só vale estudar ideias de produto e o padrão `SKIP LOCKED` do open-autoDM; o motor deles não.

### 2.2 Produto (verificado no código)

| Recurso | OpenReply / CRIA PING | OpenInstaDM | InstaPushDM | AutoDMX | open-autoDM |
| --- | --- | --- | --- | --- | --- |
| Comentário → DM com link | Sim | Sim | Sim | Sim | Sim |
| Resposta pública | Sim, com rotação de várias mensagens (`publicReplyMessages`) | Sim | Sim | Sim | Sim |
| Follow gate | Sim (`requireFollow`, mensagem e botão) | Sim | Sim, até 3 tentativas | Sim (`requires_follow`) | Sim |
| DM de abertura com botão | Sim | Sim | Sim | Não | Sim |
| Follow-up com atraso | Sim (um passo) | Sim | **Vários passos** (`follow_up_steps`) | Não | Não |
| Gatilho por DM | Sim | Sim | Sim + story + ice breakers | Não | Não |
| Inbox | Sim (Conversations API, polling) | Sim + **automação de inbox com IA** | Parcial | Não | Não |
| IA | Não | **Sim: provedores BYO cifrados, base de conhecimento, limite de 500 caracteres, sem links, só DM** | Sim (Groq/OpenAI, base URL livre) | Não | Não |
| Contatos | Não (flag `contacts` desligada) | Parcial | Parcial | Sim (tabela + tela) | Sim (tabela + rota) |
| Cliques / funil | Cliques únicos por destinatário, por botão | Igual | Não | Links rastreados + cliques | Analytics básico |
| Criação de campanha | Builder em uma página + templates | Igual | Formulário | Slide-over único | **Wizard em 3 passos (tipo → post → configurar) com prévia de celular** |
| Editor visual de fluxo | Não | Não | Não | Não | Não (é wizard linear) |
| Depuração de webhook | Diagnóstico + `WebhookEvent`/`OperationalEvent` | Igual + cache de snapshots | Não | Logs no console | `debug_events` + tela de debug |

## 3. Matriz de benchmark (prioridades pedidas)

| Funcionalidade | Projeto de referência | Evidência no código ou documentação | Já existe no CRIA PING? | Benefício para creators | Complexidade | Impacto na segurança e Meta | Prioridade | Responsável | Recomendação |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Seletor de conta | OpenReply (já nosso) | `components/account-select.tsx`, usado em inbox, campanhas e logs; `stats` valida a conta no workspace (#8) | Sim | Gerenciar várias contas sem confusão | Baixa | Já validado por workspace | P0 (só identidade visual) | Codex (visual) | Adaptar: só aplicar o design CRIA PING, sem lógica nova |
| Criação simplificada de campanha | open-autoDM | `src/components/automations/new-flow/steps/` (SelectType → SelectPost → Configure) | Parcial (builder em uma página + `lib/templates/campaign-templates.ts`) | Menos atrito na primeira campanha | Média | Nenhum se reutilizar a API atual de automações | P1 | Codex (UI) + Claude (revisão de API) | Reimplementar como wizard sobre o builder atual, atrás da flag `newDesign` |
| Prévia da conversa | open-autoDM | `new-flow/steps/PhoneComponents.tsx` (322 linhas, mock de celular) | Não | Ver a DM antes de publicar e evitar erros | Baixa | Nenhum (só cliente) | P1 | Codex | Reimplementar no nosso design system |
| Templates de automação | OpenReply | `lib/templates/campaign-templates.ts` | Sim | Começar rápido | Baixa | Nenhum | P1 | Codex (conteúdo pt-BR) | Adaptar: traduzir e criar templates de creator brasileiro |
| A/B de respostas | OpenReply (parcial) | `publicReplyMessages` faz rotação, sem métricas por variante | Parcial | Descobrir a copy que converte mais | Média | Precisa de coluna nova (migração com aprovação) | P2 | Claude | Estudar: medir cliques por variante antes de prometer A/B |
| Inbox com respostas assistidas por IA | OpenInstaDM | `InboxAutomation`, `AiProviderCredential` cifrado, `checkAiBudget`, testes `inbox-ai`/`ai-client` | Inbox sim, IA não | Responder mais rápido | Alta | Alto: custo, conteúdo gerado, janela de 24h | P2 | Claude (backend) + Codex (UI) | Estudar; reimplementar só como **sugestão** com revisão humana, nunca envio automático no início |
| Analytics de cliques e funil | OpenReply + AutoDMX | `LinkClick` com cliques únicos por destinatário; AutoDMX `link_clicks` | Parcial (cliques; sem funil comentário → DM → clique) | Provar o resultado da campanha | Média | Baixo (leitura) | P1 | Claude (consultas) + Codex (gráficos) | Adaptar: funil a partir de `DmLog` + `LinkClick`, atrás da flag `reportsV2` |
| Confiabilidade e depuração de webhooks | OpenReply + open-autoDM | `WebhookEvent`, `OperationalEvent`, `/diagnostics`; open-autoDM `debug_events` | Sim | Menos "não chegou a DM" sem explicação | Baixa | Positivo | P0 | Claude | Adaptar: garantir que o diagnóstico mostre o motivo do descarte em pt-BR |
| Janela de 24h antes de enviar | OpenInstaDM | `messaging-window` (Lua no Redis, margem de 60s) + teste | Não (só erro da Meta) | Menos falhas silenciosas | Média | Positivo (evita chamadas recusadas) | P1 | Claude | Reimplementar depois do primeiro teste real, com revisão do motor |
| Follow-up em vários passos | InstaPushDM | `follow_up_steps` JSONB | Parcial (um passo) | Nutrir o lead | Média | Médio: mais mensagens = risco de limite | P2 | Claude | Estudar |
| Editor visual de fluxo | Nenhum dos auditados | Nenhum tem editor real | Não | Fluxos complexos | Alta | Médio | P2 | Codex + Claude | Estudar; não começar antes do MVP em produção |
| Contatos | AutoDMX, open-autoDM | Tabelas `contacts` | Não (flag `contacts`) | Lista de leads | Média | LGPD: dados pessoais | P2 | Claude | Congelado (decisão: sem CRM agora) |
| Claim com `SKIP LOCKED` | open-autoDM | `claim_due_jobs` | Não se aplica (BullMQ) | — | — | — | — | — | Descartar: o BullMQ já resolve |
| Ice breakers / gatilho de story | InstaPushDM | Rotas de story/ice breakers | Não | Mais pontos de entrada | Média | Requer permissões Meta extras | P2 | Claude | Estudar |

## 4. Backlog priorizado para a nova marca

**P0: antes do primeiro creator (sem código novo de backend)**
1. Configurar a infraestrutura (seção 7) e fazer o primeiro login.
2. Rebrand seguro dos textos visíveis (ver `docs/CRIAPING_REBRAND.md`), feito pelo Codex atrás de `newDesign` quando for visual.
3. Teste ponta a ponta com uma conta profissional, com aprovação explícita antes de qualquer DM real.
4. Revisar o diagnóstico em pt-BR para explicar por que um comentário não gerou DM.

**P1: logo após o MVP estável**
5. Wizard de campanha + prévia de celular (Codex, flag `newDesign`).
6. Templates em pt-BR para creators.
7. Funil comentário → DM → clique (flag `reportsV2`).
8. Checagem da janela de 24h no worker (revisão humana obrigatória: mexe no motor).

**P2: depois de validar com usuários**
9. Métricas por variante de resposta (A/B real).
10. Sugestões de resposta com IA no inbox (sem envio automático).
11. Follow-up em vários passos, editor visual e contatos.

## 5. Divisão de tarefas

| Área | Claude | Codex |
| --- | --- | --- |
| Infra, banco, migrações, worker, auth | Dono | — |
| Rebrand de metadados, e-mails e documentação | Dono (textos e config) | Revisa |
| Design system CRIA PING, landing, dashboard | Revisa APIs e acessibilidade | Dono |
| Wizard e prévia de campanha | Revisa contrato da API | Dono |
| Funil e analytics | Consultas e API | Gráficos e tela |
| Janela de 24h, A/B, IA | Dono (com revisão humana) | UI quando houver |

Toda mudança que toca API ou componente compartilhado é revisada pelos dois. Nenhum merge automático.

## 6. O que não fazer (restrições)

- Somente API oficial da Meta. Sem scraping, automação de navegador ou senha do Instagram.
- Não transplantar worker nem módulos inteiros de outros projetos.
- Preservar assinatura de webhook, deduplicação, criptografia, limites e isolamento.
- Não aplicar migrações no Supabase sem autorização. Não expor segredos.
- Recursos incompletos ficam atrás de feature flags.

## 7. Caminho mais curto para o primeiro login do CRIA PING

Tudo isto é configuração sua, sem código novo:

1. **Supabase:** desligar a Data API, redefinir a senha do banco e rodar `npm run db:check` localmente com a URL do pooler (só leitura).
2. **Autorizar a aplicação das migrações** (`prisma migrate deploy` pela porta 5432). Eu faço quando você liberar.
3. **E-mail:** criar uma chave Resend (plano grátis) e definir `EMAIL_FROM` como `CRIA PING <login@seu-dominio>`.
4. **Vercel (Production):** `DATABASE_URL` (pooler 6543), `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `ALLOWED_EMAILS=<seu e-mail>`, `ALLOWED_EMAILS_REQUIRED=true`, `OPERATOR_EMAILS=<seu e-mail>`.
5. Novo deploy e login pelo link mágico.

Para **conectar a conta Instagram** depois do login: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` e a URL de redirect OAuth cadastrada no app Meta com o mesmo domínio de `NEXTAUTH_URL`. Para **enviar** DMs: `REDIS_URL` (Redis Cloud grátis, `noeviction`), webhook Meta apontando para o domínio e o worker no Fly (custo a aprovar). O Redis é aberto só sob demanda, então não bloqueia o login.
