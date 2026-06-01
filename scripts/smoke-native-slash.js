#!/usr/bin/env node

const { Terminal } = require('@xterm/xterm');
const { loadConfig } = require('../src/config');
const { CodexSessionManager } = require('../src/codexSessionManager');
const { RawOutputRecorder } = require('../src/rawOutputRecorder');
const {
  readTerminalScrollback,
  readTerminalViewport
} = require('../src/terminalCaptureReplay');
const {
  buildNativeSlashInput,
  isCompleteStatusSlashOutput,
  formatNativeSlashOutput,
  writeNativeSlashCommand
} = require('../src/remoteSessionController');

const command = process.argv[2] || '/resume';
const timeoutMs = Number(process.env.REMOTE_CODEX_NATIVE_SLASH_TIMEOUT_MS) || 30000;
const cwd = process.env.REMOTE_CODEX_NATIVE_SLASH_CWD || process.cwd();
const cols = Number(process.env.REMOTE_CODEX_NATIVE_SLASH_COLS) || 120;
const rows = Number(process.env.REMOTE_CODEX_NATIVE_SLASH_ROWS) || 34;
const capturePath = process.env.REMOTE_CODEX_NATIVE_SLASH_CAPTURE_PATH || '';

async function main() {
  const config = loadConfig();
  config.codex.defaultCwd = cwd;
  if (capturePath) {
    config.remoteControl.rawOutputLogEnabled = true;
    config.remoteControl.rawOutputLogPath = capturePath;
  }
  const outputRecorder = capturePath
    ? new RawOutputRecorder({ config })
    : null;
  const manager = new CodexSessionManager({ config, outputRecorder });
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
    const snapshot = readTerminalViewport(terminal);
    session.recordSnapshot({
      scrollback: readTerminalScrollback(terminal),
      viewport: snapshot
    });
    const formatted = formatNativeSlashOutput({ snapshot, command });
    console.log('--- viewport ---');
    console.log(snapshot);
    console.log('--- formatted ---');
    console.log(formatted || '(empty)');
    if (capturePath) {
      console.log('--- capture ---');
      console.log(capturePath);
    }
    if (!formatted) {
      process.exitCode = 2;
    }
  } finally {
    manager.killAll();
  }
}

function waitForReady(terminal, getLastDataAt, timeout) {
  const started = Date.now();
  let stableReadyChecks = 0;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const snapshot = readTerminalViewport(terminal);
      const idleFor = Date.now() - getLastDataAt();
      if (isCodexReadySnapshot(snapshot) && idleFor >= 500) {
        stableReadyChecks += 1;
      } else {
        stableReadyChecks = 0;
      }
      if (stableReadyChecks >= 2) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(
          new Error(
            `Timed out waiting for Codex prompt to become ready.\n${readTerminalViewport(terminal)}`
          )
        );
      }
    }, 250);
  });
}

function isCodexReadySnapshot(snapshot) {
  const text = String(snapshot || '');
  return /›/.test(text) &&
    !/(?:Booting MCP server|MCP startup|Starting MCP|Loading)/i.test(text);
}

function waitForNativeOutput(terminal, slashCommand, timeout) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const snapshot = readTerminalViewport(terminal);
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
            `Timed out waiting for ${slashCommand} output.\n${readTerminalViewport(terminal)}`
          )
        );
      }
    }, 250);
  });
}

function isNativeSlashSmokeReady(snapshot, formatted, slashCommand) {
  if (!formatted || /(?:Codex 正在处理|Working \(\d+s\))/.test(formatted)) {
    return false;
  }
  if (slashCommand === '/status') {
    return isCompleteStatusSlashOutput(formatted);
  }
  if (slashCommand === '/permissions') {
    return /1\. Default\b/.test(formatted) &&
      /2\. Auto-review\b/.test(formatted) &&
      /3\. Full Access\b/.test(formatted);
  }
  if (snapshot.includes(`› ${slashCommand}`)) return false;
  if (/OpenAI Codex|directory:|Start a fresh idea/i.test(formatted)) return false;
  return true;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
