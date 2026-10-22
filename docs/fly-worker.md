# Worker na Fly.io

O worker (`npm run worker`) roda como uma *Machine* permanente na Fly.io, na região `gru`
(São Paulo, perto do Supabase `sa-east-1`). O painel continua na Vercel. Arquivos:

- `fly.toml`: app `auto-insta-worker`, sem serviços públicos, reinício `always`, 1 VM
  `shared-cpu-1x` com 512 MB.
- `Dockerfile.worker`: imagem só do worker (sem `next build`, nenhum segredo no build).

> **Custo:** a Fly.io exige cartão e cobra por uso. Uma VM `shared-cpu-1x` de 512 MB ligada o
> mês inteiro custa poucos dólares por mês (confira a calculadora da Fly antes). **Não criar o
> app nem fazer deploy sem aprovação de custo do responsável.**

## 1. Criar o app (uma vez)

```bash
fly auth login
fly apps create auto-insta-worker          # nome igual ao do fly.toml
```

Não use `fly launch`: ele reescreve o `fly.toml`.

## 2. Segredos

Mesmos valores do ambiente **Production** da Vercel para os quatro primeiros. Defina tudo de
uma vez, para gerar um único deploy:

```bash
fly secrets set --stage \
  DATABASE_URL='postgresql://...' \
  REDIS_URL='rediss://...' \
  ENCRYPTION_KEY='<igual à Vercel Production>' \
  NEXTAUTH_URL='https://<domínio de produção>' \
  META_GRAPH_API_VERSION='v25.0'
```

`--stage` só grava; o próximo `fly deploy` aplica. Os valores nunca aparecem no `fly.toml`, no
repositório ou no chat.

**`DATABASE_URL` com Supabase:**

- A conexão direta (`db.<ref>.supabase.co:5432`) só tem IPv6 no plano gratuito. A Fly tem IPv6,
  mas prefira o **pooler em modo sessão** (porta 5432, usuário `postgres.<ref>`; copie a URL
  exata em Supabase → *Connect* → *Session pooler*), que funciona em IPv4 e IPv6 e serve
  conexões longas como as do worker.
- Termine a URL com `?sslmode=require`.
- `DB_POOL_MAX` (padrão 3) define as conexões do worker. Some com as da Vercel e fique abaixo
  do limite do pooler do plano.

**`REDIS_URL`:** `rediss://` (TLS), com senha e política `noeviction` no provedor.

## 3. Deploy

```bash
fly deploy                    # constrói Dockerfile.worker nos builders da Fly
fly status                    # 1 machine "started"
fly logs                      # deve mostrar "[DM Worker] Started"
```

Depois, `GET https://<domínio de produção>/api/health` deve mostrar `worker.healthy: true` (o
heartbeat é gravado no Redis a cada 30 s e expira em 120 s).

Garanta uma única instância no MVP: `fly scale count 1`.

## 4. Atualizar

O worker não faz deploy automático. Depois do merge de um PR que mexe em `lib/` ou `worker/`:

```bash
git checkout main && git pull
fly deploy
```

Se o PR trouxer migração, aplique-a antes, com aprovação (`docs/PRODUCAO.md`, seção 5).

## 5. Rollback

```bash
fly releases --image          # lista versões com a imagem de cada uma
fly deploy --image <imagem da versão anterior>
```

Pausa de emergência sem perder a fila: `fly scale count 0` (a fila fica no Redis); volte com
`fly scale count 1`.

## 6. Validar a imagem localmente (opcional)

```bash
docker build -f Dockerfile.worker -t auto-insta-worker .
docker run --rm --network host \
  -e DATABASE_URL=postgresql://postgres:postgres@localhost:5432/openreply \
  -e REDIS_URL=redis://localhost:6379 \
  -e ENCRYPTION_KEY=<64 hex> -e NEXTAUTH_URL=http://localhost:3000 \
  auto-insta-worker
```

Contra o `docker-compose.yml` local, com as migrações aplicadas, o log mostra
`[DM Worker] Started` e a chave `health:worker:dm` aparece no Redis.
