#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
const launcherInstaller = fs.readFileSync(
  path.join(root, 'scripts', 'install-launchers.sh'),
  'utf8'
);
const logoPath = path.join(root, 'docs', 'assets', 'remote-codex-logo.png');
const iconPath = path.join(root, 'build', 'icons', '512x512.png');

assert.deepEqual(readPngMetadata(logoPath), {
  width: 600,
  height: 450,
  colorType: 6
});
assert.deepEqual(readPngMetadata(iconPath), {
  width: 512,
  height: 512,
  colorType: 6
});
assert.match(readme, /docs\/assets\/remote-codex-logo\.png/);
assert.match(builder, /from: build\/icons\/512x512\.png/);
assert.match(builder, /icon: build\/icons\/512x512\.png/);
assert.match(main, /icon: resolveWindowIconPath\(\)/);
assert.match(main, /process\.resourcesPath, 'icon\.png'/);
assert.match(main, /'build', 'icons', '512x512\.png'/);
assert.match(launcherInstaller, /ICON_FILE="\$\{APP_DIR\}\/build\/icons\/512x512\.png"/);
assert.match(launcherInstaller, /Icon=\$\{ICON_FILE\}/);
assert.doesNotMatch(launcherInstaller, /Icon=utilities-terminal/);

console.log('Application brand asset tests passed.');

function readPngMetadata(filePath) {
  const content = fs.readFileSync(filePath);
  assert.equal(content.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(content.subarray(12, 16).toString('ascii'), 'IHDR');
  return {
    width: content.readUInt32BE(16),
    height: content.readUInt32BE(20),
    colorType: content[25]
  };
}
