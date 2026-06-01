#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  classifyVisualTurnOutput,
  formatTerminalProgress,
  formatVisualProgressSnapshot,
  formatVisualSnapshot,
  mergeStreamingTurnText
} = require('../src/remoteSessionController');
const feishuPlugin = require('../src/plugins/feishu');

const feishuMarkdown = feishuPlugin.__private.formatCardMarkdown;

const fixtures = [
  {
    name: 'final bullet answer is not progress',
    run: () => {
      const input = '测试最终回答';
      const snapshot = [
        `› ${input}`,
        '• 我会建议你先保留当前实现。'
      ].join('\n');
      return {
        progress: formatVisualProgressSnapshot(snapshot, input),
        final: formatVisualSnapshot(snapshot, input)
      };
    },
    expected: {
      progress: '',
      final: '我会建议你先保留当前实现。'
    }
  },
  {
    name: 'human progress note keeps note and hides technical actions',
    run: () => {
      const input = '审阅当前工作空间中的代码';
      const snapshot = [
        `› ${input}`,
        '• 基础检查都过了，但我还要验证两个边界。',
        '  这样可以避免最终回答和流式更新互相干扰。',
        '• Ran node -c scripts/smoke-remote-streaming.js',
        '• Ran node -e "const parser=require(\'./src/remoteSessionController\')"',
        '  │ console.log(parser.formatVisualProgressSnapshot(...))',
        '• Explored',
        '  └ Search updateReplyStream|formatVisualProgressSnapshot',
        '• Edited src/remoteSessionController.js'
      ].join('\n');
      return formatVisualProgressSnapshot(snapshot, input);
    },
    expected: [
      '**进度**',
      '- 基础检查都过了，但我还要验证两个边界。',
      '  这样可以避免最终回答和流式更新互相干扰。',
      '- Ran node -c scripts/smoke-remote-streaming.js',
      '- Ran node -e "const parser=require(\'./src/remoteSessionController\')"',
      '- Explored',
      '- Edited src/remoteSessionController.js'
    ].join('\n'),
    forbidden: [
      'console.log',
      'Search updateReplyStream'
    ]
  },
  {
    name: 'technical-only visual progress is summarized',
    run: () => {
      const input = '修复远程流式卡片';
      const snapshot = [
        `› ${input}`,
        '• Read src/plugins/feishu/index.js',
        '• Searched streaming card docs',
        '• Edited src/plugins/feishu/index.js',
        '• Ran node -c src/plugins/feishu/index.js'
      ].join('\n');
      return formatVisualProgressSnapshot(snapshot, input);
    },
    expected: [
      '**进度**',
      '- Read src/plugins/feishu/index.js',
      '- Searched streaming card docs',
      '- Edited src/plugins/feishu/index.js',
      '- Ran node -c src/plugins/feishu/index.js'
    ].join('\n'),
    forbidden: []
  },
  {
    name: 'thinking explanation streams before technical actions',
    run: () => {
      const input = '实现流式说明文字';
      const snapshot = [
        `› ${input}`,
        'Thinking (3s • esc to interrupt)',
        '我先检查远程输出解析和飞书卡片更新链路。',
        '• 当前看起来是进度提取规则没有保留说明文字。'
      ].join('\n');
      return formatVisualProgressSnapshot(snapshot, input);
    },
    expected: [
      '**进度**',
      '- Thinking (3s)',
      '- 我先检查远程输出解析和飞书卡片更新链路。',
      '- 当前看起来是进度提取规则没有保留说明文字。'
    ].join('\n')
  },
  {
    name: 'progress streams when submitted prompt scrolled out',
    run: () => {
      const input = '修改飞书表情状态';
      const snapshot = [
        'Working (7s • esc to interrupt)',
        '我已经定位到两个具体修复点，正在改代码：一个是 viewport 里没有原始 prompt 时仍然解析当前 turn 的可见输出，另一个是把“完成”回调接到流式卡片关闭或最终回复发送成功之后。',
        '• Edited src/remoteSessionController.js'
      ].join('\n');
      return formatVisualProgressSnapshot(snapshot, input, { allowMissingPrompt: true });
    },
    expected: [
      '**进度**',
      '- Working (7s)',
      '- 我已经定位到两个具体修复点，正在改代码：一个是 viewport 里没有原始 prompt 时仍然解析当前 turn 的可见输出，另一个是把“完成”回调接到流式卡片关闭或最终回复发送成功之后。',
      '- Edited src/remoteSessionController.js'
    ].join('\n')
  },
  {
    name: 'classified progress keeps note when submitted prompt scrolled out',
    run: () => {
      const input = '修改飞书表情状态';
      const snapshot = [
        'Working (7s • esc to interrupt)',
        '我已经定位到两个具体修复点，正在改代码：一个是 viewport 里没有原始 prompt 时仍然解析当前 turn 的可见输出，另一个是把“完成”回调接到流式卡片关闭或最终回复发送成功之后。'
      ].join('\n');
      const classified = classifyVisualTurnOutput(snapshot, input, { allowMissingPrompt: true });
      return {
        status: classified.status.text,
        explanations: classified.explanations,
        finalText: classified.finalText
      };
    },
    expected: {
      status: 'Working (7s)',
      explanations: [
        '我已经定位到两个具体修复点，正在改代码：一个是 viewport 里没有原始 prompt 时仍然解析当前 turn 的可见输出，另一个是把“完成”回调接到流式卡片关闭或最终回复发送成功之后。'
      ],
      finalText: ''
    }
  },
  {
    name: 'final answer extracts when submitted prompt scrolled out',
    run: () => {
      const input = '修改飞书表情状态';
      const snapshot = [
        '可以，已改好。',
        '',
        '现在 Feishu 收到你发来的远程命令后，会先给原消息加“工作中”表情；远程任务正常处理完成后，会再给同一条消息加“完成”表情。'
      ].join('\n');
      return formatVisualSnapshot(snapshot, input, { allowMissingPrompt: true });
    },
    expected: [
      '可以，已改好。',
      '现在 Feishu 收到你发来的远程命令后，会先给原消息加“工作中”表情；远程任务正常处理完成后，会再给同一条消息加“完成”表情。'
    ].join('\n')
  },
  {
    name: 'streaming progress accumulates across viewport snapshots',
    run: () => {
      const first = [
        '**进度**',
        '- Working (1s)',
        '- 我先检查远程输出解析链路。'
      ].join('\n');
      const second = [
        '**进度**',
        '- Working (2s)',
        '- 我再检查 Feishu stream 更新链路。'
      ].join('\n');
      return mergeStreamingTurnText(first, second);
    },
    expected: [
      '**进度**',
      '- Working (2s)',
      '- 我先检查远程输出解析链路。',
      '- 我再检查 Feishu stream 更新链路。'
    ].join('\n')
  },
  {
    name: 'plain final-looking text without active status is not progress',
    run: () => {
      const input = '总结一下';
      const snapshot = [
        `› ${input}`,
        '我已经完成实现，并补了测试。'
      ].join('\n');
      return formatVisualProgressSnapshot(snapshot, input);
    },
    expected: ''
  },
  {
    name: 'visual turn output is classified by purpose',
    run: () => {
      const input = '实现分类输出';
      const snapshot = [
        `› ${input}`,
        'Thinking (4s • esc to interrupt)',
        '我先把当前终端输出按用途分类，后续再决定远端展示策略。',
        '• Read src/remoteSessionController.js',
        '  └ Search parseCodexProgressState',
        '• Edited src/remoteSessionController.js',
        '• Ran npm run test:remote-output-parser',
        '• 这个结构会保留人能看懂的说明，同时把命令和文件路径放进技术细节。',
        '• 已加入分类能力。'
      ].join('\n');
      const classified = classifyVisualTurnOutput(snapshot, input);
      return {
        status: classified.status?.text || '',
        explanations: classified.explanations,
        activityKinds: classified.activities.map((activity) => activity.kind),
        technical: classified.technical,
        finalText: classified.finalText
      };
    },
    expected: {
      status: 'Thinking (4s)',
      explanations: [
        '我先把当前终端输出按用途分类，后续再决定远端展示策略。',
        '这个结构会保留人能看懂的说明，同时把命令和文件路径放进技术细节。'
      ],
      activityKinds: ['inspect', 'edit', 'verify'],
      technical: [
        'Read src/remoteSessionController.js',
        '└ Search parseCodexProgressState',
        'Edited src/remoteSessionController.js',
        'Ran npm run test:remote-output-parser'
      ],
      finalText: '已加入分类能力。'
    }
  },
  {
    name: 'classification keeps plain final answer out of progress buckets',
    run: () => {
      const input = '总结一下';
      const snapshot = [
        `› ${input}`,
        '• 我已经完成实现，并补了测试。'
      ].join('\n');
      return classifyVisualTurnOutput(snapshot, input);
    },
    expected: {
      kind: 'turn',
      status: null,
      explanations: [],
      activities: [],
      technical: [],
      warnings: [],
      approval: null,
      finalText: '我已经完成实现，并补了测试。'
    }
  },
  {
    name: 'raw terminal fallback is summarized',
    run: () => {
      const raw = [
        '\x1b[32m• Ran node -c scripts/smoke-remote-streaming.js\x1b[0m',
        '• Explored',
        '  └ Search isLikelyProgressMarkerText',
        '• Updated src/remoteSessionController.js'
      ].join('\n');
      return formatTerminalProgress(raw);
    },
    expected: [
      '**进度**',
      '- Ran node -c scripts/smoke-remote-streaming.js',
      '- Explored',
      '- Updated src/remoteSessionController.js'
    ].join('\n'),
    forbidden: ['Search isLikelyProgressMarkerText']
  },
  {
    name: 'working status remains visible',
    run: () => formatTerminalProgress('Working (8s • esc to interrupt)'),
    expected: '**进度**\n- Working (8s)'
  },
  {
    name: 'approval prompt preserves actionable command',
    run: () => {
      const lines = [
        'Running shell command',
        'Would you like to run the following command?',
        'Reason: Need to verify the change.',
        '$ npm run smoke:remote-streaming',
        '> 1. Yes',
        '  2. No'
      ];
      return formatTerminalProgress(lines.join('\n'));
    },
    expected: [
      '**等待确认**',
      '- Running shell command',
      '- Would you like to run the following command?',
      '- Reason: Need to verify the change.',
      '',
      '```bash',
      'npm run smoke:remote-streaming',
      '```',
      '',
      '**选项**',
      '> 1. Yes',
      '- 2. No',
      '',
      '可在卡片按钮中选择，也可以发送 `/approve`、`/always` 或 `/deny`。'
    ].join('\n')
  },
  {
    name: 'usage limit warning is visible',
    run: () => formatTerminalProgress("You've hit your usage limit."),
    expected: '**进度**\n- Error: You\'ve hit your usage limit.'
  },
  {
    name: 'intro and prompt noise are ignored',
    run: () => {
      const input = '无输出任务';
      const snapshot = [
        'Use /skills to list available skills',
        `› ${input}`,
        '›'
      ].join('\n');
      return formatVisualProgressSnapshot(snapshot, input);
    },
    expected: ''
  },
  {
    name: 'final answer with markdown is preserved',
    run: () => {
      const input = '给我代码';
      const snapshot = [
        `› ${input}`,
        '• 可以这样写：',
        '```js',
        "console.log('ok');",
        '```'
      ].join('\n');
      return formatVisualSnapshot(snapshot, input);
    },
    expected: [
      '可以这样写：',
      '```js',
      "console.log('ok');",
      '```'
    ].join('\n')
  },
  {
    name: 'local native status prompt does not contaminate final answer',
    run: () => {
      const input = '总结一下当前实现';
      const snapshot = [
        `› ${input}`,
        '• 已经完成主要实现。',
        '› /status',
        '>_ OpenAI Codex (v0.135.0)',
        'Model: gpt-5.5',
        'Directory: /tmp/project',
        'Permissions: Workspace',
        'Session: abc123',
        '5h limit: [████░░░░] 50% left (resets 12:00)',
        '• 后续回复也应该继续保留。'
      ].join('\n');
      return formatVisualSnapshot(snapshot, input);
    },
    expected: '已经完成主要实现。\n后续回复也应该继续保留。',
    forbidden: ['Codex 状态', 'gpt-5.5', '5h limit', 'abc123']
  },
  {
    name: 'local native status panel does not contaminate progress stream',
    run: () => {
      const input = '继续实现功能';
      const snapshot = [
        `› ${input}`,
        'Thinking (3s • esc to interrupt)',
        '我正在检查当前状态。',
        '>_ OpenAI Codex (v0.135.0)',
        'Model: gpt-5.5',
        'Directory: /tmp/project',
        'Permissions: Workspace',
        'Session: abc123'
      ].join('\n');
      return formatVisualProgressSnapshot(snapshot, input);
    },
    expected: [
      '**进度**',
      '- Thinking (3s)',
      '- 我正在检查当前状态。'
    ].join('\n'),
    forbidden: ['gpt-5.5', '/tmp/project', 'abc123']
  },
  {
    name: 'technical progress after answer marker is not appended to final answer',
    run: () => {
      const input = '解释上次问题';
      const snapshot = [
        `› ${input}`,
        '• 解析问题来自终端页面和任务回复混在同一个视觉快照里。',
        '• Ran npm run test:remote-output-parser',
        '  │ Remote output parser tests passed',
        '• Edited src/remoteSessionController.js',
        '• 需要保留这句人类可读的后续结论。'
      ].join('\n');
      return formatVisualSnapshot(snapshot, input);
    },
    expected: [
      '解析问题来自终端页面和任务回复混在同一个视觉快照里。',
      '需要保留这句人类可读的后续结论。'
    ].join('\n'),
    forbidden: ['npm run', 'Remote output parser', 'src/remoteSessionController.js']
  },
  {
    name: 'technical indented notes are not streamed as explanations',
    run: () => {
      const input = '继续修复解析';
      const snapshot = [
        `› ${input}`,
        'Thinking (5s • esc to interrupt)',
        '我会先复现上次丢回复的问题。',
        '• Ran npm run test:remote-output-parser',
        '  │ scripts/test-remote-output-parser.js failed',
        '  │ src/remoteSessionController.js:2520',
        '• 现在改成剥离外部页面块。'
      ].join('\n');
      return formatVisualProgressSnapshot(snapshot, input);
    },
    expected: [
      '**进度**',
      '- Thinking (5s)',
      '- 我会先复现上次丢回复的问题。',
      '- Ran npm run test:remote-output-parser',
      '- 现在改成剥离外部页面块。'
    ].join('\n'),
    forbidden: ['scripts/test-remote-output-parser.js', 'src/remoteSessionController.js']
  },
  {
    name: 'styled progress carries Codex color marker',
    run: () => {
      const input = '检查颜色';
      const snapshot = {
        lines: [
          { text: `› ${input}` },
          {
            text: '• Ran node -c scripts/smoke-remote-streaming.js',
            bulletStyle: { fgMode: 'palette', fg: 4, bgMode: 'default', bg: 0 }
          }
        ]
      };
      return formatVisualProgressSnapshot(snapshot, input, { colorMarkers: true });
    },
    expected: [
      '**进度**',
      '- <!--remote-codex-color:rgba(96,165,250,1)-->Ran node -c scripts/smoke-remote-streaming.js'
    ].join('\n'),
    forbidden: []
  },
  {
    name: 'Feishu markdown consumes internal color markers',
    run: () =>
      feishuMarkdown(
        [
          '**进度**',
          '- <!--remote-codex-color:rgba(96,165,250,1)-->Ran node -c scripts/smoke-remote-streaming.js'
        ].join('\n')
      ),
    expected: [
      "<font color='cus-remote-progress'>**进度**</font>  ",
      "<font color='cus-remote-progress'>- Ran `node -c scripts/smoke-remote-streaming.js`</font>"
    ].join('\n'),
    forbidden: ['remote-codex-color']
  }
];

for (const fixture of fixtures) {
  const actual = fixture.run();
  assert.deepEqual(actual, fixture.expected, fixture.name);
  for (const forbidden of fixture.forbidden || []) {
    assert.doesNotMatch(
      typeof actual === 'string' ? actual : JSON.stringify(actual),
      new RegExp(escapeRegExp(forbidden)),
      `${fixture.name}: leaked ${forbidden}`
    );
  }
}

console.log(`Remote output parser tests passed (${fixtures.length} fixtures).`);

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
