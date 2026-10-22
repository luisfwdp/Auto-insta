# CRIA PING — primeiro login, migrações e infraestrutura de automação

> Roteiro operacional do MVP. Estado verificado em 2026-10-22:
> - Supabase `auto-insta` (ref `qgojitqdpyzprapqazvi`, sa-east-1): `public` vazio, nenhuma migração aplicada, advisor de segurança sem alertas.
> - **Data API ligada**: o PostgREST responde com `PGRST205`. Os privilégios padrão do schema `public` dão `ALL` a `anon` e `authenticated`, então qualquer tabela criada pelo Prisma ficaria exposta pela chave pública.
> - Vercel `auto-insta`: só `NEXTAUTH_URL`, `ALLOWED_EMAILS_REQUIRED=true` e `META_GRAPH_API_VERSION`. O login fica fechado até `ALLOWED_EMAILS` existir.
> - Vercel Deployment Protection: Standard (`all_except_custom_domains`). Toda URL `*.vercel.app` pede login da Vercel antes do app.
>
> Regras: nenhuma senha no chat, em commits ou em logs. Nenhuma migração sem autorização explícita. Nenhuma DM real sem aprovação específica.

## Etapa 1 — Primeiro login

### 1.1 Fechar a Data API (antes de qualquer migração)

O CRIA PING usa só a conexão Postgres; a Data API não é usada.

1. Supabase → projeto **auto-insta** → **Project Settings → Data API** (em painéis mais novos: **Integrations → Data API → Settings**) → desligar **Enable Data API** → Save.
2. Avisar o Claude. Ele repete a sondagem: a resposta `PGRST205` precisa deixar de aparecer.
3. Na janela das migrações (Etapa 2), o Claude também revoga os privilégios padrão de `anon`/`authenticated` no schema `public`. É uma segunda camada caso a Data API seja religada por engano.

### 1.2 Senha do banco e URLs do pooler

1. **Project Settings → Database → Reset database password**. Gere a senha no próprio painel e guarde no seu gerenciador de senhas.
2. Botão **Connect** (topo do projeto) → **Connection string** → copiar:
   - **Transaction pooler** (porta **6543**): vai para a Vercel e para o segredo `DATABASE_URL_POOLER`.
   - **Session pooler** (porta **5432**): vai para o worker no Fly e para o segredo `DATABASE_URL_SESSION`.
   - O usuário das duas deve ser `postgres.qgojitqdpyzprapqazvi`. Se aparecer outro ref, você está no projeto errado (o `onde-tem-pagode` é `pixioansxkrlkmuleeip`).

### 1.3 Validar o pooler com `npm run db:check`

Sem colar URL no chat, use o workflow manual **Production database** (`.github/workflows/production-database.yml`, deste PR):

1. GitHub → repositório → **Settings → Environments → New environment** → nome `production-database`.
2. Nesse ambiente:
   - **Required reviewers**: marque você. Toda execução espera o seu clique.
   - **Deployment branches and tags** → *Selected branches* → `main`.
   - **Environment secrets → Add secret**: `DATABASE_URL_POOLER` (6543) e `DATABASE_URL_SESSION` (5432).
3. Depois do merge deste PR: **Actions → Production database → Run workflow → action: `check`**, e aprove a execução.
4. O resultado esperado é `All checks passed.` no passo *Pooler compatibility*. O passo *Migration status before* mostra as 24 migrações pendentes; isso é normal agora.

Alternativa local, se preferir: `DATABASE_URL='<transaction pooler>' npm run db:check` no seu terminal. Tudo é somente leitura.

### 1.4 Variáveis do Auth.js

O login usa só estas variáveis (todas em **Production**, nenhuma em Preview):

| Variável | Estado | Como gerar / onde obter |
| --- | --- | --- |
| `DATABASE_URL` | falta | Transaction pooler (6543) |
| `NEXTAUTH_URL` | ok | `https://auto-insta-luisfwdp-2259s-projects.vercel.app`. Muda junto com o domínio próprio |
| `NEXTAUTH_SECRET` | falta | No seu terminal: `openssl rand -base64 32` |
| `RESEND_API_KEY` **ou** `EMAIL_SERVER` | falta | 1.5 |
| `EMAIL_FROM` | falta | `CRIA PING <login@seu-dominio>` |
| `ALLOWED_EMAILS` | falta | 1.6 |
| `ALLOWED_EMAILS_REQUIRED` | ok (`true`) | — |
| `OPERATOR_EMAILS` | falta | 1.6 |
| `ENCRYPTION_KEY` | falta | `openssl rand -hex 32`. Não é usada no login, mas é exigida para conectar o Instagram. **Nunca troque depois de conectar contas**: os tokens salvos ficam ilegíveis. O mesmo valor vai para o worker |

Onde cadastrar: Vercel → projeto **auto-insta** → **Settings → Environment Variables** → *Add New* → Environment: **Production** → marcar **Sensitive** nas secretas → Save.

O Redis abre a conexão só quando é usado, então `REDIS_URL` não bloqueia o login.

### 1.5 E-mail (Resend recomendado)

1. resend.com → **Domains → Add Domain** → use um subdomínio de envio (ex.: `mail.seu-dominio`).
2. Crie no seu DNS os registros que o Resend mostrar (SPF/MX e DKIM). Adicione um DMARC (`_dmarc`, `v=DMARC1; p=none;`). Depois clique em **Verify** até o domínio ficar *Verified*.
3. **API Keys → Create API Key** → permissão *Sending access*, restrita a esse domínio → copie direto para a Vercel como `RESEND_API_KEY`.
4. `EMAIL_FROM` = `CRIA PING <login@mail.seu-dominio>`.

Atalho só para o primeiro teste: sem domínio verificado, o Resend envia apenas de `onboarding@resend.dev` para o e-mail dono da conta Resend. Funciona para o seu primeiro login, não para convidar outras pessoas.

SMTP próprio: defina `EMAIL_SERVER=smtp://usuario:senha@host:587` (a Vercel guarda como Sensitive). Com ele, o Resend é ignorado.

### 1.6 Quem entra

- `ALLOWED_EMAILS` = o seu e-mail de login (vários separados por vírgula).
- `OPERATOR_EMAILS` = o mesmo e-mail. Dá acesso ao diagnóstico da instância inteira.

### 1.7 Deploy e validação

1. Só depois das migrações (Etapa 2): **Deployments** → último deploy de produção → **⋯ → Redeploy**. Variáveis novas só valem em deploy novo.
2. Abra `NEXTAUTH_URL/login`. Primeiro aparece a tela da Vercel (proteção Standard; você passa como dono). Depois vem o login do CRIA PING.
3. Digite o seu e-mail → tela *verify-request* → o e-mail chega (confira em Resend → **Emails**: *Delivered*) → clique no link → painel.
4. O Claude confere, só com leituras: `User`, `Session` e `Workspace` com 1 linha cada.
5. Teste negativo: um e-mail fora da lista não pode receber o link.

## Etapa 2 — Plano de migrações (aguarda sua autorização)

| Passo | O que acontece | Quem |
| --- | --- | --- |
| 1. Verificar o destino | Confirmar ref `qgojitqdpyzprapqazvi`, nome `auto-insta`, `public` vazio, sem `_prisma_migrations` (já confirmado em 2026-10-22; repetido no dia) | Claude (leitura via MCP) |
| 2. Migrations × schema | O job *Database checks* do CI aplica as 24 migrações num Postgres limpo e roda `prisma migrate diff --exit-code` (verde na `main`). Reproduzido localmente hoje | Claude |
| 3. Ponto de recuperação | O banco está vazio e o plano grátis não tem PITR. O "backup" é o estado vazio registrado no passo 1. Recuperar = remover os objetos criados pela migração, com sua autorização. Depois que houver dados reais, ativar backups (plano pago) entra na decisão de custo | Claude registra |
| 4. Endurecer privilégios | `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;` (e o mesmo para `SEQUENCES` e `FUNCTIONS`) | Claude (MCP), só com autorização |
| 5. Pré-checagem | **Actions → Production database → `check`** | Você aprova |
| 6. Aplicar | **Actions → Production database → `migrate`**: roda `prisma migrate deploy` pelo session pooler | Você aprova |
| 7. Validar | O workflow roda `prisma migrate status` + `migrate diff --exit-code`. O Claude confere 18 tabelas + `_prisma_migrations` com 24 linhas concluídas, `has_table_privilege('anon', …) = false` nas tabelas, o advisor de segurança e que a Data API continua fechada | Workflow + Claude |

**Parar imediatamente se:**
- o ref ou o nome do projeto não for o esperado, ou `public` não estiver vazio;
- a Data API ainda responder;
- `check` falhar em qualquer passo (não migrar);
- `migrate deploy` der erro. Nesse caso: não repetir, não usar `migrate reset` nem `--accept-data-loss`, e o Claude lê `_prisma_migrations` e propõe a correção;
- o advisor apontar tabela exposta.

## Etapa 3 — Infraestrutura de automação (depois do login)

### Redis compatível com BullMQ

- Redis Cloud → **New database** → plano **Essentials 30 MB (Free)** → região AWS **sa-east-1** se houver (senão us-east-1).
- **Configuration → Data eviction policy: `noeviction`**. É obrigatório para o BullMQ; com outra política, jobs podem sumir.
- **TLS**: a tabela oficial do Redis lista TLS só nos planos pagos, mas guias recentes mostram TLS no grátis. Verifique em **Security → TLS** no próprio banco. Se não houver TLS, decida entre aceitar sem TLS só para testes ou aprovar o plano pago mais barato (Essentials 250 MB, cerca de US$5/mês; confira o preço no painel).
- A URL vai como `rediss://default:<senha>@host:porta` (com TLS) ou `redis://…`, na Vercel (`REDIS_URL`) e no Fly. O `ioredis` ativa TLS sozinho com `rediss://`.
- Limites do plano grátis: 30 conexões, ~100 ops/s. Suficiente para uma conta de teste.

### Worker no Fly.io (`criaping-worker`)

- `fly.toml` usa `app = "criaping-worker"`, região `gru`, 1 VM shared-cpu-1x 512 MB, sem portas públicas, reinício `always`.
- O nome parece livre (`criaping-worker.fly.dev` não resolve), mas só `fly apps create criaping-worker` confirma.
- **Custo**: shared-cpu-1x 512 MB ≈ US$3,19/mês em iad; em gru é um pouco mais. Estimativa: US$3–5/mês. Confira em fly.io/calculator antes de criar. O Fly exige cartão.
- Segredos: `fly secrets set DATABASE_URL=… REDIS_URL=… ENCRYPTION_KEY=… META_GRAPH_API_VERSION=v25.0`, rodado por você no seu terminal (passo a passo em `docs/fly-worker.md`).
- **Heartbeat**: o worker grava `health:worker:dm` no Redis a cada 30 s (expira em 120 s). Para validar: logs `[DM Worker] Started` no `fly logs` + `/api/health` com `worker.healthy: true` (pela sessão logada, por causa da proteção da Vercel).

### Primeira conta Meta

- **Antes**: escolher o domínio de produção. O webhook da Meta não passa pela proteção da Vercel em `*.vercel.app`; um domínio próprio fica fora dela.
- Em developers.facebook.com → seu app → **Instagram → API setup with Instagram login**:
  - *OAuth redirect* = `https://<domínio>/api/instagram/callback`;
  - *Webhook callback* = `https://<domínio>/api/webhook`, com o verify token igual a `WEBHOOK_VERIFY_TOKEN`;
  - campos `comments` e `messages`.
- Vercel: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`, `CRON_SECRET`.
- Modo de desenvolvimento do app: só contas com papel no app (testers) disparam webhooks. Use a sua conta profissional de teste.
- **Nenhuma DM real** sem sua aprovação específica do roteiro de teste.

## Etapa 4 — Páginas legais: pendências (validação jurídica final é sua)

As páginas `app/privacy`, `app/terms` e `app/data-deletion` ainda são as do OpenReply (inglês, "OpenReply", data de maio de 2026). A Meta exige URL de Privacidade e de Exclusão de Dados para publicar o app.

**Privacidade (LGPD)**
- Controlador: razão social e CNPJ da Creator Lab Connect, endereço e e-mail de contato.
- Encarregado (DPO) e canal de contato (LGPD art. 41).
- Bases legais por finalidade (art. 7º).
- Dados de **não usuários**: quem comenta ou recebe DM (ID e nome do Instagram, texto do comentário). Nos cliques, só hash de IP, hash do destinatário e user agent.
- Operadores reais: Vercel, Supabase (São Paulo), Redis Cloud, Fly.io (São Paulo) e Resend (EUA). A página atual cita Railway, que não é usado.
- Transferência internacional (art. 33) para Resend e Vercel.
- Prazos de retenção concretos (logs, eventos de webhook, cliques).
- Direitos do titular (art. 18) e como exercê-los.
- Remover a menção a "billing", que não existe.

**Termos**
- Identificação do fornecedor, foro e lei brasileira.
- Uso aceitável alinhado aos Termos da Plataforma Meta.
- Limitação de responsabilidade compatível com o CDC.
- Manter a nota de que o núcleo é open source (MIT, baseado no OpenReply).

**Exclusão de dados**
- E-mail real de suporte (hoje diz só "contact support").
- Prazo de atendimento.
- O que é apagado e o que fica retido por obrigação legal.
- Opcional, depois: *Data Deletion Callback* da Meta (`signed_request`), que o código ainda não tem. A página de instruções basta para a revisão do app.

O Claude prepara o rascunho em pt-BR assim que você enviar os dados do controlador. O Codex aplica o visual.
