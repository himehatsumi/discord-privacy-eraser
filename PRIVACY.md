# Privacy

Discord Privacy Eraser is designed to keep account credentials and message data inside the Discord browser tab.

## Data read

The userscript reads:

- The current Discord channel or DM ID from the browser URL.
- The signed-in account ID from Discord's `/users/@me` API response.
- Channel message history returned by Discord while a dry scan is running.
- The newest author-filtered search hit used to anchor a fresh run, unless direct-history-only mode is selected.
- Discord rate-limit response headers.
- The existing in-memory authorization header used by the Discord web client.

## Data sent

The script sends requests only to the same Discord origin on which it is running:

- `GET /api/v9|v10/users/@me`
- `GET /api/v9|v10/channels/{channel_id}/messages/search` for a DM/group DM, locked to the authenticated author ID
- `GET /api/v9|v10/guilds/{guild_id}/messages/search` for a server channel, locked to the authenticated author and channel IDs
- `GET /api/v9|v10/channels/{channel_id}/messages`
- `DELETE /api/v9|v10/channels/{channel_id}/messages/{message_id}`

It has no telemetry, analytics, advertisements, webhooks, remote dependencies, update URL, or third-party network requests. The search and history requests stay on the active Discord origin. It does not fetch attachments.

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

Version 1.5 uses a new preferences key to establish owned-message batches and the matched-message log controls. Older private preference values are not read; existing locked run checkpoints remain separate and retain their original reviewed batch mode.

Version 1.1 also removes the two namespaced page-storage keys that version 1.0 could have created when private userscript storage was unavailable. It does not remove or modify Discord's own storage keys.

A checkpoint may contain:

- Filter and pacing settings.
- The target guild/channel IDs.
- The signed-in user ID.
- Queued message IDs and timestamps.
- Progress counters and failed message IDs.
- The current batch number, scan cursor, batch capacity, and whether end-of-history was confirmed.
- Whether the checkpoint uses the current owned-message boundary or a preserved pre-1.5 combined-history boundary.
- Whether the latest owned-message anchor was found, whether search or direct history found it, and how many newer messages were skipped by the direct-history fallback.
- A non-cryptographic queue-integrity checksum.
- Rate-limit deadlines, learned pacing, and recent invalid-request timestamps.

It does not contain message content, attachment URLs, cookies, the authorization token, or activity-log text.

## Memory-only matched-message log

During a live scan, the panel can display every filter match in the current batch as full text, a 300-character preview, timestamp/ID only, or not at all. Full text is the default for a fresh v1.5 run so the dry-run queue can be audited before deletion.

Those entries exist only in the userscript's current JavaScript memory and the panel's shadow DOM. They are cleared when the page is reloaded, the next batch starts, or the log is cleared. They are never included in preferences or checkpoints, written to a file or clipboard, or transmitted anywhere. After a reload, an interrupted checkpoint can resume safely, but message text found before the reload is intentionally not reconstructed or persisted.

## Memory-only diagnostic log

Version 1.5.1 can create a separate technical trace for investigating incorrect ownership or pagination counts. It contains response counts and status, timestamps, hashed account/channel/message/cursor IDs, anonymized per-page author distributions, message-type counts, missing-author and webhook counts, pagination transitions, active filter categories, API version, rate-limit headers, and final counters.

It deliberately omits message content, usernames, raw Discord IDs, authorization data, cookies, and request headers. The trace is not added to preferences or checkpoints and disappears on reload. It is placed on the clipboard only after the user explicitly clicks **Copy diagnostics**; that copy is intended to be pasted into a private bug report.

Use **Clear checkpoint** in the panel to erase saved run data. Removing the userscript through the userscript manager may also provide an option to remove its stored values.

## Security boundary

The script cannot protect data already copied, quoted, screenshotted, downloaded, cached, or retained for legal reasons. Discord describes its own retention behavior in its official support documentation.
