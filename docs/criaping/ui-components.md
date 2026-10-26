# CRIA PING — PR B / F1: componentes reutilizáveis

O kit em `components/ui/` prepara a migração visual sem mudar telas operacionais ou contratos de API. Nenhuma dependência nova. Use os componentes em árvores protegidas por `newDesign`; o root disponibiliza `--cp-*` apenas com essa flag. Importe diretamente o módulo necessário.

| Módulo | Componentes / contrato |
| --- | --- |
| `primitives.tsx` | Button (`primary`, `secondary`, `danger`; loading bloqueia cliques; `type="button"` padrão), Card, Badge (tom + texto), Skeleton (label obrigatório), EmptyState (título, descrição e ação opcional) |
| `fields.tsx` | Input, Select e Textarea com label obrigatório, hint/erro ligados por IDs, props/ref nativos e IDs automáticos; Toggle nativo com `role="switch"`, checked/onChange e disabled |
| `tabs.tsx` | Tabs controladas por `value/onValueChange`; IDs estáveis, setas, Home/End, salto de tabs desabilitadas; painéis ficam montados para preservar rascunhos |
| `dialog.tsx` | Dialog controlado por open/onClose; `showModal`, fundo inerte, ciclo Tab/Shift+Tab, Escape, restauração de foco e bloqueio de scroll; título e rótulo de fechar obrigatórios |
| `toast.tsx` | Toast persistente e dispensável, região live educada; manter montado antes de alterar mensagem. Sem timeout que limite o tempo de leitura |
| `data-table.tsx` | DataTable genérica com caption, cabeçalhos de coluna/linha, keys e renderizadores de célula; loading/erro/vazio explícitos, sem linhas antigas nesses estados; região com scroll e foco no mobile |

Os componentes recebem copy traduzida de quem os consome; não têm strings de produto fixas. A galeria `/design-system/components` é uma rota técnica com noindex e gate servidor antes de ler cookies. Usa pt-BR sem preferência e aceita en/zh-TW pelo seletor existente. Os catálogos atuais têm inglês como chave-fonte, além dos JSONs pt-BR e zh-TW; todas as novas chaves foram adicionadas aos dois JSONs. O fallback global legado não mudou neste PR.

A galeria mostra estados de UI, não campanhas ou métricas inventadas. Salvar/confirmar só muda feedback local. Não há chamadas às APIs de campanhas, Instagram ou dados de tenant. A alteração de idioma usa a ação existente e preserva o rascunho de exemplo.

## Decisões de acessibilidade

Controles e select nativos, fontes de 16px nos campos, foco neon e texto preto sobre neon. `--cp-border` é decorativo; bordas de controles usam `--cp-control-border`. Erros têm texto e ligação semântica. Toast não rouba foco nem desaparece sozinho. Skeleton não precisa de animação para comunicar carregamento; o spinner respeita movimento reduzido. Tabs usam ativação automática por teclado e precisam receber um `value` de uma tab habilitada. A tabela não adiciona seleção, ordenação ou paginação que o backend não fornece. Diálogos devem ter um único modal aberto por vez e ser fechados por `onClose`, sem manipular `.close()` fora do componente.

## Retorno da revisão do PR A

- Documentado em `docs/feature-flags.md` que ativação/rollback exige valor consistente no build e runtime.
- Bindings do next/font agora geram famílias `criapingSora` e `criapingInter`, sem ocupar nomes genéricos Sora/Inter; ainda sem preload. O build confirma os nomes prefixados. Regras de fonte podem existir no CSS legado, mas não há download da fonte com a flag off.
- Fallback duplicado removido, bordas decorativas e par neon/preto documentados e títulos SVG com IDs diferentes entre variantes. Para repetir uma mesma variante inline, o consumidor ainda deve gerar IDs por instância (os assets atuais são usados como imagens).
- Teste adicional confirma opções de preload e escopo de todas as declarações de token. `LICENSE`, copyrights e licenças OFL permanecem intactos.

## Revisão e reprodução

Rodar `npm run typecheck`, `npm run lint`, `FEATURE_FLAGS=newDesign npm test` e `FEATURE_FLAGS=-newDesign npm test`. Fazer build/start com as variáveis locais de teste do job CI e a mesma flag no build e runtime, uma vez para cada estado. Não usar credenciais ou banco de produção.

As ferramentas de browser permanecem fora das dependências do produto:

```bash
npm install --prefix /tmp/criaping-browser --no-package-lock playwright @axe-core/playwright
/tmp/criaping-browser/node_modules/.bin/playwright install chromium
CRIAPING_BROWSER_TOOLS=/tmp/criaping-browser/node_modules node scripts/verify-criaping-ui.mjs on
# Rebuild/restart com FEATURE_FLAGS=-newDesign antes da próxima execução:
CRIAPING_BROWSER_TOOLS=/tmp/criaping-browser/node_modules node scripts/verify-criaping-ui.mjs off
```

`CRIAPING_REVIEW_URL` permite escolher outra URL local. O script verifica teclado, formulário, live region, preservação de rascunho ao trocar idiomas, axe na página e diálogo, gate 404 e ausência de downloads WOFF2 no login com flag off. JSONs e capturas ficam em `ui-screenshots/`; regenerar a cada mudança visual.

| Evidência | Desktop | Mobile |
| --- | --- | --- |
| Galeria ligada | [Desktop](ui-screenshots/components-on-desktop.png) | [Mobile](ui-screenshots/components-on-mobile.png) |
| Diálogo ligado | [Desktop](ui-screenshots/dialog-on-desktop.png) | [Mobile](ui-screenshots/dialog-on-mobile.png) |
| Galeria desligada (404) | [Desktop](ui-screenshots/components-off-desktop.png) | [Mobile](ui-screenshots/components-off-mobile.png) |
| Login ligado | [Desktop](ui-screenshots/login-on-desktop.png) | [Mobile](ui-screenshots/login-on-mobile.png) |
| Login desligado | [Desktop](ui-screenshots/login-off-desktop.png) | [Mobile](ui-screenshots/login-off-mobile.png) |

A validação automatizada de AA se limita à galeria e aos estados exercitados. Não substitui revisão com leitor de tela ou validação das futuras páginas consumidoras. As suítes de banco condicionais não são executadas sem banco descartável; este PR não altera queries/schema. Revisão obrigatória: Claude Code, conforme `AGENTS.md`; merge humano.

## Resultado desta revisão

Typecheck, lint e os dois builds passaram. Suíte com a flag ligada e desligada: **379 passaram, 40 ignorados por condições preexistentes** em cada execução. Os JSONs registram 200/404 esperados em desktop/mobile e nenhum erro JavaScript. O teste de teclado passou, e axe não detectou violações nas situações verificadas, incluindo diálogo aberto e os três idiomas. As capturas do login on/off são idênticas por SHA-256 nas duas resoluções, inclusive às capturas do PR A. Sem novas fontes baixadas no login com a flag off.
