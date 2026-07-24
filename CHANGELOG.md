# Changelog

All notable changes are documented here.

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
