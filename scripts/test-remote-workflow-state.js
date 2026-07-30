#!/usr/bin/env node

const assert = require('node:assert/strict');
const { RemoteSessionController } = require('../src/remoteSessionController');
const feishuPlugin = require('../src/plugins/feishu');

async function main() {
  testStructuredRunnerSelection();
  await testHistoricalMessagesAreIgnoredAfterStartup();
  await testAcceptedFeishuMessageGetsAckReaction();
  await testInvalidAckReactionFallsBackToOk();
  await testAcceptedFeishuMessageGetsDoneReactionAfterDispatch();
  await testStartupNotice();
  await testStopInterruptsWithoutClosingSession();
  await testStaleBusyStateDoesNotBlockNewInput();
  await testVisibleIdlePromptDoesNotBlockNewInput();
  await testNewInputPreservesPendingFinalReply();
  await testRemoteInputWritesBeforeReplyStreamReady();
  await testOutputWaitsForPendingReplyStream();
  await testActiveVisualStateQueuesNewInput();
  await testClosingCardQueuesNewInput();
  await testDoneReactionWaitsForSettledVisualTurn();
  await testPromptSuggestionSettlesVisualTurn();
  await testLocalMistypedStatusPageSendsSeparatePanel();
  testSessionPhases();
  await testResumeNavigationPatchesOriginalCard();
  await testResumeEnterShowsImmediateFeedback();
  await testStreamingCardActionShowsImmediateFeedback();
  await testStreamingNavigationDoesNotShowIntermediateFeedback();
  await testCreatedStreamingCardIsLinkedToMessage();
  await testSharedVisualStreamDoesNotReplayStaleProgress();
  await testResumeStreamStaysOpenAcrossPageRefreshes();
  await testOpenResumeCommandReusesExistingCard();
  await testStatusResizeRedrawDoesNotSpamStream();
  await testNativeSlashDoesNotSendPanelWhileStreamStarts();
  await testIncompleteStatusDoesNotSendStaticPanel();
  await testClosedNativeStreamDoesNotSendTrailingPanel();
  await testNativeNavigationAllowsOriginalPanelRefresh();
  await testPermissionModeButtonSelectsAndConfirms();
  await testGenericModelPickerNavigationAndCompletion();
  await testReviewPickerTransitionsToNextRolloutTask();
  await testNativeReportCompletesAndReleasesNextInput();
  await testNativePickerLoadingAndUnsupportedFallback();
  await testNativeTextInputAcceptsNextRemoteMessage();
  await testSlashTaskBindsNextRolloutInsteadOfExactCommand();
  await testDestructiveNativeCommandIsBlocked();
  await testResumeEnterWaitsForConfirmedPageExit();
  await testNativePageExitClosesStream();
  await testResumeEnterAndExitControls();
  await testStaleResumeCardIsRejected();
  console.log('Remote workflow state tests passed.');
}

function testStructuredRunnerSelection() {
  const execRunner = { run() {} };
  const appServerRunner = { run() {} };
  const controller = new RemoteSessionController({
    sessionManager: null,
    execRunner,
    appServerRunner,
    config: {
      remoteControl: { responseSource: 'rollout_jsonl' },
      plugins: {
        exec: { responseSource: 'exec_json' },
        app: { responseSource: 'app_server' }
      }
    }
  });

  assert.equal(controller.getStructuredRunner('exec'), execRunner);
  assert.equal(controller.getStructuredRunner('app'), appServerRunner);
  assert.equal(controller.shouldUseStructuredRunner('exec'), true);
  assert.equal(controller.shouldUseStructuredRunner('app'), true);
  assert.equal(controller.shouldUseStructuredRunner('feishu'), false);
}

async function testHistoricalMessagesAreIgnoredAfterStartup() {
  const accepted = [];
  const plugin = createFeishuPlugin({
    remoteController: {
      async handleMessage(message) {
        accepted.push(message.text);
      }
    }
  });
  plugin.startedAtMs = 2000000000000;

  await plugin.handleReceiveMessage(feishuMessage('/status', '1999999999000', 'old'));
  await plugin.handleReceiveMessage(feishuMessage('/tail', '', 'missing-time'));
  await plugin.handleReceiveMessage(feishuMessage('/resume', '2000000001000', 'new'));
  await wait(0);

  assert.deepEqual(accepted, ['/resume']);
}

async function testAcceptedFeishuMessageGetsAckReaction() {
  const accepted = [];
  const reactions = [];
  const plugin = createFeishuPlugin({
    remoteController: {
      async handleMessage(message) {
        accepted.push(message.text);
      }
    }
  }, {
    ackReactionEnabled: true,
    ackReactionEmoji: '了解'
  });
  plugin.addMessageReaction = async (reaction) => {
    reactions.push(reaction);
  };

  await plugin.handleReceiveMessage(feishuMessage('/status', '2000000001000', 'om_ack'));
  await wait(0);

  assert.deepEqual(accepted, ['/status']);
  assert.deepEqual(reactions, [
    {
      messageId: 'om_ack',
      emojiType: 'Get'
    }
  ]);
}

async function testInvalidAckReactionFallsBackToOk() {
  const attempts = [];
  const plugin = createFeishuPlugin({
    remoteController: {
      async handleMessage() {}
    }
  }, {
    ackReactionEnabled: true,
    ackReactionEmoji: 'not_a_real_reaction'
  });
  plugin.addMessageReaction = async (reaction) => {
    attempts.push(reaction);
    if (reaction.emojiType !== 'OK') {
      throw new Error('reaction type is invalid');
    }
  };

  await plugin.handleReceiveMessage(feishuMessage('/status', '2000000001000', 'om_ack_fallback'));
  await wait(0);

  assert.deepEqual(attempts, [
    {
      messageId: 'om_ack_fallback',
      emojiType: 'NOT_A_REAL_REACTION'
    },
    {
      messageId: 'om_ack_fallback',
      emojiType: 'OK'
    }
  ]);
}

async function testAcceptedFeishuMessageGetsDoneReactionAfterDispatch() {
  const reactions = [];
  const plugin = createFeishuPlugin({
    remoteController: {
      async handleMessage(message) {
        await message.onTurnFinished();
      }
    }
  }, {
    ackReactionEnabled: true,
    ackReactionEmoji: 'hourglass',
    doneReactionEnabled: true,
    doneReactionEmoji: 'done'
  });
  plugin.addMessageReaction = async (reaction) => {
    reactions.push(reaction);
  };

  await plugin.handleReceiveMessage(feishuMessage('/status', '2000000001000', 'om_done'));
  await wait(0);

  assert.deepEqual(reactions, [
    {
      messageId: 'om_done',
      emojiType: 'HOURGLASS'
    },
    {
      messageId: 'om_done',
      emojiType: 'DONE'
    }
  ]);
}

async function testStartupNotice() {
  const sent = [];
  const plugin = createFeishuPlugin();
  plugin.pluginConfig.defaultChatId = 'oc_default';
  plugin.pluginConfig.allowedChatIds = ['oc_default', 'oc_team'];
  plugin.sendText = async (message) => sent.push(message);

  await plugin.sendStartupNotice();

  assert.deepEqual(
    sent.map((message) => message.receiveId),
    ['oc_default', 'oc_team']
  );
  assert.match(sent[0].text, /仅处理此消息之后发送的新指令/);
  assert.match(sent[0].text, /状态 `\/status`/);
  assert.match(sent[0].text, /历史会话 `\/resume`/);
  assert.match(sent[0].text, /权限模式 `\/permission`/);
  assert.match(sent[0].text, /飞书开发者后台配置悬浮菜单/);
}

async function testStopInterruptsWithoutClosingSession() {
  const controller = createController();
  const writes = [];
  const replies = [];
  const state = createState({
    turnStartedAt: Date.now(),
    write(input) {
      writes.push(input);
    }
  });
  controller.sessions.set('feishu:chat', state);

  await controller.handleMessage({
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    text: '/stop',
    reply: async (text) => replies.push(text)
  });

  assert.deepEqual(writes, ['\x1b']);
  assert.equal(controller.sessions.get('feishu:chat'), state);
  assert.match(replies.at(-1), /会话仍保持运行/);
}

async function testStaleBusyStateDoesNotBlockNewInput() {
  const controller = createController();
  const writes = [];
  const replies = [];
  const state = createState({
    turnStartedAt: Date.now() - 16943 * 1000,
    snapshot: '› ',
    write(input) {
      writes.push(input);
    }
  });
  state.lastInputText = 'old task';
  controller.sessions.set('feishu:chat', state);

  await controller.handleMessage({
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    text: 'new task',
    reply: async (text) => replies.push(text)
  });

  assert.equal(replies.length, 0);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /new task/);
  assert.equal(state.lastInputText, 'new task');
  assert.ok(state.turnStartedAt > Date.now() - 5000);
}

async function testVisibleIdlePromptDoesNotBlockNewInput() {
  const controller = createController();
  const writes = [];
  const replies = [];
  const state = createState({
    turnStartedAt: Date.now() - 40 * 1000,
    snapshot: [
      '上一条输出已经滚出可视区域。',
      '› '
    ].join('\n'),
    write(input) {
      writes.push(input);
    }
  });
  state.lastInputText = 'old task that is no longer visible';
  controller.sessions.set('feishu:chat', state);

  await controller.handleMessage({
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    text: 'new task',
    reply: async (text) => replies.push(text)
  });

  assert.equal(replies.length, 0);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /new task/);
  assert.equal(state.lastInputText, 'new task');
  assert.ok(state.turnStartedAt > Date.now() - 5000);
}

async function testNewInputPreservesPendingFinalReply() {
  const controller = createController();
  const writes = [];
  const replies = [];
  let finished = 0;
  let staleStreamFinished = 0;
  let staleStreamUnregistered = 0;
  const state = createState({
    turnStartedAt: Date.now() - 40 * 1000,
    snapshot: [
      '上一轮最终回复还留在屏幕里。',
      '› '
    ].join('\n'),
    write(input) {
      writes.push(input);
    }
  });
  state.lastInputText = 'old task';
  state.lastReplyText = 'old final reply';
  state.pendingReplyText = 'old final reply';
  state.pendingReplyTimer = setTimeout(() => {}, 10000);
  state.replyStream = {
    async finish() {
      staleStreamFinished += 1;
    },
    unregister() {
      staleStreamUnregistered += 1;
    }
  };
  controller.sessions.set('feishu:chat', state);

  await controller.handleMessage({
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    text: 'new task',
    reply: async (text) => replies.push(text),
    onTurnFinished: async () => {
      finished += 1;
    }
  });

  assert.deepEqual(replies, []);
  assert.equal(finished, 0);
  assert.equal(staleStreamFinished, 0);
  assert.equal(staleStreamUnregistered, 0);
  assert.equal(state.pendingReplyText, 'old final reply');
  assert.ok(state.pendingReplyTimer);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /new task/);
  assert.equal(state.queuedMessages.length, 1);
  clearTimeout(state.pendingReplyTimer);
  state.pendingReplyTimer = null;
}

async function testRemoteInputWritesBeforeReplyStreamReady() {
  const controller = createController();
  const writes = [];
  let resolveStream;
  let handleResolved = false;
  const state = createState({
    snapshot: '› ',
    write(input) {
      writes.push(input);
    }
  });
  controller.sessions.set('feishu:chat', state);

  const handling = controller.handleMessage({
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    text: 'new task',
    reply: async () => {},
    createReplyStream: async () => {
      await new Promise((resolve) => {
        resolveStream = resolve;
      });
      return {
        async update() {},
        async finish() {}
      };
    }
  }).then(() => {
    handleResolved = true;
  });

  await wait(10);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /new task/);
  assert.equal(handleResolved, false);

  resolveStream();
  await handling;
  assert.equal(handleResolved, true);
  controller.clearStreamHeartbeat(state);
}

async function testOutputWaitsForPendingReplyStream() {
  const controller = createController();
  const writes = [];
  const updates = [];
  let resolveStream;
  const state = createState({
    snapshot: '› ',
    write(input) {
      writes.push(input);
    }
  });
  controller.sessions.set('feishu:chat', state);

  const handling = controller.handleMessage({
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    text: 'new task',
    reply: async () => {
      throw new Error('streaming output should not fall back to text while stream starts');
    },
    createReplyStream: async () => {
      await new Promise((resolve) => {
        resolveStream = resolve;
      });
      return {
        async update(text) {
          updates.push(text);
        },
        async finish() {}
      };
    }
  });

  await wait(10);
  assert.equal(writes.length, 1);
  assert.equal(state.replyStreamStarting, true);

  controller.testRolloutReader.latest().emit({
    type: 'progress',
    text: '第一段输出不能因为飞书卡片还没创建完就丢失。'
  });
  await wait(10);

  assert.deepEqual(updates, []);

  resolveStream();
  await handling;
  await state.rolloutEventChain;

  assert.equal(state.replyStreamStarting, false);
  assert.equal(state.outputBuffer, '');
  assert.equal(updates.length, 1);
  assert.match(updates[0], /第一段输出不能因为飞书卡片还没创建完就丢失/);
  controller.clearStreamHeartbeat(state);
}

async function testActiveVisualStateQueuesNewInput() {
  const controller = createController();
  const writes = [];
  const replies = [];
  const state = createState({
    turnStartedAt: Date.now() - 40 * 1000,
    snapshot: [
      'Thinking',
      '› '
    ].join('\n'),
    write(input) {
      writes.push(input);
    }
  });
  state.lastInputText = 'old task that is still running';
  controller.sessions.set('feishu:chat', state);

  await controller.handleMessage({
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    text: 'new task',
    reply: async (text) => replies.push(text)
  });

  assert.equal(writes.length, 1);
  assert.match(writes[0], /new task/);
  assert.deepEqual(replies, []);
  assert.equal(state.lastInputText, 'old task that is still running');
  assert.equal(state.queuedMessages.length, 1);

  state.turnStartedAt = 0;
  state.rolloutFinished = true;
  state.turnFinishedNotified = false;
  controller.notifyTurnFinished(state);
  await wait(0);

  assert.equal(state.queuedMessages.length, 0);
  assert.equal(state.lastInputText, 'new task');
  assert.ok(state.rolloutTurn);

  controller.testRolloutReader.latest().emit({ type: 'final', text: 'queued reply' });
  controller.testRolloutReader.latest().emit({
    type: 'turn_complete',
    finalText: 'queued reply'
  });
  await state.rolloutEventChain;
  assert.deepEqual(replies, ['queued reply']);
}

async function testClosingCardQueuesNewInput() {
  const controller = createController();
  const writes = [];
  const state = createState({
    snapshot: '› ',
    write(input) {
      writes.push(input);
    }
  });
  state.replyStream = { unregister() {} };
  state.streamFinishedForTurn = false;
  controller.sessions.set('feishu:chat', state);

  await controller.handleMessage({
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    text: 'queued while the previous card closes',
    reply: async () => {}
  });

  assert.equal(writes.length, 1);
  assert.equal(state.queuedMessages.length, 1);
  assert.equal(state.replyStream != null, true, 'the closing card must not be replaced');
}

async function testDoneReactionWaitsForSettledVisualTurn() {
  const controller = createController();
  const replies = [];
  let finished = 0;
  const state = createState({
    turnStartedAt: Date.now(),
    snapshot: [
      '› 解释远程发送逻辑',
      '• 第一段回答已经出现，但任务还没结束。',
      'Working (8s • esc to interrupt)',
      '› Find and fix a bug in @filename'
    ].join('\n')
  });
  state.lastInputText = '解释远程发送逻辑';
  state.reply = async (text) => replies.push(text);
  state.onTurnFinished = async () => {
    finished += 1;
  };
  controller.sessions.set('feishu:chat', state);

  state.rolloutTurn = { stop() {} };
  await controller.handleRolloutEvent(state, {
    type: 'progress',
    text: '第一段回答已经出现，但任务还没结束。'
  });

  assert.deepEqual(replies, []);
  assert.equal(finished, 0);
  assert.notEqual(state.turnStartedAt, 0);

  await controller.handleRolloutEvent(state, {
    type: 'final',
    text: '完整回答已经结束。'
  });
  await controller.handleRolloutEvent(state, {
    type: 'turn_complete',
    turnId: 'turn-finished',
    finalText: '完整回答已经结束。'
  });

  assert.deepEqual(replies, ['完整回答已经结束。']);
  assert.equal(finished, 1);
  assert.equal(state.turnStartedAt, 0);
}

async function testPromptSuggestionSettlesVisualTurn() {
  const controller = createController();
  const replies = [];
  let finished = 0;
  const state = createState({
    turnStartedAt: Date.now(),
    snapshot: [
      '› 你好？',
      '• 你好，我在。需要我看这个 Electron/Codex shell 项目的什么问题？',
      ' ',
      '› Write tests for @filename',
      ' ',
      '  gpt-5.5 high fast · ~/project'
    ].join('\n')
  });
  state.lastInputText = '你好？';
  state.reply = async (text) => replies.push(text);
  state.onTurnFinished = async () => {
    finished += 1;
  };
  controller.sessions.set('feishu:chat', state);

  state.rolloutTurn = { stop() {} };
  await controller.handleRolloutEvent(state, {
    type: 'final',
    text: '你好，我在。需要我看这个 Electron/Codex shell 项目的什么问题？'
  });
  await controller.handleRolloutEvent(state, {
    type: 'turn_complete',
    turnId: 'turn-prompt',
    finalText: '你好，我在。需要我看这个 Electron/Codex shell 项目的什么问题？'
  });

  assert.deepEqual(replies, ['你好，我在。需要我看这个 Electron/Codex shell 项目的什么问题？']);
  assert.equal(finished, 1);
  assert.equal(state.turnStartedAt, 0);
}

async function testLocalMistypedStatusPageSendsSeparatePanel() {
  const controller = createController();
  const panels = [];
  const replies = [];
  const state = createState({
    turnStartedAt: Date.now(),
    snapshot: [
      '› 帮我看看这里的代码在做什么',
      'Working (5s • esc to interrupt)',
      '我正在检查入口文件和远程状态机。',
      '› /statu',
      '>_ OpenAI Codex (v0.42.0)',
      'Model: gpt-5-codex',
      'Permissions: workspace-write',
      'Directory: /tmp/project',
      'Session: abc123',
      '5h limit: [████░░░░] 50% left (resets 12:00)'
    ].join('\n')
  });
  state.lastInputText = '帮我看看这里的代码在做什么';
  state.reply = async (text) => replies.push(text);
  state.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', state);

  controller.queueOutput(state, 'local mistyped status output');
  await wait(10);
  controller.queueOutput(state, 'local mistyped status redraw');
  await wait(10);

  assert.equal(panels.length, 1);
  assert.equal(panels[0].kind, 'native_slash');
  assert.equal(panels[0].command, '/status');
  assert.match(panels[0].content, /^\*\*Codex 状态\*\*/);
  assert.match(panels[0].content, /gpt-5-codex/);
  assert.doesNotMatch(panels[0].content, /\/statu/);
  assert.deepEqual(replies, []);
  assert.notEqual(state.turnStartedAt, 0);
}

function testSessionPhases() {
  const controller = createController();
  const state = createState();

  assert.equal(controller.refreshSessionPhase(state), 'idle');

  state.turnStartedAt = Date.now();
  assert.equal(controller.refreshSessionPhase(state), 'working');

  state.session.visualViewportSnapshot = 'Booting MCP server: docs';
  assert.equal(controller.refreshSessionPhase(state), 'loading_plugins');

  state.session.visualViewportSnapshot = approvalLines();
  assert.equal(controller.refreshSessionPhase(state), 'awaiting_authorization');

  state.session.visualViewportSnapshot = 'Resume a previous session';
  state.nativeCommand = { command: '/resume' };
  assert.equal(controller.refreshSessionPhase(state), 'native_resume');
}

async function testResumeNavigationPatchesOriginalCard() {
  let sentPanelCount = 0;
  const patchedContents = [];
  const plugin = createFeishuPlugin({
    remoteController: {
      async handleMessage(message) {
        assert.equal(message.text, '/up');
        assert.equal(message.pageContext, '/resume');
        await message.replyPanel({
          kind: 'native_slash',
          title: 'Remote Codex /resume',
          command: '/resume',
          content: '**/resume 会话列表**\n> selected',
          actions: ['up', 'down', 'enter', 'escape']
        });
      }
    }
  });
  plugin.sendPanel = async () => {
    sentPanelCount += 1;
  };
  plugin.client = {
    im: {
      v1: {
        message: {
          async patch(payload) {
            patchedContents.push(payload.data.content);
            assert.equal(payload.path.message_id, 'om_resume');
          }
        }
      }
    }
  };

  await plugin.handleCardAction(feishuCardAction('up', '/resume'));

  assert.equal(sentPanelCount, 0);
  assert.equal(patchedContents.length, 1);
  assert.doesNotMatch(patchedContents[0], /正在刷新选择/);
  assert.match(patchedContents[0], /历史会话/);
}

async function testResumeEnterShowsImmediateFeedback() {
  const patchedContents = [];
  const plugin = createFeishuPlugin({
    remoteController: {
      async handleMessage(message) {
        assert.equal(message.text, '/enter');
        assert.equal(message.pageContext, '/resume');
      }
    }
  });
  plugin.client = {
    im: {
      v1: {
        message: {
          async patch(payload) {
            patchedContents.push(payload.data.content);
          }
        }
      }
    }
  };

  await plugin.handleCardAction(feishuCardAction('enter', '/resume'));

  assert.equal(patchedContents.length, 1);
  assert.match(patchedContents[0], /正在恢复会话/);
  assert.match(patchedContents[0], /等待 Codex 切换到所选会话/);
  assert.match(patchedContents[0], /按钮已锁定/);
  assert.doesNotMatch(patchedContents[0], /remote_codex_action/);
}

async function testStreamingCardActionShowsImmediateFeedback() {
  const feedback = [];
  const patchedContents = [];
  const plugin = createFeishuPlugin({
    remoteController: {
      async handleMessage(message) {
        assert.equal(message.text, '/escape');
      }
    }
  });
  plugin.replyStreamsByMessageId.set('om_resume', {
    async showActionFeedback(action, page) {
      feedback.push({ action, page });
    }
  });
  plugin.client = {
    im: {
      v1: {
        message: {
          async patch(payload) {
            patchedContents.push(payload.data.content);
          }
        }
      }
    }
  };

  await plugin.handleCardAction(feishuCardAction('escape', '/resume'));

  assert.deepEqual(feedback, [{ action: 'escape', page: '/resume' }]);
  assert.equal(patchedContents.length, 0);
}

async function testStreamingNavigationDoesNotShowIntermediateFeedback() {
  const feedback = [];
  const plugin = createFeishuPlugin({
    remoteController: {
      async handleMessage(message) {
        assert.equal(message.text, '/down');
      }
    }
  });
  plugin.replyStreamsByMessageId.set('om_resume', {
    async showActionFeedback(action, page) {
      feedback.push({ action, page });
    }
  });

  await plugin.handleCardAction(feishuCardAction('down', '/resume'));

  assert.deepEqual(feedback, []);
}

async function testCreatedStreamingCardIsLinkedToMessage() {
  const plugin = createFeishuPlugin();
  plugin.cardkitRequest = async () => ({
    data: { card_id: 'card_stream' }
  });
  plugin.client = {
    im: {
      v1: {
        message: {
          async create() {
            return { data: { message_id: 'om_stream' } };
          }
        }
      }
    }
  };

  const stream = await plugin.createReplyStream({
    receiveId: 'oc_chat',
    initialText: 'Working',
    controlMode: 'resume'
  });

  assert.equal(plugin.replyStreamsByMessageId.get('om_stream'), stream);
  stream.unregister();
  assert.equal(plugin.replyStreamsByMessageId.has('om_stream'), false);
}

async function testSharedVisualStreamDoesNotReplayStaleProgress() {
  const controller = createController();
  const updates = [];
  const state = createState({
    snapshot: [
      '› 你看下当前项目内容',
      '  gpt-5.5 high fast · /tmp/project'
    ].join('\n'),
    turnStartedAt: Date.now()
  });
  state.lastInputText = '你看下当前项目内容';
  state.lastStreamText = '**进度**\n- 旧进度不应继续出现在卡片里';
  state.replyStream = {
    async update(text) {
      updates.push(text);
    },
    async finish() {}
  };
  controller.sessions.set('feishu:chat', state);

  controller.queueOutput(state, '• 新进度来自本次 PTY 输出\n');
  await wait(10);

  assert.equal(updates.length, 0);
  assert.doesNotMatch(state.lastStreamText, /新进度来自本次 PTY 输出/);
  controller.clearStreamHeartbeat(state);
}

async function testSharedVisualStreamKeepsRawWindowWithoutSendingRawOnlyText() {
  const controller = createController();
  const updates = [];
  const state = createState({
    snapshot: [
      '› 你看下当前项目内容',
      '  gpt-5.5 high fast · /tmp/project'
    ].join('\n'),
    turnStartedAt: Date.now()
  });
  state.lastInputText = '你看下当前项目内容';
  state.replyStream = {
    async update(text) {
      updates.push(text);
    },
    async finish() {}
  };
  controller.sessions.set('feishu:chat', state);

  controller.queueOutput(state, '• 正在读取项目结构\n');
  await wait(10);
  controller.queueOutput(state, '• 正在读取项目结构\n');
  await wait(10);

  assert.equal(state.outputBuffer, '');
  assert.ok(state.streamRawProgressWindow.length > 0);
  assert.ok(state.streamRawProgressWindow.length <= 12000);
  assert.equal(updates.length, 0);
  controller.clearStreamHeartbeat(state);
}

async function testResumeEnterAndExitControls() {
  const controller = createController();
  const writes = [];
  const replies = [];
  const state = createState({
    nativeCommand: { command: '/resume' },
    write(input) {
      writes.push(input);
    }
  });
  controller.sessions.set('feishu:chat', state);
  const message = {
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    pageContext: '/resume',
    reply: async (text) => replies.push(text)
  };

  await controller.sendControlInput('feishu:chat', message, 'enter');
  clearTimeout(state.nativePageActionTimer);
  state.nativePageActionTimer = null;
  state.nativeCommand = { command: '/resume' };
  await controller.sendControlInput('feishu:chat', message, 'escape');
  clearTimeout(state.nativePageActionTimer);
  state.nativePageActionTimer = null;

  assert.deepEqual(writes, ['\r', '\x1b']);
  assert.deepEqual(replies, []);
}

async function testResumeStreamStaysOpenAcrossPageRefreshes() {
  const controller = createController();
  const updates = [];
  const replacements = [];
  const finishes = [];
  const stream = {
    async update(text) {
      updates.push(text);
    },
    async replace(text) {
      replacements.push(text);
    },
    async finish(text) {
      finishes.push(text);
    }
  };
  const state = createState({
    nativeCommand: { command: '/resume' },
    snapshot: resumeSnapshot('First session')
  });
  state.replyStream = stream;
  state.turnStartedAt = Date.now();
  controller.sessions.set('feishu:chat', state);

  controller.queueOutput(state, 'resume loading');
  await wait(10);
  state.session.visualSnapshot = resumeSnapshot('Second session');
  state.session.visualViewportSnapshot = state.session.visualSnapshot;
  controller.queueOutput(state, 'resume refreshed');
  await wait(10);

  assert.equal(updates.length, 2);
  assert.equal(finishes.length, 0);
  assert.equal(state.replyStream, stream);
  assert.equal(state.streamFinishTimer, null);
}

async function testOpenResumeCommandReusesExistingCard() {
  const controller = createController();
  const writes = [];
  const replacements = [];
  const state = createState({
    nativeCommand: { command: '/resume' },
    snapshot: resumeSnapshot('Selected session'),
    write(input) {
      writes.push(input);
    }
  });
  state.replyStream = {
    async replace(text) {
      replacements.push(text);
    },
    async update(text) {
      replacements.push(text);
    },
    async finish() {}
  };
  state.lastReplyText = '**/resume 会话列表**';
  controller.sessions.set('feishu:chat', state);

  await controller.handleNativeSlashCommand(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      reply: async () => {
        throw new Error('duplicate resume should not send text');
      },
      replyPanel: async () => {
        throw new Error('duplicate resume should not send a new panel');
      },
      createReplyStream: async () => {
        throw new Error('duplicate resume should not create a stream');
      }
    },
    '/resume'
  );

  assert.deepEqual(writes, []);
  assert.equal(replacements.length, 1);
  assert.match(replacements[0], /\/resume 会话列表/);
}

async function testStatusResizeRedrawDoesNotSpamStream() {
  const controller = createController();
  const updates = [];
  const state = createState({
    nativeCommand: { command: '/status' },
    snapshot: statusSnapshot('[████░░░░] 50% left (resets 12:00)')
  });
  state.replyStream = {
    async update(text) {
      updates.push(text);
    },
    async finish() {}
  };
  state.turnStartedAt = Date.now();
  controller.sessions.set('feishu:chat', state);

  controller.queueOutput(state, 'status redraw 1');
  await wait(10);
  state.session.visualSnapshot = statusSnapshot('[███░░░] 50% left (resets 12:00)');
  state.session.visualViewportSnapshot = state.session.visualSnapshot;
  controller.queueOutput(state, 'status redraw 2');
  await wait(10);

  assert.equal(updates.length, 1);
  assert.match(updates[0], /5 小时额度: 余量适中 50% 剩余/);
}

async function testNativeSlashDoesNotSendPanelWhileStreamStarts() {
  const controller = createController();
  const panels = [];
  const updates = [];
  const state = createState({
    nativeCommand: { command: '/status' },
    snapshot: statusSnapshot()
  });
  state.replyPanel = async (panel) => panels.push(panel);
  state.replyStreamStarting = true;
  controller.sessions.set('feishu:chat', state);

  controller.queueOutput(state, 'status output before cardkit card is created');
  await wait(10);
  assert.deepEqual(panels, []);

  state.replyStreamStarting = false;
  state.replyStream = {
    async update(text) {
      updates.push(text);
    },
    async finish() {}
  };
  controller.queueOutput(state, 'status output after stream exists');
  await wait(10);

  assert.equal(updates.length, 1);
  assert.deepEqual(panels, []);
}

async function testIncompleteStatusDoesNotSendStaticPanel() {
  const controller = createController();
  const panels = [];
  const state = createState({
    nativeCommand: { command: '/status' },
    snapshot: [
      '>_ OpenAI Codex (v0.135.0)',
      'Directory: ~/下载/temp/article/codex-electron-shell'
    ].join('\n')
  });
  state.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', state);

  controller.queueOutput(state, 'partial status');
  await wait(10);

  assert.deepEqual(panels, []);
}


async function testClosedNativeStreamDoesNotSendTrailingPanel() {
  const controller = createController();
  const panels = [];
  const state = createState({
    nativeCommand: { command: '/status' },
    snapshot: statusSnapshot()
  });
  state.streamedThisTurn = true;
  state.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', state);

  controller.queueOutput(state, 'late status refresh');
  await wait(10);

  assert.deepEqual(panels, []);
}

async function testNativeNavigationAllowsOriginalPanelRefresh() {
  const controller = createController();
  const panels = [];
  const writes = [];
  const state = createState({
    nativeCommand: { command: '/resume' },
    snapshot: resumeSnapshot('Selected session'),
    write(input) {
      writes.push(input);
    }
  });
  state.streamedThisTurn = true;
  state.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', state);

  await controller.sendControlInput(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      pageContext: '/resume',
      reply: async () => {},
      replyPanel: state.replyPanel
    },
    'down'
  );
  controller.queueOutput(state, 'resume moved');
  await wait(10);

  assert.deepEqual(writes, ['\x1b[B']);
  assert.equal(panels.length, 1);
  assert.equal(panels[0].command, '/resume');
}

async function testNativePageExitClosesStream() {
  const controller = createController();
  const updates = [];
  const replacements = [];
  const finishes = [];
  const stream = {
    async update(text) {
      updates.push(text);
    },
    async replace(text) {
      replacements.push(text);
    },
    async finish(text) {
      finishes.push(text);
    }
  };
  const state = createState({
    nativeCommand: { command: '/resume' },
    snapshot: resumeSnapshot('Selected session')
  });
  state.replyStream = stream;
  state.lastStreamText = '**/resume 会话列表**';
  state.turnStartedAt = Date.now();

  controller.beginNativePageAction(state, 'escape');
  await wait(20);
  state.session.visualSnapshot = '› ';
  state.session.visualViewportSnapshot = state.session.visualSnapshot;
  assert.equal(controller.confirmNativePageActionIfReady(state, 'test'), true);
  await wait(0);

  assert.equal(state.nativeCommand, null);
  assert.equal(state.replyStream, null);
  assert.match(replacements[0], /已退出历史会话选择/);
  assert.match(finishes[0], /已退出历史会话选择/);
}

async function testResumeEnterWaitsForConfirmedPageExit() {
  const controller = createController();
  const writes = [];
  const panels = [];
  const state = createState({
    nativeCommand: { command: '/resume' },
    snapshot: resumeSnapshot('Selected session'),
    write(input) {
      writes.push(input);
    }
  });
  state.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', state);

  await controller.sendControlInput(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      pageContext: '/resume',
      reply: async () => {},
      replyPanel: state.replyPanel
    },
    'enter'
  );

  assert.deepEqual(writes, ['\r']);
  assert.equal(state.nativeCommand.command, '/resume');
  assert.equal(state.nativePageAction.action, 'enter');

  controller.queueOutput(state, 'resume still visible');
  await wait(10);
  assert.equal(panels.length, 0);
  assert.equal(state.nativeCommand.command, '/resume');

  state.session.visualSnapshot = [
    '上一条消息: 请继续优化 Remote Codex',
    '上一条输出: 已完成恢复后的状态检查。',
    '› '
  ].join('\n');
  state.session.visualViewportSnapshot = state.session.visualSnapshot;
  controller.queueOutput(state, 'resume closed');
  await wait(10);

  assert.equal(state.nativeCommand, null);
  assert.equal(panels.length, 1);
  assert.equal(panels[0].active, false);
  assert.match(panels[0].content, /会话已恢复/);
  assert.match(panels[0].content, /恢复目标: `just now Selected session`/);
  assert.match(panels[0].content, /上一条输出: 已完成恢复后的状态检查/);
  assert.deepEqual(panels[0].actions, []);
}

async function testPermissionModeButtonSelectsAndConfirms() {
  const controller = createController();
  const writes = [];
  const panels = [];
  const state = createState({
    nativeCommand: { command: '/permissions' },
    snapshot: permissionsSnapshot('Default'),
    write(input) {
      writes.push(input);
    }
  });
  state.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', state);

  await controller.sendControlInput(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      pageContext: '/permissions',
      reply: async () => {},
      replyPanel: state.replyPanel
    },
    'permission_auto_review'
  );

  assert.deepEqual(writes, ['\x1b[B', '\r']);
  assert.equal(state.nativePageAction.action, 'permission_auto_review');

  state.session.visualSnapshot = '› ';
  state.session.visualViewportSnapshot = state.session.visualSnapshot;
  controller.queueOutput(state, 'permissions closed');
  await wait(10);

  assert.equal(state.nativeCommand, null);
  assert.equal(panels.length, 1);
  assert.match(panels[0].content, /权限模式已更新/);
  assert.match(panels[0].content, /`Approve for me`/);
  assert.deepEqual(panels[0].actions, []);

  writes.length = 0;
  panels.length = 0;
  const fullAccessState = createState({
    nativeCommand: { command: '/permissions' },
    snapshot: permissionsSnapshot('Default'),
    write(input) {
      writes.push(input);
    }
  });
  fullAccessState.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', fullAccessState);

  await controller.handleMessage({
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    pageContext: '/permissions',
    text: '/permission_full_access',
    reply: async () => {},
    replyPanel: fullAccessState.replyPanel
  });

  assert.deepEqual(writes, ['\x1b[B', '\x1b[B', '\r']);
  assert.equal(fullAccessState.nativePageAction.action, 'permission_full_access');

  fullAccessState.session.visualSnapshot = fullAccessConfirmationSnapshot('continue');
  fullAccessState.session.visualViewportSnapshot = fullAccessState.session.visualSnapshot;
  controller.queueOutput(fullAccessState, 'full access confirmation opened');
  await wait(10);

  assert.equal(fullAccessState.nativeCommand.command, '/permissions');
  assert.equal(fullAccessState.nativePageAction.completionAction, 'permission_full_access');
  assert.equal(panels.length, 1);
  assert.equal(panels[0].active, true);
  assert.equal(panels[0].completed, undefined);
  assert.match(panels[0].content, /Enable full access\?/);
  assert.match(panels[0].content, /> 1\. Yes, continue anyway/);
  assert.deepEqual(panels[0].actions, ['up', 'down', 'enter', 'escape']);

  await controller.sendControlInput(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      pageContext: '/permissions',
      reply: async () => {},
      replyPanel: fullAccessState.replyPanel
    },
    'enter'
  );

  assert.deepEqual(writes, ['\x1b[B', '\x1b[B', '\r', '\r']);
  assert.equal(fullAccessState.nativePageAction.action, 'enter');
  assert.equal(fullAccessState.nativePageAction.completionAction, 'permission_full_access');

  fullAccessState.session.visualSnapshot = `${fullAccessConfirmationSnapshot('continue')}\n› `;
  fullAccessState.session.visualViewportSnapshot = fullAccessState.session.visualSnapshot;
  controller.queueOutput(fullAccessState, 'permissions closed');
  await wait(10);

  assert.equal(fullAccessState.nativeCommand, null);
  assert.equal(panels.length, 2);
  assert.match(panels[1].content, /权限模式已更新/);
  assert.match(panels[1].content, /`Full Access`/);
  assert.deepEqual(panels[1].actions, []);

  writes.length = 0;
  panels.length = 0;
  const cancelledState = createState({
    nativeCommand: { command: '/permissions' },
    snapshot: permissionsSnapshot('Default'),
    write(input) {
      writes.push(input);
    }
  });
  cancelledState.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', cancelledState);

  await controller.sendControlInput(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      pageContext: '/permissions',
      reply: async () => {},
      replyPanel: cancelledState.replyPanel
    },
    'permission_full_access'
  );
  cancelledState.session.visualSnapshot = fullAccessConfirmationSnapshot('continue');
  cancelledState.session.visualViewportSnapshot = cancelledState.session.visualSnapshot;
  controller.queueOutput(cancelledState, 'full access confirmation opened');
  await wait(10);

  await controller.sendControlInput(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      pageContext: '/permissions',
      reply: async () => {},
      replyPanel: cancelledState.replyPanel
    },
    'down'
  );
  cancelledState.session.visualSnapshot = fullAccessConfirmationSnapshot('cancel');
  cancelledState.session.visualViewportSnapshot = cancelledState.session.visualSnapshot;
  controller.queueOutput(cancelledState, 'cancel selected');
  await wait(10);

  await controller.sendControlInput(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      pageContext: '/permissions',
      reply: async () => {},
      replyPanel: cancelledState.replyPanel
    },
    'enter'
  );
  assert.equal(cancelledState.nativePageAction.cancelled, true);
  cancelledState.session.visualSnapshot = `${fullAccessConfirmationSnapshot('cancel')}\n› `;
  cancelledState.session.visualViewportSnapshot = cancelledState.session.visualSnapshot;
  controller.queueOutput(cancelledState, 'confirmation cancelled');
  await wait(10);

  assert.equal(cancelledState.nativeCommand, null);
  assert.match(panels.at(-1).content, /权限模式未更改/);
  assert.match(panels.at(-1).content, /Cancel Go back without enabling full access/);
  assert.deepEqual(panels.at(-1).actions, []);

  writes.length = 0;
  panels.length = 0;
  const compactState = createState({
    nativeCommand: { command: '/permissions' },
    snapshot: compactPermissionsSnapshot('Approve for me'),
    write(input) {
      writes.push(input);
    }
  });
  controller.sessions.set('feishu:chat', compactState);

  await controller.sendControlInput(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      pageContext: '/permissions',
      reply: async () => {}
    },
    'permission_default'
  );

  assert.deepEqual(writes, ['\x1b[A', '\r']);
  assert.equal(compactState.nativePageAction.action, 'permission_default');

  writes.length = 0;
  const loadingState = createState({
    nativeCommand: { command: '/permissions' },
    snapshot: permissionsLoadingSnapshot(),
    write(input) {
      writes.push(input);
    }
  });
  controller.sessions.set('feishu:chat', loadingState);

  await controller.sendControlInput(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      pageContext: '/permissions',
      reply: async () => {}
    },
    'permission_full_access'
  );

  assert.deepEqual(writes, ['\x1b[B', '\x1b[B', '\r']);
  assert.equal(loadingState.nativePageAction.action, 'permission_full_access');
}

async function testGenericModelPickerNavigationAndCompletion() {
  const controller = createController();
  const writes = [];
  const panels = [];
  const state = createState({
    nativeCommand: { command: '/model', text: '/model' },
    snapshot: modelPickerSnapshot(1),
    write(input) {
      writes.push(input);
    }
  });
  state.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', state);

  controller.queueOutput(state, 'model picker');
  await wait(10);
  assert.equal(panels[0].command, '/model');
  assert.deepEqual(panels[0].actions, ['up', 'down', 'enter', 'escape']);
  assert.match(panels[0].content, /> 1\. gpt-5\.6-sol/);

  await controller.sendControlInput(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      pageContext: '/model',
      reply: async () => {},
      replyPanel: state.replyPanel
    },
    'down'
  );
  state.session.visualSnapshot = modelPickerSnapshot(2);
  state.session.visualViewportSnapshot = state.session.visualSnapshot;
  controller.queueOutput(state, 'model selection moved');
  await wait(10);
  assert.equal(writes.at(-1), '\x1b[B');
  assert.match(panels.at(-1).content, /> 2\. gpt-5\.6-terra/);

  await controller.sendControlInput(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      pageContext: '/model',
      reply: async () => {},
      replyPanel: state.replyPanel
    },
    'enter'
  );
  assert.equal(writes.at(-1), '\r');
  state.session.visualSnapshot = 'Model set to gpt-5.6-terra\n› ';
  state.session.visualViewportSnapshot = state.session.visualSnapshot;
  controller.queueOutput(state, 'model picker closed');
  await wait(10);

  assert.equal(state.nativeCommand, null);
  assert.match(panels.at(-1).content, /选择已确认/);
  assert.deepEqual(panels.at(-1).actions, []);
}

async function testReviewPickerTransitionsToNextRolloutTask() {
  let observerOptions = null;
  const controller = createController();
  controller.rolloutReader = {
    beginTurn(options) {
      observerOptions = options;
      return { stop() {} };
    }
  };
  const writes = [];
  const panels = [];
  const state = createState({
    nativeCommand: { command: '/review', text: '/review' },
    snapshot: reviewPickerSnapshot(2),
    write(input) {
      writes.push(input);
    }
  });
  state.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', state);

  await controller.sendControlInput(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      pageContext: '/review',
      reply: async () => {},
      replyPanel: state.replyPanel
    },
    'enter'
  );

  assert.equal(observerOptions.matchNextPrompt, true);
  assert.deepEqual(writes, ['\r']);
  assert.equal(state.nativeTaskRolloutPending, true);

  observerOptions.onEvent({
    type: 'bound',
    sessionId: 'codex-review-session',
    turnId: 'review-turn',
    rolloutPath: '/tmp/review.jsonl',
    prompt: 'Review the uncommitted changes'
  });
  observerOptions.onEvent({ type: 'turn_started', turnId: 'review-turn' });
  observerOptions.onEvent({
    type: 'progress',
    turnId: 'review-turn',
    text: '正在检查未提交改动。'
  });
  controller.queueOutput(state, 'Working•kinging•ngg terminal repaint garbage');
  observerOptions.onEvent({
    type: 'final',
    turnId: 'review-turn',
    text: '发现 1 个需要修复的问题。\n\n- src/main.js:42 存在状态竞态。'
  });
  observerOptions.onEvent({
    type: 'turn_complete',
    turnId: 'review-turn',
    finalText: '发现 1 个需要修复的问题。\n\n- src/main.js:42 存在状态竞态。'
  });
  await wait(30);

  assert.equal(state.nativeCommand, null);
  assert.equal(state.nativeTaskRolloutPending, false);
  assert.match(panels.map((panel) => panel.content).join('\n'), /正在检查未提交改动/);
  assert.match(panels.at(-1).content, /src\/main\.js:42 存在状态竞态/);
  assert.doesNotMatch(
    panels.map((panel) => panel.content).join('\n'),
    /kinging|ngg|terminal repaint/
  );
  assert.equal(panels.at(-1).completed, true);
  assert.deepEqual(panels.at(-1).actions, []);
}

async function testDestructiveNativeCommandIsBlocked() {
  const controller = createController();
  const replies = [];
  await controller.handleMessage({
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    text: '/delete',
    reply: async (text) => replies.push(text)
  });
  assert.equal(replies.length, 1);
  assert.match(replies[0], /不允许远程执行 `\/delete`/);
  assert.match(replies[0], /永久删除/);
}

async function testNativeReportCompletesAndReleasesNextInput() {
  const controller = createController();
  const writes = [];
  const panels = [];
  const state = createState({
    nativeCommand: { command: '/mcp', text: '/mcp' },
    snapshot: [
      '/mcp',
      'MCP Tools',
      '- codex_apps',
      '› Ask a new question'
    ].join('\n'),
    write(input) {
      writes.push(input);
    }
  });
  state.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', state);

  controller.queueOutput(state, 'mcp report completed');
  await wait(10);
  assert.equal(state.nativeCommand, null);
  assert.equal(panels.length, 1);
  assert.equal(panels[0].completed, true);
  assert.deepEqual(panels[0].actions, []);

  await controller.handleMessage({
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    text: '继续检查项目',
    reply: async () => {}
  });
  assert.equal(writes.length, 1);
  assert.match(writes[0], /继续检查项目/);
}

async function testSlashTaskBindsNextRolloutInsteadOfExactCommand() {
  let observerOptions = null;
  const controller = createController();
  controller.rolloutReader = {
    beginTurn(options) {
      observerOptions = options;
      return { stop() {} };
    }
  };
  const writes = [];
  const state = createState({
    snapshot: '› ',
    write(input) {
      writes.push(input);
    }
  });
  controller.sessions.set('feishu:chat', state);

  await controller.handleMessage({
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    text: '/compact',
    reply: async () => {}
  });

  assert.equal(observerOptions.prompt, '/compact');
  assert.equal(observerOptions.matchNextPrompt, true);
  assert.deepEqual(writes, ['/compact\r']);
  assert.equal(state.nativeCommand, null);
}

async function testNativePickerLoadingAndUnsupportedFallback() {
  const controller = createController();
  const panels = [];
  const loadingState = createState({
    nativeCommand: { command: '/plugins', text: '/plugins' },
    snapshot: [
      'Plugins',
      'Loading available plugins...',
      '› Loading plugins... This updates when the marketplace list is ready.',
      'Press enter to confirm or esc to go back'
    ].join('\n')
  });
  loadingState.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', loadingState);
  controller.queueOutput(loadingState, 'plugins loading');
  await wait(10);
  assert.equal(loadingState.nativeCommand.command, '/plugins');
  assert.equal(panels.at(-1).active, true);
  assert.deepEqual(panels.at(-1).actions, ['up', 'down', 'enter', 'escape']);

  panels.length = 0;
  const unsupportedState = createState({
    nativeCommand: { command: '/personality', text: '/personality' },
    snapshot: [
      "Current model doesn't support personalities. Try /model.",
      '› Explain this codebase'
    ].join('\n')
  });
  unsupportedState.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', unsupportedState);
  controller.queueOutput(unsupportedState, 'personality unsupported');
  await wait(10);
  assert.equal(unsupportedState.nativeCommand, null);
  assert.equal(panels.at(-1).completed, true);
  assert.deepEqual(panels.at(-1).actions, []);
}

async function testNativeTextInputAcceptsNextRemoteMessage() {
  const controller = createController();
  const writes = [];
  const panels = [];
  const state = createState({
    nativeCommand: { command: '/rename', text: '/rename' },
    snapshot: [
      'Name thread',
      'Type a name and press Enter',
      'Press enter to confirm or esc to go back'
    ].join('\n'),
    write(input) {
      writes.push(input);
    }
  });
  state.replyPanel = async (panel) => panels.push(panel);
  controller.sessions.set('feishu:chat', state);

  await controller.handleMessage({
    pluginId: 'feishu',
    conversationId: 'chat',
    userId: 'user',
    text: 'Feishu native command audit',
    reply: async () => {}
  });
  assert.equal(writes.length, 1);
  assert.match(writes[0], /Feishu native command audit/);
  assert.equal(state.nativePageAction.action, 'enter');

  state.session.visualSnapshot = 'Thread renamed\n› Continue working';
  state.session.visualViewportSnapshot = state.session.visualSnapshot;
  controller.queueOutput(state, 'rename completed');
  await wait(10);
  assert.equal(state.nativeCommand, null);
  assert.match(panels.at(-1).content, /选择已确认/);
}

async function testStaleResumeCardIsRejected() {
  const controller = createController();
  const writes = [];
  const replies = [];
  const state = createState({
    nativeCommand: { command: '/permissions' },
    write(input) {
      writes.push(input);
    }
  });
  controller.sessions.set('feishu:chat', state);

  await controller.sendControlInput(
    'feishu:chat',
    {
      pluginId: 'feishu',
      conversationId: 'chat',
      userId: 'user',
      pageContext: '/resume',
      reply: async (text) => replies.push(text)
    },
    'down'
  );

  assert.deepEqual(writes, []);
  assert.match(replies.at(-1), /页面已经变化/);
}

function createController() {
  const rolloutReader = new FakeRolloutReader();
  const controller = new RemoteSessionController({
    sessionManager: null,
    rolloutReader,
    logger: {
      event() {},
      warn() {}
    },
    config: {
      codex: {
        defaultCwd: process.cwd(),
        allowedWorkdirs: []
      },
      remoteControl: {
        responseSource: 'rollout_jsonl',
        sendOutput: true,
        outputMode: 'final',
        flushIntervalMs: 1,
        finalReplyDebounceMs: 1
      },
      plugins: {
        feishu: {
          streaming: true,
          segmentedOutput: false
        }
      }
    }
  });
  controller.testRolloutReader = rolloutReader;
  return controller;
}

class FakeRolloutReader {
  constructor() {
    this.turns = [];
  }

  beginTurn(options) {
    const turn = {
      options,
      stopped: false,
      emit(event) {
        options.onEvent?.(event);
      },
      fail(error) {
        options.onError?.(error);
      },
      stop() {
        this.stopped = true;
      }
    };
    this.turns.push(turn);
    return turn;
  }

  latest() {
    const turn = this.turns.at(-1);
    assert.ok(turn, 'expected a fake rollout turn');
    return turn;
  }
}

function createState(options = {}) {
  const snapshot = options.snapshot || '';
  return {
    key: 'feishu:chat',
    pluginId: 'feishu',
    conversationId: 'chat',
    session: {
      id: 's1',
      visualSnapshot: snapshot,
      visualViewportSnapshot: snapshot,
      write: options.write || (() => {}),
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
    nativePageExitTimer: null,
    nativePageActionTimer: null,
    pendingReplyTimer: null,
    createReplyStream: null,
    replyStream: null,
    replyStreamStarting: false,
    lastReplyText: '',
    lastStreamText: '',
    lastSentReplyText: '',
    pendingReplyText: '',
    lastLocalNativeSlashPanelSignature: '',
    streamedThisTurn: false,
    segmentedThisTurn: false,
    streamFinishedForTurn: false,
    streamClosedText: '',
    streamAccumulatedText: '',
    streamRawProgressWindow: '',
    segmentAccumulatedText: '',
    segmentRawProgressWindow: '',
    segmentReplyChain: Promise.resolve(),
    segmentReplyGeneration: 0,
    rolloutGeneration: 0,
    rolloutEventChain: Promise.resolve(),
    rolloutTurn: null,
    rolloutSessionId: '',
    rolloutTurnId: '',
    rolloutPath: '',
    rolloutProgressText: '',
    rolloutFinalText: '',
    rolloutFinalQueued: false,
    rolloutCompletionSeen: false,
    rolloutFinished: false,
    rolloutFailed: false,
    nativeTaskRolloutPending: false,
    sentSegmentSignatures: new Set(),
    nativePanelUpdateRequested: false,
    controlActionLocks: new Map(),
    lastApprovalSignature: '',
    lastInputText: '',
    nativeCommand: options.nativeCommand || null,
    nativePageAction: null,
    phase: 'idle',
    turnStartedAt: options.turnStartedAt || 0,
    queuedMessages: [],
    queuedMessageActivating: false,
    stopped: false
  };
}

function resumeSnapshot(selected) {
  return [
    'Resume a previous session',
    `❯ just now ${selected}`,
    '  2h ago Parser regression tests',
    '1 / 2'
  ].join('\n');
}

function permissionsSnapshot(selected = 'Default') {
  const selectedIndex = {
    Default: 1,
    'Auto-review': 2,
    'Full Access': 3
  }[selected] || 1;
  return [
    'Update Model Permissions',
    `${selectedIndex === 1 ? '> ' : '  '}1. Default (current)  Codex can read and edit files in the current workspace, and run commands.`,
    `${selectedIndex === 2 ? '> ' : '  '}2. Auto-review        Same workspace-write permissions as Default, but eligible on-request approvals are routed.`,
    `${selectedIndex === 3 ? '> ' : '  '}3. Full Access        Codex can edit files outside this workspace and access the internet without asking for approval.`,
    'Press enter to confirm or esc to go back'
  ].join('\n');
}

function compactPermissionsSnapshot(selected = 'Default') {
  return [
    '权限模式',
    `${['Default', 'Ask for approval'].includes(selected) ? '> ' : '  '}Ask for approval`,
    `${['Auto-review', 'Approve for me'].includes(selected) ? '> ' : '  '}Approve for me`,
    `${selected === 'Full Access' ? '> ' : '  '}Full Access`
  ].join('\n');
}

function permissionsLoadingSnapshot() {
  return [
    '权限模式',
    '正在读取当前权限模式。',
    '可直接选择 Ask for approval、Approve for me 或 Full Access。'
  ].join('\n');
}

function fullAccessConfirmationSnapshot(selected = 'continue') {
  return [
    'Enable full access?',
    'When Codex runs with full access, it can edit any file on your computer and run commands with network, without your',
    'approval. Exercise caution when enabling full access. This significantly increases the risk of data loss, leaks, or',
    'unexpected behavior.',
    `${selected === 'continue' ? '› ' : '  '}1. Yes, continue anyway  Apply full access for this session`,
    `${selected === 'cancel' ? '› ' : '  '}2. Cancel                Go back without enabling full access`
  ].join('\n');
}

function modelPickerSnapshot(selected = 1) {
  return [
    'Select Model and Effort',
    `${selected === 1 ? '› ' : '  '}1. gpt-5.6-sol (current)  Latest frontier model.`,
    `${selected === 2 ? '› ' : '  '}2. gpt-5.6-terra          Balanced model.`,
    'Press enter to confirm or esc to go back'
  ].join('\n');
}

function reviewPickerSnapshot(selected = 2) {
  return [
    'Select a review preset',
    `${selected === 1 ? '› ' : '  '}1. Review against a base branch  (PR Style)`,
    `${selected === 2 ? '› ' : '  '}2. Review uncommitted changes`,
    `${selected === 3 ? '› ' : '  '}3. Review a commit`,
    `${selected === 4 ? '› ' : '  '}4. Custom review instructions`,
    'Press enter to confirm or esc to go back'
  ].join('\n');
}

function statusSnapshot(limit = '[████░░░░] 50% left (resets 12:00)') {
  return [
    '>_ OpenAI Codex (v0.42.0)',
    'Model: gpt-5-codex',
    'Permissions: workspace-write',
    'Directory: /tmp/project',
    'Session: abc123',
    `5h limit: ${limit}`
  ].join('\n');
}

function createFeishuPlugin(services = {}, pluginConfig = {}) {
  return feishuPlugin.create({
    config: {},
    pluginConfig: {
      mode: 'long_connection',
      streaming: true,
      ackReactionEnabled: false,
      appId: 'app',
      appSecret: 'secret',
      ...pluginConfig
    },
    services,
    logger: {
      event() {},
      warn() {}
    }
  });
}

function feishuMessage(text, createTime, id) {
  return {
    message: {
      chat_id: 'oc_chat',
      message_id: id,
      create_time: createTime,
      content: JSON.stringify({ text })
    },
    sender: {
      sender_id: {
        open_id: 'ou_user'
      }
    }
  };
}

function feishuCardAction(action, page) {
  return {
    action: {
      value: {
        remote_codex_action: action,
        remote_codex_page: page
      }
    },
    context: {
      open_chat_id: 'oc_chat',
      open_message_id: 'om_resume'
    },
    operator: {
      operator_id: {
        open_id: 'ou_user'
      }
    }
  };
}

function approvalLines() {
  return [
    'Running shell command',
    'Would you like to run the following command?',
    'Reason: verify',
    '$ npm test',
    '> 1. Yes',
    '  2. No'
  ].join('\n');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
