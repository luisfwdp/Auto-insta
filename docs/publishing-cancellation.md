# Publishing cancellation claim

The publishing worker must claim a publication before contacting Meta. A Speed
Post cancellation can change a queued publication to `CANCELLED` after the worker
loads it but before its conditional `PROCESSING` update. When that update affects
no row, the worker stops without creating containers or publishing media.

Cancellation does not recall a publication that has already entered `PROCESSING`.
An external publish request that Meta has accepted cannot be undone by cancelling
the batch. This change preserves the existing behavior for work already in flight.

Validation: the worker regression simulates a cancellation winning the claim and
asserts that no Instagram context, permission, quota, container, or publish call is
made. This is a unit regression; it does not establish real Meta delivery.

Deployment requires the worker review and human approval required by `AGENTS.md`.
No schema or production data changes are needed. Rollback: revert the code commit
and redeploy the prior approved worker image; no data rollback is required.
