# Programação e Speed Post

O PING CHAT publica somente pela API oficial do Instagram. O painel grava a
programação no Postgres, guarda as mídias em um bucket privado do Supabase e o
worker da Fly processa os jobs BullMQ. URLs assinadas de download são criadas
somente durante o job e não são persistidas.

## Configuração

1. Crie no mesmo projeto Supabase um bucket **privado** chamado
   `instagram-publishing` (ou defina `SUPABASE_MEDIA_BUCKET`).
2. Configure `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` na Vercel e no worker.
   A service-role key nunca pode ser exposta ao navegador ou adicionada ao Git.
3. Mantenha `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, modo de login e versão
   da Graph API iguais entre painel e worker.
4. Depois da revisão humana, aplique a migração aditiva
   `20261109130000_add_content_publishing` pelo workflow protegido de produção.

O upload usa uma URL temporária específica para um objeto. A confirmação no
servidor verifica existência, tamanho máximo e assinatura JPEG/ISO Base Media
antes de disponibilizar a mídia na biblioteca.

## Fluxo operacional

- **Programação:** cria rascunhos, agenda ou publica imediatamente imagens,
  carrosséis e Reels.
- **Speed Post:** gera até 100 Reels por lote, com horários fixos ou datas
  individuais e ordem manual, sequencial ou aleatória.
- O worker consulta `content_publishing_limit`, cria e acompanha o container e
  chama `media_publish`. Jobs têm chave determinística e o banco é a fonte de
  verdade para idempotência.
- Trial Reels enviam `trial_params`; se a conta/API não for elegível, a Meta
  rejeita a operação e o erro fica no histórico. Não existe fallback simulado.

Pausar impede novos itens do lote. Retomar recoloca falhas na programação.
Cancelar é definitivo para itens ainda não publicados. Itens já em
processamento podem terminar, porque a Meta não oferece transação distribuída
nem cancelamento de `media_publish` em andamento.

## Validação antes do deploy

Execute `npm run typecheck`, `npm run lint`, `npm test` e `npm run build`. Use um
Postgres descartável em `TEST_DATABASE_URL` para validar a migração. Em produção,
confirme o bucket privado, aplique a migração com aprovação humana, publique
Vercel e Fly, verifique `/api/health` e só então faça uma publicação real em uma
conta autorizada.
