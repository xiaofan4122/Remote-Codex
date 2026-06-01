#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  RemoteSessionController,
  classifyTerminalColorRole,
  formatVisualProgressSnapshot,
  formatVisualSnapshot,
  parseCodexProgressState
} = require('../src/remoteSessionController');

async function main() {
  smokeBulletProgress();
  await smokeWorkingHeartbeat();
  await smokeStreamFinishState();
  await smokeFinalUpdateFailureFallback();
  console.log('Remote streaming smoke passed.');
}

function smokeBulletProgress() {
  const input = '帮我改飞书富文本';
  const snapshot = [
    `› ${input}`,
    '• 我先检查飞书消息解析入口',
    '• Read src/plugins/feishu/index.js',
    '  Found the parser only keeps plain text content.',
    '• Edited src/plugins/feishu/index.js'
  ].join('\n');

  const progress = formatVisualProgressSnapshot(snapshot, input);
  assert.match(progress, /- 我先检查飞书消息解析入口/);
  assert.match(progress, /- 正在检查代码/);
  assert.match(progress, /- 正在修改/);
  assert.doesNotMatch(progress, /src\/plugins\/feishu\/index\.js|Found the parser/);

  const finalSnapshot = [
    `› ${input}`,
    '• 我会建议你先保留当前实现。'
  ].join('\n');
  assert.equal(
    formatVisualSnapshot(finalSnapshot, input),
    '我会建议你先保留当前实现。'
  );
  assert.equal(formatVisualProgressSnapshot(finalSnapshot, input), '');

  const reviewInput = '审阅当前工作空间中的代码';
  const reviewProgress = [
    `› ${reviewInput}`,
    '• 基础检查都过了，但我还要用小型复现验证两个边界：中文最终回答以 • 我会... 开头是否被误过滤，以及流式 update 失败后是否',
    '  还有普通文本兜底。',
    '• Ran node -c scripts/smoke-remote-streaming.js',
    '• Ran node -e "const {formatVisualSnapshot,formatVisualProgressSnapshot}=require(\'./src/remoteSessionController\'); const',
    "  │ input='测试'; const snap=['› '+input,'• 我会建议你先保留当前实现。'].join('\\\\n');",
    '  │ console.log(JSON.stringify({final:formatVisualSnapshot(snap,input),progress:formatVisualProgressSnapshot(snap,inpu',
    '• Explored',
    '  └ Search isLikelyProgressMarkerText|stream_already_sent|updateReplyStream\\(|startReplyStream|FeishuReplyStream|',
    '           finish\\(text\\)|currentText = nextText in remoteSessionController.js'
  ].join('\n');
  const renderedReviewProgress = formatVisualProgressSnapshot(reviewProgress, reviewInput);
  assert.match(renderedReviewProgress, /- 基础检查都过了/);
  assert.match(renderedReviewProgress, /还有普通文本兜底/);
  assert.match(renderedReviewProgress, /- 正在验证/);
  assert.match(renderedReviewProgress, /- 正在检查代码/);
  assert.doesNotMatch(renderedReviewProgress, /node -c|node -e|│ input|Search isLikelyProgressMarkerText/);

  const styledReviewProgress = {
    lines: [
      { text: `› ${reviewInput}` },
      {
        text: '• Ran node -c scripts/smoke-remote-streaming.js',
        firstChar: '•',
        bulletStyle: { fgMode: 'palette', fg: 4, bgMode: 'default', bg: 0 }
      }
    ]
  };
  const renderedStyledProgress = formatVisualProgressSnapshot(
    styledReviewProgress,
    reviewInput
  );
  assert.match(renderedStyledProgress, /- 正在验证/);
  const renderedStyledColorProgress = formatVisualProgressSnapshot(
    styledReviewProgress,
    reviewInput,
    { colorMarkers: true }
  );
  assert.match(
    renderedStyledColorProgress,
    /<!--remote-codex-color:rgba\(96,165,250,1\)-->/
  );

  const parsedStyledProgress = parseCodexProgressState(
    styledReviewProgress.lines.slice(1)
  );
  assert.equal(parsedStyledProgress.items[0].colorRole, 'command');
  assert.equal(
    classifyTerminalColorRole({ fgMode: 'palette', fg: 2 }),
    'success'
  );

  const controller = createController();
  const fallbackProgress = controller.formatStreamingStateOutput(
    {
      shared: true,
      pluginId: 'feishu',
      session: { visualSnapshot: 'Working...' },
      lastInputText: reviewInput
    },
    reviewProgress,
    ''
  );
  assert.match(fallbackProgress, /- 基础检查都过了/);
  assert.match(fallbackProgress, /- (?:<!--remote-codex-color:[^>]+-->)?正在验证/);
  assert.doesNotMatch(fallbackProgress, /node -e|Search isLikelyProgressMarkerText/);

  const classifiedStreamProgress = controller.formatStreamingStateOutput(
    {
      shared: true,
      pluginId: 'feishu',
      session: { visualStyledSnapshot: reviewProgress, visualSnapshot: '' },
      lastInputText: reviewInput
    },
    '',
    ''
  );
  assert.match(classifiedStreamProgress, /- 基础检查都过了/);
  assert.match(classifiedStreamProgress, /还有普通文本兜底/);
  assert.match(classifiedStreamProgress, /- (?:<!--remote-codex-color:[^>]+-->)?正在验证/);
  assert.match(classifiedStreamProgress, /- (?:<!--remote-codex-color:[^>]+-->)?正在检查代码/);
  assert.doesNotMatch(
    classifiedStreamProgress,
    /node -c|node -e|src\/remoteSessionController\.js|Search isLikelyProgressMarkerText/
  );
}

async function smokeWorkingHeartbeat() {
  const updates = [];
  let initialText = '';
  const controller = createController();
  const state = {
    createReplyStream: async ({ initialText: text }) => {
      initialText = text;
      return {
        async update(value) {
          updates.push(value);
        },
        async finish() {}
      };
    },
    nativeCommand: null,
    turnStartedAt: Date.now() - 6000,
    replyStream: null,
    streamFinishTimer: null,
    streamHeartbeatTimer: null,
    streamedThisTurn: false,
    streamFinishedForTurn: false,
    streamClosedText: '',
    lastStreamText: '',
    lastSentReplyText: ''
  };

  await controller.startReplyStream(state, {});
  assert.match(initialText, /\*\*进度\*\*\n- Working \(\d+s\)/);

  state.lastStreamText = '**进度**\n- 正在验证';
  controller.sendWorkingHeartbeat(state);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(updates.at(-1), /\*\*进度\*\*\n- Working \(\d+s\)/);
  assert.match(updates.at(-1), /- 正在验证/);
  controller.clearStreamHeartbeat(state);
}

async function smokeStreamFinishState() {
  let finishedText = '';
  const controller = createController();
  const state = {
    replyStream: {
      async update() {},
      async finish(text) {
        finishedText = text;
      }
    },
    streamFinishTimer: null,
    streamedThisTurn: false,
    streamFinishedForTurn: false,
    streamClosedText: '',
    lastSentReplyText: '',
    turnStartedAt: Date.now()
  };

  controller.updateReplyStream(state, '**回复**\n完成', {
    final: true,
    finishDelayMs: 1
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finishedText, '**回复**\n完成');
  assert.equal(state.replyStream, null);
  assert.equal(state.streamedThisTurn, true);
  assert.equal(state.streamFinishedForTurn, true);
  assert.equal(state.lastSentReplyText, '**回复**\n完成');
  assert.equal(state.turnStartedAt, 0);
}

async function smokeFinalUpdateFailureFallback() {
  let fallbackText = '';
  const controller = createController();
  const state = {
    replyStream: {
      async update() {},
      async finish() {
        const error = new Error('final update failed');
        error.finalUpdateFailed = true;
        throw error;
      }
    },
    reply: async (text) => {
      fallbackText = text;
    },
    session: { id: 'test-session' },
    pluginId: 'test',
    conversationId: 'test',
    streamFinishTimer: null,
    streamHeartbeatTimer: null,
    streamedThisTurn: false,
    streamFinishedForTurn: false,
    streamClosedText: '',
    lastSentReplyText: '',
    turnStartedAt: Date.now()
  };

  controller.updateReplyStream(state, '**回复**\n完成', {
    final: true,
    finishDelayMs: 1
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fallbackText, '**回复**\n完成');
  assert.equal(state.lastSentReplyText, '**回复**\n完成');
  assert.equal(state.turnStartedAt, 0);
}

function createController() {
  return new RemoteSessionController({
    sessionManager: null,
    logger: {
      event() {},
      warn() {}
    },
    config: {
      remoteControl: {
        sendOutput: true,
        outputMode: 'final',
        flushIntervalMs: 1,
        finalReplyDebounceMs: 1
      },
      plugins: {}
    }
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
