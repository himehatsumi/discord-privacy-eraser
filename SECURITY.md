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
- Token display, copy, export, logging, or persistent storage.
- Message-content or attachment persistence.
- Deletion without author-ID verification.
- Server-wide, multi-channel, or all-DM deletion scope.
- Removal of the dry run, target lock, or typed confirmation.
- Removal of queue-integrity, strict history-ordering, or invalid-request circuit checks.
- Retrying HTTP 429 before Discord's `Retry-After` period has elapsed.

Run `npm test` before every release.
