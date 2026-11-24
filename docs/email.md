# E-mail transacional e domínio

O CRIA PING envia e-mail pelo Resend, o mesmo provedor do link de login.

## Variáveis (Vercel)

| Variável | Uso |
| --- | --- |
| `RESEND_API_KEY` | Chave da API do Resend (já usada no login) |
| `EMAIL_FROM` | Remetente, no domínio verificado. Ex.: `CRIA PING <contato@pingchatbr.app>` |
| `EMAIL_REPLY_TO` | Para onde vão as respostas dos clientes. Ex.: `contato@pingchatbr.app` |
| `NEXTAUTH_URL` | URL pública do app. Precisa ser a do domínio próprio para os links de login e o e-mail de boas-vindas apontarem para ele |
| `OPERATOR_EMAILS` | Quem pode usar o envio geral (lista separada por vírgula) |

## O que é enviado

- **Link de login** (Auth.js + Resend).
- **Confirmação de conta criada**: uma vez, quando o usuário é criado. Se o envio
  falhar, o cadastro continua e o erro é registrado no log, sem o endereço.
- **Envio geral do operador**: em Diagnósticos, o cartão "Enviar e-mail para todas
  as contas" aparece só para quem está em `OPERATOR_EMAILS`. Vai um e-mail
  individual por titular com e-mail verificado; ninguém vê o endereço dos outros.
  Há confirmação obrigatória e intervalo mínimo de 10 minutos entre envios. Cada
  envio grava um evento operacional com contagens, sem endereços nem o texto.

API: `GET /api/admin/broadcast` (prévia do público) e `POST` com
`{ subject, message, confirm: "SEND" }`.

## Domínio

1. No Resend, adicione o domínio e copie os registros DNS que ele gerar (DKIM,
   SPF e MX do subdomínio de envio). O valor de DKIM é único por domínio.
2. Crie esses registros no DNS do domínio (Vercel) e aguarde a verificação.
3. Acrescente um registro DMARC (`_dmarc`, TXT).
4. Só então troque `EMAIL_FROM` para o endereço do domínio. Antes da verificação,
   o Resend recusa o envio.

Receber e-mail em `contato@…` é separado do envio: precisa de uma caixa postal ou
de um serviço de encaminhamento, com registros MX próprios na raiz do domínio.

## Cuidados

O envio geral serve para avisos de serviço aos titulares de conta. Para
comunicação promocional, a LGPD e as boas práticas pedem base legal adequada e
opção de descadastro, que este envio não oferece.

## Aviso de fim do teste grátis

Quando o teste de 72 horas termina sem plano pago, o envio de DMs passa a ser
recusado (`COMMERCIAL_ACCESS_DENIED`). O worker avisa o dono do workspace por
e-mail, uma única vez, com o link para `/billing`
(`lib/email/trial-ended.ts`, verificação a cada hora).

- Só roda com `BILLING_ENABLED=true` e com `RESEND_API_KEY`, `EMAIL_FROM` e
  `NEXTAUTH_URL` (ou `AUTH_URL`) **definidos no worker**. Sem eles, não faz nada.
  `EMAIL_REPLY_TO` é opcional.
- Considera testes encerrados nos últimos 3 dias, ainda `TRIALING` e sem
  `paidThrough`. Workspaces com licença vitalícia válida são ignorados, porque
  continuam com acesso.
- O controle de "já avisado" é um `OperationalEvent` com a mensagem
  `Trial ended notice sent`, sem o endereço de e-mail. Se o provedor recusar o
  envio, nada é gravado e a próxima rodada tenta de novo.
