const fs = require('node:fs');

const source = fs.readFileSync('discord-privacy-eraser.user.js', 'utf8');

const forbidden = [
  ['remote userscript dependency', /^\s*\/\/\s*@require\b/m],
  ['cross-origin userscript permission', /^\s*\/\/\s*@connect\b/m],
  ['privileged cross-origin request', /\bGM_xmlhttpRequest\b/],
  ['beacon exfiltration primitive', /\.sendBeacon\s*\(/],
  ['WebSocket exfiltration primitive', /\bnew\s+WebSocket\s*\(/],
  ['dynamic eval', /\beval\s*\(/],
  ['dynamic Function constructor', /\bnew\s+Function\s*\(/],
  ['cookie access', /\bdocument\.cookie\b/],
];

for (const [label, pattern] of forbidden) {
  if (pattern.test(source)) {
    throw new Error(`Security invariant failed: found ${label}.`);
  }
}

const required = [
  ['same-origin API construction', /\$\{location\.origin\}\/api\/v\$\{apiVersion\}\$\{path\}/],
  ['author identity gate', /function isAuthoredByUser/],
  ['deletable message-type gate', /function isDeletableOwnedMessage/],
  ['Discord call events excluded', /OWNED_CONTENT_MESSAGE_TYPES = new Set\(\[0, 19, 20, 23\]\)/],
  ['unknown message types fail closed', /OWNED_CONTENT_MESSAGE_TYPES\.has\(messageType\(message\)\)/],
  ['unfiltered default includes pinned messages', /includePinned: true/],
  ['explicit delete-everything scope detector', /function isDeleteEverythingConfig/],
  ['per-batch ownership diagnostics', /batchOwnedMessages/],
  ['latest-owned-message anchor', /anchorIndex = messages\.findIndex/],
  ['author-locked latest-message lookup', /function isAllowedAuthorSearchPath/],
  ['strict search-hit validation', /function extractSearchAnchor/],
  ['search fallback to direct history', /continuing through direct history/],
  ['bounded sparse-window search jump', /purpose: 'sparse-window next-message lookup'/],
  ['search jump cursor bound', /max_id: String\(maxId\)/],
  ['fast seek remains rate-limit governed', /Avoid an additional fixed delay while seeking/],
  ['target-bound typed confirmation', /const phrase = `DELETE \$\{count\} FROM \$\{runState\.target\.channelId\}`/],
  ['429 handling', /response\.status === 429/],
  ['Retry-After handling', /headers\.get\('Retry-After'\)/],
  ['Retry-After hard minimum', /minimumWait \+ 250 \+ positiveJitter/],
  ['dry-run target lock', /runState\.signature !== expectedSignature/],
  ['fresh identity verification', /resolveCurrentUser\(\{ force: true \}\)/],
  ['mid-run account-switch stop', /The signed-in Discord account changed/],
  ['locked-channel queue validation', /validateQueueIntegrity\(runState, target\)/],
  ['queue checksum', /computeQueueDigest/],
  ['unexpected API request block', /Blocked an unexpected Discord API method, path, or body/],
  ['history page limits stay within 1-100', /limit=\(\?:\[1-9\]\|\[1-9\]\\d\|100\)/],
  ['same-origin credential sniffing', /if \(isSameOriginDiscordApi\(args\[0\]\)\)/],
  ['strict history ordering', /Discord returned duplicate or out-of-order history/],
  ['persisted rate-limit cooldown', /runState\.rateLimitUntil/],
  ['invalid-request circuit breaker', /invalidRequestCircuitError/],
  ['checkpointed scan/delete batching', /startContinuousDeletion/],
  ['owned-message batch capacity', /runState\.batchOwnedMessages >= config\.scanBatchSize/],
  ['exact owned-message boundary', /function trimToOwnedBatchBoundary/],
  ['memory-only matched-message log', /runtime\.matchLogs\.push/],
  ['memory-only diagnostic log', /runtime\.debugLogs\.push/],
  ['hashed diagnostic identifiers', /function debugId/],
  ['explicit diagnostic copy control', /dpe-copy-debug/],
  ['diagnostic content privacy notice', /message content, usernames, raw account\/channel\/message IDs/],
  ['batch no-progress guard', /batchProgressFingerprint/],
  ['panel editing event isolation', /event\.stopImmediatePropagation\?\.\(\)/],
  ['shadow host text-entry marker', /host\.contentEditable = 'true'/],
  ['removed-launcher remount', /rootHost && !rootHost\.isConnected/],
  ['no token persistence claim implemented', /token held only in memory/],
];

for (const [label, pattern] of required) {
  if (!pattern.test(source)) {
    throw new Error(`Security invariant failed: missing ${label}.`);
  }
}

const executableUrls = [...source.matchAll(/nativeFetch\s*\(\s*([^,\n]+)/g)]
  .map((match) => match[1].trim());
if (executableUrls.length !== 1 || !executableUrls[0].includes('location.origin')) {
  throw new Error('Security invariant failed: unexpected fetch destination construction.');
}

if (/localStorage\.setItem\s*\(/.test(source)) {
  throw new Error('Security invariant failed: deletion state must not use page-readable localStorage.');
}

if (/https:\/\/\*\.discord\.com/.test(source)) {
  throw new Error('Security invariant failed: userscript metadata must list supported Discord hosts explicitly.');
}

console.log('Userscript security invariants passed.');
