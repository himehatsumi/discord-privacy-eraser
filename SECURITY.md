# Security

## Built-in protections

- Requests are limited to the active Discord origin.
- Each run is locked to the current channel or DM.
- Only messages authored by the signed-in account can enter the deletion queue.
- Calls, system entries, and unknown message types are ignored.
- The account, target, settings, and queue are rechecked before deletion.
- A target-bound confirmation is required before the first DELETE request.
- Saved queues include an integrity checksum.
- Discord rate limits and `Retry-After` are respected.
- Tokens are held only in memory and are never displayed, copied, logged, or saved.

## Limits

The script cannot recover deleted messages or remove data already copied, quoted, downloaded, cached, or retained by Discord.

Automating a normal Discord account may violate Discord's rules and can put the account at risk.

Only the latest release is supported.
