const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_BIND_TIMEOUT_MS = 60000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_INITIAL_TAIL_BYTES = 64 * 1024 * 1024;
const TURN_START_TOLERANCE_MS = 0;

class CodexRolloutReader {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.logger = options.logger || console;
    this.codexHome = path.resolve(
      options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
    );
    this.pollIntervalMs = normalizePositiveNumber(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS
    );
    this.bindTimeoutMs = normalizePositiveNumber(
      options.bindTimeoutMs,
      DEFAULT_BIND_TIMEOUT_MS
    );
    this.turnTimeoutMs = normalizePositiveNumber(
      options.turnTimeoutMs,
      DEFAULT_TURN_TIMEOUT_MS
    );
    this.initialTailBytes = normalizePositiveNumber(
      options.initialTailBytes,
      DEFAULT_INITIAL_TAIL_BYTES
    );
    this.rolloutPaths = new Map();
    this.turns = new Set();
  }

  beginTurn(options = {}) {
    const turn = new CodexRolloutTurn({
      reader: this,
      prompt: options.prompt,
      matchNextPrompt: options.matchNextPrompt,
      cwd: options.cwd,
      startedAt: options.startedAt,
      bindTimeoutMs: options.bindTimeoutMs,
      turnTimeoutMs: options.turnTimeoutMs,
      skipPromptMatches: options.skipPromptMatches,
      onEvent: options.onEvent,
      onError: options.onError
    });
    this.turns.add(turn);
    turn.onceStopped = () => this.turns.delete(turn);
    turn.start();
    return turn;
  }

  stopAll() {
    for (const turn of [...this.turns]) turn.stop('reader_stopped');
  }

  findRolloutPath(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return '';

    const cached = this.rolloutPaths.get(id);
    if (cached && fileExists(this.fs, cached)) return cached;

    const sessionsRoot = path.join(this.codexHome, 'sessions');
    const found = findFileBySuffix(
      this.fs,
      sessionsRoot,
      `-${id}.jsonl`
    );
    if (found) this.rolloutPaths.set(id, found);
    return found;
  }
}

class CodexRolloutTurn {
  constructor({
    reader,
    prompt,
    matchNextPrompt,
    cwd,
    startedAt,
    bindTimeoutMs,
    turnTimeoutMs,
    skipPromptMatches,
    onEvent,
    onError
  }) {
    this.reader = reader;
    this.fs = reader.fs;
    this.logger = reader.logger;
    this.prompt = String(prompt || '');
    this.matchNextPrompt = Boolean(matchNextPrompt);
    this.cwd = cwd ? path.resolve(String(cwd)) : '';
    this.startedAt = normalizeStartedAt(startedAt);
    this.bindTimeoutMs = normalizePositiveNumber(bindTimeoutMs, reader.bindTimeoutMs);
    this.turnTimeoutMs = normalizePositiveNumber(turnTimeoutMs, reader.turnTimeoutMs);
    this.skipPromptMatches = Math.max(0, Math.floor(Number(skipPromptMatches) || 0));
    this.promptMatchesSeen = 0;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.onError = typeof onError === 'function' ? onError : null;
    this.historyPath = path.join(reader.codexHome, 'history.jsonl');
    this.historyTail = createTailState(this.fs, this.historyPath, { fromEnd: true });
    this.rolloutTail = null;
    this.rolloutPath = '';
    this.sessionId = '';
    this.historyTimestampMs = 0;
    this.turnId = '';
    this.finalText = '';
    this.bound = false;
    this.completed = false;
    this.stopped = false;
    this.polling = false;
    this.startedTimerAt = Date.now();
    this.timer = null;
    this.onceStopped = null;
  }

  start() {
    if (this.timer || this.stopped) return this;
    this.timer = setInterval(() => this.poll(), this.reader.pollIntervalMs);
    this.timer.unref?.();
    this.poll();
    return this;
  }

  stop(reason = 'stopped') {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onceStopped?.(reason);
  }

  async poll() {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      if (!this.bound) {
        this.pollHistory();
        this.tryBind();
        if (!this.bound && Date.now() - this.startedTimerAt >= this.bindTimeoutMs) {
          this.fail('Codex rollout session could not be bound to the submitted prompt.');
        }
        return;
      }

      this.pollRollout();
      if (!this.completed && Date.now() - this.startedTimerAt >= this.turnTimeoutMs) {
        this.fail('Codex rollout turn timed out before task_complete.');
      }
    } catch (error) {
      this.fail(error.message || String(error));
    } finally {
      this.polling = false;
    }
  }

  pollHistory() {
    const records = readIncrementalJsonl(this.fs, this.historyPath, this.historyTail, {
      onMalformed: (line) => this.logMalformed('history', line)
    });
    for (const record of records) {
      if (
        record &&
        (this.matchNextPrompt || String(record.text || '') === this.prompt) &&
        String(record.session_id || '').trim()
      ) {
        if (this.promptMatchesSeen < this.skipPromptMatches) {
          this.promptMatchesSeen += 1;
          continue;
        }
        if (!this.sessionId) {
          if (this.matchNextPrompt) {
            this.prompt = String(record.text || '');
            if (!this.prompt) continue;
          }
          this.sessionId = String(record.session_id).trim();
          this.historyTimestampMs = normalizeHistoryTimestamp(record.ts);
        }
      }
    }
  }

  tryBind() {
    if (!this.sessionId || this.bound) return;
    const rolloutPath = this.reader.findRolloutPath(this.sessionId);
    if (!rolloutPath) return;

    const located = locateSubmittedTurn(this.fs, rolloutPath, {
      prompt: this.prompt,
      cwd: this.cwd,
      startedAt: Math.max(this.startedAt, this.historyTimestampMs || 0),
      maxBytes: this.reader.initialTailBytes
    });
    if (located.status === 'cwd_mismatch') {
      this.logger.event?.('codex.rollout.binding.rejected', {
        sessionId: this.sessionId,
        reason: 'cwd_mismatch',
        expectedCwd: this.cwd,
        actualCwd: located.cwd || ''
      });
      this.sessionId = '';
      return;
    }
    if (located.status !== 'found') return;

    this.rolloutPath = rolloutPath;
    this.turnId = located.turnId || '';
    this.bound = true;
    this.rolloutTail = {
      offset: located.endOffset,
      partialBuffer: located.partialBuffer || Buffer.alloc(0)
    };
    this.emitEvent({
      type: 'bound',
      sessionId: this.sessionId,
      turnId: this.turnId,
      rolloutPath: this.rolloutPath,
      cliVersion: located.cliVersion || '',
      cwd: located.cwd || this.cwd,
      prompt: this.prompt
    });
    this.emitEvent({
      type: 'turn_started',
      sessionId: this.sessionId,
      turnId: this.turnId
    });
    for (const record of located.records) this.consumeRolloutRecord(record);
  }

  pollRollout() {
    const records = readIncrementalJsonl(
      this.fs,
      this.rolloutPath,
      this.rolloutTail,
      { onMalformed: (line) => this.logMalformed('rollout', line) }
    );
    for (const record of records) this.consumeRolloutRecord(record);
  }

  consumeRolloutRecord(record) {
    if (this.stopped || !record || record.type !== 'event_msg') return;
    const payload = record.payload || {};

    if (payload.type === 'task_started') {
      const nextTurnId = String(payload.turn_id || '');
      if (this.turnId && nextTurnId && nextTurnId !== this.turnId) {
        this.fail('A new rollout task started before the bound task completed.');
        return;
      }
      if (!this.turnId) this.turnId = nextTurnId;
      return;
    }

    if (payload.type === 'agent_message') {
      const text = normalizeRolloutMessage(payload.message);
      if (!text) return;
      if (payload.phase === 'commentary') {
        this.emitEvent({
          type: 'progress',
          sessionId: this.sessionId,
          turnId: this.turnId,
          text,
          timestamp: record.timestamp || ''
        });
      } else if (payload.phase === 'final_answer') {
        this.finalText = text;
        this.emitEvent({
          type: 'final',
          sessionId: this.sessionId,
          turnId: this.turnId,
          text,
          timestamp: record.timestamp || ''
        });
      }
      return;
    }

    if (payload.type !== 'task_complete') return;
    const completedTurnId = String(payload.turn_id || '');
    if (this.turnId && completedTurnId && completedTurnId !== this.turnId) return;

    this.completed = true;
    this.emitEvent({
      type: 'turn_complete',
      sessionId: this.sessionId,
      turnId: completedTurnId || this.turnId,
      finalText:
        this.finalText || normalizeRolloutMessage(payload.last_agent_message),
      durationMs: Number(payload.duration_ms) || 0,
      timeToFirstTokenMs: Number(payload.time_to_first_token_ms) || 0,
      timestamp: record.timestamp || ''
    });
    this.stop('turn_complete');
  }

  emitEvent(event) {
    try {
      this.onEvent?.(event);
    } catch (error) {
      this.fail(error.message || String(error));
    }
  }

  fail(message) {
    if (this.stopped) return;
    const error = new Error(String(message || 'Codex rollout reader failed.'));
    this.logger.warn?.('Codex rollout reader:', error.message);
    try {
      this.onError?.(error);
    } finally {
      this.stop('error');
    }
  }

  logMalformed(source, line) {
    this.logger.event?.('codex.rollout.jsonl.malformed', {
      source,
      sessionId: this.sessionId,
      chars: String(line || '').length
    });
  }
}

function locateSubmittedTurn(fsImpl, rolloutPath, options = {}) {
  const tail = readJsonlTail(fsImpl, rolloutPath, options.maxBytes);
  const prompt = String(options.prompt || '');
  const earliest = normalizeStartedAt(options.startedAt) - TURN_START_TOLERANCE_MS;
  let matchIndex = -1;

  for (let index = 0; index < tail.records.length; index += 1) {
    const record = tail.records[index].value;
    if (
      record?.type === 'event_msg' &&
      record.payload?.type === 'user_message' &&
      String(record.payload?.message || '') === prompt &&
      timestampMs(record.timestamp) >= earliest
    ) {
      matchIndex = index;
      break;
    }
  }

  if (matchIndex < 0) {
    return { status: 'pending' };
  }

  let startIndex = matchIndex;
  let turnId = '';
  let turnCwd = '';
  let cliVersion = '';
  for (let index = matchIndex; index >= 0; index -= 1) {
    const record = tail.records[index].value;
    if (record?.type === 'turn_context' && !turnCwd) {
      turnCwd = String(record.payload?.cwd || '');
    }
    if (record?.type === 'event_msg' && record.payload?.type === 'task_started') {
      startIndex = index;
      turnId = String(record.payload?.turn_id || '');
      break;
    }
  }
  for (const entry of tail.records) {
    const record = entry.value;
    if (record?.type === 'session_meta') {
      cliVersion = String(record.payload?.cli_version || '');
      if (!turnCwd) turnCwd = String(record.payload?.cwd || '');
      break;
    }
  }

  if (options.cwd && turnCwd && path.resolve(turnCwd) !== path.resolve(options.cwd)) {
    return { status: 'cwd_mismatch', cwd: turnCwd };
  }

  return {
    status: 'found',
    turnId,
    cwd: turnCwd,
    cliVersion,
    records: tail.records.slice(matchIndex + 1).map((entry) => entry.value),
    endOffset: tail.endOffset,
    partialBuffer: tail.partialBuffer
  };
}

function readJsonlTail(fsImpl, filePath, maxBytes = DEFAULT_INITIAL_TAIL_BYTES) {
  const stat = fsImpl.statSync(filePath);
  const size = Number(stat.size) || 0;
  const requestedStart = Math.max(0, size - normalizePositiveNumber(maxBytes, size || 1));
  const buffer = Buffer.alloc(Math.max(0, size - requestedStart));
  if (buffer.length > 0) {
    const fd = fsImpl.openSync(filePath, 'r');
    try {
      fsImpl.readSync(fd, buffer, 0, buffer.length, requestedStart);
    } finally {
      fsImpl.closeSync(fd);
    }
  }

  let baseOffset = requestedStart;
  let content = buffer;
  if (requestedStart > 0) {
    const firstNewline = content.indexOf(0x0a);
    if (firstNewline < 0) {
      return { records: [], endOffset: size, partialBuffer: Buffer.alloc(0) };
    }
    baseOffset += firstNewline + 1;
    content = content.subarray(firstNewline + 1);
  }

  const parsed = parseJsonlBuffer(content, baseOffset);

  return {
    records: parsed.records,
    endOffset: size,
    partialBuffer: parsed.partialBuffer
  };
}

function readIncrementalJsonl(fsImpl, filePath, state, options = {}) {
  if (!fileExists(fsImpl, filePath)) return [];
  const stat = fsImpl.statSync(filePath);
  const size = Number(stat.size) || 0;
  if (size < state.offset) {
    state.offset = 0;
    state.partialBuffer = Buffer.alloc(0);
  }
  if (size === state.offset) return [];

  const buffer = Buffer.alloc(size - state.offset);
  const fd = fsImpl.openSync(filePath, 'r');
  try {
    fsImpl.readSync(fd, buffer, 0, buffer.length, state.offset);
  } finally {
    fsImpl.closeSync(fd);
  }
  state.offset = size;

  const pending = Buffer.isBuffer(state.partialBuffer)
    ? state.partialBuffer
    : Buffer.from(String(state.partial || ''), 'utf8');
  const parsed = parseJsonlBuffer(Buffer.concat([pending, buffer]), 0, options);
  state.partialBuffer = parsed.partialBuffer;
  delete state.partial;
  return parsed.records.map((entry) => entry.value);
}

function createTailState(fsImpl, filePath, options = {}) {
  const offset = options.fromEnd && fileExists(fsImpl, filePath)
    ? Number(fsImpl.statSync(filePath).size) || 0
    : 0;
  return { offset, partialBuffer: Buffer.alloc(0) };
}

function parseJsonlBuffer(buffer, baseOffset = 0, options = {}) {
  const records = [];
  let lineStart = 0;
  while (lineStart < buffer.length) {
    const newline = buffer.indexOf(0x0a, lineStart);
    if (newline < 0) break;
    const lineBuffer = buffer.subarray(lineStart, newline);
    const line = lineBuffer.toString('utf8');
    const endOffset = baseOffset + newline + 1;
    if (line.trim()) {
      try {
        records.push({
          offset: baseOffset + lineStart,
          endOffset,
          value: JSON.parse(line)
        });
      } catch {
        options.onMalformed?.(line);
      }
    }
    lineStart = newline + 1;
  }
  return {
    records,
    partialBuffer: Buffer.from(buffer.subarray(lineStart))
  };
}

function findFileBySuffix(fsImpl, root, suffix) {
  if (!fileExists(fsImpl, root)) return '';
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fsImpl.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return target;
      }
    }
  }
  return '';
}

function normalizeRolloutMessage(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^\n+|\n+$/g, '');
}

function normalizeStartedAt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Date.now();
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeHistoryTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1e12 ? number * 1000 : number;
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function fileExists(fsImpl, target) {
  try {
    return fsImpl.existsSync(target);
  } catch {
    return false;
  }
}

module.exports = {
  CodexRolloutReader,
  locateSubmittedTurn,
  normalizeRolloutMessage,
  readIncrementalJsonl,
  readJsonlTail
};
