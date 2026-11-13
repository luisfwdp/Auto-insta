# CRIA PING — matriz de finalização

Atualizada em 13 de novembro de 2026. Esta matriz separa código existente,
alterações ainda em pull request e comprovação real. CI verde ou teste com mock
não substitui um evento recebido da Meta nem uma publicação confirmada no
Instagram.

| Módulo | Comprovado na `main` | Pronto em PR | Prova ainda necessária | Estado |
| --- | --- | --- | --- | --- |
| Comentários | Webhook assinado, reconciliação, fila BullMQ, deduplicação, retries, escopo por workspace, resposta pública e DM | #65, #70, #74 | Comentário de conta externa → webhook → fila → resposta/DM com permissões avançadas | Parcial: código pronto; prova externa pendente |
| Stories | Parser de resposta textual com `reply_to.story`, filtro por Story e campanha `93cd0b51-2a28-49cf-ab48-607fbcded338` corrigida para o Story `4028147829863364233` | #70 testa pipeline; #71 adiciona parsers conservadores de menção e reação, sem envio | Payload real de resposta/menção/reação e DM confirmada na Meta | Bloqueado por App Review/permissões |
| Programação | Storage privado, upload assinado, validação de mídia, publicação imediata/agendada, carrossel/Reel, cancelamento, histórico e worker | #67 calendário/reagendamento; #68 recuperação idempotente; #69 escopo de publicação | Upload autorizado → agendamento → publicação real confirmada no Instagram | Parcial: integração real pendente |
| Speed Post | Lotes de até 100 vídeos, ordem, legenda padrão/individual, fuso, pausa, retomada, cancelamento e retries | #66 alinha prévia/ordem e impede horários duplicados; #72 esclarece falha de Trial Reel | Lote autorizado executado em sequência, sem duplicação, incluindo recuperação de falha | Parcial: integração real pendente |
| Contas Meta | Facebook/Unified/Instagram Login, múltiplas contas, seleção de ativos, tokens AES-256-GCM e assinatura de webhooks | #69 escopo de publicação; #77 alertas de expiração | Verificação empresarial, App Review aprovado, reconexão e evento externo | Bloqueado pela Meta |
| Infraestrutura | Vercel, Supabase, Redis/BullMQ, worker Fly.io, heartbeat e canário; produção saudável no SHA `cae0a74` | #73 remove ruído do parser Redis; #75 monitora fila de publicação; #78 atualiza Actions para Node 24 | Mesclar, redeployar e confirmar ambas as filas em produção | Pronto para merge humano |
| Interface | Dashboard, contas, campanhas, inbox, relatórios, Programação, Speed Post, estados de loading/erro/vazio e pt-BR | #66, #67, #72, #77 | Inspeção responsiva final após deploy consolidado | Parcial |
| Segurança | PR #49 mesclado (`63db027`), RBAC, tokens criptografados, webhook assinado, isolamento de tenant e headers de segurança | #65 CSRF sem Origin; #74 rate limit/auditoria de DM; #76 zera advisories npm de produção | Merge humano e nova auditoria sobre a `main` consolidada | Pronto para merge humano |

## Evidências atuais

- `main`: `cae0a74607fc841b300335a2d06ffc4aaca4cc3b`.
- Produção Vercel: deploy `READY` desse SHA.
- Saúde: banco OK, Redis `PONG`, fila de DM sem backlog e worker saudável.
- Supabase: projeto saudável; bucket privado `instagram-publishing`, limite de
  300 MB e MIME types restritos.
- Suite da `main` antes da fila de PRs: typecheck, lint, 552 testes aprovados,
  41 skips preexistentes e build de 72 rotas.
- `npm audit --omit=dev`: zero vulnerabilidades no PR #76.
- PRs #65–#78: CI verde e marcados como prontos para revisão.
- Webhooks armazenados nos sete dias auditados: comentários, menções e
  `story_insights`; nenhum evento `messaging`/`reply_to.story` externo foi
  recebido. Portanto, a falha da campanha de Story ocorreu antes da fila.

## Bloqueios externos confirmados

1. A verificação empresarial da Meta está com envio pendente.
2. As permissões de mensagens, comentários e publicação estão “Pronto para
   teste”, sem acesso avançado aprovado.
3. Depois da aprovação, as contas precisam ser reconectadas para receber os
   novos grants.
4. O `AGENTS.md` exige que o merge final seja executado por uma pessoa.

## Critério para mudar um módulo para concluído

O módulo só muda para **concluído** quando o código está na `main`, o deploy de
produção contém o SHA, os checks estão verdes e o fluxo real autorizado foi
confirmado no serviço externo. Falhas ou limitações oficiais da Meta devem ser
mostradas ao usuário; nunca serão substituídas por fallback silencioso.
