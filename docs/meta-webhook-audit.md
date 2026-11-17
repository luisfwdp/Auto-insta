# Auditoria de assinaturas de webhook da Meta

O worker registra, 30 segundos após iniciar e depois a cada 24 horas, um evento
operacional `Meta webhook subscription audit` para cada conta oficial (`META`).
O objetivo é transformar "comentários chegam, mensagens não" em evidência por
etapa, em vez de hipótese.

## O que é lido

| Etapa | Fonte | Campo no evento |
| --- | --- | --- |
| Assinatura efetiva da conta | `GET /{ig-user-id}/subscribed_apps` | `subscribedFields`, `missingFields` |
| Permissões concedidas ao token | `GET /me/permissions` (somente `graph.facebook.com`) | `grantedPermissions` |
| Eventos que o callback persistiu em 7 dias | tabela `WebhookEvent` (contagens) | `receivedLast7Days` |
| Erro da Meta ao ler a assinatura | resposta da Graph API, sem query string | `subscriptionError` |

A leitura de `subscribed_apps` consta do schema oficial do IG User
([SDK oficial](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/iguser.py),
`get_subscribed_apps`) e do
[guia de configuração de webhooks](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup).

O nível é `WARNING` quando `comments` ou `messages` não estão na assinatura
efetiva, ou quando a leitura falha; caso contrário, `INFO`.

## O que a auditoria não faz

- Não altera nada na Meta: só requisições `GET`. Reassinar uma conta continua
  sendo feito pela reconexão.
- Não grava token, remetente, texto de mensagem nem payload de webhook.
- Não prova entrega. `messages` assinado com `messaging: 0` significa que a
  falha está depois da assinatura (emissão ou entrega pela Meta, ou descarte por
  conta não reconhecida, que o registro de entradas não reconhecidas mostra).

## Como ler o resultado

1. `subscriptionError` preenchido: o token não consegue ler a assinatura.
   Verifique validade do token e permissões antes de qualquer outra etapa.
2. `missingFields` contém `messages`: a conta não está assinada para mensagens.
   Reconecte a conta e rode a auditoria de novo (reinício do worker).
3. `grantedPermissions` sem `instagram_manage_messages`: o login não concedeu a
   permissão; revise a configuração de login e reconecte.
4. Tudo presente e `messaging: 0` após uma DM de teste: a causa é externa ao
   código (nível de acesso do app, modo do app, ou "Permitir acesso às
   mensagens" na conta). Consulte o evento de entradas não reconhecidas para
   descartar roteamento.

## Rollback

Sem schema nem migração. Reverter o commit e reimplantar o worker remove a
auditoria; os eventos já gravados permanecem como histórico.
