#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  LocalTerminalInputTracker,
  resolveLocalSubmissionPrompt,
  shouldObserveLocalSubmission
} = require('../src/localTerminalInputTracker');

const tracker = new LocalTerminalInputTracker();
assert.equal(tracker.push('\r'), null);
tracker.push('本地任务');
assert.deepEqual(tracker.push('\r'), {
  text: '本地任务',
  needsSnapshotText: false
});

tracker.push('\x1b[200~第一行\n第二行\x1b[201~');
assert.deepEqual(tracker.push('\r'), {
  text: '第一行\n第二行',
  needsSnapshotText: false
});

tracker.push('abc');
tracker.push('\x7f');
assert.deepEqual(tracker.push('\r'), {
  text: 'ab',
  needsSnapshotText: false
});

tracker.push('\x1b[A');
const historySubmission = tracker.push('\r');
assert.equal(historySubmission.needsSnapshotText, true);
assert.equal(
  resolveLocalSubmissionPrompt(historySubmission, '› 从历史记录恢复的任务'),
  '从历史记录恢复的任务'
);

assert.equal(shouldObserveLocalSubmission('普通本地任务'), true);
assert.equal(shouldObserveLocalSubmission('/compact'), true);
assert.equal(shouldObserveLocalSubmission('/plan 制定发布计划'), true);
assert.equal(shouldObserveLocalSubmission('/status'), false);
assert.equal(shouldObserveLocalSubmission('/resume'), false);
assert.equal(shouldObserveLocalSubmission(''), false);

console.log('Local terminal turn sync tests passed.');
