#!/usr/bin/env node

const assert = require('node:assert/strict');
const feishuPlugin = require('../src/plugins/feishu');

async function main() {
  smokeCardMarkdownCodexColors();
  smokeCardMarkdownHeadingSpacing();
  await smokeReplyStreamPatchesCurrentTarget();
  await smokeReplyStreamCoalescesRapidTargets();
  await smokeReplyStreamFinishesWithCompletedTemplate();
  await smokeReplyStreamRecoversFailedElementUpdate();
  await smokeCreateReplyStreamKeepsEmptyInitialText();
  await smokeStreamingUpdateLogsText();

  assert.equal(
    await dispatchText({
      content: JSON.stringify({ text: 'hello from text' })
    }),
    'hello from text'
  );
  assert.equal(
    await dispatchText({
      pluginConfig: { requireMention: true },
      content: JSON.stringify({
        title: '富文本标题',
        content: [
          [
            { tag: 'at', user_name: 'Remote Codex', user_id: 'ou_bot' },
            { tag: 'text', text: ' 请总结 ' },
            { tag: 'a', text: '这个链接', href: 'https://example.com' }
          ],
          [{ tag: 'text', text: '第二行' }]
        ]
      }),
      mentions: [
        {
          key: '@_user_1',
          name: 'Remote Codex',
          id: { open_id: 'ou_bot' }
        }
      ]
    }),
    '富文本标题\n请总结 这个链接 (https://example.com)\n第二行'
  );

  assert.equal(
    await dispatchText({
      content: JSON.stringify({
        post: {
          zh_cn: {
            content: [
              [
                { tag: 'text', text: '查看截图' },
                { tag: 'img', image_key: 'img_key' }
              ]
            ]
          }
        }
      })
    }),
    '查看截图[图片]'
  );

  console.log('Feishu rich text smoke passed.');
}

function smokeCardMarkdownHeadingSpacing() {
  const markdown = feishuPlugin.__private.formatCardMarkdown([
    '开场说明',
    '**结果**',
    '第一段内容',
    '- 紧凑列表一',
    '- 紧凑列表二',
    '## 验证',
    '验证完成',
    '```md',
    '**代码块内不是标题**',
    '代码块内容',
    '```'
  ].join('\n'));

  assert.match(markdown, /开场说明  \n\n\*\*结果\*\*  \n\n第一段内容/);
  assert.match(markdown, /- 紧凑列表一  \n- 紧凑列表二/);
  assert.match(markdown, /- 紧凑列表二  \n\n## 验证  \n\n验证完成/);
  assert.match(markdown, /```md\n\*\*代码块内不是标题\*\*\n代码块内容\n```/);
}

function smokeCardMarkdownCodexColors() {
  const markdown = feishuPlugin.__private.formatCardMarkdown(
    [
      '**进度**',
      '- <!--remote-codex-color:rgba(96,165,250,1)-->Ran node -c test.js',
      '  <!--remote-codex-color:rgba(100,116,139,1)-->└ Search parser',
      '- Edited src/plugins/feishu/index.js'
    ].join('\n')
  );

  assert.match(markdown, /<font color='cus-remote-progress'>- Ran `node -c test\.js`<\/font>/);
  assert.match(markdown, /<font color='cus-remote-muted'>　└ Search parser<\/font>/);
  assert.match(markdown, /<font color='cus-remote-success'>- Edited `src\/plugins\/feishu\/index\.js`<\/font>/);
  assert.doesNotMatch(markdown, /remote-codex-color/);

  const card = feishuPlugin.__private.buildStreamingCard({
    title: 'Remote Codex',
    initialText: markdown,
    controlMode: 'default'
  });
  assert.equal(card.header.subtitle.content, '正在处理');
  assert.equal(
    card.config.style.color['cus-remote-progress'].light_mode,
    'rgba(29,78,216,1)'
  );
  assert.equal(
    card.config.style.color['cus-remote-progress'].dark_mode,
    'rgba(96,165,250,1)'
  );
  assert.equal(
    card.config.streaming_config.print_frequency_ms.default,
    10
  );
  assert.equal(
    card.config.streaming_config.print_step.default,
    80
  );

  const completed = feishuPlugin.__private.buildCompletedStreamingCard({
    title: 'Remote Codex',
    text: '最终完成',
    template: 'green'
  });
  assert.equal(completed.header.template, 'green');
  assert.equal(completed.header.subtitle.content, '已完成');
  assert.equal(completed.config.streaming_mode, false);
  assert.equal(completed.body.elements.some((element) => element.tag === 'action'), false);
  assert.match(completed.body.elements[0].content, /最终完成/);
}

async function smokeReplyStreamRecoversFailedElementUpdate() {
  const closes = [];
  let closeAttempts = 0;
  const stream = new feishuPlugin.__private.FeishuReplyStream({
    plugin: {
      async updateStreamingContent() {
        throw new Error('simulated element update failure');
      },
      async closeStreamingCard(payload) {
        closeAttempts += 1;
        if (closeAttempts === 1) {
          throw new Error('simulated close failure');
        }
        closes.push(payload);
      }
    },
    cardId: 'card-recovery',
    elementId: 'content',
    logger: {
      warn() {},
      event() {}
    }
  });

  await stream.finish('最终整卡内容');
  assert.equal(closeAttempts, 2);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].text, '最终整卡内容');
}

async function smokeReplyStreamPatchesCurrentTarget() {
  const frames = [];
  const stream = new feishuPlugin.__private.FeishuReplyStream({
    plugin: {
      async updateStreamingContent({ text }) {
        frames.push(text);
      },
      async closeStreamingCard() {}
    },
    cardId: 'card',
    elementId: 'content',
    logger: {
      warn() {},
      event() {}
    }
  });

  const text = [
    '**进度**',
    '- Working (6s)',
    '- Ran npm run test:feishu-remote-turn',
    '',
    '**回复**',
    '这是一段足够长的最终回复，用来确认飞书卡片不是一次性整段替换，而是按多个 frame 更新。'
  ].join('\n');

  await stream.update(text);
  assert.equal(frames.length, 1);
  assert.equal(frames.at(-1), text);
}

async function smokeReplyStreamCoalescesRapidTargets() {
  const frames = [];
  const stream = new feishuPlugin.__private.FeishuReplyStream({
    plugin: {
      async updateStreamingContent({ text, sequence }) {
        frames.push({ text, sequence, at: Date.now() });
      },
      async closeStreamingCard() {}
    },
    cardId: 'card',
    elementId: 'content',
    logger: {
      warn() {},
      event() {}
    }
  });

  await Promise.all([
    stream.update('**进度**\n- 第一步'),
    stream.update('**进度**\n- 第二步'),
    stream.update('**进度**\n- 第三步\n\n**回复**\n最终内容')
  ]);

  assert.ok(frames.length <= 2, `expected coalesced frames, got ${frames.length}`);
  assert.equal(frames.at(-1).text, '**进度**\n- 第三步\n\n**回复**\n最终内容');
  for (let index = 1; index < frames.length; index += 1) {
    assert.ok(frames[index].sequence > frames[index - 1].sequence);
  }
}

async function smokeReplyStreamFinishesWithCompletedTemplate() {
  const frames = [];
  const closes = [];
  const stream = new feishuPlugin.__private.FeishuReplyStream({
    plugin: {
      async updateStreamingContent({ text }) {
        frames.push(text);
      },
      async closeStreamingCard(payload) {
        closes.push(payload);
      }
    },
    cardId: 'card',
    elementId: 'content',
    title: 'Remote Codex',
    completedTemplate: 'green',
    logger: {
      warn() {},
      event() {}
    }
  });

  await stream.finish('最终完成');

  assert.equal(frames.at(-1), '最终完成');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].template, 'green');
  assert.equal(closes[0].title, 'Remote Codex');
  assert.equal(closes[0].text, '最终完成');
}

async function smokeCreateReplyStreamKeepsEmptyInitialText() {
  let initialText = 'unset';
  const plugin = feishuPlugin.create({
    config: {},
    pluginConfig: {
      mode: 'long_connection',
      streaming: true
    },
    services: {
      remoteController: {
        async handleMessage(message) {
          await message.createReplyStream({
            initialText: '',
            controlMode: 'default'
          });
        }
      }
    },
    logger: {
      event() {},
      warn() {}
    }
  });
  plugin.createReplyStream = async ({ initialText: text }) => {
    initialText = text;
    return null;
  };

  await plugin.handleReceiveMessage({
    sender: { sender_id: { open_id: 'ou_sender' } },
    message: {
      chat_id: 'oc_chat',
      message_id: 'om_empty_initial',
      content: JSON.stringify({ text: 'hello' })
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(initialText, '');
}

async function smokeStreamingUpdateLogsText() {
  const events = [];
  const plugin = feishuPlugin.create({
    config: {},
    pluginConfig: {
      mode: 'long_connection'
    },
    services: {},
    logger: {
      event(message, meta) {
        events.push({ message, meta });
      },
      warn() {}
    }
  });
  plugin.cardkitRequest = async () => ({});
  const text = '**进度**\n- 正在检查项目结构';

  await plugin.updateStreamingContent({
    cardId: 'card',
    elementId: 'content',
    text,
    sequence: 2
  });

  const event = events.find((item) => item.message === 'feishu.stream.updated');
  assert.ok(event);
  assert.equal(event.meta.chars, text.length);
  assert.match(event.meta.text, /正在检查项目结构/);
}

async function dispatchText({ content, mentions = [], pluginConfig = {} }) {
  let receivedText = '';
  const plugin = feishuPlugin.create({
    config: {},
    pluginConfig: {
      mode: 'long_connection',
      ...pluginConfig
    },
    services: {
      remoteController: {
        async handleMessage(message) {
          receivedText = message.text;
        }
      }
    },
    logger: {
      event() {},
      warn() {}
    }
  });

  await plugin.handleReceiveMessage({
    sender: {
      sender_id: {
        open_id: 'ou_sender'
      }
    },
    message: {
      chat_id: 'oc_chat',
      message_id: `om_${Math.random().toString(16).slice(2)}`,
      content,
      mentions
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  return receivedText;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
