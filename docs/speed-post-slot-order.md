# Speed Post: chronological daily slots

Fixed daily slots are applied in chronological local-time order before assigning
the selected media sequence. For example, increasing five default daily posts to
six used to append `15:15` after `21:00`; item 6 then published before items 4
and 5. The new defaults, calendar preview, and server scheduling use the same
canonical ordering. User-edited slots are also sorted for scheduling without
changing the selected media order or mutating the submitted array.

This applies to newly created fixed schedules. Existing publications retain their
stored dates. Explicit custom dates remain attached to their chosen media item.
There is no database migration or rewrite of running batches.

Regression tests cover a manually ordered 100-media batch at six daily posts and
unsorted edited slots across multiple local days in `America/Sao_Paulo`.
They validate scheduling only; a real authorized batch still needs Meta delivery
confirmation.

Rollback: revert this PR and redeploy the web app after the required reviews.
Existing stored schedules and media remain intact in either direction.
