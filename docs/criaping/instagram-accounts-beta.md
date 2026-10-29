# CRIA PING — contas do Instagram no beta

Este incremento cobre a fase 4 e os estados relacionados da fase 6. Ele usa somente contratos existentes. `newDesign` continua `false` por padrão e a tela legada de configurações permanece ativa quando a flag está desligada.

## Fontes reais

- `GET /api/dashboard/stats`: fornece nome, username, provider, expiração do token e estado do webhook.
- `GET /api/workspace/members`: mantém as permissões e a equipe já existentes.
- `POST /api/instagram/disconnect`: continua sendo a única ação de desconexão; a interface só confirma sucesso quando a API confirma.

Nenhuma conta, métrica, permissão, endpoint, OAuth ou estado da Meta foi simulado no produto. Os dados artificiais existem apenas no roteiro Playwright local.

## Experiência

- Configurações mostra identificação, provider, expiração disponível e webhook retornados pela API.
- Cada conta pode abrir o wizard existente com seu `instagramAccountId` real.
- A desconexão recusada não produz confirmação falsa.
- Carregamento, ausência de contas, sessão expirada, permissão insuficiente, operação recusada, serviço indisponível e falha genérica são estados distintos.
- As falhas são classificadas somente a partir do status HTTP recebido: 401, 403, 400/409/422, 502/503/504 e demais códigos. Nenhum código novo foi inventado.
- Falha na consulta de membros não transforma uma consulta de contas bem-sucedida em erro, e vice-versa.

## Identidade e legado

- Sora nos headings, Inter no corpo e tokens CRIA PING nos componentes novos.
- Touch targets de 44 px, foco visível, navegação por teclado e ausência de overflow horizontal em 390, 820 e 1440 px.
- Zernio deixa de aparecer como promoção na sidebar CRIA PING e fica recolhido em “Integrações avançadas”, sem links comerciais no modo novo. O legado não muda.
- O seletor compartilhado de contas recebe nome de formulário, foco visível e altura adequada no modo novo.

## Evidências

| Estado | Desktop | Tablet | Mobile |
| --- | --- | --- | --- |
| Contas conectadas | [imagem](instagram-accounts-screenshots/connected-desktop.jpg) | [imagem](instagram-accounts-screenshots/connected-tablet.jpg) | [imagem](instagram-accounts-screenshots/connected-mobile.jpg) |
| Sem contas | [imagem](instagram-accounts-screenshots/empty-desktop.jpg) | [imagem](instagram-accounts-screenshots/empty-tablet.jpg) | [imagem](instagram-accounts-screenshots/empty-mobile.jpg) |
| Sessão expirada | [imagem](instagram-accounts-screenshots/session-expired-desktop.jpg) | [imagem](instagram-accounts-screenshots/session-expired-tablet.jpg) | [imagem](instagram-accounts-screenshots/session-expired-mobile.jpg) |

Também foi registrada a [operação recusada](instagram-accounts-screenshots/operation-refused-desktop.jpg). O relatório automatizado está em [`checks.json`](instagram-accounts-screenshots/checks.json).

## Reprodução local

```bash
node scripts/prepare-instagram-accounts-review.mjs
FEATURE_FLAGS=newDesign npm run dev
CRIAPING_BROWSER_TOOLS=/tmp/criaping-browser/node_modules node scripts/verify-instagram-accounts.mjs
node scripts/prepare-instagram-accounts-review.mjs cleanup
```

O roteiro intercepta todas as APIs, recusa a única mutação exercitada e falha diante de qualquer escrita inesperada. Axe WCAG A/AA, overflow e erros de página são verificados nos três tamanhos.

## Resultado e limites

- Typecheck e ESLint completos passaram.
- Testes com a flag ligada e desligada: 403 aprovados e 40 ignorados por condições existentes em cada execução.
- Builds de produção com a flag ligada e desligada passaram em webpack. O build Turbopack local não avançou na otimização dentro do tempo de observação; o CI continua responsável pelo build padrão.
- Playwright + axe passaram em Chromium com dados mockados, sem acesso a banco, Auth.js ou Meta.
- OAuth real, conta real, dispositivos físicos, Safari/iOS, Android e entrega de DM continuam fora desta evidência.
