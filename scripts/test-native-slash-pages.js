#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  RemoteSessionController,
  formatNativeSlashOutput,
  isCompleteStatusSlashOutput
} = require('../src/remoteSessionController');
const feishuPlugin = require('../src/plugins/feishu');

async function main() {
  testResumePickerOutput();
  testResumeRowsOutput();
  testResumeDisabledOutput();
  testPermissionsPickerOutput();
  testPermissionsLoadingDoesNotLeakPreviousAnswer();
  testStatusOutput();
  testStatusOutputFiltersUsageLinkAndColorsQuotaLevels();
  testStatusOutputWithoutQuotaCanBeComplete();
  testPartialStatusOutputIsNotComplete();
  testFeishuResumeButtons();
  testFeishuPermissionsButtons();
  testFeishuStatusHasNoButtons();
  testFeishuNativeSlashPanelCard();
  testFeishuResumeActionFeedback();
  await testNativeSlashControlModes();
  await testNativeSlashStaticPanelFallback();
  console.log('Native slash page tests passed.');
}

function testResumePickerOutput() {
  const output = formatNativeSlashOutput({
    command: '/resume',
    snapshot: [
      'Resume a previous session',
      '> 1. Fix Feishu streaming cards',
      '  2. Update parser fixtures',
      '  3. Review workspace changes',
      'enter resume  esc exit'
    ].join('\n')
  });

  assert.equal(
    output,
    [
      '**/resume 会话列表**',
      '- 选择要恢复的历史会话。',
      '- 第 1/1 页，当前可见 3/3 项。',
      '',
      '**列表**',
      '> 1. Fix Feishu streaming cards',
      '- 2. Update parser fixtures',
      '- 3. Review workspace changes',
      '',
      '点击卡片里的上移/下移/恢复，或发送 `/up`、`/down`、`/enter`。'
    ].join('\n')
  );
}

function testResumeRowsOutput() {
  const output = formatNativeSlashOutput({
    command: '/resume',
    snapshot: [
      'Resume a previous session',
      '❯ just now Fix Feishu resume card',
      '  2h ago Parser regression tests',
      '  2026-05-29 Workspace review',
      '1 / 3',
      '↓ more'
    ].join('\n')
  });

  assert.equal(
    output,
    [
      '**/resume 会话列表**',
      '- 卡片显示 3/3 项，位置 1 / 3。',
      '',
      '**列表**',
      '> just now Fix Feishu resume card',
      '- 2h ago Parser regression tests',
      '- 2026-05-29 Workspace review',
      '',
      '还有更多历史会话；点击 Down 或发送 `/down` 继续浏览。',
      '',
      '点击 Enter 或发送 `/enter` 恢复选中的会话，发送 `/esc` 退出。'
    ].join('\n')
  );
}

function testResumeDisabledOutput() {
  const output = formatNativeSlashOutput({
    command: '/resume',
    snapshot: [
      "'/resume' disabled while a task is in progress"
    ].join('\n')
  });

  assert.match(output, /^\*\*\/resume\*\*/);
  assert.match(output, /当前 Codex 还在处理任务/);
}

function testPermissionsPickerOutput() {
  const output = formatNativeSlashOutput({
    command: '/permissions',
    snapshot: [
      'Update Model Permissions',
      '> 1. Default (current)  Codex can read and edit files in the current workspace, and run commands. Approval is required',
      '                        to access the internet or edit other files.',
      '  2. Auto-review        Same workspace-write permissions as Default, but eligible `on-request` approvals are routed',
      '                        through the auto-reviewer subagent.',
      '  3. Full Access        Codex can edit files outside this workspace and access the internet without asking for',
      '                        approval. Exercise caution when using.',
      'Press enter to confirm or esc to go back'
    ].join('\n')
  });

  assert.match(output, /^\*\*权限模式\*\*/);
  assert.match(output, /当前模式: `Default`/);
  assert.match(output, /点击下方模式按钮会立即应用/);
  assert.match(output, /> 1\. Default \(current\)/);
  assert.match(output, /- 2\. Auto-review/);
  assert.match(output, /- 3\. Full Access/);
  assert.doesNotMatch(output, /点击上移\/下移切换选项/);
}

function testPermissionsLoadingDoesNotLeakPreviousAnswer() {
  const output = formatNativeSlashOutput({
    command: '/permissions',
    snapshot: [
      '当前在 main 分支，远程是 origin。',
      '已提交并推送到远程仓库。',
      '提交号：22e539d。',
      '/permissions choose what Codex is allowed to do'
    ].join('\n')
  });

  assert.equal(
    output,
    '**权限模式**\n- 正在读取当前权限模式。\n- 可直接选择 Default、Auto-review 或 Full Access。'
  );
  assert.doesNotMatch(output, /22e539d|origin|已提交并推送/);
}

function testStatusOutput() {
  const output = formatNativeSlashOutput({
    command: '/status',
    snapshot: [
      '>_ OpenAI Codex (v0.42.0)',
      'Model: gpt-5-codex',
      'Permissions: workspace-write',
      'Directory: /tmp/project',
      'Session: abc123',
      '5h limit: [████░░░░] 50% left (resets 12:00)'
    ].join('\n')
  });

  assert.match(output, /^\*\*Codex 状态\*\*/);
  assert.match(output, /- 版本: `v0\.42\.0`/);
  assert.match(output, /- 模型: gpt-5-codex/);
  assert.match(output, /- 5 小时额度: 余量适中 50% 剩余/);
}

function testStatusOutputFiltersUsageLinkAndColorsQuotaLevels() {
  const output = formatNativeSlashOutput({
    command: '/status',
    colorMarkers: true,
    snapshot: [
      '>_ OpenAI Codex (v0.135.0)',
      'Visit https://chatgpt.com/codex/settings/usage for up-to-date',
      'information on rate limits and credits',
      'Model: gpt-5.5',
      'Session: abc123',
      '5h limit: [████░░░░] 22% left (resets 04:44)',
      'Weekly limit: [████████░░] 88% left (resets 23:44 on 7 Jun)'
    ].join('\n')
  });

  assert.doesNotMatch(output, /chatgpt\.com|rate limits and credits/);
  assert.match(output, /rgba\(255,107,107,1\).*5 小时额度: 余量紧张 22% 剩余/);
  assert.match(output, /rgba\(110,231,183,1\).*每周额度: 余量充足 88% 剩余/);
  assert.equal(isCompleteStatusSlashOutput(output), true);
}

function testStatusOutputWithoutQuotaCanBeComplete() {
  const output = formatNativeSlashOutput({
    command: '/status',
    snapshot: [
      '>_ OpenAI Codex (v0.135.0)',
      'Model: gpt-5.5 (reasoning medium, summaries auto)',
      'Directory: ~/下载/temp/article/codex-electron-shell',
      'Permissions: Workspace (on-request)',
      'Agents.md: <none>',
      'Account: user@example.com (Plus)',
      'Collaboration mode: Default',
      'Session: 019e7f11-19e9-76c0-bafa-9ee0da0ecb01'
    ].join('\n')
  });

  assert.match(output, /\*\*运行信息\*\*/);
  assert.doesNotMatch(output, /\*\*剩余用量\*\*/);
  assert.match(output, /\*\*用量提示\*\*/);
  assert.match(output, /重新发送 `\/status` 重试/);
  assert.equal(isCompleteStatusSlashOutput(output), true);
}

function testPartialStatusOutputIsNotComplete() {
  const output = formatNativeSlashOutput({
    command: '/status',
    snapshot: [
      '>_ OpenAI Codex (v0.135.0)',
      'Visit https://chatgpt.com/codex/settings/usage for up-to-date',
      'information on rate limits and credits'
    ].join('\n')
  });

  assert.equal(output, '**Codex 状态**\n- 版本: `v0.135.0`');
  assert.equal(isCompleteStatusSlashOutput(output), false);
}

function testFeishuResumeButtons() {
  const card = feishuPlugin.__private.buildStreamingCard({
    title: 'Remote Codex /resume',
    initialText: '**/resume 会话列表**',
    controlMode: 'resume'
  });
  const actions = card.body.elements.find((element) => element.tag === 'action').actions;
  const labels = actions.map((action) => action.text.content);
  const values = actions.map((action) => action.value.remote_codex_action);

  assert.deepEqual(labels, ['上移', '下移', '恢复', '退出']);
  assert.deepEqual(values, ['up', 'down', 'enter', 'escape']);
  assert.deepEqual(
    actions.map((action) => action.value.remote_codex_page),
    ['/resume', '/resume', '/resume', '/resume']
  );
  assert.equal(card.header.template, 'blue');
}

function testFeishuPermissionsButtons() {
  const card = feishuPlugin.__private.buildStreamingCard({
    title: 'Remote Codex /permissions',
    initialText: '**权限选项**',
    controlMode: 'permissions'
  });
  const actions = card.body.elements.find((element) => element.tag === 'action').actions;

  assert.deepEqual(
    actions.map((action) => action.text.content),
    ['Default', 'Auto-review', 'Full Access']
  );
  assert.deepEqual(
    actions.map((action) => action.value.remote_codex_page),
    ['/permissions', '/permissions', '/permissions']
  );
  assert.deepEqual(
    actions.map((action) => action.value.remote_codex_action),
    ['permission_default', 'permission_auto_review', 'permission_full_access']
  );
}

function testFeishuStatusHasNoButtons() {
  const card = feishuPlugin.__private.buildStreamingCard({
    title: 'Remote Codex /status',
    initialText: '**Codex 状态**',
    controlMode: 'status'
  });
  assert.equal(card.body.elements.some((element) => element.tag === 'action'), false);
}

function testFeishuNativeSlashPanelCard() {
  const card = feishuPlugin.__private.buildPanelCard({
    kind: 'native_slash',
    title: 'Remote Codex /resume',
    command: '/resume',
    content: [
      '**/resume 会话列表**',
      '- 卡片显示 2/2 项，位置 1 / 2。',
      '',
      '**列表**',
      '> just now Fix resume card',
      '- 2h ago Parser tests'
    ].join('\n'),
    actions: ['up', 'down', 'enter', 'escape']
  });
  const markdown = card.elements.find((element) => element.tag === 'markdown').content;
  const actions = card.elements.find((element) => element.tag === 'action').actions;

  assert.match(markdown, /\*\*历史会话\*\*/);
  assert.match(markdown, /当前选择:/);
  assert.match(markdown, /just now Fix resume card/);
  assert.deepEqual(
    actions.map((action) => action.text.content),
    ['上移', '下移', '恢复', '退出']
  );
  assert.equal(card.header.title.content, 'Remote Codex /resume');
}

function testFeishuResumeActionFeedback() {
  const resumeCard = feishuPlugin.__private.buildActionStateCard({
    action: 'enter',
    page: '/resume',
    status: 'submitted'
  });
  const resumeMarkdown = resumeCard.elements.find(
    (element) => element.tag === 'markdown'
  ).content;
  assert.match(resumeMarkdown, /正在恢复会话/);
  assert.match(resumeMarkdown, /等待 Codex 切换到所选会话/);

  const navigationText = feishuPlugin.__private.buildStreamingActionFeedback({
    action: 'down',
    page: '/resume',
    currentText: '**/resume 会话列表**\n> selected'
  });
  assert.match(navigationText, /resume 会话列表/);
  assert.match(navigationText, /\*\*操作状态\*\*/);
  assert.match(navigationText, /正在更新当前选项/);
}

async function testNativeSlashControlModes() {
  const controller = createController();
  assert.equal(await captureControlMode(controller, '/resume'), 'resume');
  assert.equal(await captureControlMode(controller, '/permissions'), 'permissions');
  assert.equal(await captureControlMode(controller, '/status'), 'status');
}

async function testNativeSlashStaticPanelFallback() {
  const controller = createController();
  const key = 'feishu:chat';
  const replies = [];
  const panels = [];
  const writes = [];
  const snapshot = [
    'Resume a previous session',
    '❯ just now Fix Feishu resume card',
    '  2h ago Parser regression tests',
    '1 / 2'
  ].join('\n');
  controller.sessions.set(key, {
    key,
    pluginId: 'feishu',
    conversationId: 'chat',
    reply: async (text) => replies.push(text),
    replyPanel: async (panel) => panels.push(panel),
    session: {
      id: 's1',
      visualSnapshot: snapshot,
      visualViewportSnapshot: snapshot,
      write(input) {
        writes.push(input);
      },
      readAfter() {
        return { chunks: [] };
      },
      status() {
        return { exited: false };
      }
    },
    shared: true,
    cursor: 0,
    outputBuffer: '',
    flushTimer: null,
    streamFinishTimer: null,
    streamHeartbeatTimer: null,
    pendingReplyTimer: null,
    createReplyStream: null,
    replyStream: null,
    lastReplyText: '',
    lastStreamText: '',
    lastSentReplyText: '',
    pendingReplyText: '旧的最终回答不应该在 /resume 前被发送',
    streamedThisTurn: false,
    streamFinishedForTurn: false,
    streamClosedText: '',
    controlActionLocks: new Map(),
    lastApprovalSignature: '',
    lastInputText: '',
    nativeCommand: null,
    turnStartedAt: 0,
    stopped: false
  });

  await controller.handleNativeSlashCommand(
    key,
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      reply: async (text) => replies.push(text),
      replyPanel: async (panel) => panels.push(panel)
    },
    '/resume'
  );
  controller.queueOutput(controller.sessions.get(key), 'resume screen changed');
  await wait(10);

  assert.equal(replies.length, 0);
  assert.equal(panels.length, 1);
  assert.equal(panels[0].kind, 'native_slash');
  assert.equal(panels[0].command, '/resume');
  assert.match(panels[0].content, /\*\*\/resume 会话列表\*\*/);
  assert.doesNotMatch(panels[0].content, /旧的最终回答/);
  assert.ok(writes.length > 0);
}

async function captureControlMode(controller, command) {
  let controlMode = '';
  const state = {
    createReplyStream: async (options) => {
      controlMode = options.controlMode;
      return {
        async update() {},
        async finish() {}
      };
    },
    nativeCommand: { command },
    turnStartedAt: Date.now(),
    replyStream: null,
    streamHeartbeatTimer: null,
    streamFinishTimer: null,
    streamedThisTurn: false,
    streamFinishedForTurn: false,
    streamClosedText: '',
    lastStreamText: ''
  };
  await controller.startReplyStream(state, {});
  controller.clearStreamHeartbeat(state);
  return controlMode;
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
