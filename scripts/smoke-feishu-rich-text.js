#!/usr/bin/env node

const assert = require('node:assert/strict');
const feishuPlugin = require('../src/plugins/feishu');

async function main() {
  smokeCardMarkdownCodexColors();
  await smokeReplyStreamDripsFrames();

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

function smokeCardMarkdownCodexColors() {
  const markdown = feishuPlugin.__private.formatCardMarkdown(
    [
      '**进度**',
      '- <!--remote-codex-color:rgba(96,165,250,1)-->Ran node -c test.js',
      '  <!--remote-codex-color:rgba(100,116,139,1)-->└ Search parser'
    ].join('\n')
  );

  assert.match(markdown, /<font color='cus-remote-progress'>- Ran node -c test\.js<\/font>/);
  assert.match(markdown, /<font color='cus-remote-muted'>  └ Search parser<\/font>/);
  assert.doesNotMatch(markdown, /remote-codex-color/);

  const card = feishuPlugin.__private.buildStreamingCard({
    title: 'Remote Codex',
    initialText: markdown,
    controlMode: 'default'
  });
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
    30
  );
  assert.equal(
    card.config.streaming_config.print_step.default,
    4
  );
}

async function smokeReplyStreamDripsFrames() {
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
    '- Ran node -c scripts/smoke-remote-streaming.js',
    '',
    '**回复**',
    '这是一段足够长的最终回复，用来确认飞书卡片不是一次性整段替换，而是按多个 frame 更新。'
  ].join('\n');

  await stream.update(text);
  assert.ok(frames.length >= 3, `expected multiple stream frames, got ${frames.length}`);
  assert.equal(frames.at(-1), text);
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
