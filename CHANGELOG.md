# Changelog

All notable changes are documented here.

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
