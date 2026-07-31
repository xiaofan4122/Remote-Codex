const {
  formatActionFeedback,
  formatActionStateText,
  formatRemoteActionLabel,
  isSubmitCardAction
} = require('./cardActions');
const {
  CARD_COLORS,
  buildCardConfig,
  clipForCard,
  colorCardText,
  formatCardMarkdown,
  inlineCode,
  summarizeForCard
} = require('./cardMarkdown');

const STREAM_CONTENT_ELEMENT_ID = 'content';
const STREAM_INITIAL_TEXT = [
  '**正在处理**',
  '',
  '已收到任务，正在等待 Codex 输出…'
].join('\n');

function buildReplyCard(text, index = 0, total = 1, options = {}) {
  const suffix = total > 1 ? ` ${index + 1}/${total}` : '';
  return {
    config: buildCardConfig({
      update_multi: true,
      wide_screen_mode: true,
      enable_forward: true
    }),
    header: {
      template: options.template || 'blue',
      title: {
        tag: 'plain_text',
        content: `${options.title || 'Remote Codex'}${suffix}`
      }
    },
    elements: [
      {
        tag: 'markdown',
        content: formatCardMarkdown(text)
      }
    ]
  };
}

function buildPanelCard(panel = {}) {
  const actions = buildPanelActions(panel);
  const elements = [
    {
      tag: 'markdown',
      content: formatCardMarkdown(buildPanelMarkdown(panel))
    }
  ];

  if (actions.length > 0) {
    elements.push({
      tag: 'action',
      actions
    });
  }

  return {
    config: buildCardConfig({
      update_multi: true,
      wide_screen_mode: true,
      enable_forward: true
    }),
    header: {
      template: getPanelTemplate(panel),
      title: {
        tag: 'plain_text',
        content: panel.title || 'Remote Codex'
      }
    },
    elements
  };
}

function buildActionStateCard({ action, page = '', text, status } = {}) {
  const label = formatRemoteActionLabel(action);
  const feedback = formatActionFeedback(action, page);
  const approvalAction = ['approve', 'approve_persistent', 'deny'].includes(
    String(action || '').toLowerCase()
  );
  const lines = approvalAction
    ? [text || formatActionStateText(status, action, page)]
    : [
        `**${feedback.title}**`,
        `- 操作: ${colorCardText(label, CARD_COLORS.approval)}`,
        `- 状态: ${text || formatActionStateText(status, action, page)}`,
        `- ${feedback.detail}`
      ];

  return {
    config: buildCardConfig({
      update_multi: true,
      wide_screen_mode: true,
      enable_forward: true
    }),
    header: {
      template: approvalAction && String(action || '').toLowerCase() === 'deny'
        ? 'grey'
        : isSubmitCardAction(action) ? 'green' : 'blue',
      title: {
        tag: 'plain_text',
        content: 'Remote Codex'
      }
    },
    elements: [
      {
        tag: 'markdown',
        content: formatCardMarkdown(lines.join('\n'))
      }
    ]
  };
}

function getPanelTemplate(panel = {}) {
  if (panel.template) return panel.template;
  if (panel.completed) return 'green';
  if (panel.kind === 'permission' && panel.active) return 'orange';
  if (panel.kind === 'permission') return 'grey';
  if (panel.kind === 'native_slash' && panel.command === '/permissions') return 'orange';
  if (panel.kind === 'native_slash' && panel.command === '/status') return 'green';
  if (panel.kind === 'native_slash') return 'blue';
  if (panel.kind === 'status' && panel.running) return 'green';
  if (panel.kind === 'status') return 'grey';
  return 'blue';
}

function buildPanelMarkdown(panel = {}) {
  if (panel.kind === 'status') return buildStatusPanelMarkdown(panel);
  if (panel.kind === 'permission') return buildPermissionPanelMarkdown(panel);
  if (panel.kind === 'native_slash') return buildNativeSlashPanelMarkdown(panel);
  if (panel.kind === 'commands') return buildCommandPanelMarkdown(panel);
  return panel.fallbackText || 'Remote Codex';
}

function buildStatusPanelMarkdown(panel = {}) {
  const lines = ['**状态**'];
  if (panel.notice) lines.push(`- ${panel.notice}`);

  if (!panel.attached || !panel.session) {
    lines.push(`- ${colorCardText('未接入会话', CARD_COLORS.warning)}`);
    lines.push('- 发送 `/start` 可启动会话；`/resume` 会打开 Codex 原生历史会话列表。');
    lines.push('', '**快捷命令**', '- `/start` 启动会话', '- `/resume` 历史会话列表', '- `/permission` 权限面板', '- `/status` Codex 状态');
    return lines.join('\n');
  }

  const session = panel.session || {};
  const outputMode = panel.config?.sendOutput ? panel.config?.outputMode : 'silent';
  lines.push(
    `- 运行: ${panel.running ? colorCardText('运行中', CARD_COLORS.success) : colorCardText('未运行', CARD_COLORS.muted)}`,
    `- 状态: ${formatPanelPhase(panel.phase)}`,
    `- 模式: ${inlineCode(panel.source || 'rollout_jsonl')}`,
    `- 工作目录: ${inlineCode(session.cwd || 'unknown')}`,
    `- 输出: ${inlineCode(outputMode || 'final')}`,
    `- 飞书长连接: ${panel.transport?.websocket ? colorCardText('已启动', CARD_COLORS.success) : colorCardText('未启动', CARD_COLORS.warning)}`
  );
  if (session.id) lines.push(`- 会话: ${inlineCode(session.id)}`);
  if (session.cursor !== undefined) lines.push(`- 游标: ${inlineCode(session.cursor)}`);
  if (session.createdAt) lines.push(`- 创建: ${inlineCode(session.createdAt)}`);
  if (panel.lastInputText) {
    lines.push(`- 最近输入: ${inlineCode(clipForCard(panel.lastInputText, 120))}`);
  }

  lines.push('', '**快捷命令**', '- `/resume` 历史会话列表', '- `/permission` 权限面板', '- `/status` Codex 状态', '- `/tail` 最近输出', '- `/stop` 中断当前任务，保留 Codex 会话');
  return lines.join('\n');
}

function formatPanelPhase(phase) {
  return {
    detached: '未接入',
    exited: '已退出',
    idle: '等待命令',
    working: '正在处理',
    loading_plugins: '正在加载插件',
    awaiting_authorization: '等待授权',
    native_resume: '历史会话选择',
    native_permissions: '权限模式选择',
    native_status: 'Codex 状态页',
    native_page: 'Codex 特殊页面'
  }[String(phase || '')] || String(phase || '未知');
}

function buildPermissionPanelMarkdown(panel = {}) {
  const lines = [];
  if (!panel.attached) {
    lines.push(panel.message || '当前没有接入会话。');
    lines.push('- 发送 `/resume` 可接入当前可视化 Codex 会话。');
    return lines.join('\n');
  }

  if (panel.active) {
    const approval = panel.approval || {};
    const reason = String(approval.reason || '')
      .replace(/^Reason:\s*/i, '')
      .trim();
    const command = clipForCard(String(approval.command || '').trim(), 1800)
      .replace(/```/g, "'''");
    if (reason) {
      lines.push(reason);
    }
    if (command) {
      if (lines.length > 0) lines.push('');
      lines.push('```bash', command, '```');
    }
    if (lines.length === 0) {
      lines.push(
        String(approval.question || panel.message || '需要确认本次操作。').trim()
      );
    }
    return lines.join('\n');
  }

  lines.push(panel.message || '当前没有待处理的权限请求。');
  return lines.join('\n');
}

function buildNativeSlashPanelMarkdown(panel = {}) {
  if (panel.command === '/resume') {
    return buildResumeNativeSlashPanelMarkdown(panel);
  }
  const lines = [];
  if (panel.notice) {
    lines.push(`- ${panel.notice}`, '');
  }
  const content = String(panel.content || panel.message || panel.fallbackText || '').trim();
  if (content) {
    lines.push(content);
  } else {
    lines.push('Codex 没有返回可解析的页面内容。');
  }
  return lines.join('\n');
}

function buildResumeNativeSlashPanelMarkdown(panel = {}) {
  const content = String(panel.content || panel.message || panel.fallbackText || '').trim();
  if (!content) return 'Codex 没有返回可解析的历史会话列表。';

  const sourceLines = content.split('\n');
  const selected = sourceLines
    .map((line) => line.trim())
    .find((line) => /^>\s+/.test(line));
  const lines = [];
  if (panel.notice) {
    lines.push(`- ${panel.notice}`, '');
  }

  for (const line of sourceLines) {
    const compact = line.trim();
    if (/^\*\*\/resume 会话列表\*\*$/.test(compact)) {
      lines.push('**历史会话**');
      if (selected) {
        lines.push(`- 当前选择: ${colorCardText(selected.replace(/^>\s+/, ''), CARD_COLORS.command)}`);
      }
      continue;
    }
    if (/^点击 Enter 或发送/.test(compact)) {
      lines.push('', colorCardText('点击“恢复”会切换到当前选中的历史会话；点击“退出”返回命令界面。', CARD_COLORS.muted));
      continue;
    }
    if (/^点击卡片里的/.test(compact)) {
      lines.push('', colorCardText('使用上移/下移切换选择，恢复前请确认当前选择。', CARD_COLORS.muted));
      continue;
    }
    if (/^>\s+/.test(compact)) {
      lines.push(colorCardText(compact, CARD_COLORS.command));
      continue;
    }
    if (/^-\s+/.test(compact) && !/^-\s+(?:第|卡片显示|选择要恢复|Codex 已|现在可以|当前)/.test(compact)) {
      lines.push(colorCardText(compact, CARD_COLORS.muted));
      continue;
    }
    lines.push(line);
  }
  return lines.join('\n').trim();
}

function buildCommandPanelMarkdown(panel = {}) {
  return [
    '**快捷命令**',
    panel.attached
      ? '- 已接入 Remote Codex 会话。'
      : '- 当前还没有接入会话，先使用 `/start`。',
    '',
    '- `/resume` 打开 Codex 原生历史会话列表',
    '- `/permission` 打开 Codex 原生权限面板',
    '- `/status` 打开 Codex 原生状态面板',
    '- `/tail` 查看最近输出',
    '- `/stop` 中断当前任务，保留 Codex 会话',
    '- `/remote-status` 查看 Remote Codex 自身状态'
  ].join('\n');
}

function buildPanelActions(panel = {}) {
  const actions = Array.isArray(panel.actions) ? panel.actions : [];
  return actions
    .map((action) => buildPanelActionButton(action, panel))
    .filter(Boolean)
    .slice(0, 6);
}

function buildPanelActionButton(action, panel = {}) {
  const value = String(action || '').toLowerCase();
  const nativeSlashLabels = panel.kind === 'native_slash'
    ? {
        enter: panel.command === '/resume' ? '恢复' : '确认',
        deny: '退出'
      }
    : {};
  const option = {
    approve: ['允许一次', 'approve', 'primary'],
    approve_persistent: ['总是允许', 'approve_persistent', 'default'],
    deny: [
      nativeSlashLabels.deny || '拒绝',
      'deny',
      nativeSlashLabels.deny ? 'default' : 'danger'
    ],
    escape: ['退出', 'escape', 'default'],
    resume: ['历史会话', 'resume', 'primary'],
    permission: ['权限', 'permission', 'default'],
    status: ['状态', 'status', 'default'],
    tail: ['最近输出', 'tail', 'default'],
    stop: ['中断任务', 'stop', 'danger'],
    up: ['上移', 'up', 'default'],
    down: ['下移', 'down', 'default'],
    page_up: ['上一页', 'page_up', 'default'],
    page_down: ['下一页', 'page_down', 'default'],
    home: ['顶部', 'home', 'default'],
    end: ['底部', 'end', 'default'],
    viewer_exit: ['退出', 'viewer_exit', 'default'],
    enter: [nativeSlashLabels.enter || '确认', 'enter', 'primary'],
    permission_default: ['Ask for approval', 'permission_default', 'default'],
    permission_auto_review: ['Approve for me', 'permission_auto_review', 'primary'],
    permission_full_access: ['Full Access', 'permission_full_access', 'danger'],
    help: ['帮助', 'help', 'default'],
    commands: ['快捷命令', 'commands', 'default']
  }[value];
  if (!option) return null;
  return buildControlButton(option[0], option[1], option[2], {
    page: panel.kind === 'native_slash' ? panel.command : '',
    context: panel.actionContext || ''
  });
}

function buildPanelFallbackText(panel = {}) {
  return stripCardMarkup(buildPanelMarkdown(panel));
}

function stripCardMarkup(text) {
  return String(text || '')
    .replace(/<font\s+color='[^']+'>/g, '')
    .replace(/<\/font>/g, '')
    .replace(/\*\*/g, '')
    .trim();
}

function buildStreamingCard({ title, initialText, controlMode = 'default' }) {
  const actions = buildControlButtons(controlMode);
  const content = String(initialText || '').trim() || STREAM_INITIAL_TEXT;
  const elements = [
    {
      tag: 'markdown',
      element_id: STREAM_CONTENT_ELEMENT_ID,
      content: formatCardMarkdown(content)
    }
  ];
  if (actions.length > 0) {
    elements.push(buildV2ButtonColumns(actions, 'stream_control'));
  }

  return {
    schema: '2.0',
    config: buildCardConfig({
      update_multi: true,
      summary: {
        content: 'Remote Codex 正在处理'
      },
      ...buildStreamingModeConfig()
    }),
    header: {
      template: getStreamingCardTemplate(controlMode),
      title: {
        tag: 'plain_text',
        content: title || 'Remote Codex'
      },
      subtitle: {
        tag: 'plain_text',
        content: getStreamingCardSubtitle(controlMode)
      }
    },
    body: {
      elements
    }
  };
}

function buildStreamingPanelCard(panel = {}) {
  const actions = buildPanelActions(panel);
  const text = buildPanelMarkdown(panel);
  const elements = [
    {
      tag: 'markdown',
      element_id: STREAM_CONTENT_ELEMENT_ID,
      content: formatCardMarkdown(text)
    }
  ];
  if (actions.length > 0) {
    elements.push(buildV2ButtonColumns(actions, 'panel_action'));
  }

  return {
    schema: '2.0',
    config: buildCardConfig({
      update_multi: true,
      streaming_mode: false,
      summary: {
        content: panel.kind === 'permission'
          ? 'Remote Codex 等待权限确认'
          : 'Remote Codex 等待操作'
      }
    }),
    header: {
      template: getPanelTemplate(panel),
      title: {
        tag: 'plain_text',
        content: panel.title || 'Remote Codex'
      },
      subtitle: {
        tag: 'plain_text',
        content: panel.kind === 'permission' ? '等待确认' : '等待操作'
      }
    },
    body: {
      elements
    }
  };
}

function buildStreamingModeConfig() {
  return {
    streaming_mode: true,
    streaming_config: {
      print_frequency_ms: {
        default: 10,
        pc: 10,
        ios: 15,
        android: 15
      },
      print_step: {
        default: 80,
        pc: 100,
        ios: 60,
        android: 60
      },
      print_strategy: 'fast'
    }
  };
}

function buildCompletedStreamingCard({
  title,
  text,
  summary,
  template = 'green',
  subtitle = '已完成',
  contentElements = null
} = {}) {
  const elements = Array.isArray(contentElements) && contentElements.length > 0
    ? contentElements
    : [
      {
        tag: 'markdown',
        element_id: STREAM_CONTENT_ELEMENT_ID,
        content: formatCardMarkdown(text)
      }
    ];
  return {
    schema: '2.0',
    config: buildCardConfig({
      update_multi: true,
      streaming_mode: false,
      summary: {
        content: summary || summarizeForCard(text) || 'Remote Codex'
      }
    }),
    header: {
      template: template || 'green',
      title: {
        tag: 'plain_text',
        content: title || 'Remote Codex'
      },
      subtitle: {
        tag: 'plain_text',
        content: subtitle || '已完成'
      }
    },
    body: {
      elements
    }
  };
}

function getStreamingCardSubtitle(controlMode = 'default') {
  if (controlMode === 'resume') return '选择历史会话';
  if (controlMode === 'permissions') return '设置权限模式';
  if (controlMode === 'status') return '正在读取状态';
  if (controlMode === 'viewer') return '查看原生页面';
  if (controlMode === 'navigation' || controlMode === 'slash') return '等待操作';
  return '正在处理';
}

function getStreamingCardTemplate(controlMode = 'default') {
  if (controlMode === 'resume') return 'blue';
  if (controlMode === 'permissions') return 'orange';
  if (controlMode === 'status') return 'blue';
  if (controlMode === 'viewer') return 'blue';
  if (controlMode === 'slash') return 'blue';
  return 'blue';
}

function getCompletedStreamingCardTemplate() {
  return 'green';
}

function buildControlButtons(controlMode = 'default') {
  if (controlMode === 'resume') {
    return [
      buildControlButton('上移', 'up', 'default', { page: '/resume' }),
      buildControlButton('下移', 'down', 'default', { page: '/resume' }),
      buildControlButton('恢复', 'enter', 'primary', { page: '/resume' }),
      buildControlButton('退出', 'escape', 'default', { page: '/resume' })
    ];
  }

  if (controlMode === 'permissions') {
    return [
      buildControlButton('Ask for approval', 'permission_default', 'default', { page: '/permissions' }),
      buildControlButton('Approve for me', 'permission_auto_review', 'primary', { page: '/permissions' }),
      buildControlButton('Full Access', 'permission_full_access', 'danger', { page: '/permissions' })
    ];
  }

  if (controlMode === 'status') {
    return [];
  }

  if (controlMode === 'viewer') {
    return [
      buildControlButton('上移', 'up', 'default'),
      buildControlButton('下移', 'down', 'default'),
      buildControlButton('上一页', 'page_up', 'default'),
      buildControlButton('下一页', 'page_down', 'default'),
      buildControlButton('退出', 'viewer_exit', 'primary')
    ];
  }

  if (controlMode === 'navigation' || controlMode === 'slash') {
    return [
      buildControlButton('上移', 'up', 'default'),
      buildControlButton('下移', 'down', 'default'),
      buildControlButton('确认', 'enter', 'primary'),
      buildControlButton('退出', 'escape', 'default')
    ];
  }

  return [];
}

function buildControlButton(label, action, type, options = {}) {
  const value = { remote_codex_action: action };
  if (options.page) value.remote_codex_page = options.page;
  if (options.context) value.remote_codex_context = options.context;
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: label
    },
    type,
    value,
    behaviors: [
      {
        type: 'callback',
        value
      }
    ]
  };
}

function buildV2ButtonColumns(actions, idPrefix) {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    background_style: 'default',
    horizontal_spacing: 'medium',
    margin: '12px 0 0 0',
    columns: actions.map((action, index) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'center',
      elements: [buildV2Button(action, `${idPrefix}_${index + 1}`)]
    }))
  };
}

function buildV2Button(action, elementId) {
  const value = action?.value && typeof action.value === 'object'
    ? action.value
    : {};
  return {
    tag: 'button',
    element_id: elementId.slice(0, 20),
    text: action.text,
    type: action.type || 'default',
    width: 'fill',
    size: 'large',
    behaviors: [
      {
        type: 'callback',
        value
      }
    ]
  };
}

module.exports = {
  STREAM_CONTENT_ELEMENT_ID,
  buildActionStateCard,
  buildCompletedStreamingCard,
  buildControlButtons,
  buildPanelCard,
  buildPanelFallbackText,
  buildPanelMarkdown,
  buildReplyCard,
  buildStreamingCard,
  buildStreamingPanelCard,
  buildStreamingModeConfig,
  getCompletedStreamingCardTemplate
};
