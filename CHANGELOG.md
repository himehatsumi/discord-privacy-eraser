# Changelog

All notable changes are documented here.

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
