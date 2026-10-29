# CRIA PING — onboarding e contas do Instagram

Este incremento prepara o primeiro acesso e a gestão visual de contas usando somente contratos já existentes. `newDesign` continua `false` por padrão; com a flag desligada, `/onboarding` redireciona para `/dashboard` e a tela legada de configurações permanece ativa.

## Fontes reais

- `GET /api/instagram/accounts`: identifica se há contas conectadas e fornece nome, username e ID usados no próximo passo.
- `GET /api/dashboard/stats`: mantém na tela de configurações provider, expiração do token e estado real do webhook.
- `GET /api/workspace/members`: mantém permissões e equipe existentes.
- `POST /api/instagram/disconnect`: continua sendo a única ação de desconexão; a interface só confirma sucesso quando a API confirma.
- `getMissingInstagramOAuthEnv()`: informa no servidor se a conexão Meta pode ser iniciada, sem criar endpoint nem expor valores.

Nenhuma conta, métrica, conversão, permissão, endpoint, OAuth ou estado da Meta foi simulado no produto. Os dados artificiais existem apenas no roteiro Playwright local.

## Jornada

1. O dashboard sem conta direciona para `/onboarding`.
2. A página verifica as contas do workspace e mostra loading, carregamento prolongado, falha ou o resultado real.
3. Sem conta e com Meta configurada, a ação existente `/api/instagram/connect` fica disponível.
4. Sem a configuração Meta, a página explica a indisponibilidade e oferece configurações ou retorno ao dashboard.
5. Com contas, cada ação “Criar campanha” inclui `instagramAccountId` e abre o wizard existente com a conta escolhida.
6. Configurações apresenta nome, username, provider, expiração disponível e webhook; desconexão recusada não produz confirmação falsa.

401, 403, 400/409/422, 502/503/504 e demais falhas são classificados somente a partir do status HTTP recebido. Eles correspondem, respectivamente, a sessão expirada, permissão insuficiente, operação recusada, indisponibilidade do serviço e falha de API. Nenhum código novo foi inventado.

## Identidade e legado

- Sora nos headings, Inter no corpo e tokens CRIA PING nos novos componentes.
- Touch targets de 44 px, foco visível, navegação por teclado e sem overflow horizontal em 390, 820 e 1440 px.
- Zernio deixa de aparecer como promoção na sidebar CRIA PING e fica recolhido em “Integrações avançadas”, sem links comerciais no modo novo. O legado não muda.
- O seletor compartilhado de contas recebe nome de formulário, foco visível e altura adequada no modo novo.

## Evidências

| Estado | Desktop | Tablet | Mobile |
| --- | --- | --- | --- |
| Conta conectada | [imagem](onboarding-screenshots/onboarding-connected-desktop.jpg) | [imagem](onboarding-screenshots/onboarding-connected-tablet.jpg) | [imagem](onboarding-screenshots/onboarding-connected-mobile.jpg) |
| Orientação para conectar | [imagem](onboarding-screenshots/onboarding-connect-desktop.jpg) | [imagem](onboarding-screenshots/onboarding-connect-tablet.jpg) | [imagem](onboarding-screenshots/onboarding-connect-mobile.jpg) |
| Meta ausente | [imagem](onboarding-screenshots/onboarding-meta-missing-desktop.jpg) | [imagem](onboarding-screenshots/onboarding-meta-missing-tablet.jpg) | [imagem](onboarding-screenshots/onboarding-meta-missing-mobile.jpg) |
| Configurações de contas | [imagem](onboarding-screenshots/instagram-accounts-desktop.jpg) | [imagem](onboarding-screenshots/instagram-accounts-tablet.jpg) | [imagem](onboarding-screenshots/instagram-accounts-mobile.jpg) |

Também foram registradas [sessão expirada](onboarding-screenshots/onboarding-session-expired-desktop.jpg) e [operação recusada](onboarding-screenshots/instagram-operation-refused-desktop.jpg). O relatório automatizado está em [`checks.json`](onboarding-screenshots/checks.json).

## Reprodução local

```bash
node scripts/prepare-onboarding-review.mjs
FEATURE_FLAGS=newDesign npm run dev
CRIAPING_BROWSER_TOOLS=/tmp/criaping-browser/node_modules node scripts/verify-onboarding.mjs
node scripts/prepare-onboarding-review.mjs cleanup
```

O roteiro intercepta todas as APIs, recusa a única mutação exercitada e falha diante de qualquer escrita inesperada. Axe WCAG A/AA, overflow e erros de página são verificados nos três tamanhos.

## Resultado e limites

- Typecheck e ESLint completos passaram.
- Testes com a flag ligada e desligada: 407 aprovados e 40 ignorados por condições existentes em cada execução.
- Builds de produção com a flag ligada e desligada passaram em webpack. O build Turbopack local não avançou na otimização dentro do tempo de observação; o CI continua responsável pelo build padrão.
- Playwright + axe passaram em Chromium com dados mockados, sem acesso a banco, Auth.js ou Meta.
- OAuth real, conta real, dispositivos físicos, Safari/iOS, Android e entrega de DM continuam fora desta evidência.
