# CRIA PING — interface operacional e caminho do MVP

Fonte da verdade: rotas, schemas de validação e serviços já presentes neste repositório. O novo visual continua desligado por padrão e só aparece com `FEATURE_FLAGS=newDesign` no momento do build/deploy.

## PR C — navegação, dashboard e estados reais (este PR)

- Aplicar a identidade CRIA PING ao shell autenticado, sidebar, topbar e menu mobile.
- Reutilizar o workspace primário, o seletor de conta existente e `GET /api/dashboard/stats`.
- Mostrar somente contagens persistidas: automações, DMs enviadas, campanhas ativas e cliques rastreados.
- Cobrir loading, erro sem estimativas, conta sem Instagram e conta sem campanhas.
- Manter aparência, rotas e comportamento do shell legado com a flag desligada.

## PR D — campanhas e wizard em três etapas

- Revestir a listagem existente de campanhas, mantendo busca, filtro, ativar/pausar, duplicar, excluir, importar e relatórios conforme as APIs atuais.
- Reorganizar o `CampaignBuilder` existente em: (1) conta/publicação/palavra-chave, (2) comentário/DM, (3) revisão/confirmação.
- Preservar os contratos atuais de `GET/POST/PATCH/DELETE /api/automations`; não criar status de rascunho, pois hoje o modelo persiste apenas `isActive`.
- Salvar apenas na confirmação final. Nenhuma etapa intermediária envia DM.

## PR E — preview de DM, revisão e mobile

- Adaptar `CampaignPreview`, `PostPicker` e as mensagens/botões que já são aceitos pelo schema de automação.
- Representar abertura, link rastreado opcional, segundo botão opcional, verificação de seguidor e follow-up somente quando configurados.
- Testar 390 px, 820 px e 1440 px, teclado, redução de movimento e textos longos nos três idiomas.

## PR F — acabamento, primeiro acesso e testes completos

- Onboarding do primeiro usuário: login → conexão profissional do Instagram → primeira campanha.
- Mensagens acionáveis para email, OAuth, webhook, Redis/worker e permissões Meta.
- Regressão completa com `newDesign` ligado/desligado, screenshots e roteiro de rollback.

## Capacidades reais já existentes

- Login por magic link via Resend ou SMTP, sessão persistida com Auth.js/Prisma e allowlist opcional.
- Workspace criado no primeiro login e isolamento por workspace nas rotas autenticadas.
- OAuth de Instagram profissional, contas múltiplas, leitura de perfil e publicações.
- Campanhas por publicação específica, qualquer publicação ou próximo reel; palavra-chave específica ou qualquer palavra.
- Resposta pública opcional, DM de abertura, DM principal, até dois links rastreados, verificação de seguidor e follow-up de até 24 horas.
- Webhook, fila Redis/worker, deduplicação, limites, logs, cliques, CTR, relatórios compartilháveis e inbox.

## Lacunas e riscos antes do MVP

- Não existe rascunho persistido: uma campanha é ativa ou pausada. O wizard deve manter o rascunho apenas no navegador até a confirmação.
- A aplicação usa sempre o workspace primário; ainda não existe mecanismo completo para alternar workspace. Não será simulado na interface.
- `GET /api/automations` cria retroativamente um slug de relatório ausente, portanto a leitura atual pode escrever no banco. Convém separar essa correção em manutenção posterior, sem misturá-la ao redesign.
- O fluxo real depende de email transacional, banco, Redis/worker e configuração Meta/webhook válidos. Builds com valores fictícios não comprovam esses serviços.
- Permissões e revisão da Meta determinam quais contas e recursos funcionam fora dos usuários de teste do app.

## Checklist do primeiro login e primeira automação

1. URL pública e `NEXTAUTH_URL` coincidentes; `NEXTAUTH_SECRET`, banco e migrações já implantadas.
2. Resend/SMTP e `EMAIL_FROM` válidos; email do proprietário presente em `ALLOWED_EMAILS` quando o modo restrito estiver ativo.
3. `ENCRYPTION_KEY`, app Meta, segredo, token de verificação e callback configurados com o mesmo domínio.
4. Conta profissional do Instagram vinculada a uma Página e autorizada para o app Meta.
5. Webhook inscrito e acessível; Redis e worker de DM ativos.
6. Criar a campanha pausada, revisar publicação/palavras/mensagens e só então ativá-la manualmente.

### Estado verificado em 26/10/2026

- GitHub `production-database`: os dois segredos de pooler existem; há revisor obrigatório (`luisfwdp`) e a única branch autorizada é `main`.
- Faltam no mesmo ambiente as variáveis não secretas `EXPECTED_PROJECT_REF` e `SUPABASE_PUBLISHABLE_KEY`. O único preflight executado falhou exatamente por `EXPECTED_PROJECT_REF` vazio; ele não chegou a validar Data API, conexão ou estado do banco.
- Vercel `auto-insta`: existem somente `NEXTAUTH_URL`, `ALLOWED_EMAILS_REQUIRED=true` e `META_GRAPH_API_VERSION`. Portanto o login ainda está bloqueado pela ausência de `DATABASE_URL`, `NEXTAUTH_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM` e `ALLOWED_EMAILS`.
- Depois do login, conectar o Instagram ainda requer `ENCRYPTION_KEY`, `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET`. Operação real requer também segredos de webhook/cron, Redis e worker.
- A desativação atual da Data API não pôde ser comprovada pelo workflow enquanto as duas variáveis do preflight estiverem ausentes.

Não executar migrações, enviar DMs, alterar credenciais ou ligar `newDesign` em produção faz parte deste plano.
