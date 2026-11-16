# Instagram account subscriptions for interactive DMs

The IG User subscription made during Instagram Login or Unified Login now
requests `comments`, `messages`, `messaging_postbacks`, and `messaging_seen`.
The last two are required by the existing opening-DM flow: button taps queue
the reveal response, and read notifications queue its five-minute fallback.

Meta lists those two event types in the [Instagram webhook reference](https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram/).
Its [official SDK IG User schema](https://github.com/meta/facebook-python-business-sdk/blob/main/facebook_business/adobjects/iguser.py)
includes both in `IGUser.SubscribedFields` and uses that enum for
`create_subscribed_apps`, a `POST /{ig-user-id}/subscribed_apps` operation.

The account endpoint is `graph.instagram.com` with Instagram Login and
`graph.facebook.com` with Unified Login. App-level Instagram subscriptions must
also contain the fields; account subscription does not replace app setup, token
permissions, app access approval, or account eligibility.

Facebook Login's Page setup remains a separate operation:
`POST graph.facebook.com/{page-id}/subscribed_apps` with Page fields
`feed,messages`. Do not copy Instagram's `messaging_seen` into that request. The
[Page endpoint reference](https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/)
uses a different field enum and warns that its fields do not configure Instagram
webhook subscriptions.

## Existing connections and verification

Deployment changes future connection/reconnection requests; it does not alter
existing subscriptions. After approval and deployment, reconnect each authorized
Instagram/Unified account, or have an authorized operator update its IG User
subscription with the complete field set. Read back `/{ig-user-id}/subscribed_apps`
to confirm the effective fields without logging tokens. Meta rejection is
propagated; there is no silent fallback to a reduced field list.

Then verify an authorized opening-DM button tap reaches the callback as a
postback and that the reveal DM arrives. Independently verify a read receipt and
the fallback while respecting the messaging window. Unit tests with anonymous
responses establish request shape, not real delivery.

The missing interactive fields do **not** explain the separate missing inbound
DM incident: `messages` was already subscribed. Its delivery cause remains under
investigation and must be established from actual callback/Meta evidence.

## Rollback

No schema or data migration. Revert the code commit and redeploy the approved
previous application if necessary. Subscription fields on previously reconnected
accounts remain on Meta; do not remove them automatically. Any account-side
rollback requires an authorized operator and must preserve required app fields.
Meta integration changes require Claude Code and human review under `AGENTS.md`.
