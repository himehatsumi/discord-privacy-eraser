# Discord Privacy Eraser

`discord-privacy-eraser.user.js` is a local userscript for permanently deleting **only deletable messages authored by your signed-in account** in the currently open Discord channel or DM.

[Latest release](https://github.com/himehatsumi/discord-privacy-eraser/releases/latest) · [Changelog](CHANGELOG.md) · [Privacy](PRIVACY.md) · [Security](SECURITY.md)

The finished default workflow is **newest-first** and uses one button to scan 500 of your deletable messages, confirm the first bounded queue, delete it, and repeat automatically. The separate preview controls are optional.

## Important warning

Discord says [automating a normal user account is prohibited self-botting](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots) and may result in account termination. This script reduces operational risk by using conservative, adaptive pacing, but it cannot remove that policy risk.

Deletion is permanent. The recommended cleanup button scans before it deletes and requires one exact, target-bound confirmation. Use the optional preview and narrow filters first if you want to audit the queue separately.

## Install

1. Install Tampermonkey or Violentmonkey in a browser.
2. Download `discord-privacy-eraser.user.js` from the [latest release](https://github.com/himehatsumi/discord-privacy-eraser/releases/latest), or open the file on the release tag.
3. Import the file into the userscript manager. If it does not offer an import action, create a new script and replace its template with the complete file contents.
4. Open Discord in the browser at `https://discord.com/channels/@me`.
5. Hard-refresh the Discord tab after installing the script.
6. Open the exact channel or DM to clean, then click **Privacy Eraser** at the bottom-right.

If the session indicator does not turn green, change to another Discord channel once. The script observes Discord's existing in-memory session; it never asks you to paste or export a token.

## Recommended cleanup

1. Accept the warning.
2. With no filters, the default scope is every normal user-content message authored by your account, including pinned, edited, sticker, voice, attachment, and poll messages. Calls and other system entries are ignored.
3. Uncheck **Include pinned messages** or add dates, protected phrases, or a small maximum such as `10` only if you want a narrower run.
4. Leave **Scan, then delete every N deletable messages** at `500`. Fresh runs use **Newest first** by default.
5. Click **Start cleanup: scan 500 → delete → repeat**. It snaps to your actual latest deletable message, collects the first anchored batch, and displays every match.
6. Type the exact target-and-count-bound phrase into the in-panel confirmation screen. No DELETE request is sent before this one-time confirmation.
7. Leave the tab open. The script deletes that batch, scans the next 500 of your deletable messages, and repeats until the maximum, date boundary, end of history, stop, or error.

**Preview next batch (optional)** keeps the old two-step workflow available: it scans without deleting, after which **Delete previewed batch…** starts the same confirmed continuation loop.

Messages newer than your latest deletable message are skipped before batch counting begins. The scanner then collects `500` deletable messages authored by your account, rather than stopping after `500` combined history items. Discord call entries have message type `3`, which Discord's [Message Types table](https://docs.discord.com/developers/resources/message#message-object-message-types) marks as non-deletable; they are ignored even when their author field is your account. They cannot anchor a batch, consume capacity, pass filters, or enter the queue. Unknown future message types also fail closed.

After a full 100-item history page with no deletable message from you, the default mode performs another exact account- and channel-locked search using that page's oldest ID as `max_id`, jumps to your next older deletable message, and resumes normal history paging there. If that lookup is unavailable or invalid, direct history continues without trusting the result. After confirmation, deletion repeats in 500-message batches until the configured maximum, date boundary, or end of history.

Every filter match in the current batch appears in the matched-message log. Its detail can be set to full text, a 300-character preview, timestamp/ID only, or off. The default is full text. This log exists only in the current page memory: message content is never written into the checkpoint, browser storage, a file, or a network request.

The **Diagnostics for bug reports** log records both scan and deletion phases: search response shape, hashed cursors and identities, page timestamps, anonymized author counts, message types, confirmation state, deletion response statuses, pagination transitions, and rate-limit headers. It never includes message text, usernames, raw Discord IDs, credentials, typed confirmation text, or tokens. Click **Copy diagnostics** and paste the complete block into a bug report; the trace stays in page memory until you explicitly copy it.

During deletion, the panel shows whether the queue is newest- or oldest-first and the timestamp of the next request. Every successful deletion produces an activity-log line with its timestamp, batch progress, and remaining count. Newest-first is the default for fresh runs; oldest-first remains available.

The default lookup searches the locked channel for the authenticated account, sorted newest first with a maximum of 25 hits. Every accepted hit must match `/users/@me`, the current channel, the optional sparse-window `max_id`, a valid snowflake/timestamp, and the reviewed normal user-content types (`DEFAULT`, `REPLY`, `CHAT_INPUT_COMMAND`, or `CONTEXT_MENU_COMMAND`). Search failures fall back to direct newest-to-oldest history. All paths obey live rate-limit headers and HTTP 429 `Retry-After`.

For a very long history, leave the tab open. Pausing or stopping preserves the exact seek/scan/delete checkpoint. Transient network and server errors use exponential backoff. Learned pacing and active cooldown deadlines survive reloads. The script also learns from [Discord's documented rate-limit response headers](https://docs.discord.com/developers/topics/rate-limits).

## Safety properties

- Current channel or DM only; no server-wide or all-DM mode.
- Every candidate must have an author ID equal to `/users/@me`.
- Every candidate's message type must be in the reviewed user-content allowlist; `CALL`, other system types, and unknown types fail closed.
- Every queued message ID and history cursor must be a valid Discord snowflake from the locked channel.
- History pages must be strictly newest-to-oldest; malformed, duplicate, cross-channel, or out-of-order pages pause without partially trusting the page.
- The saved queue has a target/account/settings-bound checksum to detect accidental checkpoint corruption.
- The signed-in identity is rechecked before deletion; an account change stops the run before another message is touched.
- A complete pre-deletion scan and a target-bound typed confirmation are mandatory before a new deletion. The recommended button automates the scan-to-confirmation handoff; it does not bypass either gate.
- Only the first batch can request confirmation; later batches continue under the same account, target, filter, owned-message batch mode, and queue-integrity lock.
- The unfiltered default includes pinned and edited messages; uncheck either option to preserve that category.
- Navigation away pauses the run by default.
- No remote dependencies, update URL, telemetry, attachment downloads, or third-party requests.
- A method-and-path allowlist permits only identity reads, the exact account/channel-bound latest-message search, locked-channel history reads, and deletion of a single queued message.
- A rolling invalid-request circuit breaker pauses before mixed 401/403/429 responses can accumulate unchecked.
- The Discord authorization token is held only in memory and never shown, logged, copied, exported, or persisted.
- Checkpoints store only settings, target/message IDs, timestamps, and counters in userscript-manager storage.
- Bug-report diagnostics are memory-only, hash all Discord IDs, omit content and usernames, and require an explicit copy action.

## What the filters mean

- **On or after / before:** Inclusive date-time boundaries in your local timezone.
- **Must contain:** Only messages containing the text, or matching the optional regular expression.
- **Always preserve:** A newline-separated list. Any matching message is skipped.
- **Attachments / links:** Limit deletion to specific message categories.
- **Include pinned / edited:** Both are on by default so an otherwise unfiltered run means every deletable message authored by you.
- **Protect newer than:** Skips recent messages by age in hours.
- **Maximum deletions:** Caps the complete multi-batch run; `0` is unlimited.
- **Newest/oldest first:** Controls order and maximum-cap selection inside each scanned batch. Newest-first is the fresh-run default. Batches themselves always move from newer history toward older history.
- **Scan, then delete every N deletable messages:** Controls how many eligible messages authored by the authenticated account form one batch; the default is `500`. Call/system entries do not count.
- **Matched-message log detail:** Shows every filter match in the current batch as full text, a preview, timestamp/ID only, or not at all. It is memory-only.
- **Latest-message lookup:** Defaults to the fast author-locked search plus sparse-window jumps and automatic direct-history fallback. “Direct history only” disables searches and remains available for troubleshooting.
- **Batch scan delay:** Adds optional spacing after the owned-message anchor is found. It does not slow the initial rate-limit-aware seek.
- **Confirm empty history pages:** Requires repeated empty responses before declaring the scan complete.
- **Invalid requests / 10 min:** Pauses after the configured number of counted 401/403/429 responses; shared-resource 429 responses are excluded.

Age filters use one fixed timestamp for the entire run, including after pause/reload. Each batch retains only its bounded owned-message working set instead of keeping every match from a long conversation in memory.

Version 1.3.1 starts a new preferences generation so older “preserve pinned by default” settings cannot silently contradict the new delete-everything default. Existing interrupted run checkpoints retain their original locked settings and must be cleared or completed separately.

Version 1.6 introduces a new queue-eligibility version. Pre-1.6 checkpoints are ignored so an older queue containing an authored call entry can never be resumed for deletion. Start a fresh dry scan after updating.

Version 1.6.1 preserves valid v1.6.0 queues. Confirmation now stays inside the userscript panel instead of relying on a browser prompt after asynchronous account validation.

Version 1.6.2 adds the recommended single-button scan/delete loop and starts a new preferences generation whose fresh default is newest-first. An active checkpoint still loads its exact reviewed order and settings; finish or clear it before starting with the new defaults.

Version 1.6.3 is the finished terminology and documentation pass. The safety stage is consistently called a pre-deletion scan, making it clear that the recommended one-button workflow does not require a separate preview action and still never sends DELETE before confirmation.

## Recovery behavior

- **Pause:** Stops before the next request.
- **Stop:** Ends the active run but retains the checkpoint.
- **Resume:** Continues the interrupted scan or deletion and then returns to the automatic scan/delete batch loop.
- **Retry failures:** Moves HTTP 400/403 failures back into a new review queue.
- **Auto-resume:** Off by default. If enabled, any interrupted confirmed batch workflow resumes after a 10-second grace period; **Stop** cancels it.
- Discord DOM replacement is detected and the launcher is remounted without starting a second operation or auto-resume timer.
- The shadow host is identified as a text-entry surface, and keyboard, paste, composition, pointer, and form-input events stop at the panel boundary so Discord's global handlers do not steal editing from its fields.

Deleting the other person's messages is not possible in a DM. Authored call entries and other system message types are ignored before queueing and therefore do not appear as deletion failures.

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
- Mocked end-to-end scans and deletions covering the single-button newest-first cleanup handoff, UI-triggered in-panel confirmation, deletion-phase diagnostics and progress, call-event exclusion, fail-closed message types, max-ID sparse-window jumps, the author-locked latest-message lookup, safe direct-history fallback, 500-owned-message interleaving, exact mid-page boundaries, complete memory-only match logs, checkpoint invalidation, no-progress guards, panel input isolation, filters, malformed pages, account changes, persisted cooldowns, HTTP 401, and HTTP 429 recovery.
- Static security-invariant checks for remote code, third-party request primitives, author verification, target locking, typed confirmation, and rate-limit handling.
- Release-consistency checks that keep the package, userscript metadata, runtime version, changelog, and README release links aligned.

GitHub Actions runs the same checks on every push and pull request.

See [PRIVACY.md](PRIVACY.md) for the data-flow description and [SECURITY.md](SECURITY.md) for the review policy.

## Research and audit notes

The reliability design was informed by the open-source Undiscord project and a maintained fork, especially their author-filtered search shape, pagination, empty-history handling, checkpointing, UI-mount failures, match previews, and rate-limit parsing patterns. Their source was independently checked for remote code loading, third-party network requests, token handling, and destructive scope before using these ideas. This script uses Discord search to find the newest eligible message and to skip only full sparse history windows, with exact account/channel/cursor validation before every jump.

This implementation is original and intentionally omits token copy/paste controls, media backup, server-wide deletion, all-DM deletion, remote icons/dependencies, and log downloads.
