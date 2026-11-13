# Automações de Story: contrato proposto (Claude → Codex)

Status: **proposta**. Só os parsers existem (`lib/meta/webhook.ts`); nada é enviado ainda.

## O que a API oficial entrega

| Evento | Campo do webhook | Forma | Status |
| --- | --- | --- | --- |
| Resposta de texto a um Story | `messages` | `message.reply_to.story.id` | em produção (#55) |
| Menção em Story de outra pessoa | `messages` | `message.attachments[].type = "story_mention"` | parser `parseStoryMentionEvents` |
| Reação a mensagem | `message_reactions` | `messaging[].reaction {mid, action, reaction, emoji}` | parser `parseReactionEvents` |

Limites da Meta: a resposta por DM só é permitida dentro da janela de 24 h aberta pela
interação do usuário; reação rápida a Story (emoji) chega como mensagem/reação e não traz o
id do Story em todos os casos, então não dá para filtrar por Story específico com garantia.
Requer `instagram_manage_messages` e os campos `messages` e `message_reactions` assinados.

## Schema proposto (uma migração, aditiva)

```prisma
enum AutomationTrigger { COMMENT  DM_KEYWORD  STORY_REPLY  STORY_MENTION  REACTION }
model Automation { trigger AutomationTrigger @default(COMMENT) }
```

Campanhas existentes continuam `COMMENT`; `dmTriggerEnabled` e o permalink de Story seguem
valendo até a migração de dados (sem remoção de coluna).

## API

`POST/PATCH /api/automations` aceita `trigger`. Para `STORY_MENTION` e `REACTION`:
`keywords` é ignorado, `postId` proibido, `dmMessage` obrigatório, `publicReplyEnabled` falso.

## Worker

Novo job `process-story-event` com `jobId` determinístico
(`story_<conta>_<mid>`), uma DM por remetente por campanha a cada 24 h, registro em `DmLog`.

## Pendências antes de ativar

1. Aprovação humana da migração (AGENTS.md).
2. Payload real anonimizado de cada evento capturado em produção.
3. UI do Codex para escolher o gatilho.
