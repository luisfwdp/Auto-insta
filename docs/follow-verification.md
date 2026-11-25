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

## Recuperação de toques sem webhook

Quando a Meta não entrega `messaging_postbacks` (por exemplo, enquanto a
permissão de mensagens está só com Acesso Padrão), o toque no botão nunca chega
e ninguém recebe o link. Em produção, em 25/11/2026, um toque real em "Já estou
seguindo" não gerou nenhum evento, embora a conta estivesse inscrita em
`messaging_postbacks`.

O worker passa a recuperar esses toques pela mesma lista de conversas que a
Caixa de entrada já lê (`lib/polling/button-tap-reconciler.ts`), no mesmo ciclo
de 5 minutos da varredura de comentários:

- Só contas META com campanha ativa que envia botão (`requireFollow` ou DM de
  abertura) e que contataram alguém nas últimas 24 horas. Sem isso, nenhuma
  chamada à Graph API é feita.
- Só age quando a mensagem mais recente da conversa é da outra pessoa, tem até
  24 horas e o texto é exatamente o título do botão (sem diferenciar maiúsculas).
- Só para quem a campanha já havia contatado antes do toque; a campanha mais
  recente decide de qual botão se trata.
- Cada mensagem é tratada uma única vez (marcador no Redis por 48 horas) e o job
  usa o mesmo formato de `jobId` do webhook, de modo que um postback que chegue
  para a mesma mensagem não gera um segundo job.
- Não envia nada por conta própria: enfileira o mesmo job `process-postback`, e
  o caminho existente continua exigindo `is_user_follow_business === true`,
  cota, deduplicação e janela de mensagens.

Limites: só a mensagem mais recente de cada conversa é lida, então um toque
seguido de outra mensagem da pessoa não é recuperado; a lista cobre as 50
conversas mais recentes; o atraso é de até 5 minutos. Não há chamada nova à
Graph API nem permissão nova. O registro operacional
(`Button taps recovered from conversations`) guarda só a contagem.

Pressuposto ainda não comprovado em produção: que a API de conversas devolva o
toque do botão como mensagem com o título do botão. Os testes usam payload
anonimizado nesse formato. Se a API não devolver, a rotina não encontra nada e
não tem efeito.

Referência: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api
