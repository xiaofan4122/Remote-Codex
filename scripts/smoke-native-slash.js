#!/usr/bin/env node

const { Terminal } = require('@xterm/xterm');
const { loadConfig } = require('../src/config');
const { CodexSessionManager } = require('../src/codexSessionManager');
const {
  buildNativeSlashInput,
  formatNativeSlashOutput,
  writeNativeSlashCommand
} = require('../src/remoteSessionController');

const command = process.argv[2] || '/resume';
const timeoutMs = Number(process.env.REMOTE_CODEX_NATIVE_SLASH_TIMEOUT_MS) || 30000;
const cwd = process.env.REMOTE_CODEX_NATIVE_SLASH_CWD || process.cwd();
const cols = Number(process.env.REMOTE_CODEX_NATIVE_SLASH_COLS) || 120;
const rows = Number(process.env.REMOTE_CODEX_NATIVE_SLASH_ROWS) || 34;

async function main() {
  const config = loadConfig();
  config.codex.defaultCwd = cwd;
  const manager = new CodexSessionManager({ config });
  const session = manager.create({ cwd, cols, rows });
  const terminal = new Terminal({ cols, rows, scrollback: 1000 });
  let lastDataAt = Date.now();

  session.on('data', (chunk) => {
    lastDataAt = Date.now();
    terminal.write(chunk.data);
  });

  try {
    await waitForReady(terminal, () => lastDataAt, timeoutMs);
    await writeNativeSlashCommand(session, command);
    await waitForNativeOutput(terminal, command, timeoutMs);
    const snapshot = readViewport(terminal, rows);
    const formatted = formatNativeSlashOutput({ snapshot, command });
    console.log('--- viewport ---');
    console.log(snapshot);
    console.log('--- formatted ---');
    console.log(formatted || '(empty)');
    if (!formatted) {
      process.exitCode = 2;
    }
  } finally {
    manager.killAll();
  }
}

function waitForReady(terminal, getLastDataAt, timeout) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const snapshot = readViewport(terminal, rows);
      const idleFor = Date.now() - getLastDataAt();
      if (/›/.test(snapshot) && !/Booting MCP server/i.test(snapshot) && idleFor >= 500) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(
          new Error(
            `Timed out waiting for Codex prompt to become ready.\n${readViewport(terminal, rows)}`
          )
        );
      }
    }, 250);
  });
}

function waitForNativeOutput(terminal, slashCommand, timeout) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const snapshot = readViewport(terminal, rows);
      const formatted = formatNativeSlashOutput({ snapshot, command: slashCommand });
      if (isNativeSlashSmokeReady(snapshot, formatted, slashCommand)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(
          new Error(
            `Timed out waiting for ${slashCommand} output.\n${readViewport(terminal, rows)}`
          )
        );
      }
    }, 250);
  });
}

function isNativeSlashSmokeReady(snapshot, formatted, slashCommand) {
  if (!formatted || /Codex 正在处理/.test(formatted)) return false;
  if (slashCommand === '/status' && /Model:|Session:|Permissions:/i.test(formatted)) {
    return true;
  }
  if (snapshot.includes(`› ${slashCommand}`)) return false;
  if (/OpenAI Codex|directory:|Start a fresh idea/i.test(formatted)) return false;
  return true;
}

function readViewport(terminal, rowCount) {
  const buffer = terminal.buffer.active;
  const lines = [];
  const start = Math.max(0, buffer.viewportY);
  const end = Math.min(buffer.length, start + rowCount);

  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index);
    if (line) lines.push(line.translateToString(true));
  }

  return lines.join('\n');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
