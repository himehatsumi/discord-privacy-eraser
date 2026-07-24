# Discord Privacy Eraser

`discord-privacy-eraser.user.js` is a local userscript for previewing and permanently deleting **only messages authored by your signed-in account** in the currently open Discord channel or DM.

[Latest release](https://github.com/himehatsumi/discord-privacy-eraser/releases/latest) · [Changelog](CHANGELOG.md) · [Privacy](PRIVACY.md) · [Security](SECURITY.md)

## Important warning

Discord says [automating a normal user account is prohibited self-botting](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots) and may result in account termination. This script reduces operational risk by using conservative, adaptive pacing, but it cannot remove that policy risk.

Deletion is permanent. Run the dry scan, verify its count and date range, and use narrow filters first.

## Install

1. Install Tampermonkey or Violentmonkey in a browser.
2. Download `discord-privacy-eraser.user.js` from the [latest release](https://github.com/himehatsumi/discord-privacy-eraser/releases/latest), or open the file on the release tag.
3. Import the file into the userscript manager. If it does not offer an import action, create a new script and replace its template with the complete file contents.
4. Open Discord in the browser at `https://discord.com/channels/@me`.
5. Hard-refresh the Discord tab after installing the script.
6. Open the exact channel or DM to clean, then click **Privacy Eraser** at the bottom-right.

If the session indicator does not turn green, change to another Discord channel once. The script observes Discord's existing in-memory session; it never asks you to paste or export a token.

## Recommended first run

1. Accept the warning.
2. With no filters, the default scope is every message authored by your account, including pinned and edited messages.
3. Uncheck **Include pinned messages** or add dates, protected phrases, or a small maximum such as `10` only if you want a narrower run.
4. Leave **Scan, then delete every N of your messages** at `500`, or choose a batch size from `100` to `10,000`.
5. Click **Dry run / scan**. It snaps to your actual latest message with an author-locked Discord search, then previews the first anchored batch without deleting anything.
6. Review the target lock, matched count, date range, and memory-only matched-message log.
7. Click **Delete queued…** and type the exact confirmation phrase, including the locked channel ID.

Messages newer than your latest message are skipped before batch counting begins. A fresh v1.5 run then keeps walking older combined history until it has collected `500` messages authored by your account, rather than stopping after the first `500` messages from both people. This fixes sparse conversations where a combined-history window contained only one of your messages. The preview reports the inspected total, newer messages skipped, processed history count, how many were yours, how many passed filters, and how many were queued. Older history beyond that owned-message boundary is deliberately not scanned until the first reviewed queue is confirmed.

After that one confirmation, the script deletes the reviewed matches, collects the next 500 messages authored by you, deletes that batch's filtered matches, and repeats until it reaches the configured maximum, date boundary, or end of history. A batch with no filter matches is skipped without pausing. The maximum deletion setting applies to the entire run, not separately to every batch.

Every filter match in the current batch appears in the matched-message log. Its detail can be set to full text, a 300-character preview, timestamp/ID only, or off. The default is full text. This log exists only in the current page memory: message content is never written into the checkpoint, browser storage, a file, or a network request.

The default anchor lookup is equivalent to searching the locked channel for messages from the authenticated account, sorted newest first. The returned hit must have the exact `/users/@me` author ID and current channel ID. If Discord search is unavailable, still indexing, or returns an invalid result, the script self-corrects by falling back to direct newest-to-oldest history. That fallback has no fixed timer: it requests the next page as soon as the previous one completes while still obeying live rate-limit headers and HTTP 429 `Retry-After`. Post-anchor batch scanning defaults to 250 ms between pages and remains configurable.

For a very long history, leave the tab open. Pausing or stopping preserves the exact seek/scan/delete checkpoint. Transient network and server errors use exponential backoff. Learned pacing and active cooldown deadlines survive reloads. The script also learns from [Discord's documented rate-limit response headers](https://docs.discord.com/developers/topics/rate-limits).

## Safety properties

- Current channel or DM only; no server-wide or all-DM mode.
- Every candidate must have an author ID equal to `/users/@me`.
- Every queued message ID and history cursor must be a valid Discord snowflake from the locked channel.
- History pages must be strictly newest-to-oldest; malformed, duplicate, cross-channel, or out-of-order pages pause without partially trusting the page.
- The saved queue has a target/account/settings-bound checksum to detect accidental checkpoint corruption.
- The signed-in identity is rechecked before deletion; an account change stops the run before another message is touched.
- Dry run and a target-bound typed confirmation are mandatory before a new deletion.
- Only the first batch can request confirmation; later batches continue under the same account, target, filter, owned-message batch mode, and queue-integrity lock.
- The unfiltered default includes pinned and edited messages; uncheck either option to preserve that category.
- Navigation away pauses the run by default.
- No remote dependencies, update URL, telemetry, attachment downloads, or third-party requests.
- A method-and-path allowlist permits only identity reads, the exact account/channel-bound latest-message search, locked-channel history reads, and deletion of a single queued message.
- A rolling invalid-request circuit breaker pauses before mixed 401/403/429 responses can accumulate unchecked.
- The Discord authorization token is held only in memory and never shown, logged, copied, exported, or persisted.
- Checkpoints store only settings, target/message IDs, timestamps, and counters in userscript-manager storage.

## What the filters mean

- **On or after / before:** Inclusive date-time boundaries in your local timezone.
- **Must contain:** Only messages containing the text, or matching the optional regular expression.
- **Always preserve:** A newline-separated list. Any matching message is skipped.
- **Attachments / links:** Limit deletion to specific message categories.
- **Include pinned / edited:** Both are on by default so an otherwise unfiltered run means every message authored by you.
- **Protect newer than:** Skips recent messages by age in hours.
- **Maximum deletions:** Caps the complete multi-batch run; `0` is unlimited.
- **Oldest/newest first:** Controls order and maximum-cap selection inside each scanned batch. Batches themselves always move from newer history toward older history.
- **Scan, then delete every N of your messages:** Controls how many messages authored by the authenticated account form one batch; the default is exactly `500`. The script may inspect more combined messages to collect them.
- **Matched-message log detail:** Shows every filter match in the current batch as full text, a preview, timestamp/ID only, or not at all. It is memory-only.
- **Latest-message lookup:** Defaults to the fast author-locked search with automatic direct-history fallback. “Direct history only” remains available for troubleshooting.
- **Batch scan delay:** Adds optional spacing after the owned-message anchor is found. It does not slow the initial rate-limit-aware seek.
- **Confirm empty history pages:** Requires repeated empty responses before declaring the scan complete.
- **Invalid requests / 10 min:** Pauses after the configured number of counted 401/403/429 responses; shared-resource 429 responses are excluded.

Age filters use one fixed timestamp for the entire run, including after pause/reload. Each batch retains only its bounded owned-message working set instead of keeping every match from a long conversation in memory.

Version 1.3.1 starts a new preferences generation so older “preserve pinned by default” settings cannot silently contradict the new delete-everything default. Existing interrupted run checkpoints retain their original locked settings and must be cleared or completed separately.

Version 1.5 starts a fresh UI preference generation for owned-message batches and the matched-message log. Existing checkpoints retain their previously reviewed combined-history boundary; **clear the checkpoint and start a new dry scan** to use the corrected behavior.

## Recovery behavior

- **Pause:** Stops before the next request.
- **Stop:** Ends the active run but retains the checkpoint.
- **Resume:** Continues the interrupted scan or deletion and then returns to the automatic scan/delete batch loop.
- **Retry failures:** Moves HTTP 400/403 failures back into a new review queue.
- **Auto-resume:** Off by default. If enabled, any interrupted confirmed batch workflow resumes after a 10-second grace period; **Stop** cancels it.
- Discord DOM replacement is detected and the launcher is remounted without starting a second operation or auto-resume timer.
- The shadow host is identified as a text-entry surface, and keyboard, paste, composition, pointer, and form-input events stop at the panel boundary so Discord's global handlers do not steal editing from its fields.

Deleting the other person's messages is not possible in a DM. System-generated call/activity entries may also be non-deletable and will appear as failures.

Discord's message documentation confirms that the normal delete endpoint can delete a message authored by the current user; deleting somebody else's server message requires the separate `MANAGE_MESSAGES` permission. This script does not attempt moderation deletion.

If automation risk is unacceptable, use Discord's built-in per-message deletion instead or contact Discord about a privacy request. Discord says content you delete is no longer available to other users, subject to its documented retention exceptions.

## Development

The repository has no runtime or development dependencies. Node.js 20 or newer is used only for checks:

```sh
npm test
```

The test suite performs:

- JavaScript syntax validation.
- A sandboxed initialization and network-wrapper smoke test.
- Mocked end-to-end scans and deletions covering the one-request author-locked latest-message lookup, safe direct-history fallback, 500-owned-message interleaving, the regression where the first 500 combined messages contain only one owned message, exact mid-page owned boundaries, complete memory-only match logs, no-progress loop guards, panel input isolation, filters, short/empty/out-of-order pages, bounded queues, migrated checkpoints, account changes, preflight failure, persisted cooldowns, mixed invalid responses, HTTP 401, and HTTP 429 recovery.
- Static security-invariant checks for remote code, third-party request primitives, author verification, target locking, typed confirmation, and rate-limit handling.
- Release-consistency checks that keep the package, userscript metadata, runtime version, changelog, and README release links aligned.

GitHub Actions runs the same checks on every push and pull request.

See [PRIVACY.md](PRIVACY.md) for the data-flow description and [SECURITY.md](SECURITY.md) for the review policy.

## Research and audit notes

The reliability design was informed by the open-source Undiscord project and a maintained fork, especially their author-filtered search shape, pagination, empty-history handling, checkpointing, UI-mount failures, match previews, and rate-limit parsing patterns. Their source was independently checked for remote code loading, third-party network requests, token handling, and destructive scope before using these ideas. This script uses Discord search only to snap to the newest strictly validated owned message, then switches to direct channel-history pagination for the deletion batches.

This implementation is original and intentionally omits token copy/paste controls, media backup, server-wide deletion, all-DM deletion, remote icons/dependencies, and log downloads.
