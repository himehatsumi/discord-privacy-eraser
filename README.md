# Discord Privacy Eraser

`discord-privacy-eraser.user.js` is a local userscript for previewing and permanently deleting **only messages authored by your signed-in account** in the currently open Discord channel or DM.

## Important warning

Discord says [automating a normal user account is prohibited self-botting](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots) and may result in account termination. This script reduces operational risk by using conservative, adaptive pacing, but it cannot remove that policy risk.

Deletion is permanent. Run the dry scan, verify its count and date range, and use narrow filters first.

## Install

1. Install Tampermonkey or Violentmonkey in a browser.
2. Open the userscript manager dashboard and create a new script.
3. Replace its template with the complete contents of `discord-privacy-eraser.user.js`, then save.
4. Open Discord in the browser at `https://discord.com/channels/@me`.
5. Hard-refresh the Discord tab after installing the script.
6. Open the exact channel or DM to clean, then click **Privacy Eraser** at the bottom-right.

If the session indicator does not turn green, change to another Discord channel once. The script observes Discord's existing in-memory session; it never asks you to paste or export a token.

## Recommended first run

1. Accept the warning.
2. Keep **Include pinned messages** off.
3. Optionally add dates, protected phrases, or a small maximum such as `10`.
4. Click **Dry run / scan**. This does not delete anything.
5. Review the target lock, matched count, and date range.
6. Click **Delete queued…** and type the exact confirmation phrase shown.

For a very long history, leave the tab open. Pausing or stopping preserves a checkpoint. HTTP 429 responses respect Discord's `Retry-After`; transient network and server errors use exponential backoff. The script also learns pacing from [Discord's documented rate-limit response headers](https://docs.discord.com/developers/topics/rate-limits).

## Safety properties

- Current channel or DM only; no server-wide or all-DM mode.
- Every candidate must have an author ID equal to `/users/@me`.
- Every queued message ID and history cursor must be a valid Discord snowflake from the locked channel.
- The signed-in identity is rechecked before deletion; an account change stops the run before another message is touched.
- Dry run and typed confirmation are mandatory before a new deletion.
- Pinned messages are protected by default.
- Navigation away pauses the run by default.
- No remote dependencies, update URL, telemetry, attachment downloads, or third-party requests.
- A method-and-path allowlist permits only identity/history reads and deletion of a single queued message.
- The Discord authorization token is held only in memory and never shown, logged, copied, exported, or persisted.
- Checkpoints store only settings, target/message IDs, timestamps, and counters in userscript-manager storage.

## What the filters mean

- **On or after / before:** Inclusive date-time boundaries in your local timezone.
- **Must contain:** Only messages containing the text, or matching the optional regular expression.
- **Always preserve:** A newline-separated list. Any matching message is skipped.
- **Attachments / links:** Limit deletion to specific message categories.
- **Protect newer than:** Skips recent messages by age in hours.
- **Maximum deletions:** Caps the dry-run queue; `0` is unlimited.
- **Oldest/newest first:** Controls both deletion order and which messages a maximum cap selects.

## Recovery behavior

- **Pause:** Stops before the next request.
- **Stop:** Ends the active run but retains the checkpoint.
- **Resume:** Continues an interrupted scan or confirmed deletion.
- **Retry failures:** Moves HTTP 400/403 failures back into a new review queue.
- **Auto-resume:** Off by default. If enabled, an interrupted confirmed deletion resumes after a 10-second grace period; **Stop** cancels it.

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
- Mocked end-to-end scans and deletions covering filters, queue ordering, account changes, malformed history, HTTP 401, and HTTP 429 recovery.
- Static security-invariant checks for remote code, third-party request primitives, author verification, target locking, typed confirmation, and rate-limit handling.

GitHub Actions runs the same checks on every push and pull request.

See [PRIVACY.md](PRIVACY.md) for the data-flow description and [SECURITY.md](SECURITY.md) for the review policy.

## Research and audit notes

The reliability design was informed by the open-source Undiscord project and a maintained fork, especially their history pagination, empty-history handling, checkpointing, and rate-limit parsing patterns. Their source was independently checked for remote code loading, third-party network requests, token handling, and destructive scope before using these ideas.

This implementation is original and intentionally omits token copy/paste controls, media backup, server-wide deletion, all-DM deletion, remote icons/dependencies, and log downloads.
