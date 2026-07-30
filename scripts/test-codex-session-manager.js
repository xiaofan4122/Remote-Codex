#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  isCodexUpdateSuccessOutput,
  sanitizeInheritedCodexPackageManagerEnv
} = require('../src/codexSessionManager');

function main() {
  const env = sanitizeInheritedCodexPackageManagerEnv({
    PATH: '/usr/bin',
    npm_config_user_agent: 'bun/1.2.0 npm/? node/v22',
    npm_execpath: '/home/ubuntu/.bun/bin/bun',
    CODEX_MANAGED_BY_BUN: '1',
    CODEX_MANAGED_BY_NPM: '1',
    CODEX_MANAGED_PACKAGE_ROOT: '/stale/codex'
  });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.npm_config_user_agent, undefined);
  assert.equal(env.npm_execpath, undefined);
  assert.equal(env.CODEX_MANAGED_BY_BUN, undefined);
  assert.equal(env.CODEX_MANAGED_BY_NPM, undefined);
  assert.equal(env.CODEX_MANAGED_PACKAGE_ROOT, undefined);

  assert.equal(
    isCodexUpdateSuccessOutput([
      'Updating Codex via `npm install -g @openai/codex`...',
      'changed 2 packages in 13s',
      '',
      '🎉 Update ran successfully! Please restart Codex.'
    ].join('\n')),
    true
  );
  assert.equal(
    isCodexUpdateSuccessOutput('Update ran successfully but no restart wording'),
    false
  );
  assert.equal(
    isCodexUpdateSuccessOutput('Codex exited normally.'),
    false
  );

  console.log('Codex session manager tests passed.');
}

main();
