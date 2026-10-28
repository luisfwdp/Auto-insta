# Campanhas e wizard — PR #19

Base: `da4a2d8` (main, PRs #17 e #18 integrados). Uma única entrega: gerenciamento de campanhas e reorganização do CampaignBuilder, sem alteração de contrato/backend. A flag `newDesign` continua desligada por padrão e não foi alterada em produção. Build e runtime precisam ter o mesmo valor, conforme `docs/feature-flags.md`.

## Arquivos e escopo

- `app/(dashboard)/campaigns/page.tsx`: escolhe a nova listagem pelo contexto servidor do shell. O componente legado permanece no mesmo arquivo e com seu JSX inalterado.
- `components/criaping-campaigns.tsx`: listagem, filtros, ações confirmadas pela API, erro/vazio/loading e seletor de conta.
- `components/campaign-builder.tsx`: reaproveita estado, efeitos de leitura, importação e função de salvamento; adiciona a apresentação em três etapas apenas quando a flag está ligada.
- `components/campaign-wizard.tsx`, `campaign-validation.ts`, `campaigns.module.css`: navegação, foco, preflight compatível com os limites da API e estilos isolados. Controles do PR #17, shell/seletor do PR #18 e picker/preview existentes são reutilizados.
- Catálogos pt-BR/zh-TW e chaves-fonte em inglês: textos de interface, sem traduzir mensagens já digitadas/importadas. A interface segue a preferência de idioma existente; o fallback global do projeto não foi alterado neste PR.
- Teste unitário, scripts de revisão local e capturas abaixo. Sem dependência nova no produto.

## Conexões reais

| Operação | Contrato existente consumido |
| --- | --- |
| Contas disponíveis | `GET /api/dashboard/stats`, campo `instagramAccounts` |
| Listagem/conta | `GET /api/automations?instagramAccountId=...`, sem cache; nome/keywords/mensagem e ativo/pausado filtrados no cliente, como no legado |
| Ativar/pausar | `PATCH /api/automations?id=...`, `{isActive}`; sem atualização otimista quando a resposta falha |
| Duplicar | `POST /api/automations/duplicate?id=...`; a API faz a cópia pausada. A UI recarrega os dados, sem reconstruir a campanha no cliente |
| Excluir | `DELETE /api/automations?id=...`, após confirmação em Dialog |
| Relatório | Link para `/campaigns/[id]`, que já contém detalhes/analytics; relatório público somente se `reportShareEnabled` e `reportUrl` vierem habilitados na resposta |
| Publicações/avatar | `GET /api/instagram/posts` e `GET /api/instagram/profile`, com a conta selecionada |
| Criar/editar | `POST /api/automations` ou `PATCH /api/automations?id=...`, apenas na confirmação final, pelo handler existente do CampaignBuilder |

As métricas exibidas vêm de `analytics` da API: enviados, cliques, CTR, falhas e ignorados. Não há cálculo de crescimento, estimativas, novo status ou endpoint. Erros de HTTP ou `success:false` são apresentados como falha, sem confirmar a alteração localmente. Requisições de listagem são canceladas ao trocar conta; uma resposta antiga não substitui os dados atuais. A conta selecionada segue no link de criação e no retorno após salvar.

## Etapas e rascunho

1. Configuração: conta, nome opcional, publicação específica/qualquer publicação/próximo Reel, palavras-chave ou qualquer palavra, e gatilho de DM já suportado. Trocar a conta limpa a publicação e o preview anterior.
2. Mensagens: até dez variações de resposta pública, DM inicial e botão, DM principal, até dois links/botões, follow gate e follow-up com intervalo 0–1440 minutos.
3. Revisão: valores completos, preview de mensagens identificado como simulação e ativação explícita. Voltar não descarta campos. O preflight roda antes de avançar e novamente antes do envio à API. Erro de salvamento preserva o rascunho.

O draft novo permanece em memória React no navegador: não há auto-save, tabela, endpoint ou storage novo. Recarregar/sair descarta esse draft. A fila CSV preexistente continua no localStorage do navegador, com as mesmas chaves e confirmação individual; não representa persistência de rascunho no servidor. Nenhuma etapa anterior à confirmação chama uma API de escrita. Não existe botão ou chamada para enviar DM de teste. Ao confirmar uma campanha ativa, eventos reais futuros continuam sujeitos ao motor e às regras existentes.

A API atual de PATCH **não aceita trocar `instagramAccountId`**. Por isso, a conta fica bloqueada na edição e a interface explica esse limite. Configurações opcionais sem texto permanecem compatíveis com o backend; o resumo informa “Nenhum texto configurado”, sem inventar uma mensagem padrão. A ajuda do follow gate preserva o comportamento existente quando a verificação de follow não é possível.

## Verificação e capturas

Os scripts `prepare-campaign-review.mjs` e `verify-campaigns.mjs` criam uma fixture **temporária, local e sem rota de API própria**, usando os componentes reais. O Playwright intercepta os contratos acima com dados explicitamente de teste; a navegação pós-save também é observada em uma página de destino local interceptada. Isso valida o fluxo de UI e o payload, **não autenticação, execução de queries ou entrega real na Meta**. Não houve envio de mensagem ou gravação em banco real. As capturas contêm dados de teste identificados no shell, nunca métricas de produção.

Ferramentas externas ao app: Playwright, axe e Python/Pillow para comparação visual. Reprodução local:

```bash
npm install --prefix /tmp/criaping-browser --no-package-lock playwright @axe-core/playwright
/tmp/criaping-browser/node_modules/.bin/playwright install chromium
node scripts/prepare-campaign-review.mjs
# Iniciar next dev com valores locais de teste do CI e FEATURE_FLAGS=newDesign.
CRIAPING_BROWSER_TOOLS=/tmp/criaping-browser/node_modules node scripts/verify-campaigns.mjs on
# Reiniciar o servidor com FEATURE_FLAGS=-newDesign.
CRIAPING_BROWSER_TOOLS=/tmp/criaping-browser/node_modules node scripts/verify-campaigns.mjs off
# Parar o servidor e remover a fixture antes de build/commit:
node scripts/prepare-campaign-review.mjs cleanup
```

A fixture e as cópias temporárias da main não são versionadas nem implantadas. A comparação do legado cobre listagem e criação nas três resoluções, esconde somente o indicador de desenvolvimento do Next.js e tolera no máximo 1/255 por canal (rasterização de SVG), sem tolerância a diferenças de geometria/cores. Capturas partem do topo do scroll interno do shell; formulários longos continuam roláveis.

| Tela | Desktop 1440×1000 | Tablet 820×1180 | Mobile 390×844 |
| --- | --- | --- | --- |
| Listagem | [Desktop](campaign-screenshots/campaigns-desktop.jpg) | [Tablet](campaign-screenshots/campaigns-tablet.jpg) | [Mobile](campaign-screenshots/campaigns-mobile.jpg) |
| Configuração | [Desktop](campaign-screenshots/wizard-configuration-desktop.jpg) | [Tablet](campaign-screenshots/wizard-configuration-tablet.jpg) | [Mobile](campaign-screenshots/wizard-configuration-mobile.jpg) |
| Mensagens | [Desktop](campaign-screenshots/wizard-messages-desktop.jpg) | [Tablet](campaign-screenshots/wizard-messages-tablet.jpg) | [Mobile](campaign-screenshots/wizard-messages-mobile.jpg) |
| Revisão | [Desktop](campaign-screenshots/wizard-review-desktop.jpg) | [Tablet](campaign-screenshots/wizard-review-tablet.jpg) | [Mobile](campaign-screenshots/wizard-review-mobile.jpg) |
| Legado: listagem | [Desktop](campaign-screenshots/legacy-list-desktop.jpg) | [Tablet](campaign-screenshots/legacy-list-tablet.jpg) | [Mobile](campaign-screenshots/legacy-list-mobile.jpg) |
| Legado: criação | [Desktop](campaign-screenshots/legacy-new-desktop.jpg) | [Tablet](campaign-screenshots/legacy-new-tablet.jpg) | [Mobile](campaign-screenshots/legacy-new-mobile.jpg) |

Também há capturas desktop de erro e vazio. JSONs `checks-on/off.json` registram as execuções. A cobertura de navegador inclui recusa de mutação, duplicação/exclusão, busca/filtro/conta, conta imutável na edição, validação antes de avançar, navegação por Enter, ativação por Space, foco na nova etapa, Escape no diálogo, preservação de campos ao voltar e após erro, zero escritas antes da confirmação e payload real com os recursos opcionais. O axe verifica a área de conteúdo das novas telas nos estados exercitados; não equivale a auditoria completa do aplicativo ou com leitor de tela.

## Riscos e próximo PR

- A infraestrutura e uma conta real ainda precisam de um smoke test autenticado para comprovar criação/consulta/ativação e entrega em um comentário real. A validação local não alega isso.
- Permissões continuam sendo decididas pela API. Um usuário sem permissão pode ver ações, mas recebe recusa do servidor, sem confirmação falsa na UI.
- Importação e páginas de detalhes/relatórios continuam com sua apresentação existente; o novo wizard mantém o contrato. Campos de negócio que não faziam parte do builder não foram criados.
- O draft em memória é perdido ao sair/recarregar, conforme o escopo. Não há recuperação automática de rascunho novo.

Próximo PR recomendado, **após concluir/revisar este**: adaptar detalhes e relatórios de campanha ao design CRIA PING, preservando compartilhamento e analytics reais. Antes de abrir produção, executar o roteiro autenticado com a infraestrutura pronta. Revisão obrigatória de Claude Code conforme AGENTS.md; merge humano.

A topbar das capturas pertence à rota técnica da fixture; na rota operacional, o título contextual vem de `/campaigns` pelo shell existente. Os dados de exemplo aparecem somente nos scripts/capturas de teste, nunca como fallback operacional.

## Resultado dos checks locais

| Check | Resultado |
| --- | --- |
| Typecheck / ESLint | Passaram |
| Testes, flag ligada | 395 passaram, 40 ignorados por condições preexistentes |
| Testes, flag desligada | 395 passaram, 40 ignorados por condições preexistentes |
| Builds on/off | Ambos passaram, sem fixture; nenhuma rota de revisão temporária no manifesto final |
| Navegador on | Passou em desktop/tablet/mobile; ações, payload, teclado, etapas e axe no conteúdo exercitado |
| Navegador off | Comparação de listagem e criação com a main passou nas três resoluções, tolerância 1/255 por canal |
| Banco/Meta reais | Não executados localmente; precisam de infraestrutura pronta e sessão autenticada |
