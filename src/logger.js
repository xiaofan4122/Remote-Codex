const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createLogger(options = {}) {
  const logDir =
    options.logDir ||
    process.env.REMOTE_CODEX_LOG_DIR ||
    path.join(os.homedir(), '.local', 'state', 'remote-codex');
  const logFile =
    options.logFile ||
    process.env.REMOTE_CODEX_LOG_FILE ||
    path.join(logDir, 'remote-codex.log');

  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  function write(level, message, meta) {
    const entry = {
      at: new Date().toISOString(),
      level,
      message,
      ...(meta && typeof meta === 'object' ? { meta: redact(meta) } : {})
    };

    fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, () => {});

    const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[consoleMethod](message, meta || '');
  }

  return {
    logFile,
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    event: (name, meta) => write('event', name, meta)
  };
}

function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|token|password|authorization/i.test(key)) {
      next[key] = item ? '[redacted]' : item;
    } else if (typeof item === 'object') {
      next[key] = redact(item);
    } else {
      next[key] = item;
    }
  }
  return next;
}

module.exports = {
  createLogger
};
