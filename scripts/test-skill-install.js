#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const source = path.join(projectRoot, 'skills', 'remote-codex-send-files');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-install-'));
const home = path.join(root, 'home');
const codexHome = path.join(root, 'codex-home');
const installed = path.join(codexHome, 'skills', 'remote-codex-send-files');

try {
  fs.mkdirSync(home, { recursive: true });
  runInstaller();
  assertInstalledFilesMatch();

  fs.writeFileSync(path.join(installed, 'SKILL.md'), 'stale skill\n');
  runInstaller();
  assertInstalledFilesMatch();
  console.log('Remote Codex skill installation tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function runInstaller() {
  const result = spawnSync('bash', ['scripts/install-launchers.sh'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(escapeRegExp(installed)));
}

function assertInstalledFilesMatch() {
  assert.equal(
    fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8')
  );
  assert.equal(
    fs.readFileSync(path.join(installed, 'agents', 'openai.yaml'), 'utf8'),
    fs.readFileSync(path.join(source, 'agents', 'openai.yaml'), 'utf8')
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
