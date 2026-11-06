# Detalhes de campanha — beta

Base: main `e583a6f` (PRs #17–#20 integrados). A interface nova só monta com
`newDesign`; o corpo legado permanece intacto.

## Contrato real

- GET /api/automations: lista do workspace; a UI encontra o ID da rota.
- Exibe nome, conta, isActive, alvo, palavras, mensagens habilitadas e destinos dos links.
- Métricas: sent, clicks, ctr, failed e skipped, fornecidas pelo backend.
- Não há parâmetro de período nesse contrato; nenhum filtro de data foi inventado.
- Links são texto, para não disparar rastreamento nem abrir destinos durante a consulta.
- Edição usa /campaigns/[id]/edit. Pausa/ativação continuam na listagem existente.
- Nenhuma chamada de perfil/posts à Meta é necessária para ler essa interface.

## Correções na experiência nova

- Consulta recusada ou inválida não vira “campanha não encontrada”.
- 401 oferece retorno ao login; demais falhas permitem nova tentativa.
- Resultado vazio confirmado mostra campanha ausente.
- Consulta tem limite de 20 segundos, cancelamento e proteção contra resposta após desmontar.
- Sem confirmação otimista de pausa: detalhes são somente leitura e apontam à edição.

## Verificação

Em 2026-10-29: typecheck e ESLint passaram. Vitest on/off: 396 testes aprovados
e 40 ignorados pelas condições existentes (32 arquivos aprovados, quatro ignorados).
Sem Postgres descartável, nenhum teste de banco foi declarado aprovado.

Playwright + axe: listagem e wizard em 1440, 820 e 390 px passaram com flag ligada.
Com flag desligada, listagem e criação comparadas visualmente com origin/main passaram.
Detalhes: 12 combinações (três tamanhos × dados zerados, ausente, erro e 401),
sem overflow e sem violações axe no main. Retry e link de edição conferidos;
zero requisições de escrita. Screenshots em beta-screenshots/detail-*.jpg.

Os dados das screenshots são interceptados apenas pelo teste. Não provam integração
com banco, autenticação real ou Meta. Não houve envio de DM.

## Reproduzir detalhes

Instalar Playwright e @axe-core/playwright fora das dependências do produto.
Definir CRIAPING_BROWSER_TOOLS para o diretório node_modules dessa instalação.

1. node scripts/verify-campaign-detail.mjs prepare
2. FEATURE_FLAGS=newDesign npm run dev (porta 3000)
3. node scripts/verify-campaign-detail.mjs
4. Parar servidor; node scripts/verify-campaign-detail.mjs cleanup

Nunca publicar a fixture temporária. Limpar antes de builds e commits.
