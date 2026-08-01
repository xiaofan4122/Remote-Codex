#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  parseLaunchOptions,
  buildCodexArgs
} = require('../src/launchOptions');

const baseArgs = ['--no-alt-screen'];

const normal = parseLaunchOptions(
  ['electron', '.', '--model', 'gpt-5', 'Review the changes'],
  {}
);
assert.deepEqual(normal.args, ['--model', 'gpt-5', 'Review the changes']);
assert.deepEqual(normal.codexArgs, ['--model', 'gpt-5', 'Review the changes']);
assert.equal(normal.resumeArgs, null);
assert.deepEqual(buildCodexArgs(baseArgs, normal), [
  '--no-alt-screen',
  '--model',
  'gpt-5',
  'Review the changes'
]);

const packaged = parseLaunchOptions(
  ['remote-codex', '--search', '--sandbox', 'workspace-write'],
  {},
  { packaged: true }
);
assert.deepEqual(packaged.codexArgs, ['--search', '--sandbox', 'workspace-write']);
assert.deepEqual(buildCodexArgs(baseArgs, packaged), [
  '--no-alt-screen',
  '--search',
  '--sandbox',
  'workspace-write'
]);

const separator = parseLaunchOptions(
  ['electron', '.', '--', '--help'],
  {}
);
assert.deepEqual(buildCodexArgs(baseArgs, separator), [
  '--no-alt-screen',
  '--',
  '--help'
]);

const resumeAlias = parseLaunchOptions(
  ['electron', '.', '--model', 'gpt-5', '--resume', 'session-id', 'Continue'],
  {}
);
assert.deepEqual(resumeAlias.codexArgs, ['--model', 'gpt-5']);
assert.deepEqual(resumeAlias.resumeArgs, ['session-id', 'Continue']);
assert.deepEqual(buildCodexArgs(baseArgs, resumeAlias), [
  'resume',
  '--no-alt-screen',
  '--model',
  'gpt-5',
  'session-id',
  'Continue'
]);

const nativeResume = parseLaunchOptions(
  ['electron', '.', 'resume', '--last'],
  {}
);
assert.deepEqual(buildCodexArgs(baseArgs, nativeResume), [
  'resume',
  '--no-alt-screen',
  '--last'
]);

const resumeLastAlias = parseLaunchOptions(
  ['electron', '.', '--model', 'gpt-5', '--resume-last', 'Continue'],
  {}
);
assert.deepEqual(buildCodexArgs(baseArgs, resumeLastAlias), [
  'resume',
  '--no-alt-screen',
  '--model',
  'gpt-5',
  '--last',
  'Continue'
]);

const environmentResume = parseLaunchOptions(
  ['electron', '.', '--search'],
  {
    REMOTE_CODEX_RESUME: 'last',
    REMOTE_CODEX_RESUME_PROMPT: 'Continue'
  }
);
assert.deepEqual(buildCodexArgs(baseArgs, environmentResume), [
  'resume',
  '--no-alt-screen',
  '--search',
  '--last',
  'Continue'
]);

const resumeDisabled = parseLaunchOptions(
  ['electron', '.', '--no-resume', '--model', 'gpt-5'],
  { REMOTE_CODEX_RESUME: 'last' }
);
assert.equal(resumeDisabled.resumeArgs, null);
assert.deepEqual(buildCodexArgs(baseArgs, resumeDisabled), [
  '--no-alt-screen',
  '--model',
  'gpt-5'
]);

assert.deepEqual(baseArgs, ['--no-alt-screen']);

console.log('Launch option tests passed.');
