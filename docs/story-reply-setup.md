# Configure text replies to one Story

In the campaign editor, choose **Text reply to a specific Story**, paste the
original HTTPS Instagram Story link, and enter the keywords and main DM.
The numeric Story ID is derived from the link. A new Story campaign starts
paused and can be activated after reviewing and confirming its configuration.

The editor uses the existing API contract: `postId`, `postUrl`,
`dmTriggerEnabled: true`, `matchAnyPost: false`, and `pendingNextReel: false`.
It does not create a new trigger enum, migration, or Graph API call. Public
comment replies and the comment-specific opening DM are disabled for this mode.
Opening an existing Story campaign recognizes its target and preserves the link.

Only text replies that Meta identifies as replies to that same Story can match.
Ordinary DMs and replies to a different Story remain outside this campaign.
Story mentions and message reactions are not supported by this editor.

Before activation, verify with an authorized real reply that Meta delivers
`message.reply_to.story.id` matching the original permalink ID, and confirm the
resulting DM. Local UI and unit tests do not prove webhook delivery or delivery
of a DM. App permissions, account eligibility, and webhook subscriptions still
apply; see `story-specific-replies.md`.

Rollback: revert this UI PR and redeploy after review. Existing campaigns keep
their API fields and continue to use the existing worker contract. No database
or provider configuration is changed.
