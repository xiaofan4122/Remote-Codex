const fs = require('node:fs');
const path = require('node:path');
const { hashJson, normalizeTerminalSnapshot } = require('./rawOutputRecorder');
const { loadCaptureEvents } = require('./terminalCaptureReplay');

function exportCaptureFixture(inputPath, outputPath) {
  const { events, errors } = loadCaptureEvents(inputPath);
  const redacted = events.map(redactCaptureEvent);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    redacted.map((event) => JSON.stringify(event)).join('\n') + (redacted.length ? '\n' : '')
  );
  return {
    inputPath,
    outputPath,
    events: redacted.length,
    readErrors: errors.length
  };
}

function redactCaptureEvent(event) {
  const next = redactValue(event);
  if (next.dataBase64) {
    const decoded = Buffer.from(next.dataBase64, 'base64').toString('utf8');
    next.dataBase64 = Buffer.from(redactText(decoded), 'utf8').toString('base64');
    next.bytes = Buffer.byteLength(Buffer.from(next.dataBase64, 'base64'));
  }
  if (next.type === 'terminal.snapshot' && next.snapshot) {
    next.hash = hashJson(normalizeTerminalSnapshot(next.snapshot));
  }
  next.redacted = true;
  return next;
}

function redactValue(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactText(value, key) : value;
  }
  const next = {};
  for (const [childKey, child] of Object.entries(value)) {
    next[childKey] = redactValue(child, childKey);
  }
  return next;
}

function redactText(value, key = '') {
  const text = String(value || '');
  if (/secret|token|password|authorization|appsecret/i.test(key)) {
    return text ? '[REDACTED]' : text;
  }
  return text
    .replace(/\b(?:sk|xox[baprs]|pat|token)[-_][A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/((?:secret|token|password|authorization|app[_-]?secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}

module.exports = {
  exportCaptureFixture,
  redactCaptureEvent,
  redactText
};
