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
  ['author identity gate', /message\.author\.id !== currentUser\.id/],
  ['typed confirmation', /const phrase = `DELETE \$\{count\}`/],
  ['429 handling', /response\.status === 429/],
  ['Retry-After handling', /headers\.get\('Retry-After'\)/],
  ['Retry-After hard minimum', /minimumWait \+ 250 \+ positiveJitter/],
  ['dry-run target lock', /runState\.signature !== expectedSignature/],
  ['fresh identity verification', /resolveCurrentUser\(\{ force: true \}\)/],
  ['mid-run account-switch stop', /The signed-in Discord account changed/],
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

console.log('Userscript security invariants passed.');
