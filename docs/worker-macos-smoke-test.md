# Worker no macOS: smoke test

Procedimento reproduzível para homologar o worker instalado com
`scripts/worker/install-macos-launchagent.sh`. Status: **ainda não executado**
(nenhum Mac acessível às sessões de agente).

## Como a saúde é medida

`GET /api/health` → `checks.worker`:

| Campo | Significa |
| --- | --- |
| `heartbeat` (`health:worker:dm`, TTL 120 s) | processo vivo, Redis acessível e consumidor BullMQ pronto (`waitUntilReady`/`ready`; some em `error`/`closed`) |
| `consumer.state = processing` | um job de diagnóstico `worker-canary` foi **processado** há ≤ 180 s |
| `healthy` | as duas condições acima |

O canary é enfileirado a cada heartbeat (30 s) com `jobId` fixo, uma tentativa e
sem retenção: nunca há mais de um na fila. Processá-lo só grava
`health:worker:canary`; não consulta o banco nem chama a Meta.

## Passos

1. Instalar: `scripts/worker/install-macos-launchagent.sh` (com `.env.worker` preenchido, modo 600).
2. Bootstrap: `launchctl print gui/$(id -u)/com.pingchat.worker | grep state` → `running`.
3. Em até ~60 s, `/api/health` mostra `worker.healthy: true` e `consumer.state: processing`.
4. Encerramento forçado: `launchctl kill SIGKILL gui/$(id -u)/com.pingchat.worker`.
   Em ~10 s (`ThrottleInterval`) o `pid` muda em `launchctl print`; em até ~30 s
   `heartbeat.startedAt` é novo e `consumer.lastProcessedAt` avança.
5. Consumidor parado com Redis no ar: `launchctl kill SIGSTOP gui/$(id -u)/com.pingchat.worker`.
   Em até 180 s `/api/health` responde 503 com `consumer.state: stalled` (o heartbeat
   também expira em 120 s). Depois: `launchctl kill SIGCONT …` e confirmar a volta para 200.
6. Encerrar: `launchctl bootout gui/$(id -u)/com.pingchat.worker` → 503 em até 180 s.

Registrar no PR #40 os horários e as respostas de `/api/health` de cada passo.
