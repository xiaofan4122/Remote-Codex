#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Terminal } = require('@xterm/xterm');
const {
  RawOutputRecorder,
  hashJson,
  normalizeTerminalSnapshot
} = require('../src/rawOutputRecorder');
const { exportCaptureFixture } = require('../src/terminalCaptureExport');
const { readCaptureView } = require('../src/terminalCaptureViewer');
const {
  loadCaptureEvents,
  readTerminalScrollback,
  readTerminalViewport,
  replayCaptureEvents
} = require('../src/terminalCaptureReplay');

async function main() {
  await testRecorderTimelineAndSnapshotDedupe();
  await testReplayAndSequenceValidation();
  testLegacyAndDamagedLogCompatibility();
  testFixtureExportRedactsSecrets();
  testRotation();
  testCaptureViewerModel();
  console.log('Terminal capture tests passed.');
}

async function testRecorderTimelineAndSnapshotDedupe() {
  const dir = tempDir();
  const logPath = path.join(dir, 'capture.jsonl');
  const recorder = createRecorder(logPath);
  const session = fakeSession();
  recorder.recordSessionStart(session);
  recorder.recordInput(session, 'hello');
  session.cursor = 1;
  recorder.recordOutput(session, { cursor: 1, data: 'hello\r\n' });
  recorder.recordResize(session, { cols: 80, rows: 24 }, { cols: 100, rows: 30 });
  session.cols = 100;
  session.rows = 30;
  const snapshot = {
    scrollback: 'hello',
    viewport: 'hello',
    styledScrollback: { lines: [{ text: 'hello', firstChar: 'h' }] },
    styledViewport: { lines: [{ text: 'hello', firstChar: 'h' }] }
  };
  assert.equal(recorder.recordSnapshot(session, snapshot), true);
  assert.equal(recorder.recordSnapshot(session, snapshot), false);
  recorder.recordExit(session, { exitCode: 0 });

  const loaded = loadCaptureEvents(logPath);
  assert.equal(loaded.errors.length, 0);
  assert.deepEqual(
    loaded.events.map((event) => event.type),
    ['session.start', 'pty.input', 'pty.output', 'terminal.resize', 'terminal.snapshot', 'pty.exit']
  );
  assert.deepEqual(
    loaded.events.map((event) => event.sequence),
    [1, 2, 3, 4, 5, 6]
  );
  assert.equal(loaded.events[4].cursor, 1);
  assert.equal(loaded.events[4].hash, hashJson(normalizeTerminalSnapshot(snapshot)));
}

async function testReplayAndSequenceValidation() {
  const terminal = new Terminal({ cols: 20, rows: 4, scrollback: 100 });
  await writeTerminal(terminal, 'alpha\r\nbeta');
  const snapshot = {
    scrollback: readTerminalScrollback(terminal),
    viewport: readTerminalViewport(terminal)
  };
  const events = [
    captureEvent(1, 'session.start'),
    captureEvent(2, 'pty.output', { dataBase64: base64('alpha\r\nbeta') }),
    captureEvent(3, 'terminal.snapshot', {
      hash: hashJson(normalizeTerminalSnapshot(snapshot)),
      snapshot
    }),
    captureEvent(5, 'pty.exit', { exitCode: 0 })
  ];
  const replay = await replayCaptureEvents(events);
  assert.equal(replay.sessions[0].viewport, snapshot.viewport);
  assert.equal(replay.sessions[0].scrollback, snapshot.scrollback);
  assert.equal(replay.errors.length, 1);
  assert.equal(replay.errors[0].error, 'missing_sequence');
}

function testLegacyAndDamagedLogCompatibility() {
  const dir = tempDir();
  const logPath = path.join(dir, 'legacy.jsonl');
  fs.writeFileSync(logPath, [
    JSON.stringify({ at: '2026-01-01T00:00:00.000Z', type: 'pty.output', sessionId: 'legacy', cols: 80, rows: 24, dataBase64: base64('ok') }),
    '{broken',
    JSON.stringify({ type: 'pty.exit', sessionId: 'legacy', exitCode: 0 })
  ].join('\n'));
  const loaded = loadCaptureEvents(logPath);
  assert.equal(loaded.events.length, 2);
  assert.equal(loaded.errors.length, 1);
  assert.equal(loaded.events[0].schemaVersion, 0);
  assert.deepEqual(loaded.events.map((event) => event.sequence), [1, 2]);
}

function testFixtureExportRedactsSecrets() {
  const dir = tempDir();
  const inputPath = path.join(dir, 'input.jsonl');
  const outputPath = path.join(dir, 'fixture.jsonl');
  fs.writeFileSync(inputPath, `${JSON.stringify(captureEvent(1, 'pty.output', {
    dataBase64: base64('token=secret-value Bearer abc.def.ghi'),
    preview: 'token=secret-value'
  }))}\n`);
  exportCaptureFixture(inputPath, outputPath);
  const fixture = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  const decoded = Buffer.from(fixture.dataBase64, 'base64').toString('utf8');
  assert.doesNotMatch(decoded, /secret-value|abc\.def\.ghi/);
  assert.match(decoded, /\[REDACTED\]/);
  assert.equal(fixture.redacted, true);
}

function testRotation() {
  const dir = tempDir();
  const logPath = path.join(dir, 'capture.jsonl');
  fs.writeFileSync(logPath, 'x'.repeat(200));
  const recorder = new RawOutputRecorder({
    config: {
      remoteControl: {
        rawOutputLogEnabled: true,
        rawOutputLogPath: logPath,
        rawOutputLogMaxBytes: 10
      }
    }
  });
  recorder.record('test', { sessionId: 's1' });
  assert.equal(fs.existsSync(logPath), true);
  assert.equal(
    fs.readdirSync(dir).some((name) => /^capture\..+\.jsonl$/.test(name)),
    true
  );
}

function testCaptureViewerModel() {
  const dir = tempDir();
  const missing = readCaptureView(path.join(dir, 'missing.jsonl'));
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.events, []);

  const logPath = path.join(dir, 'viewer.jsonl');
  const snapshot = {
    viewport: 'visible panel',
    scrollback: 'history\nvisible panel'
  };
  fs.writeFileSync(logPath, [
    JSON.stringify(captureEvent(1, 'session.start', { command: 'codex', args: ['--no-alt-screen'] })),
    JSON.stringify(captureEvent(2, 'pty.output', { dataBase64: base64('hello\r\n'), bytes: 7 })),
    JSON.stringify(captureEvent(3, 'terminal.snapshot', {
      hash: hashJson(normalizeTerminalSnapshot(snapshot)),
      snapshot
    }))
  ].join('\n'));
  const view = readCaptureView(logPath, { limit: 2 });
  assert.equal(view.exists, true);
  assert.equal(view.totalEvents, 3);
  assert.equal(view.matchedEvents, 3);
  assert.equal(view.truncated, true);
  assert.equal(view.sessions[0].events, 3);
  assert.equal(view.typeCounts['pty.output'], 1);
  assert.deepEqual(view.events.map((event) => event.sequence), [2, 3]);
  assert.match(view.events[0].content, /## Readable text\nhello/);
  assert.match(view.events[0].content, /## Raw terminal bytes\nhello\\r\\n/);
  assert.match(view.events[1].content, /## Viewport\nvisible panel/);

  fs.appendFileSync(logPath, `\n${JSON.stringify(captureEvent(4, 'pty.output', {
    dataBase64: base64('\x1b[?2026h\x1b[9;2H\x1b[K'),
    bytes: 18
  }))}`);
  const filtered = readCaptureView(logPath, { limit: 10 });
  assert.equal(filtered.hiddenNoiseEvents, 1);
  assert.deepEqual(filtered.events.map((event) => event.sequence), [1, 2, 3]);
  const raw = readCaptureView(logPath, { limit: 10, includeNoise: true });
  assert.equal(raw.hiddenNoiseEvents, 0);
  assert.equal(raw.events.at(-1).noise, true);
  assert.equal(raw.events.at(-1).preview, '[terminal repaint/control sequence]');
  assert.match(raw.events.at(-1).content, /\\x1b\[\?2026h/);

  fs.appendFileSync(logPath, `\n${JSON.stringify(captureEvent(5, 'pty.output', {
    dataBase64: base64('ps'),
    bytes: 2
  }))}`);
  assert.equal(readCaptureView(logPath, { limit: 10 }).hiddenNoiseEvents, 2);

  fs.appendFileSync(logPath, `\n${JSON.stringify(captureEvent(6, 'pty.input', {
    dataBase64: base64('\x1b[?1;2c'),
    bytes: 7
  }))}`);
  fs.appendFileSync(logPath, `\n${JSON.stringify(captureEvent(7, 'terminal.snapshot', {
    snapshot: { viewport: '', scrollback: '' }
  }))}`);
  assert.equal(readCaptureView(logPath, { limit: 10 }).hiddenNoiseEvents, 4);
}

function createRecorder(logPath) {
  return new RawOutputRecorder({
    config: {
      remoteControl: {
        rawOutputLogEnabled: true,
        rawOutputLogPath: logPath,
        rawOutputLogMaxBytes: 1024 * 1024
      }
    }
  });
}

function fakeSession() {
  return {
    id: 's1',
    command: 'codex',
    args: ['--no-alt-screen'],
    cwd: '/tmp/project',
    cols: 80,
    rows: 24,
    cursor: 0,
    createdAt: '2026-01-01T00:00:00.000Z'
  };
}

function captureEvent(sequence, type, extra = {}) {
  return {
    schemaVersion: 1,
    sequence,
    at: '2026-01-01T00:00:00.000Z',
    type,
    sessionId: 's1',
    cwd: '/tmp/project',
    terminal: { cols: 20, rows: 4 },
    ...extra
  };
}

function writeTerminal(terminal, data) {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-capture-'));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
