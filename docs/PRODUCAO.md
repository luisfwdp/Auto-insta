# Produção do Auto Insta — guia de operação

> Guia para colocar o MVP no ar e mantê-lo estável enquanto Claude Code e Codex continuam
> desenvolvendo. Complementa `docs/setup.md` (passo a passo da Meta, que continua valendo) e
> `docs/feature-flags.md`.
>
> Regras desta fase: **nenhuma migração em produção e nenhuma DM real sem aprovação
> específica do responsável**. Nenhuma credencial nova na Railway até o incidente de segurança
> ser resolvido.

## 1. Arquitetura

```
Instagram ──webhook──▶ Vercel (web + API, projeto auto-insta) ──▶ PostgreSQL
                                   │                                  ▲
                                   └──fila──▶ Redis ◀──── Worker permanente (fora da Vercel)
                                                              └──▶ Graph API da Meta (envio)
```

- **Web** na Vercel: painel, OAuth, webhook, crons diários (`vercel.json`).
- **Worker** (`npm run worker`): processo contínuo que envia DMs, respostas públicas, verifica o
  follow gate e roda o reconciliador. Não pode rodar na Vercel.
- Web e worker compartilham **o mesmo** `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY` e
  `NEXTAUTH_URL`.

## 2. Ambientes e isolamento

| Ambiente | Web | Banco / Redis | Webhook da Meta | Worker |
| --- | --- | --- | --- | --- |
| **Production** | domínio de produção da Vercel | banco e Redis de produção | aponta para cá | worker de produção |
| **Preview** (cada PR) | URL de preview | **banco e Redis de staging, separados** ou nenhum | nunca | nenhum (ou worker de staging) |
| Local | `localhost` + túnel | Docker local | túnel só para testes | `npm run worker` local |

- Na Vercel, cadastre as variáveis **por ambiente**: Production e Preview nunca compartilham
  `DATABASE_URL`, `REDIS_URL` ou `ENCRYPTION_KEY`. Um preview ligado ao banco de produção roda
  código não revisado sobre dados reais.
- Os crons da Vercel só rodam em Production.
- Se não houver staging, deixe o Preview sem `DATABASE_URL`: o build passa (o PR #4 tirou as
  migrações do build) e o preview serve para revisar páginas estáticas e o build.
- **Proteção da Vercel:** o projeto está com *Vercel Authentication* em todos os deploys exceto
  domínios próprios. É o certo enquanto o ambiente está incompleto. Mas o domínio de produção
  precisa ficar público para a Meta (webhook e OAuth), para os links rastreados abertos pelos
  seguidores e para as páginas de privacidade e termos. Antes de conectar a Meta, escolha:
  adicionar um domínio próprio à produção (excluído da proteção), ou mudar a proteção para
  *Standard Protection* (só previews). O painel continua fechado pelo `ALLOWED_EMAILS`.

## 3. Checklist de variáveis de produção

Valores ficam só na Vercel e no host do worker, nunca no repositório nem no chat.

| Variável | Web | Worker | Observação |
| --- | --- | --- | --- |
| `NEXTAUTH_URL` | ✓ | ✓ | URL pública de produção, sem barra final. No worker, gera os links rastreados. |
| `NEXTAUTH_SECRET` | ✓ | | `openssl rand -base64 32` |
| `CRON_SECRET` | ✓ | | protege `/api/cron/*` |
| `ENCRYPTION_KEY` | ✓ | ✓ | `openssl rand -hex 32`, **idêntica** nos dois; trocar exige reconectar contas |
| `DATABASE_URL` | ✓ | ✓ | veja seção 5 |
| `REDIS_URL` | ✓ | ✓ | `rediss://` (TLS), veja seção 6 |
| `RESEND_API_KEY`, `EMAIL_FROM` | ✓ | | domínio verificado na Resend |
| `ALLOWED_EMAILS` | ✓ | | **obrigatória no Auto Insta** (seção 4) |
| `META_GRAPH_API_VERSION`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN` | ✓ | ✓ | app Meta próprio, `docs/setup.md` passos 4 a 8 |
| `FEATURE_FLAGS` | ✓ | ✓ | **não definir em produção** no MVP |
| `DB_POOL_MAX` | opcional | opcional | conexões por processo (padrão 3); some web + worker abaixo do limite do banco |

Depois de configurar: `GET /api/health` deve responder `status: ok` com `worker.healthy: true`.

## 4. Autenticação restrita

- `ALLOWED_EMAILS` com a lista exata de quem pode entrar. Sem ela, qualquer pessoa que chegue à
  URL pública recebe um link mágico e cria um workspace próprio.
- O login é só por link mágico; proteja a caixa de e-mail dos usuários permitidos com 2FA.
- Domínio de envio verificado na Resend (SPF/DKIM); `EMAIL_FROM` nesse domínio.
- Convide colaboradores pelo painel (Configurações → membros), com o papel mínimo necessário.
  O e-mail convidado também precisa estar em `ALLOWED_EMAILS`.

## 5. PostgreSQL

Recomendado: **Neon** ou **Supabase** (Postgres gerenciado, com backup e restauração para um
ponto no tempo no plano escolhido).

- **Web (Vercel):** use a URL com *pooler* do provedor (conexões curtas de funções serverless).
- **Worker e migrações:** use a URL **direta** (sem pooler em modo transação), porque o
  `prisma migrate deploy` e conexões longas não combinam com pooler em modo transação.
- Valide em staging que o modo de pooler escolhido funciona com `@prisma/adapter-pg` antes de
  produção.
- `sslmode=require` na URL.

### Supabase (projeto `auto-insta`, `sa-east-1`, plano gratuito)

- **Desligar a Data API antes das migrações** (Project Settings → Data API). O Supabase expõe o
  schema `public` por REST com a chave `anon`, que é pública. As tabelas do Prisma ficam em
  `public` sem RLS, então e-mails, logs e tokens cifrados ficariam legíveis por qualquer um com
  a URL do projeto. O Auto Insta não usa a Data API, só a conexão Postgres. Depois das
  migrações, rode o *Security Advisor* do Supabase e confirme que não sobra alerta de tabela
  exposta. Se precisar manter a Data API, habilite RLS em todas as tabelas (sem políticas: o
  Prisma conecta como `postgres`, que ignora RLS).
- **Conexões:** a conexão direta (`db.<ref>.supabase.co`) só tem IPv6 no plano gratuito, e a
  Vercel não conecta em IPv6. Use o pooler (Supabase → *Connect*):
  - Vercel: *Transaction pooler* (porta 6543), com `DB_POOL_MAX` baixo (1 ou 2);
  - worker na Fly e migrações: *Session pooler* (porta 5432).
  Valide no primeiro deploy que o modo transação funciona com `@prisma/adapter-pg`. Se der erro
  de *prepared statement*, use o pooler de sessão também na Vercel.
- **Plano gratuito:** sem backup baixável e com pausa do projeto após um período sem atividade.
  O worker conectado mantém atividade, mas acompanhe. Antes de migrações com dados reais, faça
  `pg_dump` da URL de sessão. Subir de plano depende de aprovação de custo.

### Procedimento de migração (exige aprovação)

1. O PR com migração passa no CI "Database checks" (migrações em banco vazio + verificação de
   divergência + testes).
2. Aplicar primeiro no **staging** e testar o preview correspondente.
3. Pedir aprovação explícita do responsável para produção.
4. Backup/snapshot do banco de produção (ou anotar o horário para restauração no tempo).
5. `DATABASE_URL="<url direta de produção>" npm run db:migrate` a partir de uma máquina
   confiável. **Nunca por agente.**
6. Só então mesclar e implantar o código que depende da migração.

Migrações são aditivas e com default compatível, então o código antigo continua funcionando
depois delas; isso permite reverter o código sem reverter o banco.

## 6. Redis

Recomendado: **Redis Cloud** (o mesmo da stack de referência em `docs/stack.md`) ou outro Redis
gerenciado com protocolo TCP nativo.

- Use `rediss://` (TLS) com senha. O `ioredis` ativa TLS a partir do esquema da URL.
- Política de memória **`noeviction`**: o BullMQ não pode ter chaves da fila removidas por
  falta de memória.
- Redis que funciona só por HTTP não serve (o BullMQ precisa de comandos bloqueantes).
- Provedores cobrados por comando podem ficar caros: o BullMQ faz consultas contínuas mesmo com
  a fila vazia. Prefira plano por memória.
- Não exponha um Redis próprio na internet sem TLS e senha.

## 7. Worker permanente — onde hospedar

A Railway, sugerida no `docs/setup.md`, **não deve receber credenciais novas** enquanto o
incidente não for resolvido. Se alguma credencial já foi usada lá, considere-a exposta e gere
outra (token da Meta via reconexão, `ENCRYPTION_KEY` não, senhas de banco e Redis sim).

| Opção | Como roda | Prós | Contras |
| --- | --- | --- | --- |
| **Fly.io** (recomendada para começar) | uma *Machine* com o `Dockerfile` do repo e comando `npm run worker`, sem portas públicas | Docker pronto, reinício automático, segredos cifrados, deploy por CLI ou GitHub Actions | pago (valor baixo para 1 instância pequena; confira o preço atual) |
| **VPS** (Hetzner, DigitalOcean etc.) com Docker | `docker run --restart=always ... npm run worker` ou Docker Compose | custo previsível, controle total, mesma imagem do Fly | você cuida de atualizações do SO, firewall e acesso SSH |
| **Oracle Cloud Always Free** | VM com `pm2`, como em `docs/stack.md` | gratuito | cadastro e capacidade variáveis; manutenção manual |
| Render (Background Worker) | serviço de worker com o Dockerfile | simples | o plano gratuito não oferece worker contínuo |

Recomendação: **Fly.io** para o MVP (menos operação), mantendo a VPS como alternativa
equivalente, porque as duas usam a mesma imagem Docker.

Requisitos em qualquer opção:

- Comando de start `npm run worker`; build só com `npm ci && npm run db:generate` (ou a imagem
  do `Dockerfile`, que já inclui o worker).
- Uma única instância no MVP (o limitador por conta usa Redis, mas uma instância simplifica o
  diagnóstico).
- Nenhuma porta pública: o worker só faz conexões de saída (Postgres, Redis, Meta).
- Reinício automático em falha.
- Segredos no gerenciador do provedor, nunca em arquivo na imagem.
- Monitoramento: `/api/health` mostra o *heartbeat* do worker (gravado no Redis, expira em
  2 minutos). Um monitor externo (UptimeRobot, Better Stack ou similar) consultando
  `/api/health` avisa quando `worker.healthy` fica falso.

## 8. Primeira conta real (MVP)

Uma única conta profissional do Instagram, de propriedade do responsável, com papel de testador
no app Meta (`docs/setup.md`, passo 6), app em modo Live (passo 9) e webhooks `comments` e
`messages` assinados (passo 8). Nenhuma outra ferramenta de DM conectada à conta (veja
"Migrating from ManyChat" no setup).

### Pré-condições (sem enviar nada)

1. PRs #1–#5 mesclados; CI verde na `main`; deploy de produção verde.
2. Migrações aplicadas em produção **com aprovação** (seção 5).
3. Worker no ar; `/api/health` com `status: ok` e `worker.healthy: true`.
4. Login com e-mail permitido; e-mail fora da lista recusado.
5. Conectar a conta em Configurações; conferir em Diagnóstico que não há erro de token.
6. Botão "Test" do webhook `comments` no painel da Meta → linha nova em `WebhookEvent`.

### Roteiro de teste (cada etapa envia mensagens reais: pedir aprovação antes)

Usar uma **segunda conta** do Instagram, também do responsável, como "seguidor de teste".

| # | Funcionalidade | Configuração da campanha | Ação | Resultado esperado |
| --- | --- | --- | --- | --- |
| 1 | Comentário → DM | post de teste, palavra `TESTE` | comentar `TESTE` | DM chega; `DmLog` = `SENT` |
| 2 | Resposta pública | + resposta pública ativada | comentar `TESTE` em outro comentário | resposta visível sob o comentário |
| 3 | Botão de continuação | + DM inicial com botão | tocar o botão na DM | mensagem com o link chega |
| 4 | Follow gate | + exigir seguir; conta de teste **sem** seguir | tocar o botão | pede para seguir; não entrega o link |
| 5 | Follow gate (seguindo) | mesma campanha | seguir e tocar de novo | link entregue |
| 6 | Links rastreados | 1 ou 2 botões de link | abrir os links | redireciona; clique conta no painel |
| 7 | Deduplicação | mesma campanha | comentar `TESTE` de novo no mesmo comentário/post | nada duplicado; motivo em Registros |

Registrar o resultado de cada etapa (data, ID do comentário, status) num comentário do PR ou
issue de validação do MVP. Falha em qualquer etapa: pausar a campanha, coletar `DmLog`,
`WebhookEvent` e `OperationalEvent` do caso e abrir issue antes de seguir.

## 9. Deploy, preview e rollback

**Fluxo de mudança:** branch → PR em rascunho → CI (TypeScript + Database checks) → preview da
Vercel → revisão cruzada (Claude/Codex) e humana nas áreas críticas → merge manual → deploy
automático de produção.

**Rollback do web:** Vercel → Deployments → deploy anterior → *Instant Rollback*. É imediato e
não mexe no banco. Depois, abra um PR revertendo o commit para a `main` voltar a refletir
produção.

**Rollback do worker:** reimplantar a imagem ou o commit anterior (Fly: `fly deploy --image
<imagem anterior>` ou `fly releases` para identificar a versão; VPS: `docker run` com a tag
anterior). Mantenha as imagens identificadas pelo SHA do commit.

**Rollback de funcionalidade atrás de flag:** remover o nome de `FEATURE_FLAGS` e reimplantar.

**Banco:** migrações não são revertidas automaticamente. Como são aditivas, reverter o código
basta na maioria dos casos. Para desfazer dados, restaurar o backup ou o ponto no tempo
(seção 5), com aprovação.

**Pausa de emergência dos envios:** desativar as campanhas no painel (o worker confere
`isActive` antes de cada envio, inclusive toques em botão e follow-ups já agendados) ou parar o
worker. Webhooks continuam sendo registrados e a fila fica parada no Redis.

## 10. Monitoramento mínimo

- `/api/health` (banco, Redis, fila, worker) com monitor externo a cada 5 minutos.
- Página Diagnóstico do painel: falhas de webhook, de DM e de refresh de token.
- Logs de funções da Vercel e logs do worker no provedor.
- Revisar diariamente na primeira semana: `DmLog` com `FAILED` e eventos `ERROR`.
