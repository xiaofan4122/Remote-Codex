#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  hasActiveVisualIndicators,
  hasIdlePromptAfterSubmittedPrompt,
  hasVisibleIdlePrompt,
  hasVisibleSubmittedPrompt,
  isVisualTurnSettled
} = require('../src/visualSessionState');

function main() {
  testActiveSignalsKeepTurnBusy();
  testPromptSuggestionsDoNotKeepTurnBusy();
  testSubmittedPromptBoundary();
  testVisibleSubmittedPromptWithoutNewPromptIsNotSettled();
  testSnapshotLineRecords();
  console.log('Visual session state tests passed.');
}

function testActiveSignalsKeepTurnBusy() {
  for (const line of [
    'Working (8s • esc to interrupt)',
    '• Working (8s • esc to interrupt)',
    '- Thinking',
    '• Booting MCP server: codex_apps (7s • esc to interrupt)',
    '⠙ Running shell command',
    'Would you like to run this command?'
  ]) {
    assert.equal(hasActiveVisualIndicators(line), true, line);
    assert.equal(isVisualTurnSettled(state(line)), false, line);
  }
}

function testPromptSuggestionsDoNotKeepTurnBusy() {
  const snapshot = [
    '› 你好',
    '',
    '• 你好。需要我在这个 codex-electron-shell 项目里处理什么问题？',
    '',
    '› Write tests for @filename'
  ].join('\n');

  assert.equal(hasVisibleIdlePrompt(snapshot), true);
  assert.equal(hasActiveVisualIndicators(snapshot), false);
  assert.equal(isVisualTurnSettled(state(snapshot)), true);
}

function testSubmittedPromptBoundary() {
  const snapshot = [
    '› 你好',
    '• 你好。需要我处理什么问题？',
    '› 任意新的建议提示文本'
  ].join('\n');

  assert.equal(hasIdlePromptAfterSubmittedPrompt(snapshot, '你好'), true);
  assert.equal(hasIdlePromptAfterSubmittedPrompt(snapshot, '不存在的输入'), false);
}

function testVisibleSubmittedPromptWithoutNewPromptIsNotSettled() {
  const input = '你好，请你看一下当前的文件夹里有多少个文件，每个文件有多少行';
  const snapshot = [
    `› ${input}`,
    '• Explored',
    '  └ Search ./.git/* in .',
    '• 递归统计包含了 node_modules，所以总数很大：3942 个文件，逐文件输出已经超过终端返回上限。为了给你一个可读结果，我再单独统计当前目录'
  ].join('\n');

  assert.equal(hasVisibleSubmittedPrompt(snapshot, input), true);
  assert.equal(hasIdlePromptAfterSubmittedPrompt(snapshot, input), false);
  assert.equal(isVisualTurnSettled(state(snapshot, input)), false);
}

function testSnapshotLineRecords() {
  const snapshot = {
    lines: [
      { text: 'Remote Codex' },
      { text: '• Working (2s • esc to interrupt)' },
      { text: '› Find and fix a bug in @filename' }
    ]
  };

  assert.equal(hasActiveVisualIndicators(snapshot), true);
  assert.equal(hasVisibleIdlePrompt(snapshot), true);
}

function state(snapshot, lastInputText = '') {
  return {
    lastInputText,
    session: {
      visualSnapshot: snapshot,
      visualViewportSnapshot: ''
    }
  };
}

main();
