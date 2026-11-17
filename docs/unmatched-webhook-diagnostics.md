# Signed webhooks with unmatched accounts

The callback checks the provider signature before processing. The processor then
matches `entry.id` against stored `InstagramAccount.instagramId` values for that
provider (and the authorized workspace for Zernio). Only matched entries enter
tenant webhook history and the DM queue. These protections remain unchanged.

Therefore, zero persisted message events does **not** prove that no message
reached the callback. A signed event with an unknown ID was previously discarded
before persistence. An account-ID mismatch is one possible explanation, not a
confirmed production cause.

Unmatched entries now produce a best-effort `SYSTEM` warning with no workspace,
visible only to instance operators through existing diagnostic access. The
payload contains provider, counts, fixed event-type counters, and at most five
SHA-256 entry-ID hashes. It contains no message/comment content, sender or
recipient IDs, raw account IDs, URLs, tokens, or provider-supplied field names.
These unsalted hashes are pseudonymization, not anonymization: someone who knows
an account ID can compute its hash and correlate the sampled diagnostic.

The fixed two-provider budget records at most one warning per provider per
minute **per process instance**, reserving the slot before awaiting persistence.
Restarts and multiple instances have separate budgets. The warning is sampled,
not a complete delivery ledger. Diagnostic failure does not interrupt matched
delivery and does not immediately retry logging.
Hashing, event-type counting and persistence are all best-effort: malformed
unmatched entries cannot interrupt delivery of otherwise valid matched entries.
Known-account events are persisted, enqueued and marked processed before the
diagnostic write. The request still awaits diagnostics; no detached promise is
left behind. The short diagnostic transaction uses acquisition `maxWait` 250 ms,
transaction timeout 1500 ms, PostgreSQL `statement_timeout` 1000 ms and
`lock_timeout` 250 ms, scoped locally to that transaction. PostgreSQL cancels a
blocked diagnostic statement and rolls back the transaction, releasing its
connection instead of letting a JavaScript timeout abandon an active query.
The sample is dropped on failure and its per-provider minute budget stays spent.
The native PostgreSQL regression holds an exclusive diagnostic-table lock until
after the request finishes, cancels a five-second insert trigger, and exercises
a busy one-connection pool. It verifies that the connection is reusable afterward,
transaction-local timeouts are restored, and no diagnostic lock wait or aborted
transaction remains. Run `unmatched-webhook-timeout.db.test.ts` with a disposable
`TEST_DATABASE_URL`; mocks do not establish PostgreSQL cancellation behavior.

Compare a known account's locally computed entry-ID hash with the warning to
investigate routing. Do not substitute sender IGSIDs for connected account IDs
or relax tenant/account filtering to make a webhook match. Meta's documentation
distinguishes the professional IG User from Instagram-scoped messaging users:

- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/
- https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram/
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-instagram/

No new Graph API calls or schema changes. Rollback: revert the code commit and
redeploy the previously approved web application. No data rollback or migration
is required. Unit tests demonstrate filtering and sampling; a real signed Meta
delivery is still required to establish the production cause.

## Webhooks assinados com outro objeto

Um webhook com assinatura válida cujo `object` não é `instagram` (ou sem lista
`entry`) continua sendo ignorado pelas automações, mas passa a gerar o evento
operacional `Signed webhook ignored: unsupported object or shape`, no máximo um
por minuto por provedor e por processo. O evento guarda só o nome do objeto
(quando é um dos objetos documentados pela Meta; senão `other`), se havia lista
`entry` e quantas entradas vieram. Nenhum ID, remetente ou texto é gravado.

Um diagnóstico persistido é evidência positiva de que uma requisição alcançou
esse caminho. A ausência de registro não comprova ausência de callback: os
registros são amostrados, a gravação pode falhar ou expirar, e payloads sem eventos
podem não produzir registro. Uma assinatura inválida segue o diagnóstico de
rejeição separado, também limitado; não é uma requisição assinada validada.

Para investigar não chegada, correlacione access logs HTTP da Vercel, request ID,
janela de tempo e status com os diagnósticos persistidos. Testes unitários e uma
amostra ausente não estabelecem a causa de uma DM não entregue.
