#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultConfig, saveConfig } = require('../src/config');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-config-security-'));
const configPath = path.join(testRoot, 'nested', 'remote-codex.json');

try {
  saveConfig(defaultConfig, { configPath });
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);

  fs.chmodSync(configPath, 0o644);
  saveConfig(defaultConfig, { configPath });
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);

  console.log('Remote Codex config permission tests passed.');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
