# Feature flags

O Auto Insta é desenvolvido de forma contínua sobre a `main`, com produção antecipada.
Funcionalidades incompletas entram na `main` **atrás de uma flag desligada por padrão**, e a
produção continua com o comportamento estável. A definição fica em `lib/feature-flags.ts`.

## Ligar e desligar

A variável de ambiente `FEATURE_FLAGS` recebe nomes de flags separados por vírgula. Um `-` na
frente desliga uma flag que vem ligada por padrão. Nomes desconhecidos são ignorados.

| Ambiente na Vercel | Valor sugerido |
| --- | --- |
| Production | não definir (padrões estáveis) |
| Preview | as flags em teste, ex.: `newDesign,workspaceSwitcher` |
| Development (local, `.env`) | o que estiver desenvolvendo |

O worker lê a mesma variável. Uma flag que mude o comportamento do envio precisa ter o mesmo
valor no web e no worker.

Mudar `FEATURE_FLAGS` na Vercel só vale a partir do próximo deploy (faça um *redeploy* do
último deploy de produção para aplicar sem mudar código).

## Flags atuais

| Flag | Padrão | Uso |
| --- | --- | --- |
| `newDesign` | desligada | Design system Auto Insta (F1) |
| `workspaceSwitcher` | desligada | Seletores de workspace e conta (F2) |
| `commentsCenter` | desligada | Central de comentários e moderação (F6) |
| `contacts` | desligada | Contatos, tags e painel do contato (F5) |
| `reportsV2` | desligada | Relatórios consolidados e exportação (F8) |
| `zernioIntegration` | **ligada** | Integração opcional Zernio (já estável); `-zernioIntegration` a esconde |

## Regras

- Ler flags **só no servidor** (`isFeatureEnabled`). Componentes client recebem
  `getEnabledFeatureFlags()` por props.
- Esconder a tela não basta: a rota de API da funcionalidade também verifica a flag e responde
  404 quando desligada.
- Uma flag não substitui migração segura: mudanças de schema continuam aditivas e com default
  compatível, porque o banco é o mesmo com a flag ligada ou desligada.
- Ao estabilizar a funcionalidade, remova a flag, as verificações e a menção em `FEATURE_FLAGS`
  num único PR.
- Rollback de uma funcionalidade atrás de flag: remover o nome de `FEATURE_FLAGS` e fazer
  *redeploy*. Rollback de código: *Instant Rollback* da Vercel para o deploy anterior (veja
  `docs/PRODUCAO.md`).
