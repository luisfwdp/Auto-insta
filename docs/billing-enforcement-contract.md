# Contrato de acesso e consumo comercial — candidato local

Este contrato continua fora da produção. O candidato agora integra os pontos de envio e publicação, mas sua revisão final e aprovação de rollout continuam pendentes. Não habilitar BILLING_ENABLED. Não substitui evidência real do Asaas, Meta ou entrega de e-mail. O PR financeiro #98 permanece congelado; esta etapa depende dele e exigirá revisão específica de banco/worker antes de integração. Nenhuma migração de produção foi executada.

## Autoridade

O workspace vem do contexto autenticado ou de um job persistido e filtrado por workspaceId. O navegador não escolhe owner, período, plano, valor nem escopo do provedor. O acesso pago requer o ledger canônico, vínculo atual, plano/preço versionados e resumo coerente; trial requer a redenção imutável do proprietário, por 72 horas. Suspensão recusa novos efeitos. O modo self-hosted sem BILLING_ENABLED preserva os contadores existentes.

## Reservas

Buckets de teste são globais por proprietário, inclusive entre workspaces. A criação inicial usa INSERT ON CONFLICT (createMany/skipDuplicates), pois um teste concorrente reproduziu P2002 no upsert com update vazio. Buckets pagos usam workspace, ambiente/conta e mês contratual em São Paulo. A identidade da operação é workspace/recurso/chave persistida, sem reset no rollover. Alocação e débito são transacionais; a mesma operação não consome duas vezes. Uma alteração no valor da mesma operação é conflito. Reduzir plano preserva o consumo existente e impede novas reservas acima do teto atual.

RESERVED → DISPATCHING exige claim único e nova validação do acesso/período. DISPATCHING → COMMITTED só ocorre mediante confirmação externa. Rejeição comprovada vira REJECTED e libera o consumo reservado com token anterior invalidado. Uma próxima chamada a reserve rearma a mesma identidade no bucket atual, sem reutilizar o token antigo; só essa rejeição comprovada pode mudar o vínculo de período. Uma resposta de botão rejeitada e o fallback de texto não acumulam dois consumos para uma única DM enviada. Resultado desconhecido permanece DISPATCHING, retém consumo e exige recuperação: não há expiração automática nem reenvio. Uma reserva ainda RESERVED pode ser liberada uma vez; uma reserva RELEASED não é reaberta automaticamente. Finalizar um efeito já ocorrido continua permitido após o fim do teste/assinatura.

A reserva é um limite de consumo, não prova de envio. O caller deve ter seu próprio controle de cancelamento e traduzir somente rejeições comprovadas do provedor em DEFINITELY_REJECTED. Proibido classificar timeout como rejeição definitiva.

## Integrações e critérios de liberação

- DMs: o gateway central cobre cada chamada real de Meta/Zernio, incluindo respostas, botões, follow-up e envio manual. Respostas públicas exigem acesso ativo, sem descontar DM. Um replay COMMITTED usa somente IDs reais guardados em recibo cifrado; não faz novo envio nem exige assinatura ainda ativa. Falhas ambíguas ficam retidas. O manual exige requestId UUID. Toda mensagem, manual ou automática, vincula conteúdo/conta/destinatário/tipo por fingerprint imutável. A identidade automática depende da operação lógica persistida, não do texto ou do formato: editar uma campanha durante uma tentativa incerta gera conflito, sem nova reserva ou envio. Etapas distintas recebem propósitos internos estáveis (por exemplo, confirmação e resposta final). Um fallback tem propósito próprio apenas depois de rejeição comprovada do template; UNKNOWN nunca autoriza fallback. Uma claim durável por evento recebido/automação/workspace cobre o conjunto principal+fallback no gatilho de DM/Story, independentemente do ID de execução da fila; sucesso, crash ou resultado incerto conservam a claim. Só uma recusa comprovada anterior a qualquer entrega a libera. As branches mutuamente exclusivas de primeiro envio usam o mesmo propósito primary; confirmação recheck_ack e follow-up têm propósitos distintos. A chave manual mantém a versão anterior; a automática usa a versão2, ainda sem dados comerciais em produção nesta entrega.
- Publicação/Speed Post: containers já PUBLISHED são recuperados antes dos gates de novas publicações. A reserva só ocorre antes de media_publish; acesso/conta e cancelamentos são revalidados após waitForContainer. Rejeições Meta comprovadas permitem retry; UNKNOWN nunca permite outro publish até prova PUBLISHED. Jobs comerciais terminais persistem FAILED explicitamente, sem depender de attemptsMade atingir o máximo do BullMQ.
- Upload: o token Supabase não limita bytes pelo tamanho declarado pelo cliente. Reservar o teto técnico antes de emitir token, expirar o token antes de liberar reserva e validar o tamanho real.
- STORAGE_BYTES está explicitamente indisponível no primitivo até existir baseline dos assets retidos na transição trial → pago; não zerar armazenamento por renovação/upgrade. Dados não serão apagados para caber em um plano. Reservas existentes também impedem exclusão física do workspace: preservam evidência para conciliar operações incertas e evitam contadores órfãos.
- TRANSFER_BYTES é apenas primitivo interno. URLs assinadas reutilizáveis não oferecem medição/limite exato de egress por requisição; o cap de transferência não está comprovado nem deve ser anunciado como implementado.
- Contas/membros: callbacks OAuth simples/unificado/Facebook, import Zernio, criação/aceite de convites e autoaccept verificam ocupação na mesma transação da escrita. Trial compartilha capacidade por owner; pago usa workspace. Downgrade preserva conexões e só autoriza as N ordenadas por connectedAt/id. A seleção de workspace exige associação atual, e o aceite explícito seleciona a equipe convidada sem apagar a anterior.
- Leituras, logs, cancelamentos, pausas e desconexões devem permanecer disponíveis após expiração.

## Rollback

Não habilitar a integração parcial. Depois de aprovada, suspender novas vendas pelo circuito dedicado sem liberar acesso/quotas para usuários expirados. Preservar buckets, reservas e ledger financeiro. Não reverter migração aditiva nem reduzir status DISPATCHING sem prova do resultado externo.

## Evidências e limites de prova

As suítes dirigidas usam PostgreSQL real descartável para counters, leases, capacidade e vínculos, com transporte Meta/Asaas simulado. Elas comprovam os contratos locais e não comprovam publicação, recebimento de DM ou pagamento real. A ativação depende de revisão Claude Code/Codex, aprovação humana de banco/worker, CI após retarget para main, backend humanamente integrado antes da UI e smoke tests reais autorizados.

O teto de storage do trial foi ajustado para1GB: um upload assinado reserva o teto real do bucket;300MB decimais não comportam nem um token de vídeo de300MiB. Não mudou preço de plano vendido nem foi contratado armazenamento. A reserva estimada deR$2 por teste gratuito permanece uma previsão de custo, não medição de produção.

## Ordem obrigatória da migração e rollback

A migração candidata adiciona User.activeWorkspaceId e metadados de PublishingAsset. O PrismaAdapter seleciona implicitamente todos os campos de User ao ler sessão; portanto desativar BILLING_ENABLED não torna o novo client compatível com um banco sem essas colunas. O teste comercial-migration-compat.db.test.ts reproduz P2022 antes da migração e sessão válida depois, preservando linhas/projeções antigas.

1. Revisão específica Claude Code/Codex e aprovação humana de banco/worker no SHA do PR candidato.
2. Operador humano aplica migrações aditivas a partir desse checkout aprovado, ANTES de mesclar/deployar o novo client. O agente não executa db:migrate contra produção.
3. Só então merge/deploy; manter BILLING_ENABLED=false até UI, configurações e provas reais concluídas. Para suspender novas vendas depois, usar BILLING_SALES_ENABLED=false, preservando enforcement.
4. Rollback de código para o SHA anterior aprovado continua compatível com as colunas/tabelas aditivas. Não desfazer schema nem apagar recibos/reservas, nem mover UNKNOWN para REJECTED sem prova.

Storage usa os assets como baseline de ocupação, incluindo dados retidos antes da assinatura, em vez de zerar um bucket ao mudar trial→pago. Assinaturas exigem teto real privado finito do bucket; exclusões físicas e liberações precisam de confirmação do provedor e token expirado. Uploads incertos mantêm reserva para recuperação explícita; há limites reais da API para provar término de um upload em voo. A migração conserva metadados ao impedir exclusão física do workspace com assets ainda registrados.

## Guardas de composição revisadas

Antes de alocar uma DM, o gateway consulta a identidade existente sem consumir quota. Um recibo COMMITTED permite replay; um resultado DISPATCHING não permite reenvio. Operações novas só reservam depois de validar a conta utilizável, evitando que tráfego numa conexão excedente drene a franquia das contas válidas. Recusas comerciais anteriores ao envio registram código seguro, liberam contadores/rate slots legados e não recebem a etiqueta de entrega incerta.

Cancelamento HTTP/MCP e liberação de reservas ainda não despachadas ocorrem na mesma transação. Só RESERVED/REJECTED podem liberar quota. Resposta media_publish sem ID válido não comprova publicação: conserva UNKNOWN até confirmação canônica. Se uma execução concorrente registrou REVIEW enquanto a chamada anterior estava em voo, o recibo real pode finalizar o mesmo container; a atualização é limitada pelo workspace/id/container e preserva cancelledAt e a intenção CANCELLED do lote. Nunca retomar CANCELLED comum sem prova de efeito já ocorrido. Cancelar não retrai uma chamada Graph já em voo ou aceita.

Objetos de mídias usadas apenas por publicações PUBLISHED/CANCELLED podem ser removidos após TTL, preservando todas as referências e metadados de histórico. DRAFT/SCHEDULED/QUEUED/PROCESSING/FAILED continuam bloqueando remoção pois podem ser usados/repetidos. Um estado DELETED legado não basta para zerar consumo: o fluxo antigo podia apagar antes do vencimento do token e permitir reupload. Não preencher storageDeletedAt nem zerar holds por esse status sem auditoria aprovada do provedor.

Antes de ativar, repetir inventário agregado de assets/objetos/órfãos/bytes e confirmar bucket privado com teto finito. Havendo legado incerto, manter bloqueio de baseline e concluir recuperação aprovada. A verificação de18/11/2026 do projeto desta instalação não encontrou assets ou objetos órfãos; isso é observação operacional, não garante o inventário futuro.
