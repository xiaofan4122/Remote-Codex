const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_BIND_TIMEOUT_MS = 60000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_INITIAL_TAIL_BYTES = 64 * 1024 * 1024;
const TURN_START_TOLERANCE_MS = 0;
const ROLLOUT_TURN_REPLACED_ERROR_CODE = 'CODEX_ROLLOUT_TURN_REPLACED';

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
    this.allowedExecPrefixCache = {
      mtimeMs: -1,
      prefixes: []
    };
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

  getAllowedExecPrefixes() {
    const rulesPath = path.join(this.codexHome, 'rules', 'default.rules');
    try {
      const stat = this.fs.statSync(rulesPath);
      if (this.allowedExecPrefixCache.mtimeMs === stat.mtimeMs) {
        return this.allowedExecPrefixCache.prefixes;
      }
      const prefixes = parseAllowedExecPrefixes(
        this.fs.readFileSync(rulesPath, 'utf8')
      );
      this.allowedExecPrefixCache = {
        mtimeMs: stat.mtimeMs,
        prefixes
      };
      return prefixes;
    } catch {
      this.allowedExecPrefixCache = { mtimeMs: -1, prefixes: [] };
      return [];
    }
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
    this.authorizationRequests = new Map();
    this.authorizationCompletions = new Set();
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
    if (this.stopped || !record) return;
    if (record.type === 'response_item') {
      this.consumeResponseItem(record);
      return;
    }
    if (record.type !== 'event_msg') return;
    const payload = record.payload || {};

    if (payload.type === 'task_started') {
      const nextTurnId = String(payload.turn_id || '');
      if (this.turnId && nextTurnId && nextTurnId !== this.turnId) {
        const error = new Error(
          'A new rollout task started before the bound task completed.'
        );
        error.code = ROLLOUT_TURN_REPLACED_ERROR_CODE;
        error.turnId = this.turnId;
        error.nextTurnId = nextTurnId;
        this.fail(error);
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

  consumeResponseItem(record) {
    const payload = record.payload || {};
    if (payload.type === 'custom_tool_call') {
      let approval = parseRolloutAuthorizationRequest(payload);
      if (!approval) return;
      approval = filterAutomaticallyAllowedAuthorization(
        approval,
        this.reader.getAllowedExecPrefixes()
      );
      if (!approval) {
        this.logger.event?.('codex.rollout.authorization.ignored', {
          callId: String(payload.call_id || ''),
          reason: 'allowed_exec_prefix'
        });
        return;
      }
      if (this.authorizationRequests.has(approval.callId)) return;
      this.authorizationRequests.set(approval.callId, approval);
      this.emitEvent({
        type: 'authorization_requested',
        sessionId: this.sessionId,
        turnId: approval.turnId || this.turnId,
        callId: approval.callId,
        approval,
        timestamp: record.timestamp || ''
      });
      return;
    }

    if (payload.type !== 'custom_tool_call_output') return;
    const callId = String(payload.call_id || '').trim();
    if (
      !callId ||
      !this.authorizationRequests.has(callId) ||
      this.authorizationCompletions.has(callId)
    ) {
      return;
    }
    this.authorizationCompletions.add(callId);
    const approval = this.authorizationRequests.get(callId);
    this.emitEvent({
      type: 'authorization_completed',
      sessionId: this.sessionId,
      turnId: approval?.turnId || this.turnId,
      callId,
      timestamp: record.timestamp || ''
    });
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
    const error = message instanceof Error
      ? message
      : new Error(String(message || 'Codex rollout reader failed.'));
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

function parseRolloutAuthorizationRequest(payload = {}) {
  if (
    payload.type !== 'custom_tool_call' ||
    String(payload.name || '') !== 'exec'
  ) {
    return null;
  }
  const callId = String(payload.call_id || '').trim();
  if (!callId) return null;
  const requests = extractEscalatedExecRequests(payload.input);
  if (requests.length === 0) return null;

  return buildRolloutAuthorization({
    callId,
    turnId: String(
      payload.internal_chat_message_metadata_passthrough?.turn_id || ''
    ),
    requests
  });
}

function buildRolloutAuthorization({ callId, turnId, requests }) {
  const normalizedRequests = Array.isArray(requests) ? requests : [];
  if (!callId || normalizedRequests.length === 0) return null;

  const commands = uniqueNonEmpty(
    normalizedRequests.map((request) => request.command)
  );
  const justifications = uniqueNonEmpty(
    normalizedRequests.map((request) => request.justification)
  );
  const command = commands.join('\n');
  const justification = justifications.join('；');
  const canPersist = normalizedRequests.every(
    (request) => Array.isArray(request.prefixRule) && request.prefixRule.length > 0
  );
  const options = [
    { selected: true, index: 1, action: 'approve', text: 'Yes, proceed (y)' }
  ];
  if (canPersist) {
    options.push({
      selected: false,
      index: 2,
      action: 'approve_persistent',
      text: "Yes, and don't ask again (p)"
    });
  }
  options.push({
    selected: false,
    index: options.length + 1,
    action: 'deny',
    text: 'No, and tell Codex what to do differently (esc)'
  });
  return {
    id: callId,
    callId,
    source: 'rollout_jsonl',
    turnId: String(turnId || ''),
    requests: normalizedRequests,
    status: '',
    question: normalizedRequests.length > 1
      ? `是否允许执行这组操作（${normalizedRequests.length} 项）？`
      : '是否允许执行以下操作？',
    reason: justification ? `Reason: ${justification}` : '',
    command: command || '命令由 Codex 在运行时生成。',
    commandCount: normalizedRequests.length,
    options
  };
}

function extractEscalatedExecRequests(input) {
  const source = String(input || '');
  if (!source) return [];
  const requests = [];
  for (const objectSource of findCallObjectLiterals(source, 'tools.exec_command')) {
    const permission = extractStaticStringProperty(
      objectSource,
      'sandbox_permissions'
    );
    if (permission !== 'require_escalated') continue;
    const request = {
      command: extractStaticStringProperty(objectSource, 'cmd'),
      justification: extractStaticStringProperty(objectSource, 'justification')
    };
    const prefixRule = extractStaticStringArrayProperty(
      objectSource,
      'prefix_rule'
    );
    if (prefixRule.length > 0) request.prefixRule = prefixRule;
    requests.push(request);
  }
  if (requests.length > 0) return dedupeEscalatedRequests(requests);

  const permissions = extractStaticStringProperties(source, 'sandbox_permissions');
  if (!permissions.includes('require_escalated')) return [];
  return [{
    command: extractStaticStringProperties(source, 'cmd')[0] || '',
    justification: extractStaticStringProperties(source, 'justification')[0] || ''
  }];
}

function extractStaticStringArrayProperty(source, name) {
  const value = String(source || '');
  for (const valueStart of findStaticPropertyValueStarts(value, name, {
    topLevelObject: true
  })) {
    const parsed = readStaticStringArray(value, valueStart);
    if (parsed) return parsed.values;
  }
  return [];
}

function readStaticStringArray(source, start) {
  if (source[start] !== '[') return null;
  const values = [];
  let cursor = start + 1;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] || '')) cursor += 1;
    if (source[cursor] === ']') {
      return { values, end: cursor + 1 };
    }
    const parsed = readJavaScriptStringLiteral(source, cursor);
    if (!parsed) return null;
    values.push(parsed.value);
    cursor = parsed.end;
    while (/\s/.test(source[cursor] || '')) cursor += 1;
    if (source[cursor] === ']') {
      return { values, end: cursor + 1 };
    }
    if (source[cursor] !== ',') return null;
    cursor += 1;
  }
  return null;
}

function parseAllowedExecPrefixes(source) {
  const prefixes = [];
  for (const line of String(source || '').split(/\r?\n/)) {
    if (!/decision\s*=\s*["']allow["']/.test(line)) continue;
    const match = /prefix_rule\s*\(\s*pattern\s*=\s*/.exec(line);
    if (!match) continue;
    const parsed = readStaticStringArray(line, match.index + match[0].length);
    if (parsed?.values.length) prefixes.push(parsed.values);
  }
  return prefixes;
}

function filterAutomaticallyAllowedAuthorization(approval, allowedPrefixes) {
  const requests = Array.isArray(approval?.requests) ? approval.requests : [];
  if (requests.length === 0 || !Array.isArray(allowedPrefixes)) return approval;
  const pending = requests.filter((request) => (
    !isAllowedExecPrefix(request.prefixRule, allowedPrefixes)
  ));
  if (pending.length === requests.length) return approval;
  if (pending.length === 0) return null;
  return buildRolloutAuthorization({
    callId: approval.callId,
    turnId: approval.turnId,
    requests: pending
  });
}

function isAllowedExecPrefix(prefixRule, allowedPrefixes) {
  if (!Array.isArray(prefixRule) || prefixRule.length === 0) return false;
  return allowedPrefixes.some((allowed) => (
    Array.isArray(allowed) &&
    allowed.length <= prefixRule.length &&
    allowed.every((token, index) => token === prefixRule[index])
  ));
}

function findCallObjectLiterals(source, callee) {
  const value = String(source || '');
  const masked = maskJavaScriptNonCode(value);
  const objects = [];
  let offset = 0;
  while (offset < masked.length) {
    const found = masked.indexOf(callee, offset);
    if (found < 0) break;
    let cursor = found + callee.length;
    while (/\s/.test(masked[cursor] || '')) cursor += 1;
    if (masked[cursor] !== '(') {
      offset = cursor + 1;
      continue;
    }
    cursor += 1;
    while (/\s/.test(masked[cursor] || '')) cursor += 1;
    if (masked[cursor] !== '{') {
      offset = cursor + 1;
      continue;
    }
    const end = findBalancedObjectEnd(masked, cursor);
    if (end < 0) break;
    objects.push(value.slice(cursor, end + 1));
    offset = end + 1;
  }
  return objects;
}

function findBalancedObjectEnd(masked, start) {
  let depth = 0;
  for (let index = start; index < masked.length; index += 1) {
    if (masked[index] === '{') depth += 1;
    if (masked[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function extractStaticStringProperty(source, name) {
  return extractStaticStringProperties(source, name, { topLevelObject: true })[0] || '';
}

function extractStaticStringProperties(source, name, options = {}) {
  const value = String(source || '');
  const values = [];
  for (const valueStart of findStaticPropertyValueStarts(value, name, options)) {
    const parsed = readJavaScriptStringLiteral(value, valueStart);
    if (parsed) values.push(parsed.value);
  }
  return values;
}

function findStaticPropertyValueStarts(source, name, options = {}) {
  const value = String(source || '');
  const expectedDepth = options.topLevelObject ? 1 : null;
  const starts = [];
  let objectDepth = 0;
  let index = 0;

  while (index < value.length) {
    const char = value[index];
    const next = value[index + 1];

    if (char === '/' && next === '/') {
      const newline = value.indexOf('\n', index + 2);
      index = newline < 0 ? value.length : newline + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = value.indexOf('*/', index + 2);
      index = end < 0 ? value.length : end + 2;
      continue;
    }
    if (char === '{') {
      objectDepth += 1;
      index += 1;
      continue;
    }
    if (char === '}') {
      objectDepth = Math.max(0, objectDepth - 1);
      index += 1;
      continue;
    }

    if (['"', "'", '`'].includes(char)) {
      const parsed = readJavaScriptStringLiteral(value, index);
      const end = parsed?.end || skipQuotedLiteral(value, index);
      if (
        parsed?.value === name &&
        (expectedDepth === null || objectDepth === expectedDepth)
      ) {
        const valueStart = propertyValueStart(value, end);
        if (valueStart >= 0) starts.push(valueStart);
      }
      index = Math.max(index + 1, end);
      continue;
    }

    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/.test(value[end] || '')) end += 1;
      if (
        value.slice(index, end) === name &&
        (expectedDepth === null || objectDepth === expectedDepth)
      ) {
        const valueStart = propertyValueStart(value, end);
        if (valueStart >= 0) starts.push(valueStart);
      }
      index = end;
      continue;
    }

    index += 1;
  }
  return starts;
}

function propertyValueStart(source, keyEnd) {
  let cursor = keyEnd;
  while (/\s/.test(source[cursor] || '')) cursor += 1;
  if (source[cursor] !== ':') return -1;
  cursor += 1;
  while (/\s/.test(source[cursor] || '')) cursor += 1;
  return cursor;
}

function skipQuotedLiteral(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function readJavaScriptStringLiteral(source, start) {
  const quote = source[start];
  if (!['"', "'", '`'].includes(quote)) return null;
  let value = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === quote) return { value, end: index + 1 };
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      return null;
    }
    if (char !== '\\') {
      value += char;
      continue;
    }
    index += 1;
    if (index >= source.length) return null;
    const escaped = source[index];
    if (escaped === '\n') continue;
    if (escaped === '\r') {
      if (source[index + 1] === '\n') index += 1;
      continue;
    }
    const simple = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
      '0': '\0'
    }[escaped];
    if (simple !== undefined) {
      value += simple;
      continue;
    }
    if (escaped === 'x') {
      const hex = source.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (escaped === 'u') {
      const braced = source[index + 1] === '{';
      const end = braced ? source.indexOf('}', index + 2) : index + 5;
      const hex = braced
        ? source.slice(index + 2, end)
        : source.slice(index + 1, end);
      if (end < 0 || !/^[0-9a-f]{4,6}$/i.test(hex)) return null;
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint > 0x10ffff) return null;
      value += String.fromCodePoint(codePoint);
      index = braced ? end : index + 4;
      continue;
    }
    value += escaped;
  }
  return null;
}

function maskJavaScriptNonCode(source) {
  const value = String(source || '');
  const chars = value.split('');
  let state = 'code';
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        chars[index] = chars[index + 1] = ' ';
        index += 1;
        state = 'line_comment';
      } else if (char === '/' && next === '*') {
        chars[index] = chars[index + 1] = ' ';
        index += 1;
        state = 'block_comment';
      } else if (char === '"') {
        chars[index] = ' ';
        state = 'double';
      } else if (char === "'") {
        chars[index] = ' ';
        state = 'single';
      } else if (char === '`') {
        chars[index] = ' ';
        state = 'template';
      }
      continue;
    }
    if (state === 'line_comment') {
      if (char === '\n') {
        state = 'code';
      } else {
        chars[index] = ' ';
      }
      continue;
    }
    if (state === 'block_comment') {
      chars[index] = char === '\n' ? '\n' : ' ';
      if (char === '*' && next === '/') {
        chars[index + 1] = ' ';
        index += 1;
        state = 'code';
      }
      continue;
    }
    chars[index] = char === '\n' ? '\n' : ' ';
    if (char === '\\') {
      if (index + 1 < chars.length) {
        chars[index + 1] = chars[index + 1] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (
      (state === 'double' && char === '"') ||
      (state === 'single' && char === "'") ||
      (state === 'template' && char === '`')
    ) {
      state = 'code';
    }
  }
  return chars.join('');
}

function dedupeEscalatedRequests(requests) {
  const seen = new Set();
  return requests.filter((request) => {
    const signature = `${request.command || ''}\u0000${request.justification || ''}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
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
  ROLLOUT_TURN_REPLACED_ERROR_CODE,
  extractEscalatedExecRequests,
  filterAutomaticallyAllowedAuthorization,
  locateSubmittedTurn,
  normalizeRolloutMessage,
  parseAllowedExecPrefixes,
  parseRolloutAuthorizationRequest,
  readIncrementalJsonl,
  readJsonlTail
};
