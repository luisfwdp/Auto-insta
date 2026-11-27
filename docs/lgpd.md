# LGPD no CRIA PING

Este documento descreve os controles técnicos de privacidade do produto. Ele não
é parecer jurídico: a política pública, as bases legais e os contratos com
clientes precisam de revisão de um profissional habilitado.

## Papéis

- **Cliente (workspace)**: controlador dos dados dos contatos que comentam ou
  enviam mensagens às contas Instagram conectadas.
- **CRIA PING**: operador desses dados, e controlador dos dados de cadastro e
  cobrança dos próprios clientes.

## Dados pessoais tratados

| Dado | Onde | Finalidade |
| --- | --- | --- |
| E-mail e nome do usuário | `User`, `Session`, `WorkspaceInvitation` | Autenticação e convites |
| ID, nome de usuário e texto do comentário do contato | `DmLog` | Enviar a resposta e evitar envio duplicado |
| Payload dos webhooks da Meta | `WebhookEvent` | Processar e diagnosticar entregas |
| Hash de IP, hash do destinatário, user agent e referrer | `LinkClick` | Contar cliques sem expor a identidade |
| Tokens da conta Instagram (cifrados) | `InstagramAccount` | Agir pela conta autorizada |
| Dados de cobrança | tabelas `Billing*` | Assinatura e pagamentos |

## Direitos do titular (art. 18)

`/api/workspace/contact-data`, restrito a OWNER e ADMIN do workspace da sessão:

- `GET ?commenterId=<id>` ou `?username=<usuario>`: devolve em JSON as interações,
  os cliques e a contagem de payloads guardados sobre o contato (acesso e
  portabilidade).
- `DELETE` com `{ "commenterId" | "username", "confirm": "ERASE" }`: anonimiza os
  registros de entrega (remove nome e texto, troca o ID por um marcador
  irreversível), limpa os identificadores dos cliques e apaga os payloads de
  webhook que citam o contato. O ID do comentário e o status são mantidos para
  que a pessoa não receba a mesma mensagem de novo.

Cada exclusão grava um evento operacional com quem pediu e quantos registros
foram afetados, sem o identificador do contato (art. 37).

A exclusão é irreversível. O workspace nunca é lido do cliente.

## Lacunas conhecidas

- Não há tela para essas ações; hoje são chamadas de API.
- Não há retenção automática de `WebhookEvent`, `DmLog` e `OperationalEvent`.
- Exclusão de conta e de workspace é feita por solicitação ao suporte.
- A política de privacidade pública está em português e informa o contato
  `contato@pingchatbr.app`, mas ainda não traz razão social, CNPJ nem o nome do
  encarregado. O texto não passou por revisão jurídica.
- Não há endpoint para o callback de exclusão de dados da Meta.
