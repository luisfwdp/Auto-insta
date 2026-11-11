# Story-specific reply keywords (Meta / Instagram)

A keyword-triggered DM campaign can target **one specific Story**, instead of
all direct messages, without changing the database schema.

Configure the existing campaign fields:
- `instagramAccountId`: connected Instagram account.
- `postId`: numeric Story ID from the original Instagram Story permalink.
- `postUrl`: full HTTPS permalink, for example
  `https://www.instagram.com/stories/username/4028147829863364233`.
- `dmTriggerEnabled: true`, `keywords: ["EU QUERO"]`, `isActive` only
  after an authorized human tests and approves the campaign.
- `dmMessage`: text and destination link.

On a `messages` webhook, the Meta payload includes
`message.reply_to.story.id` for text replies to Stories. The worker compares
this against the ID in the configured permalink and `postId`. A DM with no
Story ID, a reply to another Story, or a mismatched ID is **ignored**, even if
it contains the keyword. Existing general-DM campaigns are unchanged.
Story-scoped campaigns are also excluded from the comment-response path.

**Before activation:**
1. Confirm the account subscription to the `messages` webhook and its
   permissions. A connected account with `webhookSubscribed=false` needs
   operational verification.
2. Verify that the Story's permalink ID equals the ID Meta delivers in a
   real anonymized test webhook. If not, do not activate or guess a mapping.
3. Confirm the worker and Redis queue are healthy and within usage quotas.
4. Test a matching Story reply, a different Story reply, and a generic DM.
5. Avoid sending duplicate replies if another platform already owns the thread.

This uses official Meta webhook data only; it does not scrape Instagram.
Reference: https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api
