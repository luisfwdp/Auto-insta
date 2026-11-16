# Atualização atômica do progresso de lotes

A atualização do progresso usa uma transação curta. Primeiro bloqueia a linha do
lote por `id` e `workspaceId` com `SELECT ... FOR UPDATE`; depois agrega, em uma
única consulta, as publicações `PUBLISHED` e `FAILED` desse mesmo workspace. Só
então grava os contadores e a conclusão. Atualizações concorrentes do lote,
inclusive pausa e cancelamento, respeitam o mesmo bloqueio de linha do Postgres.

Isso impede um refresh iniciado antes de um cancelamento de sobrescrever o
estado `CANCELLED` depois que o cancelamento foi confirmado. Também serializa os
refreshes de workers diferentes, evitando que um snapshot antigo sobrescreva
contadores mais recentes. Não há chamada externa dentro dessa transação.

Um lote cancelado permanece intacto. Um lote pausado com itens pendentes continua
`PAUSED`; se o último item que já estava em processamento terminar, o lote pode
concluir como `COMPLETED` ou `FAILED`, preservando o comportamento anterior.
O `workspaceId` vem da publicação/job já resolvido pelo worker, nunca de um novo
parâmetro público. Tanto sucesso quanto falha terminal usam esse escopo.

## Evidência e validação

O teste em PostgreSQL nativo mantém um cancelamento aberto, inicia um refresh e
aguarda o bloqueio real em `pg_stat_activity`. Depois confirma o cancelamento e
verifica o estado final. A implementação anterior falha esse teste: grava
`COMPLETED` sobre `CANCELLED`. A correção preserva o cancelamento. A suíte também
verifica conclusões concorrentes, pausa e isolamento entre dois workspaces.

Configure `TEST_DATABASE_URL` somente para um PostgreSQL descartável e execute
`npm test -- __tests__/publishing-batch-progress.db.test.ts`. Cada execução cria
um schema aleatório a partir das migrações e remove apenas esse schema ao final.
O teste de locks exige sessões PostgreSQL independentes; PGlite não substitui
essa evidência de concorrência.

## Implantação e rollback

Sem mudança de schema, migração ou dados históricos. Exige revisão específica de
Claude Code e humano conforme `AGENTS.md`, seguida de deploy autorizado do
worker. Rollback: reverta o commit e reimplante a imagem anterior aprovada. Não
execute rollback de dados ou migração em produção.
