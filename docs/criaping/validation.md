# PR A — revisão e validação

## Escopo

Tokens isolados, fontes e SVGs; página técnica `/design-system` em pt-BR, com `noindex`, visível só sob `FEATURE_FLAGS=newDesign`. Nenhuma métrica simulada ou chamada de API nessa página. Ela não é a nova landing page.

- Flag ligada: disponibiliza tokens e fontes; a página de inspeção aplica a identidade.
- Flag ausente ou `FEATURE_FLAGS=-newDesign`: layout atual preservado e inspeção retorna 404.
- Flags são avaliadas pelo servidor; páginas estáticas refletem o valor no build. Alterar a variável exige novo build/deploy. Para rollback, remover `newDesign` e reconstruir. Não basta mudar a variável em um processo com artefatos estáticos antigos.
- Tokens legados permanecem intactos; branding nas telas operacionais e públicas entra nos PRs C–E.

## Reprodução

Node 24, `npm ci`, `npm run db:generate`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Usar as variáveis de teste do job de build em `.github/workflows/ci.yml`; não é preciso acessar um banco de produção.

Buildar e iniciar uma vez para cada configuração de `FEATURE_FLAGS` (`newDesign` e `-newDesign`). As capturas abaixo foram feitas sobre builds de produção locais, não mocks do dashboard.

Ferramentas opcionais de revisão fora do package.json/lockfile do app:

```bash
npm install --prefix /tmp/criaping-browser --no-package-lock playwright @axe-core/playwright
/tmp/criaping-browser/node_modules/.bin/playwright install chromium
CRIAPING_BROWSER_TOOLS=/tmp/criaping-browser/node_modules node scripts/verify-criaping.mjs on
# Após rebuild/restart com FEATURE_FLAGS=-newDesign:
CRIAPING_BROWSER_TOOLS=/tmp/criaping-browser/node_modules node scripts/verify-criaping.mjs off
```

`CRIAPING_REVIEW_URL` permite escolher outra URL local. Nenhum formulário de login é enviado pelo script. As dependências de navegador não entram no bundle do produto.

## Evidências

| Verificação | Resultado |
| --- | --- |
| Typecheck e lint | Passaram |
| Suíte com flag ligada | 359 passaram, 35 ignorados pela suíte |
| Suíte com flag desligada | 359 passaram, 35 ignorados pela suíte |
| Builds on/off | Ambos passaram; cliente Prisma gerado apenas para compilar, sem alteração de schema |
| Contraste | Testes dos pares de texto sobre fundo/superfície/hover >= 4,5:1; borda de controle/foco >= 3:1; ação preta sobre neon >= 4,5:1 |
| Desktop 1440×1000 e mobile 390×844 | Inspeção sem overflow; axe WCAG 2 A/AA e 2.1 AA sem violações detectadas |
| Teclado | Tab alcança skip link, Enter navega aos fundamentos; foco visível |
| Movimento reduzido | Duração do token passa a zero |
| Flag desligada | Inspeção 404, tokens ausentes, sem downloads WOFF2 no login |
| Preservação do login | PNGs on/off idênticos por SHA-256 em desktop e mobile |
| Limites | Não substitui teste assistivo manual nem avaliação de todas as telas do MVP; testes de banco ignorados não foram executados sem banco descartável |

Arquivos JSON em `screenshots/verification-*.json` registram o resultado dos checks no navegador. Screenshots versionados:

| Estado | Desktop | Mobile |
| --- | --- | --- |
| Tokens ligados | [Desktop](screenshots/tokens-on-desktop.png) | [Mobile](screenshots/tokens-on-mobile.png) |
| Tokens desligados (404) | [Desktop](screenshots/tokens-off-desktop.png) | [Mobile](screenshots/tokens-off-mobile.png) |
| Login legado, flag ligada | [Desktop](screenshots/login-on-desktop.png) | [Mobile](screenshots/login-on-mobile.png) |
| Login legado, flag desligada | [Desktop](screenshots/login-off-desktop.png) | [Mobile](screenshots/login-off-mobile.png) |

Os checks automatizados de acessibilidade se referem apenas à página de inspeção. O login legado é capturado como evidência de preservação visual, sem alegar conformidade AA de todo o sistema atual.
