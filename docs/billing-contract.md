# Card-free trial and Asaas transport contract

Explicit scope extension requested by the product owner: automatic billing through
Asaas and a **three-day trial without registering a card**, replacing the earlier
seven-day proposal. This is a backend foundation, not an enabled commercial release.

## Trial

`BILLING_ENABLED` defaults to disabled. When disabled, the new endpoints never query
the new tables. Existing self-hosted behavior remains unchanged.

- `GET /api/billing/status`: authenticated active-workspace status, with no provider
  identifiers, payment data or secrets. Response is `Cache-Control: no-store`.
- `POST /api/billing/trial`: trusted browser origin, authenticated workspace owner
  only. The workspace comes from the server context; request body identifiers are
  ignored. No card, CPF, Asaas customer, provider call or automatic charge is needed.
- Exactly 72 hours from the first owner redemption, stored atomically. Retries,
  concurrent requests, multiple workspaces and workspace replacement preserve the
  owner's original deadline. Database triggers also prevent rewriting either date.
  Different owners have independent redemptions; retries do not rewrite updatedAt.
- The DTO expires at the exact deadline. Canceling renewal retains an already paid
  period; suspension does not. Only a future canonical financial reconciler may
  update paid status; neither route can grant it.
- Both tables are server-only, have RLS enabled and revoke anonymous/browser grants.
  The additive migration must be reviewed and applied by a human, never an agent.

The status DTO is **not yet enforcement of access or quotas**. Before enabling
commercial signup, integrate entitlement checks at HTTP, MCP and actual worker
side effects, with rate limits and trial quotas. Without explicit subscription,
expiry must never charge the user. Preserve data and allow billing, cancellation,
disconnection and history access after expiry. A new verified user can still
attempt another trial; card-free signup requires abuse monitoring and bounded use.

## Provider adapter (server-only, not exposed as a checkout endpoint)

Configuration names: `ASAAS_ENVIRONMENT` (`sandbox` or `production`),
`ASAAS_API_KEY`, canonical `NEXTAUTH_URL`/`AUTH_URL`, and a **distinct**
`ASAAS_WEBHOOK_TOKEN`. Keep secret values in the platform's secret manager.
Never send them through chat, logs, client bundles or build arguments.

The transport fixes Asaas API/payer hosts by environment, refuses redirects,
bounds responses to 64 KiB, uses a ten-second timeout and returns minimal DTOs.
Amounts use integer cents; a future checkout route must use a server-side catalog,
never a browser-supplied price. Recurrence is monthly; `nextDueDate` is a date.
Hosted Asaas collects payment details; this app does not store card data.

POST has no automatic retry: network/5xx/malformed success means
`UNKNOWN_OUTCOME`, not a safe invitation to create another subscription. GET
failures use distinct error codes. Paginated reads return one bounded page and
explicit `hasMore`; consumers must not silently truncate financial reconciliation.
Provider errors and unknown fields are excluded from DTOs. Webhook authentication
uses `asaas-access-token` and timing-safe digest comparison, never the API key.
Reads accept at most 20 items per page to leave room for provider-only fields
within the 64 KiB response budget. Actual sandbox sizes still need validation.
POST HTTP 408/409 remain unknown outcomes and must not trigger a blind retry.

Before exposing checkout, implement durable intent **before** POST, unique
environment/account-scoped event inbox, reconciliation/outbox with recovery,
canonical checkout-to-payment-to-subscription linkage, and a financial ledger.
Duplicate CONFIRMED/RECEIVED events must not extend a period twice; stale overdue
events must not revoke a newer paid period. A callback, CHECKOUT_PAID, or an ACTIVE
subscription by itself must not grant paid access. Test unknown outcomes, crashes,
out-of-order events, tenant boundaries and real sandbox payments/refunds.

## Validation and rollout

Local PostgreSQL tests cover concurrency, immutable deadlines, workspace isolation,
roles, Origin, exact expiry, paid cancellation and RLS. Adapter tests use fictitious
payloads and mocked fetch; they do not prove a real checkout/payment.

No production migration, credentials, payment, resource purchase, or UI change is
part of this contract. Keep the flag disabled. Per AGENTS.md, the backend contract
needs Claude Code/Codex review and specific human schema approval/merge before its
UI integration. Integrate the existing security release first (#96, then #95).
This branch is based on #96; do not merge it before that dependency.

Rollback: disable the flag and revert the contract consumers while preserving the
additive tables and trial deadlines. Do not drop trial records or reset expired
trials during rollback. No destructive down migration is supplied.

## Official provider references

- [Create checkout](https://docs.asaas.com/reference/criar-novo-checkout)
- [Recurring checkout](https://docs.asaas.com/docs/checkout-com-assinatura-recorrente)
- [Hosted checkout URL](https://docs.asaas.com/docs/link-do-checkout-e-redirecionamento-do-cliente)
- [Payment list/filter](https://docs.asaas.com/reference/listar-cobrancas)
- [Payment retrieval](https://docs.asaas.com/reference/recuperar-uma-unica-cobranca)
- [Subscription retrieval](https://docs.asaas.com/reference/recuperar-uma-unica-assinatura)
- [Checkout webhooks](https://docs.asaas.com/docs/eventos-para-checkout)
- [Retries and idempotency](https://docs.asaas.com/docs/retries-e-idempot%C3%AAncia)
