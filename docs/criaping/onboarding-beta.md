# Onboarding e contas — beta

PR independente de detalhes: baseado na main e no GET /api/dashboard/stats existente.
Não altera OAuth, Auth.js, tokens, permissões, banco ou serviços.

- Dashboard CRIA PING oferece “Primeiros passos”, acessível novamente a qualquer momento.
- /onboarding fica no layout autenticado existente. Com newDesign desligado, redireciona
  para /dashboard; não altera a experiência legada.
- A verificação de configuração Meta usa getMissingInstagramOAuthEnv no servidor e
  serializa somente um booleano. Não envia nomes nem valores de variáveis ao navegador.
- Configuração presente não é prova de OAuth funcionando. A UI não promete isso.
- Ausência de conta só aparece após consulta bem-sucedida. API falha nunca vira conta vazia.
- Conta salva mostra identificação, webhook e vencimento retornados pelo backend.
  Não presume envio disponível nem inventa teste de saúde.
- Seleção usa IDs reais e encaminha a conta selecionada ao wizard existente.
- Usuário pode voltar ao dashboard e abrir configurações existentes.
- Carregamento termina em falha recuperável após 20 segundos. 401 aponta ao login;
  403 informa permissão insuficiente; demais falhas oferecem retry.
- Nenhuma conta de teste ou endpoint novo é incluído no produto.

## Revisão

Typecheck e lint locais aprovados antes da verificação de navegador. Chaves em inglês
(idioma fonte), pt-BR e zh-TW. Playwright usa respostas interceptadas exclusivamente
na fixture temporária. Screenshots são exemplos de testes e não contas conectadas reais.

Reprodução: instalar Playwright e @axe-core/playwright fora do produto; definir
CRIAPING_BROWSER_TOOLS com node_modules; executar
node scripts/verify-onboarding.mjs prepare, iniciar dev na porta 3000 e executar
node scripts/verify-onboarding.mjs. Parar servidor e executar cleanup antes de build/commit.

Sem credenciais/banco/Meta, login real, OAuth e entrega não foram homologados.
Revisão de Claude Code pendente antes do beta.

Playwright + axe: 15 combinações aprovadas (três tamanhos × ausência de conta,
seleção, erro de API, 401 e 403), sem overflow horizontal e sem violações no main.
Retry e encaminhamento da conta selecionada ao wizard conferidos. Zero requisições
de escrita. Evidência: onboarding-screenshots/checks.json e 15 screenshots.

Vitest on/off: 396 aprovados, 40 ignorados pelas condições existentes da suíte
(incluem dependências de Postgres descartável). Nenhum teste removido/desabilitado.
Builds com newDesign ligado/desligado aprovados após instalar dependências e gerar cliente
localmente; links simbólicos entre worktrees não são usados no build final.
