const fs = require('node:fs');
const { decodeBase64, loadCaptureEvents } = require('./terminalCaptureReplay');

const DEFAULT_EVENT_LIMIT = 800;
const MAX_EVENT_LIMIT = 2000;
const DETAIL_TEXT_LIMIT = 50000;

function readCaptureView(logPath, options = {}) {
  const limit = normalizeLimit(options.limit);
  const includeNoise = Boolean(options.includeNoise);
  if (!fs.existsSync(logPath)) {
    return emptyCaptureView(logPath, limit);
  }

  const stat = fs.statSync(logPath);
  const loaded = loadCaptureEvents(logPath);
  const allEvents = loaded.events;
  const selectedSessionId = String(options.sessionId || '');
  const sessionEvents = selectedSessionId
    ? allEvents.filter((event) => event.sessionId === selectedSessionId)
    : allEvents;
  const formatted = sessionEvents.map(formatCaptureEvent);
  const filtered = includeNoise
    ? formatted
    : formatted.filter((event) => !event.noise);
  const visibleEvents = filtered.slice(-limit);

  return {
    path: logPath,
    exists: true,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    eventLimit: limit,
    totalEvents: allEvents.length,
    matchedEvents: sessionEvents.length,
    visibleMatchedEvents: filtered.length,
    hiddenNoiseEvents: formatted.length - filtered.length,
    truncated: filtered.length > visibleEvents.length,
    readErrors: loaded.errors,
    sessions: summarizeSessions(allEvents),
    typeCounts: countEventTypes(sessionEvents),
    events: visibleEvents
  };
}

function emptyCaptureView(logPath, limit) {
  return {
    path: logPath,
    exists: false,
    sizeBytes: 0,
    modifiedAt: '',
    eventLimit: limit,
    totalEvents: 0,
    matchedEvents: 0,
    visibleMatchedEvents: 0,
    hiddenNoiseEvents: 0,
    truncated: false,
    readErrors: [],
    sessions: [],
    typeCounts: {},
    events: []
  };
}

function summarizeSessions(events) {
  const sessions = new Map();
  for (const event of events) {
    const current = sessions.get(event.sessionId) || {
      sessionId: event.sessionId,
      cwd: event.cwd || '',
      firstAt: event.at || '',
      lastAt: event.at || '',
      events: 0,
      typeCounts: {}
    };
    current.cwd = event.cwd || current.cwd;
    current.lastAt = event.at || current.lastAt;
    current.events += 1;
    current.typeCounts[event.type] = (current.typeCounts[event.type] || 0) + 1;
    sessions.set(event.sessionId, current);
  }
  return [...sessions.values()].sort((left, right) =>
    String(right.lastAt).localeCompare(String(left.lastAt))
  );
}

function countEventTypes(events) {
  const counts = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] || 0) + 1;
  }
  return counts;
}

function formatCaptureEvent(event) {
  const decoded = event.dataBase64 ? decodeBase64(event.dataBase64) : '';
  const readable = decoded ? stripTerminalControls(decoded).trim() : '';
  const noise =
    (
      event.type === 'pty.output' &&
      (!readable || isLowSignalTerminalFragment(readable, decoded))
    ) ||
    (
      event.type === 'pty.input' &&
      !readable
    ) ||
    (
      event.type === 'terminal.snapshot' &&
      !String(event.snapshot?.viewport || event.snapshot?.scrollback || '').trim()
    );
  return {
    id: `${event.sessionId}:${event.sequence}`,
    schemaVersion: Number(event.schemaVersion) || 0,
    sequence: Number(event.sequence) || 0,
    at: event.at || '',
    type: event.type,
    sessionId: event.sessionId,
    cwd: event.cwd || '',
    cursor: Number.isFinite(Number(event.cursor)) ? Number(event.cursor) : null,
    terminal: event.terminal || null,
    bytes: Number(event.bytes) || 0,
    preview: formatEventPreview(event, { decoded, readable, noise }),
    content: formatEventContent(event, { decoded, readable, noise }),
    noise,
    metadata: formatEventMetadata(event)
  };
}

function formatEventPreview(event, options = {}) {
  if (event.type === 'session.start') {
    return `${event.command || 'codex'} ${(event.args || []).join(' ')}`.trim();
  }
  if (event.type === 'terminal.resize') {
    return `${formatSize(event.previous)} -> ${formatSize(event.next || event.terminal)}`;
  }
  if (event.type === 'terminal.snapshot') {
    return clipText(event.snapshot?.viewport || event.snapshot?.scrollback || '', 300);
  }
  if (event.type === 'pty.exit') {
    return `exitCode=${event.exitCode ?? 'unknown'} signal=${event.signal || 'none'}`;
  }
  if (event.dataBase64) {
    if (options.readable) {
      return clipText(options.readable.replace(/\s+/g, ' '), 300);
    }
    return event.type === 'pty.output'
      ? '[terminal repaint/control sequence]'
      : clipText(escapeControlChars(options.decoded), 300);
  }
  return '';
}

function formatEventContent(event, options = {}) {
  if (event.type === 'pty.input' || event.type === 'pty.output') {
    return [
      '## Readable text',
      clipText(options.readable || '(no visible text)', DETAIL_TEXT_LIMIT),
      '',
      '## Raw terminal bytes',
      clipText(escapeControlChars(options.decoded), DETAIL_TEXT_LIMIT)
    ].join('\n');
  }
  if (event.type === 'terminal.snapshot') {
    return [
      '## Viewport',
      clipText(event.snapshot?.viewport || '', DETAIL_TEXT_LIMIT),
      '',
      '## Scrollback',
      clipText(event.snapshot?.scrollback || '', DETAIL_TEXT_LIMIT),
      '',
      '## Styled viewport',
      clipText(JSON.stringify(event.snapshot?.styledViewport || null, null, 2), DETAIL_TEXT_LIMIT),
      '',
      '## Styled scrollback',
      clipText(JSON.stringify(event.snapshot?.styledScrollback || null, null, 2), DETAIL_TEXT_LIMIT)
    ].join('\n');
  }
  return JSON.stringify(formatEventMetadata(event), null, 2);
}

function stripTerminalControls(value) {
  return String(value || '')
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function escapeControlChars(value) {
  return String(value || '')
    .replace(/\x1b/g, '\\x1b')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n\n')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (char) =>
      `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
    );
}

function isLowSignalTerminalFragment(value, raw = '') {
  const text = String(value || '').trim();
  const rawText = String(raw || '');
  if (!text) return true;
  if (rawText.includes('\x1b') && !/[\r\n]/.test(rawText)) return true;
  if (text.includes('\n')) return false;
  if (rawText.includes('\x1b') && text.length <= 16 && !/\s/.test(text)) {
    return true;
  }
  return /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+$/u.test(text);
}

function formatEventMetadata(event) {
  const ignored = new Set(['dataBase64', 'snapshot']);
  return Object.fromEntries(
    Object.entries(event).filter(([key]) => !ignored.has(key))
  );
}

function formatSize(size = {}) {
  return `${Number(size?.cols) || '?'}x${Number(size?.rows) || '?'}`;
}

function normalizeLimit(value) {
  const limit = Number(value) || DEFAULT_EVENT_LIMIT;
  return Math.min(MAX_EVENT_LIMIT, Math.max(1, Math.floor(limit)));
}

function clipText(value, max) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated]`;
}

module.exports = {
  DEFAULT_EVENT_LIMIT,
  MAX_EVENT_LIMIT,
  readCaptureView
};
