# Commercial mode and the new-sales circuit

`BILLING_ENABLED` controls commercial mode and its entitlement enforcement.
`BILLING_SALES_ENABLED` is a separate circuit for starting new checkouts and
publishing the offers catalog. Closing sales must not disable payment recovery,
cancel requests, status reads or already paid access.

| BILLING_ENABLED | BILLING_SALES_ENABLED | New sales |
| --- | --- | --- |
| absent, false or invalid | any | disabled; legacy self-hosted behavior |
| true | absent | enabled, preserving the existing commercial default |
| true | true | enabled |
| true | false, empty or invalid | paused |

Values accept surrounding whitespace and case-insensitive `true`/`false`.
`1`, `yes`, empty strings and other values are not affirmative consent. An absent
sales flag means an undefined environment variable, not a configured empty value.

## Pausing sales

Keep `BILLING_ENABLED=true` and set `BILLING_SALES_ENABLED=false`. Do not switch
off commercial enforcement just to stop new customer purchases: that would select
the legacy self-hosted mode rather than preserve commercial access checks.

- Checkout POST returns `503 BILLING_SALES_DISABLED` before configuration,
  database intent creation or provider calls. This includes idempotent POST
  retries; the scoped GET remains available to read an existing checkout.
- The public plans endpoint returns `404 BILLING_SALES_DISABLED`, with no offers.
- Existing checkout GET, billing status, paid/trial access and the cancellation
  outbox retain their existing commercial guards. They do not consult the sales
  flag. Webhook ingestion, reconciliation and worker maintenance also continue.
- Trial enrollment keeps its existing commercial-mode rules; the sales circuit
  does not reset, extend or terminate any free trial.
- Existing Asaas links may still be completed, and existing subscriptions may
  continue renewing. Pausing new sales is not a cancellation or refund operation.
- Tenant isolation, owner authorization, Origin checks and `no-store` responses
  are unchanged.

With commercial mode disabled, the existing `404 BILLING_DISABLED` contract is
preserved for checkout and plans. Cancellation during rollback still follows the
existing provider-scope rules; this circuit does not remove that protection.

## Rollout

This change does not modify any deployed environment, start billing, purchase a
resource or authorize a charge. Set the sales circuit explicitly to false while
commercial enforcement is being validated. Only reopen it after the approved
backend, UI, sandbox/production payment checks and required human approvals.
Keep the commercial flag on when pausing or rolling back only the sales surface.

Unit coverage in `billing-sales.test.ts` checks the environment matrix, rejection
before provider/DB work, existing checkout reads, paid status and cancellation
route availability while sales are paused. These mocks do not prove real Asaas
payments or production entitlement enforcement.
