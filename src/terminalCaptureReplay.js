const fs = require('node:fs');
const { Terminal } = require('@xterm/xterm');
const {
  CAPTURE_SCHEMA_VERSION,
  hashJson,
  normalizeTerminalSnapshot
} = require('./rawOutputRecorder');

function loadCaptureEvents(inputPath) {
  const events = [];
  const errors = [];
  const legacySequenceBySession = new Map();
  const lines = fs.readFileSync(inputPath, 'utf8').split('\n');

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      errors.push({ line: index + 1, error: `invalid_json: ${error.message}` });
      continue;
    }
    if (!event.sessionId || !event.type) {
      errors.push({ line: index + 1, error: 'missing_session_or_type' });
      continue;
    }
    if (!event.schemaVersion) {
      const next = (legacySequenceBySession.get(event.sessionId) || 0) + 1;
      legacySequenceBySession.set(event.sessionId, next);
      event = normalizeLegacyEvent(event, next);
    }
    events.push(event);
  }

  return { events, errors };
}

async function replayCaptureEvents(events, options = {}) {
  const sessions = new Map();
  const errors = [];
  const verifySnapshots = options.verifySnapshots !== false;
  const collectFrames = Boolean(options.collectFrames);
  const frameMode = normalizeFrameMode(options.frameMode);
  const frames = [];

  for (const event of events) {
    const state = getReplaySession(sessions, event);
    validateSequence(state, event, errors);

    if (event.type === 'session.start') {
      continue;
    }
    if (event.type === 'terminal.resize') {
      const next = event.next || event.terminal || {};
      state.terminal.resize(Number(next.cols) || 120, Number(next.rows) || 34);
      state.resizes += 1;
      collectReplayFrame(frames, state, event, collectFrames, frameMode);
      continue;
    }
    if (event.type === 'pty.output') {
      await writeTerminal(state.terminal, decodeBase64(event.dataBase64));
      state.outputs += 1;
      collectReplayFrame(frames, state, event, collectFrames, frameMode);
      continue;
    }
    if (event.type === 'pty.input') {
      state.inputs += 1;
      state.lastInputText = updateLastInputText(state.lastInputText, decodeBase64(event.dataBase64));
      collectReplayFrame(frames, state, event, collectFrames, frameMode);
      continue;
    }
    if (event.type === 'pty.exit') {
      state.exits += 1;
      collectReplayFrame(frames, state, event, collectFrames, frameMode);
      continue;
    }
    if (event.type === 'terminal.snapshot') {
      state.snapshots += 1;
      verifySnapshotEvent(state, event, errors, verifySnapshots);
      collectReplayFrame(frames, state, event, collectFrames, frameMode);
      continue;
    }
  }

  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    sessions: [...sessions.values()].map((state) => ({
      sessionId: state.sessionId,
      inputs: state.inputs,
      outputs: state.outputs,
      resizes: state.resizes,
      exits: state.exits,
      snapshots: state.snapshots,
      lastSequence: state.lastSequence,
      lastInputText: state.lastInputText,
      viewport: readTerminalViewport(state.terminal),
      scrollback: readTerminalScrollback(state.terminal)
    })),
    errors,
    frames
  };
}

function getReplaySession(sessions, event) {
  if (sessions.has(event.sessionId)) return sessions.get(event.sessionId);
  const size = event.terminal || {};
  const state = {
    sessionId: event.sessionId,
    terminal: new Terminal({
      cols: Number(size.cols) || 120,
      rows: Number(size.rows) || 34,
      scrollback: 1000
    }),
    inputs: 0,
    outputs: 0,
    resizes: 0,
    exits: 0,
    snapshots: 0,
    lastSequence: 0,
    lastInputText: ''
  };
  sessions.set(event.sessionId, state);
  return state;
}

function collectReplayFrame(frames, state, event, collectFrames, frameMode) {
  if (!collectFrames) return;
  if (frameMode === 'snapshots' && event.type !== 'terminal.snapshot') return;
  frames.push(buildReplayFrame(state, event));
}

function buildReplayFrame(state, event) {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    sessionId: state.sessionId,
    sequence: Number(event.sequence) || 0,
    at: event.at || '',
    eventType: event.type,
    terminal: {
      cols: state.terminal.cols,
      rows: state.terminal.rows
    },
    counters: {
      inputs: state.inputs,
      outputs: state.outputs,
      resizes: state.resizes,
      exits: state.exits,
      snapshots: state.snapshots
    },
    lastInputText: state.lastInputText,
    viewport: readTerminalViewport(state.terminal),
    scrollback: readTerminalScrollback(state.terminal)
  };
}

function normalizeFrameMode(value) {
  return value === 'all' ? 'all' : 'snapshots';
}

function updateLastInputText(previous, data) {
  const text = stripInputControls(data).trim();
  if (!text || isControlInputText(text)) return previous || '';
  return text;
}

function stripInputControls(data) {
  return String(data || '')
    .replace(/\x15/g, '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '\n')
    .replace(/\n+/g, '\n')
    .trim();
}

function isControlInputText(text) {
  return /^\/(?:status|resume|permissions?|tail|stop)\b/i.test(text);
}

function validateSequence(state, event, errors) {
  const sequence = Number(event.sequence);
  if (!Number.isFinite(sequence)) {
    errors.push({ sessionId: event.sessionId, error: 'missing_sequence' });
    return;
  }
  if (state.lastSequence && sequence !== state.lastSequence + 1) {
    errors.push({
      sessionId: event.sessionId,
      error: sequence <= state.lastSequence ? 'out_of_order_sequence' : 'missing_sequence',
      previous: state.lastSequence,
      sequence
    });
  }
  state.lastSequence = Math.max(state.lastSequence, sequence);
}

function verifySnapshotEvent(state, event, errors, verifySnapshots) {
  const snapshot = normalizeTerminalSnapshot(event.snapshot);
  if (event.hash && hashJson(snapshot) !== event.hash) {
    errors.push({
      sessionId: event.sessionId,
      sequence: event.sequence,
      error: 'snapshot_hash_mismatch'
    });
  }
  if (!verifySnapshots) return;

  const viewport = readTerminalViewport(state.terminal);
  const scrollback = readTerminalScrollback(state.terminal);
  if (snapshot.viewport && snapshot.viewport !== viewport) {
    errors.push({
      sessionId: event.sessionId,
      sequence: event.sequence,
      error: 'snapshot_viewport_mismatch'
    });
  }
  if (snapshot.scrollback && snapshot.scrollback !== scrollback) {
    errors.push({
      sessionId: event.sessionId,
      sequence: event.sequence,
      error: 'snapshot_scrollback_mismatch'
    });
  }
}

function normalizeLegacyEvent(event, sequence) {
  return {
    schemaVersion: 0,
    sequence,
    at: event.at,
    type: event.type,
    sessionId: event.sessionId,
    cwd: event.cwd || '',
    terminal: {
      cols: Number(event.cols) || 120,
      rows: Number(event.rows) || 34
    },
    ...event
  };
}

function writeTerminal(terminal, data) {
  return new Promise((resolve) => terminal.write(String(data || ''), resolve));
}

function readTerminalViewport(terminal) {
  const buffer = terminal.buffer.active;
  return readTerminalRange(buffer, buffer.viewportY, buffer.viewportY + terminal.rows);
}

function readTerminalScrollback(terminal) {
  const buffer = terminal.buffer.active;
  return readTerminalRange(buffer, Math.max(0, buffer.length - 300), buffer.length);
}

function readTerminalRange(buffer, start, end) {
  const lines = [];
  let logicalLine = '';
  for (let index = Math.max(0, start); index < Math.min(buffer.length, end); index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped) {
      logicalLine += text;
      continue;
    }
    if (logicalLine) lines.push(logicalLine);
    logicalLine = text;
  }
  if (logicalLine) lines.push(logicalLine);
  return lines.join('\n');
}

function decodeBase64(value) {
  return Buffer.from(String(value || ''), 'base64').toString('utf8');
}

module.exports = {
  decodeBase64,
  loadCaptureEvents,
  readTerminalScrollback,
  readTerminalViewport,
  replayCaptureEvents,
  buildReplayFrame
};
