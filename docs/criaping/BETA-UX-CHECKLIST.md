# CRIA PING — checklist UX do beta

Data: 2026-10-29. Base: main e583a6f, PRs #17–#20 integrados.
Não habilitar newDesign em produção. PRs desta sprint são rascunhos independentes;
merge e aprovação final permanecem humanos. Este documento não declara o beta homologado.

## Funcionalidades reais

Existentes na main: dashboard, consulta/seleção de contas, listagem de campanhas,
criação/edição pelo wizard e operações de campanha nas APIs existentes.
Detalhes e onboarding propostos em PRs separados só contam como disponíveis após integração.

### Primeiro acesso

- [ ] Entrar com sessão real e confirmar isolamento do workspace.
- [ ] Abrir “Primeiros passos” no dashboard (PR de onboarding).
- [ ] Sem contas: orientar conexão profissional sem exibir uma conta fictícia.
- [ ] Configuração Meta ausente: informar dependência e acesso às configurações.
- [ ] Conta salva: mostrar identidade e estado de webhook sem prometer envio disponível.
- [ ] Selecionar conta e encaminhar seu ID ao wizard.
- [ ] Voltar ao dashboard sem perder acesso à navegação.

### Dashboard e contas Instagram

- [x] Dashboard CRIA PING e seleção têm implementação existente com dados reais.
- [ ] Auditar dashboard completo nos três tamanhos nesta sprint.
- [ ] Homologar consulta real de contas e troca de workspace com sessões distintas.
- [ ] Executar OAuth oficial em ambiente de homologação configurado.
- [ ] Conferir tokens vencidos/webhook pendente com dados controlados reais.
- [ ] Falha de API deve permanecer diferente de “nenhuma conta”.

### Criação, edição e pausa

- [x] Wizard verificado com Playwright em desktop/tablet/mobile: três etapas,
  validação, voltar mantendo rascunho, revisão e confirmação.
- [x] Teste verifica ausência de escrita antes da confirmação.
- [x] Edição PATCH e falha HTTP/lógica exercitadas somente com interceptação.
- [x] Listagem: ações, filtros, ausência de campanhas e falha de consulta exercitados.
- [ ] Homologar criação, edição, pausa e retomada em workspace descartável real,
  com campanhas impedidas de enviar a pessoas reais.
- [ ] Confirmar mensagem final e retorno à listagem em sessão real.

### Detalhes e relatórios

- [x] Contrato conferido: GET /api/automations retorna configuração e
  sent/clicks/ctr/failed/skipped.
- [x] PR de detalhes: telas de sucesso, ausência, erro e 401 exercitadas com mocks.
- [ ] Integrar e revisar o PR de detalhes.
- [ ] Conferir métricas com registros conhecidos de homologação.
- [ ] Auditar relatório público /reports/[shareSlug] completo, incluindo slug inválido.
- [ ] Revisar relatório compartilhado com permissões/escopo reais.
- Sem filtro de período no contrato de detalhes: não oferecer controle sem suporte.
- Não existem nesta entrega novas métricas de receita, conversão ou leads.

### Erros, mobile e acessibilidade

- [x] Listagem/wizard: axe no main sem violações nos três tamanhos exercitados.
- [x] Legado off: listagem/criação comparadas visualmente com origin/main,
  desktop/tablet/mobile, sem regressão detectada.
- [x] Detalhes propostos: screenshots em três tamanhos e axe no main.
- [ ] Auditoria manual completa de sidebar/topbar e menu mobile (foco e retorno).
- [ ] Login, sessão expirada real, permissões e configurações: teclado/leitor de tela.
- [ ] Confirmar erros de serviço externo com os contratos reais do ambiente configurado.
- [ ] Testar rede lenta e recuperação de conexão em dispositivo real.
- [ ] Revalidar contraste, zoom 200%, textos longos e todos os idiomas.

## Simulação exclusiva de testes

Playwright intercepta APIs em páginas temporárias de revisão. Contas creator_one/
creator_two, campanhas e números nas screenshots são fixtures. Não são dados de produção.
As fixtures devem ser removidas antes de builds/commits; não há bypass de autenticação
ou endpoint fake no produto. Mocks não homologam banco, sessão nem integração Meta.

## Funcionalidades futuras e requisitos indisponíveis

- Analytics adicionais e filtros só após contrato backend integrado.
- Credenciais Meta, OAuth completo, webhooks e entrega real dependem do trabalho de
  backend/infraestrutura do Claude Code; não foram alterados nesta sprint.
- Testes DB requerem TEST_DATABASE_URL de Postgres descartável.
- Configuração de ambiente presente não prova que permissões Meta foram aprovadas.
- Revisão cruzada de Claude Code e aprovação humana pendentes para os PRs.

## Evidências e próximo marco

PR de detalhes: docs/criaping/campaign-detail-beta.md e beta-screenshots/.
PR de onboarding: docs/criaping/onboarding-beta.md e onboarding-screenshots/.
As pastas entram junto de seus PRs; não são dependências deste documento.

Verificações locais do PR de detalhes: typecheck/lint, builds on/off e Vitest on/off.
Vitest: 396 aprovados, 40 ignorados por condições existentes; nenhum teste foi
desabilitado para esta entrega. Banco/Meta não exercitados.

Próximo marco: revisão dos PRs e auditoria das telas ainda pendentes, seguida de
uma jornada real em homologação (login → conta → campanha pausada → edição → relatório),
sem enviar DMs a pessoas reais e antes de liberar o beta.

Rascunhos independentes: [detalhes #24](https://github.com/luisfwdp/Auto-insta/pull/24),
[onboarding/contas #26](https://github.com/luisfwdp/Auto-insta/pull/26).
Onboarding: 15 combinações de estado/tamanho passaram com Playwright/axe,
zero escritas; typecheck, lint, Vitest e builds on/off aprovados.
