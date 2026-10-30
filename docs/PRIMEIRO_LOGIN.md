# CRIA PING — primeiro login, migrações e infraestrutura de automação

> Roteiro operacional do MVP. Estado verificado em 2026-10-22:
> - Supabase `auto-insta` (ref `qgojitqdpyzprapqazvi`, sa-east-1): `public` vazio, nenhuma migração aplicada, advisor de segurança sem alertas.
> - Data API: estava ligada em 22/10. Em 28/10, depois da restauração do projeto, está **desligada**: os logs do PostgREST mostram `db-schemas=pg_pgrst_no_exposed_schemas`, e a sondagem REST devolve `503 PGRST002` a qualquer tabela. Os privilégios padrão do schema `public` continuam dando `ALL` a `anon` e `authenticated`; a migração os revoga.
> - Vercel `auto-insta`: só `NEXTAUTH_URL`, `ALLOWED_EMAILS_REQUIRED=true` e `META_GRAPH_API_VERSION`. O login fica fechado até `ALLOWED_EMAILS` existir.
> - Vercel Deployment Protection: Standard (`all_except_custom_domains`). Toda URL `*.vercel.app` pede login da Vercel antes do app.
>
> Regras: nenhuma senha no chat, em commits ou em logs. Nenhuma migração sem autorização explícita. Nenhuma DM real sem aprovação específica.

## Etapa 1 — Primeiro login

### 1.1 Fechar a Data API (antes de qualquer migração)

O CRIA PING usa só a conexão Postgres; a Data API não é usada.

1. Supabase → projeto **auto-insta** → **Project Settings → Data API** (em painéis mais novos: **Integrations → Data API → Settings**) → desligar **Enable Data API** → Save.
2. Avisar o Claude. Ele repete a sondagem: a resposta `PGRST205` precisa deixar de aparecer.
3. Na migração (Etapa 2), o workflow também revoga os privilégios de `anon`/`authenticated` no schema `public`. É uma segunda camada caso a Data API seja religada por engano.

### 1.2 Senha do banco e URLs do pooler

1. **Project Settings → Database → Reset database password**. Gere a senha no próprio painel e guarde no seu gerenciador de senhas.
2. Botão **Connect** (topo do projeto) → **Connection string** → copiar:
   - **Transaction pooler** (porta **6543**): vai para a Vercel (`DATABASE_URL`) e para o segredo `DATABASE_URL_POOLER`.
   - **Session pooler** (porta **5432**): vai para o worker no Fly e para o segredo `DATABASE_URL_SESSION`.
   - O usuário das duas deve ser `postgres.qgojitqdpyzprapqazvi`. Se aparecer outro ref, você está no projeto errado (o `onde-tem-pagode` é `pixioansxkrlkmuleeip`).

### 1.3 Ambiente protegido `production-database` no GitHub

O workflow **Production database** (`.github/workflows/production-database.yml`) só lê as URLs do banco desse ambiente. O job `guard` recusa rodar se a proteção abaixo não estiver ativa.

1. GitHub → repositório → **Settings → Environments → New environment** → nome `production-database`.
2. **Required reviewers**: adicione você. Deixe **Prevent self-review** desmarcado, senão você não consegue aprovar a própria execução.
3. **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag rule** → `main` (só ela).
4. **Environment secrets → Add environment secret**:
   - `DATABASE_URL_POOLER`: Transaction pooler, porta 6543;
   - `DATABASE_URL_SESSION`: Session pooler, porta 5432.
5. **Environment variables → Add environment variable**. Nenhum dos dois é segredo:
   - `EXPECTED_PROJECT_REF` = `qgojitqdpyzprapqazvi`;
   - `SUPABASE_PUBLISHABLE_KEY` = a chave *publishable* em **Project Settings → API Keys**. É pública; serve só para sondar a Data API.

### 1.3.1 Validar o pooler (somente leitura)

Depois do merge do PR #16: **Actions → Production database → Run workflow** → branch `main`, `action: check`, `first_deploy: true` → aprovar quando o GitHub pedir.

Resultado esperado em **Preflight (read-only)**:
```
ok   session-pooler belongs to project qgojitqdpyzprapqazvi
ok   transaction-pooler belongs to project qgojitqdpyzprapqazvi
ok   Data API disabled (HTTP …)
ok   connected over session pooler (read-only session)
ok   database state (empty, 0 relations in public)
ok   migration history consistent (23 local, 23 pending)
ok   no privileges for anon/authenticated in public
All checks passed.
```
e, no passo *Pooler compatibility*, `All checks passed.` do `db:check`.

Qualquer `FAIL` encerra a execução com erro. Os casos que separam "pendente" de "falha real":

| Situação | Resultado |
| --- | --- |
| Migrações ainda não aplicadas | `ok` (contadas como pendentes) |
| URL de outro projeto, porta errada, host direto | `FAIL` antes de conectar |
| Senha errada, rede, pooler fora | `FAIL unexpected error` (texto sem a URL) |
| Data API respondendo, ou resposta não reconhecida | `FAIL` |
| `503 PGRST002` em 3 sondagens seguidas (10 s) | `ok`: é o que a Data API desligada devolve. Uma queda do banco ainda falha no passo seguinte, que conecta ao Postgres |
| `public` com tabelas sem `_prisma_migrations` | `FAIL` (banco errado?) |
| `public` não vazio com `first_deploy: true` | `FAIL` |
| Migração que falhou pela metade, que só existe no banco, ou alterada depois de aplicada | `FAIL` |
| Privilégios de `anon`/`authenticated` | aviso no `check`; `FAIL` no `verify` |

Alternativa local, sem GitHub: `DATABASE_URL='<transaction pooler>' npm run db:check` no seu terminal.

### 1.4 Variáveis do Auth.js

O login usa só estas variáveis (todas em **Production**, nenhuma em Preview):

| Variável | Estado | Como gerar / onde obter |
| --- | --- | --- |
| `DATABASE_URL` | falta | Transaction pooler (6543) |
| `NEXTAUTH_URL` | ok | `https://auto-insta-luisfwdp-2259s-projects.vercel.app`. Muda junto com o domínio próprio |
| `NEXTAUTH_SECRET` | falta | No seu terminal: `openssl rand -base64 32` |
| `RESEND_API_KEY` | falta | 1.5 |
| `EMAIL_FROM` | falta | `CRIA PING <login@seu-dominio>` |
| `ALLOWED_EMAILS` | falta | 1.6 |
| `ALLOWED_EMAILS_REQUIRED` | ok (`true`) | — |
| `OPERATOR_EMAILS` | falta | 1.6 |
| `ENCRYPTION_KEY` | falta | `openssl rand -hex 32`. Não é usada no login, mas é exigida para conectar o Instagram. **Nunca troque depois de conectar contas**: os tokens salvos ficam ilegíveis. O mesmo valor vai para o worker |

Onde cadastrar: Vercel → projeto **auto-insta** → **Settings → Environment Variables** → *Add New* → Environment: **Production** → marcar **Sensitive** nas secretas → Save.

O Redis abre a conexão só quando é usado, então `REDIS_URL` não bloqueia o login.

### 1.5 E-mail com Resend

1. resend.com → **Domains → Add Domain** → use um subdomínio de envio do seu domínio (ex.: `mail.seu-dominio`) e a região mais próxima (São Paulo, se houver).
2. No DNS do domínio, crie exatamente os registros que o Resend mostrar: MX e TXT (SPF) do subdomínio e o TXT do DKIM (`resend._domainkey…`). Recomendado: `_dmarc.seu-dominio` TXT `v=DMARC1; p=none;`.
3. **Verify DNS Records** até o domínio aparecer como **Verified**. Pode levar de minutos a horas.
4. **API Keys → Create API Key** → *Sending access* → *Domain*: só esse domínio → copie direto para a Vercel como `RESEND_API_KEY` (Sensitive). Não cole no chat.
5. `EMAIL_FROM` = `CRIA PING <login@mail.seu-dominio>`. O endereço precisa ser do domínio verificado.

Atalho só para o seu primeiro teste: sem domínio, o Resend aceita `EMAIL_FROM=CRIA PING <onboarding@resend.dev>`, mas entrega apenas para o e-mail dono da conta Resend.

### 1.6 Quem entra

- `ALLOWED_EMAILS` = o seu e-mail (vários: separados por vírgula). Com `ALLOWED_EMAILS_REQUIRED=true` já definido, lista vazia = ninguém entra.
- `OPERATOR_EMAILS` = o seu e-mail. Só ele vê o diagnóstico da instância inteira.

### 1.7 Deploy e testes de login

Só depois das migrações (Etapa 2):

1. Vercel → **Deployments** → último deploy de produção → **⋯ → Redeploy**. Variáveis só valem em deploy novo.
2. Abra `https://auto-insta-luisfwdp-2259s-projects.vercel.app/login`. Primeiro aparece o login da Vercel (Deployment Protection), e você passa como dono. Depois vem o login do CRIA PING.
3. **E-mail permitido**: digite o seu e-mail → tela "verifique seu e-mail" → em Resend → **Emails** aparece *Delivered* → clique no link → painel do CRIA PING com o seu workspace.
4. **E-mail bloqueado**: saia, use um e-mail fora de `ALLOWED_EMAILS` → o Auth.js mostra erro de acesso negado (`AccessDenied`) e **nenhum** e-mail novo aparece no Resend. O callback `signIn` recusa antes de enviar o link.
5. O Claude confere, só com leituras: 1 linha em `User`, `Session` e `Workspace`, nenhuma para o e-mail bloqueado.

## Etapa 2 — Migrações (só com sua autorização)

**Antes** (tudo verificado pelo job *Preflight*, somente leitura):
- project ref `qgojitqdpyzprapqazvi` nas duas URLs (o pooler roteia pelo usuário `postgres.<ref>`);
- Data API desligada (sondagem REST; resposta não reconhecida conta como ligada);
- `public` vazio (`first_deploy: true`) e histórico de migrações íntegro;
- pooler compatível (`db:check`).

**Execução**: **Actions → Production database → Run workflow** → `main`, `action: migrate`, `first_deploy: true`. São **duas aprovações**: uma para o *Preflight* (leitura) e outra para o *Migrate* (escrita). O job *Migrate*, na ordem, para no primeiro erro:

1. repete o preflight (o banco pode ter mudado enquanto esperava aprovação);
2. `db-guard harden`: revoga privilégios padrão de `anon`, `authenticated` e `service_role` **antes**, para que as tabelas já nasçam sem acesso pela API;
3. `prisma migrate deploy` pelo session pooler;
4. `db-guard harden` de novo, cobrindo tabelas, sequences e funções já existentes;
5. `prisma migrate status` (precisa sair 0);
6. `prisma migrate diff --exit-code` contra `prisma/schema.prisma`;
7. `db-guard verify`: todas as 23 migrações aplicadas, histórico íntegro, nenhum privilégio de `anon`/`authenticated` em tabelas, sequences, funções e privilégios padrão, e Data API desligada.

O SQL do passo 2 e 4 está em `scripts/sql/supabase-revoke-api-roles.sql`: idempotente, transacional, e recusa rodar se os papéis do Supabase não existirem.

Não há `|| true` nem `continue-on-error` em nenhum passo. Uma execução só termina verde se todas as verificações passarem.

**Critérios de parada**: qualquer `FAIL` do preflight. Se `migrate deploy` falhar no meio:
- não repita a execução;
- não use `migrate reset`, `db push` nem `--accept-data-loss`;
- o Claude lê `_prisma_migrations` (somente leitura) e propõe a correção (`prisma migrate resolve` ou SQL de reversão) para sua aprovação.

**Backup e recuperação no plano Free do Supabase**:
- o Free **não** oferece backups diários acessíveis nem PITR. Backups diários são do Pro em diante (7 dias), e PITR é um add-on pago;
- na primeira migração o banco está vazio, então o ponto de recuperação é o próprio estado vazio. Reverter = apagar os objetos criados no schema `public`, com sua aprovação;
- quando houver dados reais, faça um dump lógico antes de cada migração, no seu computador: `supabase db dump --db-url "$DATABASE_URL_SESSION" -f backup.sql` (e `--data-only` para os dados), e guarde fora do repositório;
- alternativa paga: Pro, com backups diários.

**Riscos residuais conhecidos**:
- **Workflow de outra branch**: o `workflow_dispatch` usa o arquivo da branch escolhida, então uma branch alterada poderia remover o `guard`. O que protege de verdade é o ambiente: os segredos só são liberados para `main`, e só depois da sua aprovação.
- **Leitura da proteção**: o `guard` lê a proteção do ambiente pela API do GitHub. Se a API negar a leitura, a execução falha (fail-closed).

## Etapa 3 — Infraestrutura de automação (depois do login; não configurar ainda)

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
