# Security policy

## Supported version

Only the latest version on the default branch is supported.

## Reporting a vulnerability

Because this is a private repository, report security issues directly to the repository owner. Do not include:

- Discord authorization tokens.
- Cookies or request headers.
- Private message content.
- Screenshots that reveal account or channel identifiers.

If a Discord token may have been exposed, log out of Discord sessions and change the account password before doing anything else.

## Review checklist

Changes should be rejected if they introduce any of the following without an explicit, documented security review:

- `@require`, `@connect`, remote executable code, `eval`, or `new Function`.
- Requests to a host other than the active Discord origin.
- A latest-message search whose author ID, channel ID, guild/DM scope, sort order, or offset differs from the locked run.
- A sparse-window search whose `max_id` is absent from the exact request lock, malformed, or does not strictly bound every accepted hit to older history.
- Trusting a search hit without rechecking its author ID, channel ID, snowflake ID, and timestamp, or failing to fall back safely when search is unavailable or malformed.
- Token display, copy, export, logging, or persistent storage.
- Message-content or attachment persistence.
- Deletion without author-ID verification.
- Server-wide, multi-channel, or all-DM deletion scope.
- Removal of the dry run, target lock, or in-panel exact typed confirmation.
- Issuing a delete request before the target-and-count-bound phrase is accepted, or including typed confirmation text in diagnostics.
- Continuing an automatically confirmed batch after its account, target, filter signature, or queue-integrity lock changes.
- Counting or queueing any message newer than the authenticated account's discovered latest-message anchor in a fresh run.
- Counting a message toward the owned-message batch boundary unless its author ID equals the locked `/users/@me` identity.
- Counting or queueing Discord `CALL`, any type outside the reviewed normal user-content allowlist, or an unknown future message type.
- Resuming a checkpoint created before the current message-type eligibility version.
- Persisting matched-message log content in preferences, checkpoints, page storage, files, the clipboard, or network requests.
- Including message content, usernames, raw Discord IDs, credentials, or tokens in the diagnostic log, or copying diagnostics without an explicit user action.
- Removal of queue-integrity, strict history-ordering, or invalid-request circuit checks.
- Removing the batch no-progress guard or allowing a fresh run to cross its exact owned-message boundary without preserving the next older cursor.
- Retrying HTTP 429 before Discord's `Retry-After` period has elapsed.

Run `npm test` before every release.
