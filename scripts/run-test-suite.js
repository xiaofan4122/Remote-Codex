#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptsDirectory = __dirname;
const tests = fs.readdirSync(scriptsDirectory)
  .filter((name) => /^test-.*\.js$/.test(name))
  .sort();

for (const test of tests) {
  const relativePath = path.join('scripts', test);
  process.stdout.write(`\n[remote-codex:test] ${relativePath}\n`);
  const result = spawnSync(process.execPath, [relativePath], {
    cwd: path.resolve(scriptsDirectory, '..'),
    env: process.env,
    stdio: 'inherit'
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log(`\nRemote Codex test suite passed (${tests.length} files).`);
