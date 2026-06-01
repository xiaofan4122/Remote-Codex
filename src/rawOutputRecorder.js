const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CAPTURE_SCHEMA_VERSION = 1;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

class RawOutputRecorder {
  constructor({ config, logger = console } = {}) {
    this.logger = logger;
    this.warned = false;
    this.sequenceBySession = new Map();
    this.snapshotHashBySession = new Map();
    this.updateConfig(config || {});
  }

  updateConfig(config = {}) {
    const rawConfig = config.remoteControl || {};
    this.enabled = rawConfig.rawOutputLogEnabled !== false;
    this.logPath =
      rawConfig.rawOutputLogPath ||
      path.join(os.homedir(), '.local', 'state', 'remote-codex', 'raw-output.jsonl');
    this.maxBytes = Number(rawConfig.rawOutputLogMaxBytes) || DEFAULT_MAX_BYTES;
    this.recordTerminalControls = Boolean(rawConfig.rawOutputLogRecordTerminalControls);
    this.warned = false;
  }

  recordSessionStart(session) {
    this.recordSessionEvent(session, 'session.start', {
      command: session.command,
      args: session.args,
      createdAt: session.createdAt
    });
  }

  recordOutput(session, chunk) {
    if (!this.recordTerminalControls && isLowSignalTerminalPayload(chunk.data, 'pty.output')) {
      return;
    }
    this.recordSessionEvent(session, 'pty.output', {
      cursor: chunk.cursor,
      bytes: Buffer.byteLength(String(chunk.data || ''), 'utf8'),
      dataBase64: encodeBase64(chunk.data),
      preview: clipForLog(stripControlPreview(chunk.data), 500)
    });
  }

  recordInput(session, data) {
    if (!this.recordTerminalControls && isLowSignalTerminalPayload(data, 'pty.input')) {
      return;
    }
    this.recordSessionEvent(session, 'pty.input', {
      cursor: session.cursor,
      bytes: Buffer.byteLength(String(data || ''), 'utf8'),
      dataBase64: encodeBase64(data),
      preview: clipForLog(stripControlPreview(data), 500)
    });
  }

  recordResize(session, previous, next) {
    if (!this.recordTerminalControls) return;
    this.recordSessionEvent(session, 'terminal.resize', {
      cursor: session.cursor,
      previous: normalizeTerminalSize(previous),
      next: normalizeTerminalSize(next)
    }, { terminal: normalizeTerminalSize(next) });
  }

  recordSnapshot(session, snapshot = {}) {
    const payload = normalizeTerminalSnapshot(snapshot);
    const hash = hashJson(payload);
    if (this.snapshotHashBySession.get(session.id) === hash) return false;
    this.snapshotHashBySession.set(session.id, hash);
    this.recordSessionEvent(session, 'terminal.snapshot', {
      cursor: session.cursor,
      hash,
      snapshot: payload
    });
    return true;
  }

  recordExit(session, exit) {
    this.recordSessionEvent(session, 'pty.exit', {
      cursor: session.cursor,
      exitCode: exit?.exitCode,
      signal: exit?.signal || null
    });
  }

  recordSessionEvent(session, type, payload = {}, options = {}) {
    if (!session) return;
    this.record(type, {
      sessionId: session.id,
      cwd: session.cwd,
      terminal: options.terminal || normalizeTerminalSize(session),
      ...payload
    });
  }

  record(type, payload = {}) {
    if (!this.enabled) return;

    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.rotateIfNeeded();
      const sessionId = String(payload.sessionId || '');
      const sequence = this.nextSequence(sessionId);
      fs.appendFileSync(
        this.logPath,
        `${JSON.stringify({
          schemaVersion: CAPTURE_SCHEMA_VERSION,
          sequence,
          at: new Date().toISOString(),
          type,
          ...payload
        })}\n`
      );
    } catch (error) {
      if (this.warned) return;
      this.warned = true;
      this.logger.warn?.('Raw Codex output recorder failed:', error.message);
    }
  }

  nextSequence(sessionId) {
    const key = sessionId || '__global__';
    const next = (this.sequenceBySession.get(key) || 0) + 1;
    this.sequenceBySession.set(key, next);
    return next;
  }

  rotateIfNeeded() {
    if (!this.maxBytes || this.maxBytes <= 0) return;
    if (!fs.existsSync(this.logPath)) return;
    const stat = fs.statSync(this.logPath);
    if (stat.size < this.maxBytes) return;
    const parsed = path.parse(this.logPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(this.logPath, path.join(parsed.dir, `${parsed.name}.${stamp}${parsed.ext}`));
  }
}

function normalizeTerminalSnapshot(snapshot = {}) {
  if (typeof snapshot === 'string') {
    return {
      scrollback: snapshot,
      viewport: snapshot,
      styledScrollback: null,
      styledViewport: null
    };
  }
  return {
    scrollback: String(snapshot.scrollback || ''),
    viewport: String(snapshot.viewport || ''),
    styledScrollback: normalizeStyledSnapshot(snapshot.styledScrollback),
    styledViewport: normalizeStyledSnapshot(snapshot.styledViewport)
  };
}

function normalizeStyledSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.lines)) {
    return null;
  }
  return {
    lines: snapshot.lines.map((line) => ({
      text: String(line?.text || ''),
      firstChar: String(line?.firstChar || ''),
      firstStyle: line?.firstStyle || null,
      bulletStyle: line?.bulletStyle || null
    }))
  };
}

function normalizeTerminalSize(size = {}) {
  return {
    cols: Math.max(2, Number(size.cols) || 120),
    rows: Math.max(2, Number(size.rows) || 34)
  };
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function encodeBase64(data) {
  return Buffer.from(String(data || ''), 'utf8').toString('base64');
}

function stripControlPreview(data) {
  return String(data || '')
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTerminalControls(data) {
  return String(data || '')
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function isLowSignalTerminalPayload(data, type = 'pty.output') {
  const raw = String(data || '');
  const readable = stripTerminalControls(raw).trim();
  if (!readable) return true;
  if (type === 'pty.input') return false;
  if (raw.includes('\x1b') && !/[\r\n]/.test(raw)) return true;
  if (readable.includes('\n')) return false;
  if (raw.includes('\x1b') && readable.length <= 16 && !/\s/.test(readable)) {
    return true;
  }
  return /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+$/u.test(readable);
}

function clipForLog(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated]`;
}

module.exports = {
  CAPTURE_SCHEMA_VERSION,
  DEFAULT_MAX_BYTES,
  RawOutputRecorder,
  hashJson,
  isLowSignalTerminalPayload,
  normalizeTerminalSnapshot
};
