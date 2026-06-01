#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  buildResumeHint,
  extractCodexSessionId,
  shellQuote
} = require('../src/resumeHint');

const sessionId = '019e7f11-19e9-76c0-bafa-9ee0da0ecb01';

assert.equal(
  extractCodexSessionId([
    '>_ OpenAI Codex',
    'Model: gpt-5.5',
    `Session: ${sessionId}`
  ].join('\n')),
  sessionId
);

assert.equal(shellQuote('/tmp/project'), '/tmp/project');
assert.equal(shellQuote('/tmp/project with spaces'), "'/tmp/project with spaces'");

const hinted = buildResumeHint({
  command: 'remote-codex',
  cwd: '/tmp/project with spaces',
  session: {
    cwd: '/tmp/project with spaces',
    visualSnapshot: `Session: ${sessionId}`
  }
});
assert.match(hinted, /cd '\/tmp\/project with spaces'/);
assert.match(hinted, new RegExp(`remote-codex --resume ${sessionId}`));
assert.match(hinted, /remote-codex --resume .* '继续刚才的任务'/);
assert.doesNotMatch(hinted, /--last/);

const fallback = buildResumeHint({
  command: 'remote-codex',
  cwd: '/tmp/project',
  session: { visualSnapshot: '› ' }
});
assert.match(fallback, /remote-codex --resume --last/);
assert.match(fallback, /未能从当前画面读取原生 Codex Session ID/);

console.log('Resume hint tests passed.');
