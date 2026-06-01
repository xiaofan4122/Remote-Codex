#!/usr/bin/env node

const assert = require('node:assert/strict');
const { RemoteSessionController } = require('../src/remoteSessionController');
const feishuPlugin = require('../src/plugins/feishu');

async function main() {
  await testHistoricalMessagesAreIgnoredAfterStartup();
  await testAcceptedFeishuMessageGetsAckReaction();
  await testAcceptedFeishuMessageGetsDoneReactionAfterDispatch();
  await testStartupNotice();
  await testStopInterruptsWithoutClosingSession();
  await testStaleBusyStateDoesNotBlockNewInput();
  await testVisibleIdlePromptDoesNotBlockNewInput();
  await testNewInputDiscardsPendingFinalReply();
  await testActiveVisualStateStillBlocksNewInput();
  testDebugStateReportsVisualPhase();
  testSessionPhases();
  await testResumeNavigationPatchesOriginalCard();
  await testResumeEnterShowsImmediateFeedback();
  await testStreamingCardActionShowsImmediateFeedback();
  await testStreamingNavigationDoesNotShowIntermediateFeedback();
  await testCreatedStreamingCardIsLinkedToMessage();
  await testResumeStreamStaysOpenAcrossPageRefreshes();
  await testOpenResumeCommandReusesExistingCard();
  await testStatusResizeRedrawDoesNotSpamStream();
  await testNativeSlashDoesNotSendPanelWhileStreamStarts();
  await testIncompleteStatusDoesNotSendStaticPanel();
  await testClosedNativeStreamDoesNotSendTrailingPanel();
  await testNativeNavigationAllowsOriginalPanelRefresh();
  await testPermissionModeButtonSelectsAndConfirms();
  await testResumeEnterWaitsForConfirmedPageExit();
  await testNativePageExitClosesStream();
  await testResumeEnterAndExitControls();
  await testStaleResumeCardIsRejected();
  console.log('Remote workflow state tests passed.');
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
    ackReactionEmoji: 'done'
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
      emojiType: 'DONE'
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

async function testNewInputDiscardsPendingFinalReply() {
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
  assert.equal(staleStreamUnregistered, 1);
  assert.equal(state.pendingReplyText, '');
  assert.equal(state.pendingReplyTimer, null);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /new task/);
}

async function testActiveVisualStateStillBlocksNewInput() {
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

  assert.deepEqual(writes, []);
  assert.match(replies.at(-1), /还在处理上一条消息/);
}

function testDebugStateReportsVisualPhase() {
  const controller = createController();
  const session = {
    id: 's-debug',
    cursor: 8,
    visualSnapshot: 'Thinking\n› ',
    visualViewportSnapshot: 'Thinking\n› ',
    status() {
      return {
        id: this.id,
        cwd: '/tmp/project',
        cursor: this.cursor,
        exited: false
      };
    },
    readAfter() {
      return {
        chunks: [
          { data: 'debug output tail' }
        ]
      };
    }
  };

  const state = controller.buildDebugState(session);

  assert.equal(state.phase, 'working');
  assert.equal(state.busy, true);
  assert.equal(state.hasRemoteState, false);
  assert.equal(state.detection.visibleIdlePrompt, true);
  assert.equal(state.detection.activeVisualIndicators, true);
  assert.match(state.text.viewportTail, /Thinking/);
  assert.match(state.text.lastOutputTail, /debug output tail/);
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

  assert.deepEqual(feedback, []);
  assert.equal(patchedContents.length, 1);
  assert.match(patchedContents[0], /正在退出页面/);
  assert.doesNotMatch(patchedContents[0], /remote_codex_action/);
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
  assert.match(panels[0].content, /`Auto-review`/);
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

  fullAccessState.session.visualSnapshot = '› ';
  fullAccessState.session.visualViewportSnapshot = fullAccessState.session.visualSnapshot;
  controller.queueOutput(fullAccessState, 'permissions closed');
  await wait(10);

  assert.equal(fullAccessState.nativeCommand, null);
  assert.equal(panels.length, 1);
  assert.match(panels[0].content, /权限模式已更新/);
  assert.match(panels[0].content, /`Full Access`/);
  assert.deepEqual(panels[0].actions, []);
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
  return new RemoteSessionController({
    sessionManager: null,
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
        sendOutput: true,
        outputMode: 'final',
        flushIntervalMs: 1,
        finalReplyDebounceMs: 1
      },
      plugins: {}
    }
  });
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
    streamedThisTurn: false,
    streamFinishedForTurn: false,
    streamClosedText: '',
    nativePanelUpdateRequested: false,
    controlActionLocks: new Map(),
    lastApprovalSignature: '',
    lastInputText: '',
    nativeCommand: options.nativeCommand || null,
    nativePageAction: null,
    phase: 'idle',
    turnStartedAt: options.turnStartedAt || 0,
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
