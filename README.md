# Discord Privacy Eraser

A userscript for deleting your own messages from the currently open Discord channel or DM.

[Latest release](https://github.com/himehatsumi/discord-privacy-eraser/releases/latest) · [Changelog](CHANGELOG.md) · [Privacy](PRIVACY.md) · [Security](SECURITY.md)

## Warning

Deletion is permanent. Discord also prohibits automated normal-user accounts and may terminate accounts that use them.

## Install

1. Install Tampermonkey or Violentmonkey.
2. Download `discord-privacy-eraser.user.js` from the [latest release](https://github.com/himehatsumi/discord-privacy-eraser/releases/latest).
3. Import it into your userscript manager.
4. Open Discord in your browser and hard-refresh the page.
5. Open the channel or DM you want to clean.

## Use

1. Open **Privacy Eraser** at the bottom-right.
2. Accept the warning.
3. Set filters if needed. Blank filters mean all of your deletable messages.
4. Click **Start cleanup: scan 500 → delete → repeat**.
5. Enter the exact confirmation phrase once.

The default order is newest-first. The script keeps scanning and deleting older batches until it finishes, reaches your limit, encounters an error, or you stop it.

**Preview next batch** is optional.

## Main options

- Date, text, attachment, link, pin, edit, and age filters
- Protected phrases that are never deleted
- Newest-first or oldest-first order
- Deletion limit and batch size
- Adjustable pacing and automatic rate-limit recovery
- Pause, stop, resume, checkpoint recovery, and failure retry
- Full, preview, ID-only, or disabled matched-message logs

Calls and other system entries are ignored because Discord does not allow them to be deleted like normal messages.

## Limits

- Only the current channel or DM is processed.
- Only messages authored by the signed-in account are eligible.
- Other people's DM messages cannot be deleted.
- The tab must stay open unless you resume from a saved checkpoint.
