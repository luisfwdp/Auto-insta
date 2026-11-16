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
- A varredura recupera publicações `QUEUED` sem job no Redis após cinco minutos,
  usando a mesma chave determinística. A lease de inspeção usa `updatedAt` e
  impede que réplicas recuperem a mesma linha simultaneamente. Jobs existentes
  (inclusive concluídos ou com falha) nunca são removidos nem reenviados pela
  recuperação. Como a retenção pode apagar jobs terminais, a ausência no Redis
  não basta: a recuperação aceita apenas `attempts = 0`, sem `metaContainerId`,
  `metaMediaId`, `metaStatus` ou `publishedAt`. O worker grava `PROCESSING` e
  incrementa `attempts` atomicamente antes de chamadas externas. Marcadores Meta
  também excluem itens cujo contador foi zerado ao retomar um lote. Itens com
  histórico ambíguo ficam pendentes de inspeção; não são reenviados automaticamente.
  Lotes pausados/cancelados não são recuperados.
- Falhas isoladas de inspeção, enqueue ou liberação de lease não interrompem os
  próximos itens recuperáveis nem a varredura normal de itens agendados. A
  liberação usa comparação de status e timestamp, sem sobrescrever alterações
  concorrentes. Falhas são registradas apenas no console, sem detalhes de erro,
  no máximo uma vez por minuto por processo; não geram logs no banco ou Redis.
  Se a liberação falhar, a lease pode aguardar os cinco minutos antes de nova
  inspeção. Uma indisponibilidade geral do banco ainda pode impedir a varredura.
- Antes de `media_publish`, o worker registra `PUBLISHING`. Se a resposta da
  Meta se perder após a publicação, o retry consulta o mesmo container: quando
  ele já estiver `PUBLISHED`, não publica novamente e conclui como
  `PUBLISHED_RECOVERED`. Nesse caso o ID final da mídia pode não estar disponível,
  pois a API o devolve na resposta original de `media_publish`.
- A recuperação de um container já `PUBLISHED` independe da cota disponível:
  a publicação anterior pode ter consumido o último espaço. A cota continua
  obrigatória antes de criar um container novo e antes de publicar um existente
  ainda não publicado.
- Após criar um container na Meta, uma publicação editável aceita cancelamento
  ou retentativa pelo horário, preservando conta e conteúdo. Alterar conta,
  mídia, tipo, modo do Reel ou legenda retorna `409`; crie outra publicação
  para essas mudanças. O container existente nunca é apagado para tentar de
  novo, porque um `PUBLISHING` pode já ter sido aceito pela Meta.
- Essa proteção continua após reagendar uma falha; a gravação de conteúdo
  também exige atomicamente que nenhum container tenha sido criado em paralelo.
- Retentativas apenas por horário preservam o modo do Reel (inclusive `TRIAL`);
  os defaults de criação não são aplicados a campos omitidos em um `PATCH`.
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

Rollback da correção de recuperação por cota: reverta o commit e publique a
imagem anterior aprovada do worker, após revisão humana. Não há alteração de
schema, migração ou operação de rollback sobre dados.

Implante a recuperação junto da correção que interrompe o worker quando o claim
de `PROCESSING` perde para um cancelamento. Ambas exigem revisão humana conforme
`AGENTS.md`. Rollback: reverta o commit e reimplante a imagem aprovada anterior do
worker. Não há migração ou rollback de dados.
Rollback da proteção de conteúdo de containers: reverta o commit e reimplante a
versão aprovada anterior da aplicação. Não há mudança de schema ou de dados.
