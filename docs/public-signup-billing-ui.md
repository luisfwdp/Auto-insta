# Cadastro público e assinatura

Interface F11 para os contratos de cadastro, seleção de workspace e cobrança já
integrados nos PRs #97–#99. Não cria endpoints, provedores, planos ou migrações.

## Comportamento

- `/login?mode=signup` usa o link de e-mail do Auth.js e retorna ao onboarding.
  Cadastro não exige senha, cartão ou contratação. Respostas de elegibilidade e
  falha do provedor de e-mail são uniformes; allowlist e rate limit permanecem.
- Entradas por template validado passam pelo mesmo onboarding no modo comercial;
  o destino da campanha é preservado depois da ativação, sem reiniciar o trial.
- O proprietário ativa explicitamente o teste de 72 horas. Visitas às páginas e
  consultas GET não iniciam nem renovam o teste. O backend decide elegibilidade,
  prazo e acesso. Outros membros não podem ativar teste ou alterar cobrança.
- `/billing` mostra o estado canônico do workspace selecionado, limites e uso
  medido. Armazenamento não reportado e transferência não medida não aparecem
  como consumo zero. Suspensão/expiração não são apresentadas como acesso ativo.
- A contratação opcional exige consentimento explícito ao valor mensal e à
  primeira cobrança imediata, inclusive durante o teste. O servidor revalida a
  oferta e recebe somente os campos previstos no contrato existente.
- Antes de um POST financeiro, o navegador persiste o identificador da operação
  em sessionStorage do workspace. Sem armazenamento não há POST. Resultado
  ambíguo bloqueia nova compra; buscas conhecidas retomam apenas GET, com polling
  limitado. Nenhum redirecionamento ou retorno do Asaas concede acesso.
- Nesta UI, checkout ambíguo sem ID exige revisão operacional: o estado local não
  guarda a oferta completa para retomá-lo. O POST do backend é idempotente por
  requestId, mas esta interface não repete um checkout incerto. Cancelamento
  incerto pode ser retomado por ação explícita, com o mesmo requestId original;
  uma falha dessa retomada não apaga a intenção anterior. As garantias entre
  abas/dispositivos são do backend, não do armazenamento do navegador.
- Somente URLs HTTPS de checkout dos hosts exatos aprovados do Asaas são aceitas.
  Cookies, dados de cartão e credenciais do provedor não são enviados pela UI.
- Cancelamento exige confirmação do proprietário e preserva o período pago
  registrado; o processamento financeiro permanece no backend/worker.
- A seleção de workspace usa somente memberships retornadas pelo servidor e
  recarrega a página inteira, descartando estado cliente do tenant anterior.
- Leituras e ações da UI enviam x-cria-workspace-id como precondição. O backend
  compara com o contexto autenticado; divergência ou PIN ausente impede efeitos
  financeiros. Uma aba antiga bloqueia ações e exige recarga, inclusive quando
  a seleção mudou em outro dispositivo. O header nunca escolhe o tenant.
- `/pricing` usa o catálogo versionado do servidor e oculta ofertas quando novas
  vendas estão pausadas. A home comercial só aparece com BILLING_ENABLED=true.
  O fluxo self-hosted existente continua disponível quando a cobrança está OFF.

## Ativação e rollback

Mantenha as flags comerciais desligadas até concluir: RLS do backend (#101),
revisões e merge humano, plano Vercel adequado a uso comercial, domínio de e-mail
verificado, teste real de entrega do link, credenciais e webhook Asaas separados
por ambiente, checkout/pagamento/cancelamento Sandbox e saúde do worker.
Nenhum teste local ou mock comprova cobrança real, publicação Meta ou entrega DM.

O RLS #101 é uma dependência operacional para habilitar trial/cobrança em produção.
O contrato de precondição #105 deve ser integrado antes deste PR de interface.
A UI permanece compatível com BILLING_ENABLED=false antes da migração e não
anuncia trial quando a flag está OFF.
Para pausar novas vendas, use BILLING_SALES_ENABLED=false sem desligar enforcement,
acesso pago ou recuperação financeira. Não remova políticas com operações em voo.
Rollback da UI é revert do commit e novo deploy da versão aprovada, preservando
contratos, dados, processamento financeiro e o estado das flags do incidente.

## Validação

Testes de contrato cobrem permissões, persistência anterior ao POST, consentimento,
resultados ambíguos, polling limitado, URLs externas e mudança de workspace.
Testes de renderização cobrem catálogo real, flags de venda, i18n e estado inicial
sem inventar acesso/consumo. O teste HTTP local usa Next/Auth.js/Prisma/PostgreSQL/
Redis reais e substitui somente o transporte Resend por uma caixa local em memória;
não é prova de entrega de e-mail externo ou de integração Asaas.
