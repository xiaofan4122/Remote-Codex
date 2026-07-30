function parseTextContent(content) {
  if (!content) return '';

  try {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    return extractFeishuContentText(parsed);
  } catch {
    return String(content);
  }
}

function extractFeishuContentText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return extractRichTextBlocks(value);
  if (typeof value !== 'object') return String(value);

  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return extractPostDocumentText(value);
  if (value.post) return extractLocalizedPostText(value.post);

  const localized = extractLocalizedPostText(value);
  if (localized) return localized;

  if (value.content && typeof value.content === 'object') {
    return extractFeishuContentText(value.content);
  }

  return '';
}

function extractLocalizedPostText(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';

  const preferred = value.zh_cn || value.en_us || value.zh_hk || value.ja_jp;
  if (preferred) return extractPostDocumentText(preferred);

  for (const item of Object.values(value)) {
    const text = extractPostDocumentText(item);
    if (text) return text;
  }

  return '';
}

function extractPostDocumentText(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return '';

  const parts = [];
  if (typeof document.title === 'string' && document.title.trim()) {
    parts.push(document.title.trim());
  }

  if (Array.isArray(document.content)) {
    const body = extractRichTextBlocks(document.content);
    if (body) parts.push(body);
  } else if (document.content) {
    const body = extractFeishuContentText(document.content);
    if (body) parts.push(body);
  }

  return parts.join('\n').trim();
}

function extractRichTextBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';

  return blocks
    .map((block) => {
      if (Array.isArray(block)) {
        return block.map((element) => extractRichTextElement(element)).join('');
      }
      return extractRichTextElement(block);
    })
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractRichTextElement(element) {
  if (element === undefined || element === null) return '';
  if (typeof element === 'string') return element;
  if (Array.isArray(element)) {
    return element.map((item) => extractRichTextElement(item)).join('');
  }
  if (typeof element !== 'object') return String(element);

  const tag = String(element.tag || element.type || '').toLowerCase();
  if (tag === 'text' || tag === 'plain_text' || tag === 'md' || tag === 'markdown') {
    return String(element.text || element.content || '');
  }
  if (tag === 'a' || tag === 'link') {
    const text = String(element.text || element.content || '').trim();
    const href = String(element.href || element.url || '').trim();
    if (text && href && text !== href) return `${text} (${href})`;
    return text || href;
  }
  if (tag === 'at' || tag === 'mention') {
    const mention = String(
      element.text ||
        element.user_name ||
        element.name ||
        element.key ||
        element.user_id ||
        element.open_id ||
        ''
    ).trim();
    if (!mention) return '';
    return mention.startsWith('@') ? mention : `@${mention}`;
  }
  if (tag === 'img' || tag === 'image') {
    return '[图片]';
  }
  if (tag === 'file') {
    const name = element.file_name || element.name || element.text || '';
    return name ? `[文件: ${name}]` : '[文件]';
  }
  if (tag === 'media' || tag === 'video') {
    return '[视频]';
  }
  if (tag === 'emotion' || tag === 'emoji') {
    const name = element.emoji_type || element.name || element.text || '';
    return name ? `[${name}]` : '';
  }
  if (tag === 'hr') return '\n---\n';
  if (tag === 'code_block') {
    const text = String(element.text || element.content || '').trim();
    return text ? `\n\`\`\`\n${text}\n\`\`\`\n` : '';
  }

  if (typeof element.text === 'string') return element.text;
  if (typeof element.content === 'string') return element.content;
  if (Array.isArray(element.content)) return extractRichTextBlocks(element.content);
  return '';
}

module.exports = {
  parseTextContent
};
