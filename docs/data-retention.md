# Retenção de dados

O worker aplica a política de retenção um minuto após iniciar e depois a cada
24 horas. **Ela vem desligada**: nada é apagado enquanto nenhuma das variáveis
abaixo estiver definida no ambiente do worker (Fly).

| Variável | Efeito | O que é preservado |
| --- | --- | --- |
| `RETENTION_WEBHOOK_EVENTS_DAYS` | Apaga payloads de webhook mais antigos que N dias | Payloads ainda `PENDING` |
| `RETENTION_OPERATIONAL_EVENTS_DAYS` | Apaga eventos operacionais mais antigos que N dias | — |
| `RETENTION_CONTACT_TEXT_DAYS` | Remove o texto do comentário e o nome do contato dos registros de entrega mais antigos que N dias | A linha, o ID do comentário e o status (histórico e deduplicação) |

Regras de segurança:

- O valor precisa ser um inteiro de pelo menos 7. Valor ausente, inválido ou
  menor desliga aquela classe, em vez de apagar.
- Cada classe é independente.
- Quando algo é removido, um evento `Data retention applied` registra as
  contagens e os prazos usados.

A exclusão é irreversível. Antes de ligar em produção, defina os prazos com quem
responde pela política de privacidade e confirme que o backup do banco cobre o
período que você quer poder recuperar.

Rollback: remova as variáveis (ou reverta o commit) e reinicie o worker. Dados já
apagados não voltam.
