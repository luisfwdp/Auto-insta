# Asaas financial backend — activation remains gated

F10 commercial extension requested by the product owner. Offers are BRL79/149/299
per month in the immutable server catalog. The free trial remains72 hours without
a card or an Asaas customer. This backend is not a completed public launch.

## Contracts

- `GET /api/billing/plans`: offers/quotas only when sales are enabled; no DB/provider call.
- `POST /api/billing/checkout`: OWNER, trusted explicit Origin, bounded4KiB JSON.
  Fields: requestId(UUID), planId(versioned catalog ID), expectedAmountCents,
  acceptImmediateCharge:true. The amount is an acknowledgement checked against the
  server catalog, never an authoritative browser price. An optional early purchase
  needs clear UI consent for an immediate first charge; it must not be required to
  use the card-free trial. A mere checkout never ends the free trial or grants paid access.
- `GET /api/billing/checkout?id=UUID`: OWNER and server workspace, minimal no-store DTO.
- `POST /api/billing/cancel`: OWNER/Origin, requestId only. Stores a cancellation
  command before any provider DELETE; responds pending, not a false confirmation.
  `GET` with its id reads the owner's command state. Cancellation remains available
  when sales are disabled and the provider scope is configured.
- `GET /api/billing/status`: public session-safe DTO for the current workspace.
  Cancellation remains visible during sales rollback. Paid access cannot be reported
  from a different workspace/environment/account or without a configured scope.
- `POST /api/billing/webhook`: distinct configured token authenticated before
  reading64KiB/10s body, minimal ID inbox committed before200, including during rollback.

All browser responses use no-store; unexpected provider/DB errors are redacted.
No card/CPF/email/raw payer payload is stored in the financial inbox or ledger.
Hosted checkout links are encrypted at rest using existing AES-GCM. Provider URLs
are accepted only on exact HTTPS origins for their environment, preserving the
provider's full path/query after the September2026 URL changes.

## Financial invariants

1. Commit the immutable intent before the single checkout POST. One active intent
   per workspace/provider scope. Concurrent request keys reuse it. Network/5xx/
   408/409/invalid success/interrupted persistence means UNKNOWN, never an automatic
   new POST. A lost response without an ID requires operator reconciliation against
   the Asaas dashboard/externalReference; never guess a tenant by email or amount.
   A known OPEN link may expire after its60-minute validity plus5-minute grace if
   two complete canonical reads find no invoice and the inbox has no payment/paid
   evidence. UNKNOWN is never released by a timer. An explicit attempt can refresh
   an expired OPEN link first; a replacement still requires a separate request.
   Owner-triggered canonical refresh is limited by a dedicated CAS timestamp to
   once every5 minutes, including failed reads; it does not move the recovery cursor.
2. Inbox IDs are unique per environment/account/event. Duplicate conflicts do not
   overwrite the first event. Recoverable CAS leases, bounded retries and durable
   DEAD states protect crashes. Arrival order/callback URLs are not financial proof.
   The Asaas account, and therefore its account-wide webhook, is shared with other
   products of the same owner. An unbound provider event (PAYMENT_/SUBSCRIPTION_/
   CHECKOUT_) is retried as `RESOURCE_NOT_BOUND`, because our own webhook can arrive
   before the provider checkout ID is saved. It is finished as PROCESSED with the
   fixed code `FOREIGN_RESOURCE` (never DEAD, no alert) only when all hold: it has
   been in the inbox for at least 5 minutes; no scoped CREATING/UNKNOWN intent
   without a provider checkout ID was created before it (5-minute clock margin);
   and afterwards no local checkout/subscription/payment matches any key from the
   webhook payload or the canonical GET. Since the intent is committed before the
   only POST (invariant 1), our own early event always meets a local row and keeps
   retrying. The unresolved-intent query precedes the key re-check so an ID saved
   in between is still seen. INTERNAL_ recovery events are never classified foreign.
   An unresolved UNKNOWN intent therefore keeps unbound events on the retry/DEAD
   path until an operator reconciles it. The ownership lookup reads only the link
   IDs of a payment/subscription (still strictly validated), so another product's
   valid resource with a status/value our financial schema rejects is not stuck in
   `INVALID_RESPONSE`. Our own resources are always re-read with the strict schema
   before any decision and still fail closed. FOREIGN_RESOURCE only skips a trigger; it
   writes no ledger/access state, and every CRIA PING decision is still rebuilt from
   complete canonical reads by its own events and recovery. No schema change.
3. Resolve checkout→payment→subscription through canonical scoped Asaas GETs.
   Match customer/value/monthly cycle and the immutable server quote. Two complete
   passes must agree: totals, offsets, hasMore, IDs and snapshots cannot silently
   drift. An ACTIVE or currently paid non-current subscription raises a review
   error instead of silently leaving an uncancellable extra renewal.
4. Fetch canonical data outside transactions under a workspace lease, then verify
   ownership/expiry again under a row lock before atomic ledger/access changes.
   Renew only live workspace/inbox leases between requests; an expired or stolen
   claim must never be revived, even if the provider eventually returns success.
   An expired worker cannot overwrite a newer decision. Foreign keys also enforce
   workspace/environment/account links; SQL snapshots cannot be silently rewritten.
5. Only canonical CONFIRMED/RECEIVED invoice periods grant paid access. Monthly
   calendar boundaries use São Paulo and the original due-day (including February
   clamping), never rolling30-day extensions or duplicate-event counts. Future
   periods across unpaid gaps do not grant early access. Provider anchor behavior
   still needs a real Sandbox check before enabling sales.
6. Old refunds/overdues cannot revoke a newer paid invoice/subscription. The current
   refund removes its period. Suspension is preserved. Subscription ACTIVE and
   CHECKOUT_PAID alone cannot establish settlement.
7. Cancel renewal by the already bound subscription/customer, including an inactive
   subscription whose pending invoices still need removal. Canonical GET precedes
   idempotent DELETE retries. Preserve paidThrough and an unexpired card-free
   trial. Unknown DELETE outcomes are
   reconciled after backoff, never called a successful cancellation prematurely.

## Worker and operations

The existing worker starts bounded financial maintenance only with a valid scope;
unconfigured self-hosted deployments do not query new tables or create timers.
One tick runs at a time; crash leases recover after180s. Inbox work is claimed one
event at a time so a slow earlier read does not waste a later event's attempt.
It classifies interrupted
creations, processes cancellation outbox and inbox, and enqueues sparse recovery
GETs no more often than6h per resource. A separate CAS cursor advances atomically
with the event so failing rows cannot monopolize the sweep. Each tick queues at
most2 subscriptions plus1 checkout, below the drain budget of5 inbox events.
Only ACTIVE subscriptions or a current paid period are revisited; closed expired
records stop polling, and UNKNOWN older than7 days remains operator-gated.
It never creates replacement checkouts. Provider IDs/payloads and error
messages are excluded from telemetry; only counters and fixed error codes appear.
Scoped DEAD event/command counts produce the deduplicated fixed
`BILLING_DEAD_LETTER` alert while other jobs continue. A backlog of only DEAD work
is not reported as a successful activity summary; recovery clears the alert state.

Foreign events of other products sharing the account are visible as
`status = PROCESSED, lastErrorCode = FOREIGN_RESOURCE` and count as processed in
the summary; they need no action. DEAD events/commands require operator review. Inspect their fixed error code and
the matching provider account, invoice and local immutable intent; do not reset
UNKNOWN or replay a financial POST just to clear the queue. Preserve records.
Do not delete a workspace with financial history; the restrictive foreign keys
require a reviewed retention/cancellation process rather than silently erasing invoices.

## Environment and safe validation

Keep sales off (`BILLING_ENABLED` absent/false) until all launch gates pass.
After human schema approval, a human applies the additive migration in its approved
database. An agent never migrates production. Configure the same provider scope on
Vercel and the worker: ASAAS_ENVIRONMENT, ASAAS_ACCOUNT_SCOPE(stable UUID per account),
ASAAS_API_KEY and distinct ASAAS_WEBHOOK_TOKEN, through their secret managers.
The web checkout also needs a canonical NEXTAUTH_URL/AUTH_URL; GET/DELETE worker
maintenance validates no callback URL and does not require it.
Rotating an API key must preserve account scope. Never put secret values in chat,
PRs, logs, build args or screenshots. Production Vercel/the existing production
Fly app rejects Sandbox scope; Sandbox uses a disposable/local or approved staging DB.

For a read-only local authentication/filter check, put a Sandbox-only key in ignored
`.env.asaas-sandbox.local`, mode0600, with ASAAS_ENVIRONMENT=sandbox. Then use Node24:

```sh
npx tsx scripts/billing/sandbox-preflight.ts
```

The preflight parses only an allowlist, does not load DATABASE_URL/NODE_OPTIONS,
queries a fresh nonexistent checkout ID, prints only success booleans/error codes,
and creates no customer, checkout, subscription or charge. It does not prove a
payment, callback delivery or end-user contracting flow.

Still required: real Sandbox checkout/payment/refund/cancellation/webhook delivery,
approval/CI on the final composition, enforcement of all advertised quotas in
HTTP/MCP/worker side effects, and the UI after the backend contract is human-merged.
Sandbox must include payment across São Paulo midnight and monthly anchors29,30,31.
Confirm first dueDate and invoice amount against the immutable quote; no unverified
one-day tolerance is introduced to hide a provider mismatch.
Also prove that a payment cannot newly complete after the configured checkout TTL
and measure checkout-index/webhook lag before accepting the5-minute expiry grace
for live owner-triggered replacement. Late contradictory payments remain an
operator/DLQ case requiring provider-side review/refund, not a silent second plan.
Catalog quotas alone do not enforce usage. No production charge or deployment is
part of these local tests; mocks are not real financial proof.

Rollback sales/UI while retaining ingestion, cancellation, maintenance, secrets and
financial records. Do not roll a paid installation back to a worker without billing
maintenance indefinitely; preserve cancellation processing or carry out a reviewed
provider-side operational plan. Never drop financial/trial tables to roll back.

## Official references

- [Checkout and callbacks](https://docs.asaas.com/reference/criar-novo-checkout)
- [Recurring checkout](https://docs.asaas.com/docs/checkout-com-assinatura-recorrente)
- [Payment filters](https://docs.asaas.com/reference/listar-cobrancas)
- [Remove subscription](https://docs.asaas.com/reference/remover-assinatura)
- [Webhook idempotence](https://docs.asaas.com/docs/how-to-implement-idempotence-in-webhooks)
- [Provider URL changes](https://docs.asaas.com/changelog/altera%C3%A7%C3%A3o-na-estrutura-de-urls-p%C3%BAblicas-do-asaas)
