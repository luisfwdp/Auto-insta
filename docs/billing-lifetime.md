# Licença vitalícia de workspace

Uma licença administrativa explícita pode dispensar a assinatura de um workspace,
sem alterar pagamentos, `paidThrough`, status financeiro ou resgates de trial.
Não existe endpoint para concedê-la: o runtime lê `WorkspaceLifetimeAccess`, mas
não tem permissão de inserir, editar, revogar ou apagar concessões. RLS não
concede acesso às funções públicas, autenticadas ou `service_role`.

A licença pertence ao workspace e ao proprietário registrados na concessão.
Transferência de proprietário invalida o vínculo; suspensão continua bloqueando
novas ações. Revogação exige data, operador e motivo e não apaga histórico.
Uma licença revogada permite apenas o acesso pago/trial que já for válido por
seus próprios critérios. Não renova o trial nem cria evidência de pagamento.

## Limites e cobrança

Não há vencimento da licença. As cotas do plano versionado continuam valendo;
o plano Agência atual permite 10 contas, 5 membros, 30 mil DMs, mil publicações,
30 GB de armazenamento e 80 GB de transferência. Os contadores de uso medido
têm janela mensal de calendário em America/Sao_Paulo. Armazenamento retido
continua sujeito ao limite existente; transferência ainda não é medida, conforme
o contrato comercial atual. Não há promessa de recurso ilimitado.

Reservas usam o ID imutável da concessão e o escopo `workspace-lifetime-v1`,
separados de trial e Asaas. Reenvios conservam a idempotência existente. Jobs
validam a licença novamente antes de despachar; recibos de efeitos já confirmados
continuam recuperáveis. A interface informa `LIFETIME`, sem expor o operador,
motivo, referência administrativa ou ID da concessão. Novos checkouts são
recusados antes de gravar intent ou chamar o provedor.

A migração `20261127155600_lifetime_quota_timezone` fixa UTC somente na
função do gatilho que valida cada reserva. O horário da concessão é gravado
em UTC e a validação vale também quando a sessão do aplicativo usa o fuso de
São Paulo. A janela mensal das cotas continua seguindo o calendário de São Paulo.

Uma licença **não cancela** assinaturas ou checkouts existentes no Asaas.
Antes da concessão, o operador deve confirmar que não há assinatura vigente,
checkout aberto/em criação/desconhecido ou sincronização financeira ativa.
Se houver, resolver explicitamente essa pendência antes de conceder a licença.

## Implantação e concessão

1. Revisar o PR, a migração e o SQL específico da concessão com Claude, Codex e
   humano, conforme `AGENTS.md`. Não executar contra produção sem autorização
   específica para a migração e o registro administrativo.
2. Aplicar apenas a migração aditiva `20261123233000_workspace_lifetime_access`.
   Antes, confirmar em Vercel e Fly que a conexão efetiva usa `pingchat_runtime`,
   sem superuser, BYPASSRLS, propriedade das tabelas ou memberships elevados.
   Não inferir isso apenas da existência do papel. Se a conexão usa outro papel,
   interromper a implantação; não contornar RLS nem ampliar privilégios.
   Ela preserva dados e privilégios de outras tabelas. Amplia a função de
   vínculo de reservas para validar também o workspace/owner da concessão,
   mantendo as regras anteriores de trial e pagamento e `SECURITY INVOKER`.
3. Integrar o código aprovado; confirmar Vercel e worker Fly na mesma versão.
   O código anterior ignora a tabela; o novo exige a migração já aplicada.
4. Em transação administrativa, bloquear proprietário e `WorkspaceBilling`,
   conferir o workspace/owner esperados e ausência de suspensão, assinatura,
   checkout ativo e lease de sincronização. Inserir uma concessão única com
   plano, UUID, operador, motivo e referência da autorização. Não sobrescrever
   um registro existente, especialmente se revogado.
5. Validar `/api/billing/status`, cotas e conexão de conta na sessão correta;
   confirmar que outros workspaces e o ledger financeiro não mudaram.

SQL com identificação do cliente fica no pacote privado de operação; não
publicar dados pessoais no PR. Aplicar uma vez e, ao repetir, verificar igualdade
do vínculo e da auditoria antes de considerar a operação idempotente.
O template aborta se restarem IDs ou textos de exemplo; preencher também um
UUID próprio, operador, motivo e referência reais antes da revisão humana.

## Rollback

Revogar em transação com `revokedAt`, `revokedBy` e `revocationReason`, mantendo
o registro e todos os contadores. Não apagar licenças, reservas ou dados de
clientes. A concessão pode ser revertida sem rollback de código.

Se necessário, retornar Vercel e Fly às imagens anteriores; o código anterior
volta a exigir o acesso comercial ordinário. Deixar tabela, enum e políticas
aditivas no banco. Não remover enum nem executar migração destrutiva.
