const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

class RawOutputRecorder {
  constructor({ config, logger = console } = {}) {
    this.logger = logger;
    this.warned = false;
    this.updateConfig(config || {});
  }

  updateConfig(config = {}) {
    const rawConfig = config.remoteControl || {};
    this.enabled = Boolean(rawConfig.rawOutputLogEnabled);
    this.logPath =
      rawConfig.rawOutputLogPath ||
      path.join(os.homedir(), '.local', 'state', 'remote-codex', 'raw-output.jsonl');
    this.maxBytes = Number(rawConfig.rawOutputLogMaxBytes) || DEFAULT_MAX_BYTES;
    this.warned = false;
  }

  recordOutput(session, chunk) {
    this.record('pty.output', {
      sessionId: session.id,
      cursor: chunk.cursor,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      bytes: Buffer.byteLength(String(chunk.data || ''), 'utf8'),
      dataBase64: Buffer.from(String(chunk.data || ''), 'utf8').toString('base64'),
      preview: clipForLog(stripControlPreview(chunk.data), 500)
    });
  }

  recordInput(session, data) {
    this.record('pty.input', {
      sessionId: session.id,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      bytes: Buffer.byteLength(String(data || ''), 'utf8'),
      dataBase64: Buffer.from(String(data || ''), 'utf8').toString('base64'),
      preview: clipForLog(stripControlPreview(data), 500)
    });
  }

  recordExit(session, exit) {
    this.record('pty.exit', {
      sessionId: session.id,
      cwd: session.cwd,
      exitCode: exit?.exitCode,
      signal: exit?.signal || null
    });
  }

  record(type, payload = {}) {
    if (!this.enabled) return;

    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.rotateIfNeeded();
      fs.appendFileSync(
        this.logPath,
        `${JSON.stringify({
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

function stripControlPreview(data) {
  return String(data || '')
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipForLog(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated]`;
}

module.exports = {
  RawOutputRecorder
};
