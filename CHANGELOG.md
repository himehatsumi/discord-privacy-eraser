# Changelog

All notable changes are documented here.

## [1.6.3](https://github.com/himehatsumi/discord-privacy-eraser/releases/tag/v1.6.3) — 2026-07-24

- Finished the one-button workflow documentation after successful live use.
- Replaced remaining user-facing “dry run” terminology with “scan” or “scanned queue,” matching the actual scan → confirm → delete → repeat flow.
- Clarified that **Preview next batch** is optional while the mandatory pre-deletion scan and exact confirmation remain enforced inside the recommended cleanup button.
- Refreshed README, privacy, security-test terminology, package metadata, and release documentation without changing deletion scope or weakening any safety gate.

## [1.6.2](https://github.com/himehatsumi/discord-privacy-eraser/releases/tag/v1.6.2) — 2026-07-24

- Added a prominent single cleanup button that scans one bounded batch, hands it directly to the existing exact-phrase confirmation, deletes it, and automatically repeats scan → delete until completion.
- Kept the optional preview-only and delete-previewed controls for manual inspection without making them part of the recommended workflow.
- Made newest-first the default for fresh runs and placed it first in the order selector.
- Started preferences generation v5 so an old saved oldest-first default does not override the new behavior.
- Preserved the exact order and settings of active v1.6 checkpoints; clearing or completing a checkpoint returns the interface to the new fresh defaults.
- Added redacted diagnostics for the combined-flow start, scan-to-delete handoff, no-delete outcome, and completion.
- Added end-to-end coverage proving the combined flow scans, confirms exactly once, and deletes the newest selected message without a separate delete action.
- Prevented a failed fresh-scan preflight from handing an older unconfirmed queue to the deletion stage.

## [1.6.1](https://github.com/himehatsumi/discord-privacy-eraser/releases/tag/v1.6.1) — 2026-07-24

- Replaced the native browser prompt with an in-panel exact-phrase confirmation so an asynchronous account preflight cannot leave the destructive action detached from the original button click or silently suppressed by the browser.
- Added deletion-phase redacted diagnostics for entry, blocking reason, account/signature preflight, confirmation, request, response status, rate-limit headers, completion, and interruption/error.
- Added a visible activity-log entry after every successful deletion or already-gone response, including its timestamp, batch progress, and remaining queue count.
- Added the exact next deletion timestamp and oldest/newest order to the panel and confirmation screen, clarifying that an oldest-first queue can operate far above the currently visible latest messages.
- Preserved valid v1.6.0 scan checkpoints; updating does not require rescanning the already-reviewed queue.
- Added a UI-triggered regression proving no deletion occurs before the in-panel phrase is accepted and that the queued request is issued and completed afterward.

## [1.6.0](https://github.com/himehatsumi/discord-privacy-eraser/releases/tag/v1.6.0) — 2026-07-24

- Stopped treating Discord `CALL` messages (type `3`) and other documented non-deletable message types as owned deletion candidates, batch capacity, anchors, filter matches, or queued IDs.
- Added a fail-closed normal user-content type allowlist (`DEFAULT`, `REPLY`, `CHAT_INPUT_COMMAND`, and `CONTEXT_MENU_COMMAND`); all system and unknown future types are excluded until reviewed.
- Changed the initial author search to select the newest strictly validated **deletable** message from the authenticated account, ignoring newer call/system hits.
- Added a locked sparse-window jump: after a full 100-item history page contains no deletable message from the account, the scanner searches before that page's cursor with the exact account/channel/max-ID lock and jumps to the next older deletable message.
- Kept direct-history pagination as the fallback whenever a sparse-window search is unavailable, indexing, malformed, out of bounds, or has no eligible hit.
- Added ignored-system and sparse-jump counters, activity/diagnostic reporting, and a new checkpoint eligibility version so pre-1.6 queues containing call entries cannot be resumed for deletion.
- Added regression coverage for a newer authored call hit, a call-only sparse window, a max-ID search jump, exact batch capacity, queue exclusion, unknown message types, and old-checkpoint invalidation.

## [1.5.1](https://github.com/himehatsumi/discord-privacy-eraser/releases/tag/v1.5.1) — 2026-07-24

- Added a separate memory-only diagnostics log for investigating incorrect ownership counts without exposing message text, usernames, raw account/channel/message IDs, credentials, or tokens.
- Added one-click diagnostic copying with userscript-manager clipboard support plus browser and manual-copy fallbacks; diagnostics leave the page only after an explicit click.
- Recorded the search response shape, selected anchor, API version, hashed identity/target/cursor values, per-page time range, anonymized author distribution, message types, missing authors, webhook count, pagination transitions, rate-limit headers, and final scan counters.
- Added a prominent warning when at most one owned message is recognized after 500 anchored history messages, so the affected scan can be stopped and reported without traversing the full conversation.
- Added regression coverage proving the sparse-history trace is complete while excluding message content and raw Discord IDs from the diagnostic export.

## [1.5.0](https://github.com/himehatsumi/discord-privacy-eraser/releases/tag/v1.5.0) — 2026-07-24

- Changed fresh-run batch capacity from combined channel history to messages authored by the authenticated account: the default batch now collects 500 of your messages before deletion.
- Fixed the sparse-history failure where the scanner stopped with one match merely because the first 500 combined messages contained only one message from you.
- Added a same-origin author search that snaps directly to the authenticated account's newest message in the locked channel or DM, with bounded retries while Discord indexes the conversation.
- Locked the fast lookup to the current account, target, newest-first sort, and zero offset; every returned hit is revalidated before it can anchor a batch.
- Added automatic direct-history fallback when Discord search is unavailable, still indexing, rate limited beyond its retry budget, empty, or malformed.
- Kept direct, newest-to-oldest channel pagination after the anchor and exact mid-page owned-message boundaries, so the next batch neither skips nor duplicates older history.
- Kept pre-1.5 checkpoints on their previously reviewed combined-history boundary; clearing the checkpoint and starting a new dry scan is required to adopt the expanded owned-message scope.
- Added a separate memory-only matched-message log that displays every filter match in the current batch.
- Added configurable full-text, 300-character preview, timestamp/ID-only, and disabled match-log modes; full text is the new-run default.
- Kept message text out of preferences, checkpoints, files, clipboard operations, and third-party requests.
- Added regression coverage for a first 500-message window with only one owned message, exact owned-message boundary cursors, and complete matched-message log output.
- Refreshed installation, upgrade, privacy, security, and release documentation and added a packaged userscript asset to the current GitHub release.
- Updated repository validation to the Node 24-based GitHub Actions v6 runtime, disabled unused package-manager caching and checkout credentials, and added concurrency cancellation plus manual dispatch.

## 1.4.0 — 2026-07-24

- Added a resumable fast-seek phase that walks backward until it finds the authenticated account's actual latest message.
- Made batch 1 begin at that owned-message anchor, excluding every newer message from the other participant from its 500-message capacity.
- Removed the fixed artificial delay while seeking; Discord response headers, proactive cooldowns, 429 `Retry-After`, and retry backoff still govern request speed.
- Reduced the default post-anchor batch scan delay from 750 ms to 250 ms and allowed a configurable value of 0.
- Added persisted anchor and skipped-newer counters plus explicit seek, discovery, preview, and confirmation text.
- Preserved pre-1.4 checkpoint behavior instead of silently re-anchoring an already-reviewed queue.
- Added integration coverage for a mid-page anchor after hundreds of newer partner messages, exact remaining page capacity, and a no-fixed-delay seek.

## 1.3.1 — 2026-07-24

- Made the no-filter default mean every message authored by the authenticated account, including pinned and edited messages.
- Started a new preferences generation so the new explicit delete-everything default is not overridden by older saved UI defaults.
- Preserved the exact settings and scope of interrupted run checkpoints during the preferences change.
- Split batch reporting into combined history scanned, authored by your account, passed filters, queued, and remaining counts.
- Clarified that each 500-message batch contains combined channel/DM history and that older history is scanned only after the first queue is confirmed.
- Added the authenticated username and “older history not scanned yet” to the batch-ready log.
- Made author-ID comparison robust to string-like API values and added regression coverage for pinned and edited messages under the default scope.

## 1.3.0 — 2026-07-24

- Changed long-history processing to scan 500 raw history messages, delete that batch's reviewed matches, and repeat.
- Added a configurable history batch size from 100 to 10,000 while keeping 500 as the default.
- Kept the maximum deletion count global across batches and bounded every batch queue.
- Added a single target-bound confirmation for the first preview, with automatic continuation only while the account, target, filters, and checkpoint remain locked.
- Added batch-aware pause, stop, reload recovery, delayed auto-resume, and progress display.
- Added no-progress detection so account/target/preflight failures cannot create a tight automatic retry loop.
- Sized the last API page request to the exact remaining batch capacity so custom batches never overshoot.
- Normalized reloads at scan/delete phase boundaries and kept pre-v1.3 confirmations from expanding into the new multi-batch scope.
- Marked the shadow host as a text-entry surface and isolated keyboard, paste, composition, form, and pointer events at the panel boundary so Discord cannot steal its input.
- Recomputed queue checksums when migrating older checkpoints to the new batch configuration.
- Added integration and static checks for 500-message scan/delete interleaving, input isolation, migration, and no-progress handling.

## 1.2.0 — 2026-07-24

- Continued direct history scans across short non-empty pages and added configurable repeated-empty confirmation.
- Added strict newest-to-oldest page validation before any item on a page can enter the queue.
- Bounded oldest-first capped scans to the selected working set, reducing memory and checkpoint size on very long histories.
- Persisted active cooldown deadlines and learned deletion pacing across reloads.
- Added adaptive fallback waits when Discord returns an unrealistically short or missing retry interval.
- Added a persisted rolling circuit breaker for counted 401/403/429 responses.
- Made minimum-age filtering deterministic across long scans and resumed checkpoints.
- Added a target/account/settings-bound queue checksum and backward-compatible checkpoint migration.
- Bound the irreversible confirmation phrase to the locked channel ID and included the selected date range.
- Fixed new-scan preflight failures overwriting an unrelated existing checkpoint.
- Remounted the launcher after Discord replaces its page DOM without duplicating active work or auto-resume timers.
- Expanded integration coverage for partial pages, transient empties, out-of-order data, bounded queues, migrated checkpoints, stale targets, persisted cooldowns, and mixed invalid responses.

## 1.1.0 — 2026-07-24

- Added mocked end-to-end coverage for scans, filters, capped queue ordering, deletion, rate-limit recovery, authentication failure, account switching, malformed history, and corrupted queues.
- Bound the network allowlist to exact HTTP method/path pairs and disallowed request bodies.
- Restricted credential observation to same-origin Discord API requests and explicit supported Discord hosts.
- Added strict queue/channel/snowflake validation and fail-closed pagination guards.
- Added safe-range validation for resumed settings and pacing controls.
- Fixed capped dry runs reporting dates from discarded matches instead of the selected queue.
- Made HTTP 401 failures pause immediately instead of entering the normal deletion retry loop.
- Ensured Retry-After and base deletion delays can never be shortened by random jitter.
- Removed the page-readable checkpoint fallback and added cleanup of its legacy namespaced keys.

## 1.0.0 — 2026-07-24

- Added current-channel and DM history scanning with local author verification.
- Added a mandatory dry run, target lock, and typed deletion confirmation.
- Added date, text, regex, preserve-phrase, attachment, link, pin, edit, age, order, and maximum-count filters.
- Added adaptive deletion pacing based on Discord rate-limit headers.
- Added exact `Retry-After` handling for HTTP 429 responses.
- Added exponential backoff for network errors and HTTP 5xx responses.
- Added pause, resume, stop, compact checkpoints, navigation safety, optional delayed auto-resume, and failed-ID retry.
- Added an isolated in-page interface with no remote dependencies.
- Added token redaction and a no-display/no-persistence credential design.
- Added forced identity verification before deletion and a fail-closed stop if the signed-in account changes mid-run.
- Added smoke tests, security invariants, and GitHub Actions validation.
