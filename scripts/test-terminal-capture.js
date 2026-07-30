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
const {
  loadCaptureEvents,
  readTerminalScrollback,
  readTerminalViewport,
  replayCaptureEvents
} = require('../src/terminalCaptureReplay');

async function main() {
  await testRecorderTimelineAndSnapshotDedupe();
  testRecorderCapturesParserTrace();
  testRecorderSkipsTerminalControlsByDefault();
  await testReplayAndSequenceValidation();
  await testReplayFramesAndInputContext();
  testLegacyAndDamagedLogCompatibility();
  testFixtureExportRedactsSecrets();
  testRotation();
  console.log('Terminal capture tests passed.');
}

function testRecorderCapturesParserTrace() {
  const dir = tempDir();
  const logPath = path.join(dir, 'capture.jsonl');
  const recorder = createRecorder(logPath);
  const session = fakeSession();
  session.cursor = 7;
  recorder.recordParserTrace(session, {
    reason: 'output_flush',
    raw: { dataBase64: base64('Working repaint'), bytes: 15 },
    outputs: { segmentText: 'clean text', segmentSections: ['clean text'] },
    decision: 'send_segment_progress'
  });

  const loaded = loadCaptureEvents(logPath);
  assert.equal(loaded.errors.length, 0);
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.events[0].type, 'parser.trace');
  assert.equal(loaded.events[0].cursor, 7);
  assert.equal(loaded.events[0].decision, 'send_segment_progress');
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

async function testReplayFramesAndInputContext() {
  const events = [
    captureEvent(1, 'session.start'),
    captureEvent(2, 'pty.input', { dataBase64: base64('explain bug\r') }),
    captureEvent(3, 'pty.output', { dataBase64: base64('answer line\r\n') }),
    captureEvent(4, 'terminal.resize', {
      previous: { cols: 20, rows: 4 },
      next: { cols: 30, rows: 5 }
    }),
    captureEvent(5, 'parser.trace', {
      input: { text: 'explain bug', textBase64: base64('explain bug') },
      raw: { dataBase64: base64('• answer line'), bytes: 15 },
      outputs: { segmentText: 'answer line', segmentSections: ['answer line'] },
      decision: 'send_segment_progress'
    }),
    captureEvent(6, 'terminal.snapshot', {
      snapshot: {
        viewport: 'answer line',
        scrollback: 'answer line'
      }
    })
  ];
  const snapshotReplay = await replayCaptureEvents(events, { collectFrames: true });
  assert.deepEqual(
    snapshotReplay.frames.map((frame) => frame.eventType),
    ['terminal.snapshot']
  );
  assert.equal(snapshotReplay.frames[0].lastInputText, 'explain bug');
  assert.deepEqual(snapshotReplay.frames[0].terminal, { cols: 30, rows: 5 });
  assert.equal(snapshotReplay.sessions[0].parserTraces, 1);

  const fullReplay = await replayCaptureEvents(events, {
    collectFrames: true,
    frameMode: 'all',
    verifySnapshots: false
  });
  assert.deepEqual(
    fullReplay.frames.map((frame) => frame.eventType),
    ['pty.input', 'pty.output', 'terminal.resize', 'parser.trace', 'terminal.snapshot']
  );
  assert.equal(fullReplay.frames[3].parserTrace.decision, 'send_segment_progress');
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
    preview: 'token=secret-value',
    visual: {
      snapshotBase64: base64('authorization: token-secret')
    }
  }))}\n`);
  exportCaptureFixture(inputPath, outputPath);
  const fixture = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  const decoded = Buffer.from(fixture.dataBase64, 'base64').toString('utf8');
  const decodedSnapshot = Buffer.from(fixture.visual.snapshotBase64, 'base64').toString('utf8');
  assert.doesNotMatch(decoded, /secret-value|abc\.def\.ghi/);
  assert.doesNotMatch(decodedSnapshot, /token-secret/);
  assert.match(decoded, /\[REDACTED\]/);
  assert.match(decodedSnapshot, /\[REDACTED\]/);
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

function testRecorderSkipsTerminalControlsByDefault() {
  const dir = tempDir();
  const logPath = path.join(dir, 'capture.jsonl');
  const recorder = createRecorder(logPath, { recordTerminalControls: false });
  const session = fakeSession();
  recorder.recordSessionStart(session);
  recorder.recordInput(session, '\x1b[A');
  recorder.recordOutput(session, { cursor: 1, data: '\x1b[?2026h\x1b[9;2H\x1b[K' });
  recorder.recordOutput(session, { cursor: 2, data: 'ok\r\n' });
  recorder.recordResize(session, { cols: 80, rows: 24 }, { cols: 100, rows: 30 });
  recorder.recordExit(session, { exitCode: 0 });

  const loaded = loadCaptureEvents(logPath);
  assert.deepEqual(
    loaded.events.map((event) => event.type),
    ['session.start', 'pty.output', 'pty.exit']
  );
  assert.deepEqual(
    loaded.events.map((event) => event.sequence),
    [1, 2, 3]
  );
  assert.equal(Buffer.from(loaded.events[1].dataBase64, 'base64').toString('utf8'), 'ok\r\n');
}

function createRecorder(logPath, options = {}) {
  return new RawOutputRecorder({
    config: {
      remoteControl: {
        rawOutputLogEnabled: true,
        rawOutputLogPath: logPath,
        rawOutputLogMaxBytes: 1024 * 1024,
        rawOutputLogRecordTerminalControls: options.recordTerminalControls !== false
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
