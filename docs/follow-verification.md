# Seguir antes de receber o link

O contrato de `requireFollow` é: liberar a mensagem final e seus links somente
depois de o provedor confirmar que a pessoa segue a conta. A afirmação no botão
“Já estou seguindo” autoriza uma nova consulta; não é prova de que ela segue.

## Fluxo existente

1. Um comentário ou DM elegível encontra a campanha ativa da conta e workspace.
2. Quando há DM de abertura, ela é enviada primeiro. Caso contrário, a primeira
   consulta já pode liberar o conteúdo para um seguidor confirmado ou enviar o
   pedido para seguir com seu botão.
3. No botão, o worker consulta novamente a relação. `true` libera o texto e os
   links atuais. `false` mantém o pedido para seguir. `null`, erro, campo ausente
   ou falta de consentimento também mantêm o conteúdo protegido.
4. Um clique no pedido pode gerar duas novas consultas, após 20 e 40 segundos,
   para acomodar a atualização de um follow recente. O limite de tentativas
   automáticas permanece o existente. O botão permite tentar de novo depois;
   não se envia uma sequência automática ilimitada de mensagens.

O fallback de leitura não envia pedido nem link sem confirmação. Um botão
`reveal:` enviado antes de a exigência ser habilitada passa pela mesma validação
atual da campanha. Sem confirmação, esse primeiro clique recebe o pedido para
seguir imediatamente; somente o botão do pedido inicia as reconsultas. A política
vale para Meta e para o resultado normalizado do
provedor legado: resultado desconhecido não equivale a seguidor.

O diagnóstico distingue “Follow gate rejected a button tap”, para `false`, de
“Follow gate could not verify a button tap”, para resultado indisponível. O novo
diagnóstico não grava IGSID, nome do destinatário, conteúdo da conversa ou token.

## Meta oficial e consentimento

O campo oficial é `is_user_follow_business`, consultado pelo IGSID da pessoa:

https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/user-profile

A Meta exige consentimento de interação para a consulta de perfil; apenas um
comentário não garante esse consentimento. Não se consulta relação por scraping,
senha ou username, nem se considera a declaração da pessoa uma confirmação.

Cliques chegam pelo webhook `messaging_postbacks`. O objeto do app e a conta
conectada precisam ter a assinatura efetiva necessária, além das permissões e
elegibilidade da integração. Assinaturas de `messages` não comprovam entrega de
postbacks. Referência dos campos e formatos:

https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram

Não há nova chamada Graph API, permissão ou token no código desta correção. A
consulta de perfil e os templates de botão existentes são reutilizados.

## Validação e ativação

As regressões em `__tests__/dm-worker.test.ts` cobrem consulta desconhecida,
reconsulta que se torna positiva, pedido de seguir após a última tentativa,
clique de abertura e botões antigos. Também permanecem as suítes de isolamento,
deduplicação, quotas, fallback e integração do provedor.

Testes com mocks verificam essas decisões; não comprovam cliques, transporte de
webhook ou entrega real de DMs. Para comprovar em produção, usar somente conta e
perfil de teste autorizados e conferir:

- pessoa que não segue: pedido e botão, sem liberação do link;
- clique sem seguir: consultas limitadas e novo pedido;
- seguir e clicar: confirmação positiva e liberação do texto/link;
- novo clique/webhook repetido: identidade e comportamento de deduplicação
  existentes preservados; nenhuma repetição por retry de transporte;
- consulta indisponível: link protegido, com botão para tentar de novo.

Ativar somente nas campanhas escolhidas pelo responsável, preservando texto e
links atuais. Não habilitar resposta para toda DM por conveniência: o botão
funciona com o postback existente, independentemente de `dmTriggerEnabled`.
O rollout requer revisão específica Claude/Codex e humana conforme AGENTS.md,
main aprovada e worker atualizado. Sem migração, troca de credenciais ou bypass
de HMAC, janela de mensagens, isolamento ou regras comerciais.

## Rollback

Se a checagem ficar indisponível, pausar as campanhas afetadas pelo fluxo
autorizado antes de reverter a imagem do worker. Não remover `requireFollow`
para mascarar falha de verificação. Preservar logs, filas e histórico; não
reenviar mensagens cujo resultado de entrega seja incerto. A imagem anterior
deve ser registrada antes de cada deploy aprovado.
