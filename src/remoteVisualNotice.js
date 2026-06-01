const NOTICE_COLOR = '\x1b[38;5;111m';
const RESET_COLOR = '\x1b[0m';

function buildRemoteInputNotice({ source = 'Feishu', userId = 'user', text = '', cols = 100 } = {}) {
  const safeSource = sanitizeNoticeToken(source) || 'Remote';
  const safeUser = sanitizeNoticeToken(userId) || 'user';
  const safeText = sanitizeNoticeText(text);
  const length = safeText.length;
  const previewLimit = Math.max(24, Math.min(120, Number(cols) - 44 || 80));
  const preview = clipNoticeText(safeText, previewLimit);
  const summary = length > preview.length
    ? `received ${length} chars: ${JSON.stringify(preview)}`
    : `received: ${JSON.stringify(preview)}`;
  const line = `[Remote Codex] ${safeSource} ${safeUser}: ${summary}`;
  return `\r\n\x1b[2K${NOTICE_COLOR}${line}${RESET_COLOR}\r\n`;
}

function sanitizeNoticeToken(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[^\p{L}\p{N}@._:-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

function sanitizeNoticeText(value) {
  return String(value || '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipNoticeText(value, max) {
  const text = String(value || '');
  const limit = Math.max(1, Number(max) || 80);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1))}…`;
}

module.exports = {
  buildRemoteInputNotice,
  sanitizeNoticeText
};
