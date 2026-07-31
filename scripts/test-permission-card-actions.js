#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  RemoteSessionController,
  extractApprovalPrompt,
  formatApprovalPrompt
} = require('../src/remoteSessionController');
const feishuPlugin = require('../src/plugins/feishu');

async function main() {
  testApprovalOptionSelection();
  testFeishuPermissionPanelIsCompact();
  await testRemoteControlInputBuffer();
  await testStaleApprovalContextIsRejected();
  await testFeishuCardActionTriggerAcknowledgesImmediately();
  await testFeishuCardActionUpdatesAndDedupes();
  await testFeishuNativeActionCompletionPatchesOriginalCard();
  await testFeishuPermissionModeCardActionKeepsPageContext();
  await testFeishuFollowupPanelAllowsSecondSubmit();
  console.log('Permission card action tests passed.');
}

async function testFeishuCardActionTriggerAcknowledgesImmediately() {
  let releaseAction;
  let actionFinished = false;
  const actionBlocked = new Promise((resolve) => {
    releaseAction = resolve;
  });
  const plugin = feishuPlugin.create({
    config: {},
    pluginConfig: {
      mode: 'long_connection',
      streaming: true,
      appId: 'app',
      appSecret: 'secret'
    },
    services: {
      remoteController: {
        async handleMessage() {
          await actionBlocked;
          actionFinished = true;
        }
      }
    },
    logger: {
      event() {},
      warn() {}
    }
  });

  const response = plugin.handleCardActionTrigger({
    action: {
      value: {
        remote_codex_action: 'approve',
        remote_codex_context: 'approval-immediate-ack'
      }
    },
    context: {
      open_chat_id: 'oc_chat'
    },
    operator: {
      operator_id: {
        open_id: 'ou_user'
      }
    }
  });

  assert.equal(response instanceof Promise, false);
  assert.deepEqual(response, {
    toast: {
      type: 'info',
      content: '操作已提交',
      i18n: {
        zh_cn: '操作已提交',
        en_us: 'Action submitted'
      }
    }
  });
  assert.equal(actionFinished, false);

  releaseAction();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actionFinished, true);
}

function approvalLines(selected = 1) {
  return [
    'Running shell command',
    'Would you like to run the following command?',
    'Reason: Need to verify.',
    '$ npm run test:feishu-remote-turn',
    `${selected === 1 ? '>' : ' '} 1. Yes`,
    `${selected === 2 ? '>' : ' '} 2. Yes, always approve`,
    `${selected === 3 ? '>' : ' '} 3. No`
  ].join('\n');
}

function testApprovalOptionSelection() {
  const first = formatApprovalPrompt(extractApprovalPrompt(approvalLines(1).split('\n')));
  assert.match(first, /> 1\. Yes/);
  assert.match(first, /- 2\. Yes, always approve/);

  const second = formatApprovalPrompt(extractApprovalPrompt(approvalLines(2).split('\n')));
  assert.match(second, /- 1\. Yes/);
  assert.match(second, /> 2\. Yes, always approve/);
}

function testFeishuPermissionPanelIsCompact() {
  const progressText = formatApprovalPrompt(
    extractApprovalPrompt(approvalLines(2).split('\n'))
  );
  const card = feishuPlugin.__private.buildPanelCard({
    kind: 'permission',
    title: 'Remote Codex 权限确认',
    attached: true,
    active: true,
    approval: {
      question: 'Would you like to run the following command?',
      reason: 'Reason: Need to verify.',
      command: 'npm run test:feishu-remote-turn',
      options: [
        { index: 1, text: 'Yes', selected: false },
        { index: 2, text: 'Yes, always approve', selected: true },
        { index: 3, text: 'No', selected: false }
      ]
    },
    message: 'Codex 正在等待权限确认。',
    progressText,
    actionContext: 'approval-context',
    actions: ['approve', 'approve_persistent', 'deny']
  });
  const markdown = card.elements.find((element) => element.tag === 'markdown').content;
  const actions = card.elements.find((element) => element.tag === 'action').actions;

  assert.match(markdown, /Need to verify\./);
  assert.match(markdown, /npm run test:feishu-remote-turn/);
  assert.doesNotMatch(markdown, /Would you like to run/);
  assert.doesNotMatch(markdown, /选项|Yes, always approve|`\/approve`/);
  assert.deepEqual(
    actions.map((action) => action.text.content),
    ['允许一次', '总是允许', '拒绝']
  );
  assert.deepEqual(
    actions.map((action) => action.value.remote_codex_context),
    ['approval-context', 'approval-context', 'approval-context']
  );

  const fallbackCard = feishuPlugin.__private.buildPanelCard({
    kind: 'permission',
    title: 'Remote Codex 权限确认',
    attached: true,
    active: true,
    approval: {
      question: 'Would you like to run the following command?',
      reason: 'Reason: Need to verify.',
      command: 'npm run test:feishu-remote-turn',
      options: [
        { index: 1, text: 'Yes', selected: false },
        { index: 2, text: 'Yes, always approve', selected: true },
        { index: 3, text: 'No', selected: false }
      ]
    },
    message: 'Codex 正在等待权限确认。',
    actions: ['approve', 'approve_persistent', 'deny']
  });
  const fallbackMarkdown = fallbackCard.elements.find(
    (element) => element.tag === 'markdown'
  ).content;
  assert.match(fallbackMarkdown, /Need to verify\./);
  assert.match(fallbackMarkdown, /npm run test:feishu-remote-turn/);
  assert.doesNotMatch(fallbackMarkdown, /选项|Yes, always approve|Would you like to run/);
}

async function testRemoteControlInputBuffer() {
  const controller = createController();
  const key = 'feishu:chat';
  const writes = [];
  const replies = [];
  controller.sessions.set(key, {
    key,
    pluginId: 'feishu',
    conversationId: 'chat',
    session: {
      id: 's1',
      visualSnapshot: approvalLines(1),
      visualViewportSnapshot: approvalLines(1),
      write(input) {
        writes.push(input);
      },
      status() {
        return { exited: false };
      }
    },
    cursor: 0,
    controlActionLocks: new Map()
  });

  const message = {
    pluginId: 'feishu',
    conversationId: 'chat',
    reply: async (text) => replies.push(text)
  };

  await controller.sendControlInput(key, message, 'approve');
  await controller.sendControlInput(key, message, 'approve');

  assert.deepEqual(writes, ['y']);
  assert.match(replies.at(-1), /请勿重复点击/);

  replies.length = 0;
  await controller.sendPermissionPanel(
    key,
    message,
    controller.sessions.get(key),
    {
      status: 'Running shell command',
      question: 'Would you like to run the following command?',
      reason: 'Reason: Need to verify.',
      command: '$ npm run test:feishu-remote-turn',
      options: [
        { index: 1, text: 'Yes', selected: false },
        { index: 2, text: 'Yes, always approve', selected: true },
        { index: 3, text: 'No', selected: false }
      ]
    }
  );
  assert.match(replies.at(-1), /Need to verify\./);
  assert.match(replies.at(-1), /npm run test:feishu-remote-turn/);
  assert.doesNotMatch(replies.at(-1), /选项:|Yes, always approve|Would you like to run/);
}

async function testStaleApprovalContextIsRejected() {
  const controller = createController();
  const key = 'feishu:stale-approval';
  const writes = [];
  const panels = [];
  const state = {
    key,
    pluginId: 'feishu',
    conversationId: 'stale-approval',
    session: {
      id: 's-stale',
      visualSnapshot: approvalLines(1),
      visualViewportSnapshot: approvalLines(1),
      write(input) {
        writes.push(input);
      },
      status() {
        return { exited: false };
      }
    },
    cursor: 0,
    controlActionLocks: new Map()
  };
  controller.sessions.set(key, state);
  const approval = extractApprovalPrompt(approvalLines(1).split('\n'));
  const currentContext = controller.buildPermissionPanelPayload(
    key,
    null,
    state,
    approval
  ).actionContext;
  assert.match(currentContext, /^[a-f0-9]{24}$/);

  const message = {
    pluginId: 'feishu',
    conversationId: 'stale-approval',
    approvalContext: 'stale-context',
    reply: async () => {},
    replyPanel: async (panel) => panels.push(panel)
  };
  await controller.sendControlInput(key, message, 'approve');
  assert.deepEqual(writes, []);
  assert.equal(panels.length, 1);
  assert.equal(panels[0].active, false);
  assert.match(panels[0].message, /已失效/);

  message.approvalContext = currentContext;
  await controller.sendControlInput(key, message, 'approve');
  assert.deepEqual(writes, ['y']);
}

async function testFeishuCardActionUpdatesAndDedupes() {
  let handleCount = 0;
  let patchCount = 0;
  let deleteCount = 0;
  const routedContexts = [];
  const plugin = feishuPlugin.create({
    config: {},
    pluginConfig: {
      mode: 'long_connection',
      streaming: true,
      appId: 'app',
      appSecret: 'secret'
    },
    services: {
      remoteController: {
        async handleMessage(message) {
          handleCount += 1;
          routedContexts.push(message.approvalContext);
        }
      }
    },
    logger: {
      event() {},
      warn() {}
    }
  });
  plugin.client = {
    im: {
      v1: {
        message: {
          async patch(payload) {
            patchCount += 1;
            const content = payload?.data?.content || '';
            assert.match(content, /已提交/);
            return { code: 0 };
          },
          async delete() {
            deleteCount += 1;
            return { code: 0 };
          }
        }
      }
    }
  };

  const event = {
    action: {
      value: {
        remote_codex_action: 'approve',
        remote_codex_context: 'approval-one'
      }
    },
    context: {
      open_chat_id: 'oc_chat',
      open_message_id: 'om_card'
    },
    operator: {
      operator_id: {
        open_id: 'ou_user'
      }
    }
  };

  await plugin.handleCardAction(event);
  await plugin.handleCardAction(event);
  await plugin.handleCardAction({
    ...event,
    action: {
      value: {
        remote_codex_action: 'approve',
        remote_codex_context: 'approval-two'
      }
    }
  });

  assert.equal(handleCount, 2);
  assert.equal(patchCount, 2);
  assert.equal(deleteCount, 2);
  assert.deepEqual(routedContexts, ['approval-one', 'approval-two']);
}

async function testFeishuNativeActionCompletionPatchesOriginalCard() {
  let feedbackCount = 0;
  const patches = [];
  const sends = [];
  const plugin = feishuPlugin.create({
    config: {},
    pluginConfig: {
      mode: 'long_connection',
      streaming: true,
      appId: 'app',
      appSecret: 'secret'
    },
    services: {
      remoteController: {
        async handleMessage(message) {
          await message.replyPanel({
            kind: 'native_slash',
            title: 'Remote Codex /permissions',
            command: '/permissions',
            completed: true,
            notice: '操作已完成。',
            content: [
              '**权限模式已更新**',
              '- 已切换为 `Full Access`。',
              '- 权限模式已应用。'
            ].join('\n'),
            actions: []
          });
        }
      }
    },
    logger: {
      event() {},
      warn() {}
    }
  });
  plugin.replyStreamsByMessageId.set('om_card', {
    async showActionFeedback(action, page) {
      feedbackCount += 1;
      assert.equal(action, 'permission_full_access');
      assert.equal(page, '/permissions');
    }
  });
  plugin.client = {
    im: {
      v1: {
        message: {
          async patch(payload) {
            patches.push(JSON.parse(payload?.data?.content || '{}'));
          },
          async create(payload) {
            sends.push(payload);
            return { data: { message_id: 'om_new' } };
          }
        }
      }
    }
  };

  await plugin.handleCardAction({
    action: {
      value: {
        remote_codex_action: 'permission_full_access',
        remote_codex_page: '/permissions'
      }
    },
    context: {
      open_chat_id: 'oc_chat',
      open_message_id: 'om_card'
    },
    operator: {
      operator_id: {
        open_id: 'ou_user'
      }
    }
  });

  assert.equal(feedbackCount, 1);
  assert.equal(patches.length, 1);
  assert.equal(sends.length, 0);
  assert.equal(patches[0].header.template, 'green');
  const markdown = patches[0].elements.find((element) => element.tag === 'markdown').content;
  assert.match(markdown, /操作已完成/);
  assert.match(markdown, /权限模式已更新/);
  assert.equal(patches[0].elements.some((element) => element.tag === 'action'), false);
}

async function testFeishuPermissionModeCardActionKeepsPageContext() {
  const routed = [];
  const plugin = feishuPlugin.create({
    config: {},
    pluginConfig: {
      mode: 'long_connection',
      streaming: true,
      appId: 'app',
      appSecret: 'secret'
    },
    services: {
      remoteController: {
        async handleMessage(message) {
          routed.push({
            text: message.text,
            pageContext: message.pageContext,
            conversationId: message.conversationId,
            userId: message.userId
          });
        }
      }
    },
    logger: {
      event() {},
      warn() {}
    }
  });

  await plugin.handleCardAction({
    action: {
      value: {
        remote_codex_action: 'permission_full_access',
        remote_codex_page: '/permissions'
      }
    },
    context: {
      open_chat_id: 'oc_chat'
    },
    operator: {
      operator_id: {
        open_id: 'ou_user'
      }
    }
  });

  assert.deepEqual(routed, [
    {
      text: '/permission_full_access',
      pageContext: '/permissions',
      conversationId: 'oc_chat',
      userId: 'ou_user'
    }
  ]);
}

async function testFeishuFollowupPanelAllowsSecondSubmit() {
  const routed = [];
  const patches = [];
  const plugin = feishuPlugin.create({
    config: {},
    pluginConfig: {
      mode: 'long_connection',
      streaming: false,
      appId: 'app',
      appSecret: 'secret'
    },
    services: {
      remoteController: {
        async handleMessage(message) {
          routed.push(message.text);
          if (message.text === '/permission_full_access') {
            await message.replyPanel({
              kind: 'native_slash',
              title: 'Remote Codex /permissions 确认',
              command: '/permissions',
              active: true,
              notice: 'Codex 还需要完成下一步选择，当前操作尚未结束。',
              content: [
                '**需要继续确认**',
                '- Enable full access?',
                '',
                '**选项**',
                '> 1. Yes, continue anyway',
                '- 2. Cancel'
              ].join('\n'),
              actions: ['up', 'down', 'enter', 'escape']
            });
          }
        }
      }
    },
    logger: {
      event() {},
      warn() {}
    }
  });
  plugin.client = {
    im: {
      v1: {
        message: {
          async patch(payload) {
            patches.push(JSON.parse(payload?.data?.content || '{}'));
          }
        }
      }
    }
  };

  const event = (remoteAction) => ({
    action: {
      value: {
        remote_codex_action: remoteAction,
        remote_codex_page: '/permissions'
      }
    },
    context: {
      open_chat_id: 'oc_chat',
      open_message_id: 'om_multistage'
    },
    operator: {
      operator_id: {
        open_id: 'ou_user'
      }
    }
  });

  await plugin.handleCardAction(event('permission_full_access'));
  await plugin.handleCardAction(event('enter'));

  assert.deepEqual(routed, ['/permission_full_access', '/enter']);
  const followupCard = patches.find((card) =>
    card.elements?.some((element) =>
      element.tag === 'markdown' && /Enable full access\?/.test(element.content)
    )
  );
  assert.ok(followupCard);
  assert.deepEqual(
    followupCard.elements.find((element) => element.tag === 'action').actions
      .map((action) => action.text.content),
    ['上移', '下移', '确认', '退出']
  );
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
