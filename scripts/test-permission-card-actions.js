#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  RemoteSessionController,
  formatTerminalProgress
} = require('../src/remoteSessionController');
const feishuPlugin = require('../src/plugins/feishu');

async function main() {
  testApprovalOptionSelection();
  testFeishuPermissionPanelShowsOptionsAndControls();
  await testRemoteControlInputBuffer();
  await testFeishuCardActionUpdatesAndDedupes();
  console.log('Permission card action tests passed.');
}

function approvalLines(selected = 1) {
  return [
    'Running shell command',
    'Would you like to run the following command?',
    'Reason: Need to verify.',
    '$ npm run smoke:remote-streaming',
    `${selected === 1 ? '>' : ' '} 1. Yes`,
    `${selected === 2 ? '>' : ' '} 2. Yes, always approve`,
    `${selected === 3 ? '>' : ' '} 3. No`
  ].join('\n');
}

function testApprovalOptionSelection() {
  const first = formatTerminalProgress(approvalLines(1));
  assert.match(first, /> 1\. Yes/);
  assert.match(first, /- 2\. Yes, always approve/);

  const second = formatTerminalProgress(approvalLines(2));
  assert.match(second, /- 1\. Yes/);
  assert.match(second, /> 2\. Yes, always approve/);
}

function testFeishuPermissionPanelShowsOptionsAndControls() {
  const progressText = formatTerminalProgress(approvalLines(2));
  const card = feishuPlugin.__private.buildPanelCard({
    kind: 'permission',
    title: 'Remote Codex 权限确认',
    attached: true,
    active: true,
    approval: {
      options: [
        { index: 1, text: 'Yes', selected: false },
        { index: 2, text: 'Yes, always approve', selected: true },
        { index: 3, text: 'No', selected: false }
      ]
    },
    message: 'Codex 正在等待权限确认。',
    progressText,
    actions: ['approve', 'approve_persistent', 'deny', 'up', 'down', 'enter']
  });
  const markdown = card.elements.find((element) => element.tag === 'markdown').content;
  const actions = card.elements.find((element) => element.tag === 'action').actions;

  assert.match(markdown, /> 2\. Yes, always approve/);
  assert.match(markdown, /上移\/下移会切换 `>` 标记的选项/);
  assert.deepEqual(
    actions.map((action) => action.text.content),
    ['允许一次', '总是允许', '拒绝', '上移', '下移', '确认']
  );

  const fallbackCard = feishuPlugin.__private.buildPanelCard({
    kind: 'permission',
    title: 'Remote Codex 权限确认',
    attached: true,
    active: true,
    approval: {
      options: [
        { index: 1, text: 'Yes', selected: false },
        { index: 2, text: 'Yes, always approve', selected: true },
        { index: 3, text: 'No', selected: false }
      ]
    },
    message: 'Codex 正在等待权限确认。',
    actions: ['approve', 'approve_persistent', 'deny', 'up', 'down', 'enter']
  });
  const fallbackMarkdown = fallbackCard.elements.find(
    (element) => element.tag === 'markdown'
  ).content;
  assert.match(fallbackMarkdown, /\*\*选项\*\*/);
  assert.match(fallbackMarkdown, /> 2\. Yes, always approve/);
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
      command: '$ npm run smoke:remote-streaming',
      options: [
        { index: 1, text: 'Yes', selected: false },
        { index: 2, text: 'Yes, always approve', selected: true },
        { index: 3, text: 'No', selected: false }
      ]
    }
  );
  assert.match(replies.at(-1), /选项:/);
  assert.match(replies.at(-1), /> 2\. Yes, always approve/);
}

async function testFeishuCardActionUpdatesAndDedupes() {
  let handleCount = 0;
  let patchCount = 0;
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
          handleCount += 1;
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
            assert.match(content, /操作已提交/);
          }
        }
      }
    }
  };

  const event = {
    action: {
      value: { remote_codex_action: 'approve' }
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

  assert.equal(handleCount, 1);
  assert.equal(patchCount, 1);
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
