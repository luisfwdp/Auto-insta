# Contrato de acesso e consumo comercial — candidato local

Este contrato continua fora da produção e sem integração aos pontos de envio. Não habilitar BILLING_ENABLED. Não substitui evidência real do Asaas, Meta ou entrega de e-mail. O PR financeiro #98 permanece congelado; esta etapa depende dele e exigirá revisão específica de banco/worker antes de integração. Nenhuma migração de produção foi executada.

## Autoridade

O workspace vem do contexto autenticado ou de um job persistido e filtrado por workspaceId. O navegador não escolhe owner, período, plano, valor nem escopo do provedor. O acesso pago requer o ledger canônico, vínculo atual, plano/preço versionados e resumo coerente; trial requer a redenção imutável do proprietário, por 72 horas. Suspensão recusa novos efeitos. O modo self-hosted sem BILLING_ENABLED preserva os contadores existentes.

## Reservas

Buckets de teste são globais por proprietário, inclusive entre workspaces. A criação inicial usa INSERT ON CONFLICT (createMany/skipDuplicates), pois um teste concorrente reproduziu P2002 no upsert com update vazio. Buckets pagos usam workspace, ambiente/conta e mês contratual em São Paulo. A identidade da operação é workspace/recurso/chave persistida, sem reset no rollover. Alocação e débito são transacionais; a mesma operação não consome duas vezes. Uma alteração no valor da mesma operação é conflito. Reduzir plano preserva o consumo existente e impede novas reservas acima do teto atual.

RESERVED → DISPATCHING exige claim único e nova validação do acesso/período. DISPATCHING → COMMITTED só ocorre mediante confirmação externa. Rejeição comprovada volta a RESERVED com token anterior invalidado. Resultado desconhecido permanece DISPATCHING, retém consumo e exige recuperação: não há expiração automática nem reenvio. Uma reserva ainda RESERVED pode ser liberada uma vez; uma reserva RELEASED não é reaberta automaticamente. Finalizar um efeito já ocorrido continua permitido após o fim do teste/assinatura.

A reserva é um limite de consumo, não prova de envio. O caller deve ter seu próprio controle de cancelamento e traduzir somente rejeições comprovadas do provedor em DEFINITELY_REJECTED. Proibido classificar timeout como rejeição definitiva.

## Integrações ainda obrigatórias

- DMs: cada chamada real, incluindo respostas, botões, follow-up e envio manual. Não basta substituir o contador inicial. Respostas públicas exigem acesso ativo, embora não sejam DMs.
- Publicação/Speed Post: recuperar containers já PUBLISHED antes de bloquear novas publicações; reservar no início da execução, revalidar cancelamentos antes da chamada real.
- Upload: o token Supabase não limita bytes pelo tamanho declarado pelo cliente. Reservar o teto técnico antes de emitir token, expirar o token antes de liberar reserva e validar o tamanho real.
- STORAGE_BYTES está explicitamente indisponível no primitivo até existir baseline dos assets retidos na transição trial → pago; não zerar armazenamento por renovação/upgrade. Dados não serão apagados para caber em um plano. Reservas existentes também impedem exclusão física do workspace: preservam evidência para conciliar operações incertas e evitam contadores órfãos.
- TRANSFER_BYTES é apenas primitivo interno. URLs assinadas reutilizáveis não oferecem medição/limite exato de egress por requisição; o cap de transferência não está comprovado nem deve ser anunciado como implementado.
- Contas/membros precisam de verificação de ocupação atômica no callback OAuth e aceite de convite; downgrade preserva dados e conexões.
- Leituras, logs, cancelamentos, pausas e desconexões devem permanecer disponíveis após expiração.

## Rollback

Não habilitar a integração parcial. Depois de aprovada, suspender novas vendas pelo circuito dedicado sem liberar acesso/quotas para usuários expirados. Preservar buckets, reservas e ledger financeiro. Não reverter migração aditiva nem reduzir status DISPATCHING sem prova do resultado externo.
