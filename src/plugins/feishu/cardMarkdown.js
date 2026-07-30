const CARD_COLORS = {
  approval: 'rgba(247,201,72,1)',
  command: 'rgba(96,165,250,1)',
  error: 'rgba(255,107,107,1)',
  info: 'rgba(103,232,249,1)',
  muted: 'rgba(100,116,139,1)',
  progress: 'rgba(96,165,250,1)',
  reply: 'rgba(110,231,183,1)',
  running: 'rgba(247,201,72,1)',
  success: 'rgba(110,231,183,1)',
  warning: 'rgba(247,201,72,1)'
};

const LIGHT_CARD_COLORS = {
  approval: 'rgba(146,64,14,1)',
  command: 'rgba(29,78,216,1)',
  error: 'rgba(220,38,38,1)',
  info: 'rgba(14,116,144,1)',
  muted: 'rgba(71,85,105,1)',
  progress: 'rgba(29,78,216,1)',
  reply: 'rgba(4,120,87,1)',
  running: 'rgba(146,64,14,1)',
  success: 'rgba(4,120,87,1)',
  warning: 'rgba(180,83,9,1)'
};

const FEISHU_CARD_CUSTOM_COLORS = {
  'cus-remote-approval': {
    light_mode: LIGHT_CARD_COLORS.approval,
    dark_mode: CARD_COLORS.approval
  },
  'cus-remote-command': {
    light_mode: LIGHT_CARD_COLORS.command,
    dark_mode: CARD_COLORS.command
  },
  'cus-remote-error': {
    light_mode: LIGHT_CARD_COLORS.error,
    dark_mode: CARD_COLORS.error
  },
  'cus-remote-info': {
    light_mode: LIGHT_CARD_COLORS.info,
    dark_mode: CARD_COLORS.info
  },
  'cus-remote-muted': {
    light_mode: LIGHT_CARD_COLORS.muted,
    dark_mode: CARD_COLORS.muted
  },
  'cus-remote-progress': {
    light_mode: LIGHT_CARD_COLORS.progress,
    dark_mode: CARD_COLORS.progress
  },
  'cus-remote-reply': {
    light_mode: LIGHT_CARD_COLORS.reply,
    dark_mode: CARD_COLORS.reply
  },
  'cus-remote-running': {
    light_mode: LIGHT_CARD_COLORS.running,
    dark_mode: CARD_COLORS.running
  },
  'cus-remote-success': {
    light_mode: LIGHT_CARD_COLORS.success,
    dark_mode: CARD_COLORS.success
  },
  'cus-remote-warning': {
    light_mode: LIGHT_CARD_COLORS.warning,
    dark_mode: CARD_COLORS.warning
  }
};

const FEISHU_CARD_COLOR_TOKENS = Object.fromEntries(
  Object.entries(FEISHU_CARD_CUSTOM_COLORS)
    .flatMap(([token, modes]) => [
      [normalizeRgbaColor(modes.light_mode), token],
      [normalizeRgbaColor(modes.dark_mode), token]
    ])
);

function formatCardMarkdown(text, options = {}) {
  const value = String(text || '');
  if (!value.trim()) return options.allowEmpty ? '' : '_No output._';
  return normalizeMarkdownLineBreaks(
    enhanceCodexMarkdown(addMarkdownHeadingSpacing(value))
  )
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function addMarkdownHeadingSpacing(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const next = [];
  let inCodeBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      next.push(line);
      continue;
    }
    if (inCodeBlock || !isStandaloneMarkdownHeading(line)) {
      next.push(line);
      continue;
    }

    if (next.length > 0 && next.at(-1).trim() !== '') {
      next.push('');
    }
    next.push(line);
    if (index < lines.length - 1 && lines[index + 1].trim() !== '') {
      next.push('');
    }
  }

  return next.join('\n');
}

function isStandaloneMarkdownHeading(line) {
  const value = stripRemoteCodexColorMarkers(line).trim();
  return /^#{1,6}\s+\S/.test(value) || /^\*\*[^*].*\*\*$/.test(value);
}

function enhanceCodexMarkdown(text) {
  let inCodeBlock = false;

  return String(text || '')
    .split('\n')
    .map((line) => {
      let value = line.trimEnd();
      const markedColor = extractRemoteCodexColor(value);
      if (markedColor) {
        value = stripRemoteCodexColorMarkers(value);
      }
      const compact = value.trim();
      if (/^\s*```/.test(compact)) {
        inCodeBlock = !inCodeBlock;
        return value;
      }
      if (inCodeBlock || !compact) return value;
      if (markedColor) {
        return colorCardText(formatCodexCardLine(value), markedColor);
      }
      if (/^\*\*等待确认\*\*$/.test(compact)) {
        return colorCardText('**等待确认**', CARD_COLORS.approval);
      }
      if (/^\*\*进度\*\*$/.test(compact)) {
        return colorCardText('**进度**', CARD_COLORS.progress);
      }
      if (/^\*\*回复\*\*$/.test(compact)) {
        return colorCardText('**回复**', CARD_COLORS.reply);
      }
      if (/^\*\*选项\*\*$/.test(compact)) {
        return colorCardText('**选项**', CARD_COLORS.info);
      }
      if (/^\*\*(?:Codex 状态|剩余用量|用量提示|运行信息)\*\*$/.test(compact)) {
        return colorCardText(compact, CARD_COLORS.info);
      }
      if (/^⚠/.test(compact)) return `> ${colorCardText(compact, CARD_COLORS.warning)}`;
      if (/^-\s+(?:5 小时额度|每周额度):/.test(compact)) {
        const color = compact.includes('余量紧张') || compact.includes('低余量')
          ? CARD_COLORS.error
          : compact.includes('余量适中')
            ? CARD_COLORS.warning
            : CARD_COLORS.success;
        return colorCardText(compact, color);
      }
      if (/^(?:Error|Failed|Failure|Denied|Rejected)\b/i.test(compact)) {
        return colorCardText(compact, CARD_COLORS.error);
      }
      if (/^-\s+(?:Error|Failed|Failure|Denied|Rejected)\b/i.test(compact)) {
        return colorCardText(compact, CARD_COLORS.error);
      }
      if (/^-\s+(?:Working|Thinking|Running|Reading|Writing|Finding|Searching|Checking|Applying|Planning)\b/i.test(compact)) {
        return colorCardText(compact, CARD_COLORS.running);
      }
      if (/^-\s+(?:Ran|Explored|Opened|Searched|Found|Listed|Viewed)\b/i.test(compact)) {
        return colorCardText(formatCodexCardLine(compact), CARD_COLORS.command);
      }
      if (/^-\s+(?:Read|Edited|Updated|Created|Deleted|Checked|Applied|Wrote)\b/i.test(compact)) {
        return colorCardText(formatCodexCardLine(compact), CARD_COLORS.success);
      }
      if (/^-\s+(?:Would you like|Reason:|[123]\.)/i.test(compact)) {
        return colorCardText(compact, CARD_COLORS.approval);
      }
      if (/^-\s+Codex 正在处理/.test(compact)) {
        return colorCardText(compact, CARD_COLORS.running);
      }
      if (/^可在卡片按钮中选择/.test(compact)) {
        return colorCardText(compact, CARD_COLORS.muted);
      }
      if (/^Ran\b/.test(compact)) return colorCardText(formatCodexCardLine(compact), CARD_COLORS.command);
      if (/^Explored\b/.test(compact)) return colorCardText(formatCodexCardLine(compact), CARD_COLORS.command);
      if (/^(?:Read|Edited|Updated|Created|Deleted|Checked|Applied|Wrote)\b/.test(compact)) {
        return colorCardText(formatCodexCardLine(`- ${compact}`), CARD_COLORS.success);
      }
      if (/^└\s+/.test(compact)) {
        return `> ${colorCardText(formatCodexCardLine(compact), CARD_COLORS.muted)}`;
      }
      return formatCodexCardLine(value);
    })
    .join('\n');
}

function formatCodexCardLine(line) {
  return highlightCodexInlineTokens(preserveCodexIndentation(line));
}

function preserveCodexIndentation(line) {
  return String(line || '').replace(/^ +/, (spaces) => {
    const pairs = Math.floor(spaces.length / 2);
    const rest = spaces.length % 2;
    return `${'　'.repeat(pairs)}${rest ? ' ' : ''}`;
  });
}

function highlightCodexInlineTokens(line) {
  const value = String(line || '');
  if (value.includes('`')) return value;
  const action = value.match(/^(\s*(?:[-•]\s+)?)(Ran|Read|Edited|Updated|Created|Deleted|Checked|Applied|Wrote|Explored|Opened|Searched|Found|Listed|Viewed)\s+(.+)$/i);
  if (action) {
    const [, prefix, verb, detail] = action;
    if (/^(?:Ran|Explored|Opened|Searched|Found|Listed|Viewed)$/i.test(verb)) {
      return `${prefix}${verb} ${inlineCode(detail)}`;
    }
    return `${prefix}${verb} ${highlightFileLikeTokens(detail)}`;
  }
  return highlightFileLikeTokens(value);
}

function highlightFileLikeTokens(text) {
  return String(text || '').replace(
    /(^|[\s([{"'，。；：、])((?:\.{1,2}\/|\/)?[\w@./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|md|css|html|py|sh|yml|yaml|toml|lock|txt)(?::\d+)?)(?=$|[\s)\]}"'，。；：、])/g,
    (match, prefix, filePath) => `${prefix}${inlineCode(filePath)}`
  );
}

function colorCardText(text, color) {
  return `<font color='${normalizeCardColor(color)}'>${escapeCardFontText(text)}</font>`;
}

function extractRemoteCodexColor(line) {
  const match = String(line || '').match(/<!--remote-codex-color:([^>]+)-->/);
  return match ? normalizeCardColor(match[1]) : '';
}

function stripRemoteCodexColorMarkers(line) {
  return String(line || '').replace(/<!--remote-codex-color:[^>]+-->/g, '');
}

function normalizeCardColor(color) {
  const value = String(color || '').trim();
  const rgba = normalizeRgbaColor(value);
  if (rgba) {
    return FEISHU_CARD_COLOR_TOKENS[rgba] || 'cus-remote-muted';
  }
  if (Object.prototype.hasOwnProperty.call(FEISHU_CARD_CUSTOM_COLORS, value)) {
    return value;
  }
  if (/^(?:red|green|grey|gray|blue|orange|yellow|purple)$/i.test(value)) {
    return value.toLowerCase() === 'gray' ? 'grey' : value.toLowerCase();
  }
  return 'cus-remote-muted';
}

function normalizeRgbaColor(color) {
  const value = String(color || '').trim();
  if (!/^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)$/i.test(value)) {
    return '';
  }
  return value.replace(/\s+/g, '').toLowerCase();
}

function buildCardConfig(config = {}) {
  return {
    ...config,
    style: {
      ...(config.style || {}),
      color: {
        ...(config.style?.color || {}),
        ...FEISHU_CARD_CUSTOM_COLORS
      }
    }
  };
}

function escapeCardFontText(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeMarkdownLineBreaks(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const next = [];
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmedEnd = line.trimEnd();
    if (/^\s*```/.test(trimmedEnd)) {
      inCodeBlock = !inCodeBlock;
      next.push(trimmedEnd);
      continue;
    }

    if (inCodeBlock || trimmedEnd === '') {
      next.push(trimmedEnd);
      continue;
    }

    next.push(`${trimmedEnd}  `);
  }

  return next.join('\n');
}

function inlineCode(value) {
  const text = String(value || '').replace(/`/g, "'");
  return `\`${text}\``;
}

function clipForCard(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function summarizeForCard(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return 'Remote Codex';
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

module.exports = {
  CARD_COLORS,
  buildCardConfig,
  clipForCard,
  colorCardText,
  formatCardMarkdown,
  inlineCode,
  summarizeForCard
};
