#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  buildRemoteInputNotice,
  sanitizeNoticeText
} = require('../src/remoteVisualNotice');

const longText = [
  '第一行很长很长'.repeat(20),
  '第二行也很长'.repeat(20),
  '\x1b[31mred\x1b[0m'
].join('\n');

const notice = buildRemoteInputNotice({
  source: 'Feishu',
  userId: 'ou_user\nbad',
  text: longText,
  cols: 80
});

assert.match(notice, /^\r\n\x1b\[2K\x1b\[38;5;111m\[Remote Codex\]/);
assert.match(notice, /received \d+ chars:/);
assert.match(notice, /…/);
assert.doesNotMatch(notice, /第二行也很长/);
assert.doesNotMatch(notice, /\x1b\[31m/);
assert.doesNotMatch(notice, /\n.+\n.+\n/);
assert.equal(sanitizeNoticeText('a\nb\tc'), 'a b c');

console.log('Remote visual notice tests passed.');
