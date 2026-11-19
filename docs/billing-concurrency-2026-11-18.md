# Concorrência da quota comercial — 18/11/2026

## Evidência e limites

O run do PR #107 `44370631481`, tentativa 1, admitiu 66 operações quando o teste esperava 100; a repetição passou sem alteração. A asserção de contagem era executada antes da classificação das rejeições. Portanto os logs daquele run não comprovam o código de erro, nem permitem afirmar a causa histórica exata.

Em PostgreSQL 18 descartável local, o teste original passou. Uma reprodução controlada manteve as 120 chamadas e o código de produção, restringiu somente o pool da fixture a uma conexão e adicionou atraso de 17 ms a cada INSERT da reserva, dentro do schema descartável. Resultado com aquisição padrão: 92 admissões e 28 rejeições P2028 em aproximadamente 2 segundos. Com a mesma contenção e maxWait de 10 segundos na fixture: 100 admissões e 20 rejeições COMMERCIAL_QUOTA_EXCEEDED, em aproximadamente 2,4 segundos. A mudança foi restaurada entre experimentos. Não houve envio Meta ou cobrança Asaas.

Isso comprova que a fixture pode falhar por aquisição de transação, independentemente da correção da quota. É compatível com a intermitência observada, mas não identifica retroativamente os erros omitidos pela CI.

## Mudança proposta

- Manter dez conexões, 120 tentativas simultâneas, 100 admissões, 20 rejeições HTTP 402, um bucket e exatamente 100 reservas.
- Dar somente ao PrismaClient da fixture uma espera máxima explícita de aquisição de 10 segundos; o prazo de execução da transação permanece inalterado. Limitar o teste de pico a 15 segundos.
- Incluir contagens e códigos das rejeições na primeira asserção, sem mensagens de erro, payloads, tokens ou identificadores de cliente.
- Não mudar cliente Prisma de produção, limites comerciais, retries, schema, cobranças ou dispatch.

## Validação

Node 24, dependências do lockfile e PostgreSQL 18 local descartável: 50 testes da suíte comercial; composição completa com 1.945 testes em 120 arquivos, sem skips; typecheck, lint e build aprovados.

Se a CI voltar a falhar, usar os códigos agora presentes na primeira asserção. P2028 exige distinguir aquisição e execução antes de alterar timeouts de produção. Esta mudança não demonstra entrega de DM, pagamento real nem funcionamento comercial sob qualquer carga.

Rollback: reverter este PR, que só modifica testes e este registro. Nenhuma migração ou configuração de produção depende dele.
