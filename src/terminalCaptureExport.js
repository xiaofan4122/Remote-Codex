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
  redactBase64Fields(next);
  if (next.type === 'terminal.snapshot' && next.snapshot) {
    next.hash = hashJson(normalizeTerminalSnapshot(next.snapshot));
  }
  next.redacted = true;
  return next;
}

function redactBase64Fields(value, key = '') {
  if (Array.isArray(value)) {
    for (const item of value) redactBase64Fields(item, key);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value)) {
    if (
      typeof child === 'string' &&
      /Base64$/.test(childKey) &&
      looksLikeBase64Text(child)
    ) {
      const decoded = Buffer.from(child, 'base64').toString('utf8');
      value[childKey] = Buffer.from(redactText(decoded), 'utf8').toString('base64');
      if (childKey === 'dataBase64' && typeof value.bytes === 'number') {
        value.bytes = Buffer.byteLength(Buffer.from(value[childKey], 'base64'));
      }
      continue;
    }
    redactBase64Fields(child, childKey);
  }
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

function looksLikeBase64Text(value) {
  const text = String(value || '');
  if (!text || text.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return false;
  try {
    Buffer.from(text, 'base64').toString('utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  exportCaptureFixture,
  redactCaptureEvent,
  redactText
};
