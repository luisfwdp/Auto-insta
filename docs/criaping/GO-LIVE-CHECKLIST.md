# CRIA PING — checklist de go-live

> Estado verificado em 2026-10-29 (Claude Code). Atualize as caixas quando cada item mudar.
> Regras: nenhuma migração, escrita no banco de produção, mudança de segredo, compra ou desativação da Deployment Protection sem autorização explícita do administrador (luisfwdp@gmail.com). Nenhuma DM real sem aprovação específica.

## 1. Concluído

- [x] `main` em `e583a6f` (PRs #17–#20), CI verde (TypeScript checks + Database checks).
- [x] Supabase `auto-insta` (ref `qgojitqdpyzprapqazvi`, sa-east-1) `ACTIVE_HEALTHY`.
- [x] Data API desligada: o PostgREST aponta para `pg_pgrst_no_exposed_schemas` e responde `503 PGRST002`.
- [x] Check de produção aprovado (run `40725152431`):
  - URLs do pooler pertencem ao projeto;
  - banco vazio, 23 migrações pendentes, histórico íntegro;
  - `db:check` aprovado nos dois poolers.
- [x] Ambiente GitHub `production-database`: revisor obrigatório, só `main`, segredos `DATABASE_URL_POOLER` e `DATABASE_URL_SESSION` e variáveis `EXPECTED_PROJECT_REF` e `SUPABASE_PUBLISHABLE_KEY`.
- [x] Vercel Production com `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`, `ALLOWED_EMAILS`, `OPERATOR_EMAILS`, `ALLOWED_EMAILS_REQUIRED=true` e `META_GRAPH_API_VERSION`.
- [x] Deployment Protection (Vercel SSO) ativa em todas as URLs `*.vercel.app`.
- [x] Auditoria do login (link mágico, allowlist, sessões em banco, redirect só para a mesma origem, URLs presas a `NEXTAUTH_URL`). Testes no PR #21.

## 2. Pendências por severidade

| Severidade | Pendência | Bloqueia | Responsável |
| --- | --- | --- | --- |
| **Bloqueio** | Migrações não aplicadas (`public` vazio) | Login | Administrador autoriza; workflow `migrate` |
| **Bloqueio** | `DATABASE_URL` ausente na Vercel | Login | Administrador |
| **Bloqueio** | `RESEND_API_KEY` (ou `EMAIL_SERVER`) e `EMAIL_FROM` ausentes | Login | Administrador |
| **Bloqueio** | O último deploy de produção é anterior às variáveis cadastradas; precisa de redeploy | Login | Administrador |
| Alta | `CRON_SECRET` ausente: os crons recebem 401 e a renovação de token nunca roda (PR #22) | Contas Instagram depois de ~60 dias | Administrador cadastra; merge do #22 |
| Alta | Webhook da Meta não passa pela proteção SSO dos domínios `*.vercel.app` | Primeiro disparo | Administrador: domínio próprio |
| Alta | Redis e worker inexistentes: webhooks não enfileiram e nada é enviado | Primeiro disparo | Administrador (custo do worker: aprovar) |
| Média | URLs de campanha aceitavam `javascript:`/`data:` (PR #22) | — | Merge do #22 |
| Média | Desconectar a conta Instagram **apaga** campanhas, logs e links (cascata); sem `instagramAccountId`, desconecta todas as contas do workspace | Uso seguro | Decisão de produto; Claude + Codex |
| Média | Sem limite de requisições HTTP em `/r/*`, `/api/webhook` e no envio de link mágico | Abuso | Backlog |
| Média | `POST /api/instagram/conversations` (inbox) não checa papel: MEMBER envia DM pela marca | Multiusuário | Backlog (antes de convidar membros) |
| Baixa | Página Diagnóstico trava sem `REDIS_URL` (tenta falar com o worker) | — | Não abrir antes do Redis |
| Baixa | JSON malformado em `/api/automations` e `?page=abc` em `/api/logs` respondem 500 | — | Backlog |
| Baixa | `/api/health` (público) devolve a mensagem de erro bruta do banco/Redis | — | Backlog |
| Baixa | DM acima de 640 caracteres é cortada nos templates com botão | — | Backlog (validação no formulário) |
| Baixa | Relatório público de campanha ligado por padrão (`reportShareEnabled=true`) | — | Decisão de produto |
| Baixa | Sem botão "Sair" na interface; `/api/auth/signout` funciona | — | Codex |

## 3. Variáveis necessárias

**Vercel → Production** (segredos marcados como Sensitive; valores nunca no chat ou no repositório):

| Variável | Estado | Para quê |
| --- | --- | --- |
| `DATABASE_URL` | **falta** | Transaction pooler (6543), o mesmo valor do segredo `DATABASE_URL_POOLER` |
| `NEXTAUTH_URL` | ok | URL pública; muda junto com o domínio próprio |
| `NEXTAUTH_SECRET` | ok | Sessões e state do OAuth |
| `ENCRYPTION_KEY` | ok | Cifra tokens do Instagram; **nunca trocar depois de conectar contas** |
| `RESEND_API_KEY` | **falta** | Envio do link mágico |
| `EMAIL_FROM` | **falta** | `CRIA PING <login@mail.seu-dominio>` |
| `ALLOWED_EMAILS`, `OPERATOR_EMAILS` | ok | `luisfwdp@gmail.com` |
| `ALLOWED_EMAILS_REQUIRED` | ok (`true`) | Lista vazia = ninguém entra |
| `CRON_SECRET` | **falta** | Crons (`openssl rand -hex 32`) |
| `REDIS_URL` | falta (disparo) | `rediss://…`, política `noeviction` |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN` | falta (disparo) | App Meta |
| `META_GRAPH_API_VERSION` | ok (`v25.0`) | — |

**Worker (Fly, quando aprovado):** `DATABASE_URL` (session pooler 5432), `REDIS_URL`, `ENCRYPTION_KEY` (igual à da Vercel), `NEXTAUTH_URL`, `META_GRAPH_API_VERSION`.

## 4. Procedimentos seguros

### 4.1 Resend (primeiro login)
Não há integração com o Resend nesta sessão, então a conta e a chave são criadas pelo administrador:
1. resend.com → entrar ou criar conta com `luisfwdp@gmail.com`. O plano Free basta.
2. **Teste sem domínio:** `EMAIL_FROM=CRIA PING <onboarding@resend.dev>`. O Resend só entrega desse remetente para o e-mail **dono da conta Resend**. Como o único e-mail permitido (`luisfwdp@gmail.com`) é o mesmo, isso basta para o primeiro login.
3. **Definitivo:** **Domains → Add Domain** (subdomínio, ex.: `mail.seu-dominio`), criar no DNS os registros MX/SPF e DKIM mostrados mais um DMARC (`v=DMARC1; p=none;`), e depois **Verify**. `EMAIL_FROM=CRIA PING <login@mail.seu-dominio>`.
4. **API Keys → Create** com *Sending access* (restrita ao domínio, quando houver), colada direto na Vercel como `RESEND_API_KEY` (Sensitive).

### 4.2 Primeira migração (só com autorização explícita)
1. Autorização escrita do administrador no chat. A aprovação de um `check` não vale.
2. **Actions → Production database → Run workflow**: `main`, `action: migrate`, `first_deploy: true`.
3. **Aprovação 1, Preflight (leitura):** projeto, Data API, banco vazio, histórico, pooler.
4. **Aprovação 2, Migrate (escrita), em ordem, parando no primeiro erro:**
   1. repete o preflight;
   2. revoga os privilégios de `anon`/`authenticated`/`service_role` (inclusive os padrões e o EXECUTE global para PUBLIC);
   3. `prisma migrate deploy`;
   4. revoga de novo;
   5. `migrate status`;
   6. `migrate diff --exit-code`;
   7. `db-guard verify`.
5. **Se der erro:** não repetir, não usar `migrate reset`, `db push` nem `--accept-data-loss`. O Claude lê `_prisma_migrations` (só leitura) e propõe a correção.

As 23 migrações foram auditadas: nenhuma cria função, trigger, extensão, `GRANT` ou `REVOKE`. Os `DROP` e o `UPDATE` só atingem objetos criados pela própria sequência, num banco vazio.

### 4.3 Depois da migração
- **Claude (só leitura):** 18 tabelas mais `_prisma_migrations` com 23 linhas; nenhum privilégio de API; Data API desligada; painel de segurança sem alertas.
- **Administrador:**
  1. cadastra `DATABASE_URL`, `RESEND_API_KEY`, `EMAIL_FROM` e `CRON_SECRET`;
  2. em **Deployments → ⋯ → Redeploy** do último deploy de produção;
  3. faz login em `NEXTAUTH_URL/login`.
- **Validação do login:**
  - o link chega (Resend → Emails: *Delivered*) e abre o painel;
  - `User`, `Session` e `Workspace` têm 1 linha;
  - um e-mail fora da lista recebe *AccessDenied* e nenhum envio;
  - o dashboard abre vazio, sem erro;
  - `/api/auth/signout` encerra a sessão;
  - **não** abrir Diagnóstico, **não** conectar Instagram.

## 5. Critérios de entrada no beta

1. Login funcionando, com teste de e-mail permitido e bloqueado.
2. PR #22 mesclado e `CRON_SECRET` configurada; cron de renovação respondendo 200 no log da Vercel.
3. Domínio próprio com `NEXTAUTH_URL`, redirect OAuth e webhook apontando para ele; proteção SSO mantida nos domínios `*.vercel.app`.
4. Redis com `noeviction` e worker no Fly com `/api/health` mostrando `worker.healthy: true` (custo aprovado).
5. App Meta com a conta de teste como testadora; `webhookSubscribed=true` depois da conexão.
6. Uma campanha de teste aprovada pelo administrador, com DMs disparadas a partir de uma segunda conta e registros em `WebhookEvent`, `DmLog` (SENT) e nenhum `OperationalEvent` de erro.
7. Decisão sobre a exclusão em cascata ao desconectar a conta.
8. Páginas de privacidade, termos e exclusão de dados revisadas juridicamente (exigência da Meta para publicar o app).

## 6. Plano de recuperação

- **Deploy web:** Vercel → Deployments → *Instant Rollback* para o deploy anterior.
- **Banco (plano Free, sem backup acessível nem PITR):**
  - *antes de dados reais:* reverter = apagar os objetos criados em `public`, com autorização;
  - *depois:* dump lógico antes de cada migração (`supabase db dump --db-url "$DATABASE_URL_SESSION" -f backup.sql` e `--data-only`), guardado fora do repositório;
  - backups diários exigem o plano Pro.
- **Pausa do projeto:** o Supabase Free pausa projetos sem uso. Reativar em **Restore project**; o banco é preservado.
- **Emergência de envio:** desativar as campanhas no painel ou parar o worker (`fly scale count 0`); os webhooks continuam registrados em `WebhookEvent`.
- **Vazamento de segredo:** trocar na origem (Supabase/Resend/Meta), atualizar Vercel, GitHub e Fly, e fazer redeploy. `ENCRYPTION_KEY` não pode ser trocada sem reconectar as contas Instagram.
