# Privacy

Discord Privacy Eraser is designed to keep account credentials and message data inside the Discord browser tab.

## Data read

The userscript reads:

- The current Discord channel or DM ID from the browser URL.
- The signed-in account ID from Discord's `/users/@me` API response.
- Channel message history returned by Discord while a dry scan is running.
- Discord rate-limit response headers.
- The existing in-memory authorization header used by the Discord web client.

## Data sent

The script sends requests only to the same Discord origin on which it is running:

- `GET /api/v9|v10/users/@me`
- `GET /api/v9|v10/channels/{channel_id}/messages`
- `DELETE /api/v9|v10/channels/{channel_id}/messages/{message_id}`

It has no telemetry, analytics, advertisements, webhooks, remote dependencies, update URL, or third-party network requests. It does not fetch attachments.

## Credential handling

The Discord authorization token:

- Is observed from the already authenticated Discord web client or its loaded modules.
- Is held only in a JavaScript closure in memory.
- Is never shown in the interface.
- Is never written to userscript-manager storage, `localStorage`, a file, the clipboard, or a log.
- Is never sent to any destination other than the same-origin Discord API.

The source includes defensive token redaction for local log messages.

## Local storage

Preferences and recovery checkpoints are stored only using the userscript manager's private value storage. There is deliberately no page-readable `localStorage` fallback for settings or deletion queues. If private userscript storage is unavailable or full, the current run may continue in memory, but reload recovery is unavailable.

Version 1.3.1 uses a new preferences key to establish the explicit unfiltered delete-everything default. The older private preference value is not read; existing locked run checkpoints remain separate and retain their original settings.

Version 1.1 also removes the two namespaced page-storage keys that version 1.0 could have created when private userscript storage was unavailable. It does not remove or modify Discord's own storage keys.

A checkpoint may contain:

- Filter and pacing settings.
- The target guild/channel IDs.
- The signed-in user ID.
- Queued message IDs and timestamps.
- Progress counters and failed message IDs.
- The current batch number, scan cursor, batch capacity, and whether end-of-history was confirmed.
- A non-cryptographic queue-integrity checksum.
- Rate-limit deadlines, learned pacing, and recent invalid-request timestamps.

It does not contain message content, attachment URLs, cookies, the authorization token, or activity-log text.

Use **Clear checkpoint** in the panel to erase saved run data. Removing the userscript through the userscript manager may also provide an option to remove its stored values.

## Security boundary

The script cannot protect data already copied, quoted, screenshotted, downloaded, cached, or retained for legal reasons. Discord describes its own retention behavior in its official support documentation.
