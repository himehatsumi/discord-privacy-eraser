const assert = require('node:assert/strict');
const fs = require('node:fs');

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const source = fs.readFileSync('discord-privacy-eraser.user.js', 'utf8');
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');
const version = packageJson.version;

assert.match(
  source,
  new RegExp(`^// @version\\s+${version.replaceAll('.', '\\.')}$`, 'm'),
  'userscript metadata version must match package.json',
);
assert.match(
  source,
  new RegExp(`version: '${version.replaceAll('.', '\\.')}'`),
  'runtime version must match package.json',
);
assert.match(
  changelog,
  new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\]`, 'm'),
  'CHANGELOG.md must begin with a linked section for the package version',
);
assert.match(
  readme,
  /github\.com\/himehatsumi\/discord-privacy-eraser\/releases\/latest/,
  'README.md must link to the current GitHub release surface',
);

console.log(`Release metadata is consistent for v${version}.`);
