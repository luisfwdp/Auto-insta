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

Em produção, em 26/11/2026, um toque real em “Me envie o link” apareceu na
API de conversas, mas não chegou como `messaging_postbacks` no callback. A
conta estava inscrita nesse campo. O suporte Meta informou um incidente de
entrega. O Acesso Padrão atende ao teste com papéis
no próprio app; o Acesso Avançado atende a contas de clientes externos.

O worker passa a recuperar esses toques pela mesma lista de conversas que a
Caixa de entrada já lê (`lib/polling/button-tap-reconciler.ts`). A recuperação
roda separada da varredura de comentários:

- Só contas META com campanha ativa que envia botão (`requireFollow` ou DM de
  abertura) e que contataram alguém nas últimas 24 horas. Sem isso, nenhuma
  chamada à Graph API é feita.
- A cada 30 segundos, consulta até três prévias para contas que enviaram
  uma DM elegível ou um novo pedido para seguir nos últimos dez minutos.
  A cada cinco minutos, uma varredura
  completa cobre até as 50 conversas recentes. O worker evita rodadas
  simultâneas e suspende essa leitura da conta por cinco minutos quando a
  Meta retorna um limite de taxa.
- Só age quando a mensagem mais recente da conversa é da outra pessoa, tem até
  24 horas e o texto é exatamente o título do botão (sem diferenciar maiúsculas).
- Só para quem tem uma DM registrada como `SENT`, anterior ao toque, na mesma
  conta e workspace. A campanha do envio mais recente decide de qual botão
  se trata.
- Uma reserva Redis de um minuto evita varreduras simultâneas para o mesmo
  toque. A reserva vira marcador de 48 horas após enfileirar. Uma falha de
  fila libera a reserva; uma interrupção do processo permite retry após expirar.
- Quando o ID de mensagem coincide com o `mid` do postback, ambas as entradas
  usam a mesma identidade de job e a trava persistente de entrega. A fila
  conserva as últimas 1.000 conclusões e a trava continua após a remoção do job.
- Quando os IDs diferem e ambos os eventos incluem o horário, a trava usa
  também a conta, a pessoa, o passo do fluxo e o instante fornecido pela
  Meta. A tolerância cobre arredondamento de até dois segundos. Um segundo
  toque para o mesmo passo nesse intervalo também é deduplicado.
- Não envia nada por conta própria: enfileira o mesmo job `process-postback`, e
  o caminho existente continua exigindo `is_user_follow_business === true`,
  cota, deduplicação e janela de mensagens.

Limites: digitar o título do botão também pode ser interpretado como um toque.
As mesmas regras de envio anterior, janela e confirmação de follow se aplicam.
Só a mensagem mais recente de cada conversa é lida, então um toque
seguido de outra mensagem da pessoa não é recuperado; a lista cobre as 50
conversas mais recentes na varredura completa. O tempo de entrega depende
da fila, da resposta da Meta e de qual varredura encontra o toque. O registro operacional
(`Button taps recovered from conversations`) guarda só a contagem.

O worker distingue limite de envio explícito (`FOLLOW_PROMPT_RATE_LIMITED`, com
retry), rejeição confirmada (`FOLLOW_PROMPT_PROVIDER_REJECTED`) e entrega
indeterminada (`FOLLOW_PROMPT_DELIVERY_UNCONFIRMED`, preservando a trava de
envio). Esses diagnósticos não incluem o texto original do provedor. O registro
de recuperação comprova o enfileiramento. Para confirmar a entrega do pedido
para seguir e do link, verifique a conversa no Instagram do destinatário de
teste.

Referência: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api

Em 27/11, a chamada de 50 prévias expirou enquanto a chamada de uma prévia
retornou a conversa e os cliques do teste. A varredura completa começa com
uma prévia, processa cada página conforme chega e cresce até oito conversas
por chamada. Um timeout reduz a página e repete o mesmo cursor enquanto houver
tempo no orçamento de 35 segundos por conta. O ciclo recente usa até 18
segundos por conta. Se outra página falhar, os jobs já gravados continuam na
fila. A Caixa de entrada mantém sua consulta usual.

## Campanhas que começam por DM

O gatilho **Só por DM** exige pelo menos uma palavra-chave e dispensa
publicação ou Reel. Pode começar com um botão de abertura. Se o seguidor já
for confirmado no clique, os links são liberados. Para quem ainda não segue,
o botão de confirmação faz a consulta antes de liberar os links.

Em contas Meta com esse gatilho ativo, o worker também verifica a mensagem
mais recente das conversas. Recupera mensagens de texto recebidas nos últimos
dez minutos e posteriores à ativação da campanha. Ignora mensagens da
própria conta, respostas a Stories, conteúdo não suportado e os rótulos dos
botões usados pela recuperação de cliques. A fila usa a mesma identidade de
mensagem do webhook e mantém as verificações de envio.

A primeira página é consultada no ciclo de 30 segundos, dentro da mesma
varredura e do mesmo cooldown de cliques por conta. O ciclo amplo dá cobertura
às páginas seguintes. Uma mensagem pode ficar fora da recuperação se deixar
de ser a mais recente da conversa ou se a Meta não a retornar a tempo.
O webhook continua sendo a entrada principal. O gatilho exclusivo exige um
horário de origem válido no evento para evitar responder a mensagens antigas.
A migração adiciona uma data de ativação opcional. Campanhas antigas não são
reclassificadas. Editar o texto de uma campanha ativa preserva essa data.

Limites de taxa: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
