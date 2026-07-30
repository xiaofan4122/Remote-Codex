#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexRolloutReader } = require('../src/codexRolloutReader');

async function main() {
  await testBindsNextUnknownPrompt();
  await testIncrementalRolloutEventsAreSemanticAndOrdered();
  await testResumeAppendsWithoutReplayingPreviousTurns();
  await testRecentIdenticalPromptDoesNotBindPreviousTurn();
  await testQueuedIdenticalPromptsBindInOrder();
  await testNextTaskBoundaryCannotLeakIntoBoundTurn();
  console.log('Codex rollout reader tests passed.');
}

async function testBindsNextUnknownPrompt() {
  const fixture = createFixture();
  const events = [];
  const reader = createReader(fixture.codexHome);
  reader.beginTurn({
    matchNextPrompt: true,
    cwd: fixture.cwd,
    startedAt: Date.now() - 1000,
    onEvent: (event) => events.push(event)
  });

  const prompt = 'Review the current working tree changes';
  appendJson(fixture.historyPath, {
    session_id: fixture.sessionId,
    ts: Date.now() / 1000,
    text: prompt
  });
  appendJson(fixture.rolloutPath, event('event_msg', {
    type: 'user_message',
    message: prompt
  }));
  appendJson(fixture.rolloutPath, event('event_msg', {
    type: 'task_started',
    turn_id: 'turn-next'
  }));
  appendJson(fixture.rolloutPath, event('event_msg', {
    type: 'agent_message',
    phase: 'final_answer',
    message: 'Review completed.'
  }));
  appendJson(fixture.rolloutPath, event('event_msg', {
    type: 'task_complete',
    turn_id: 'turn-next',
    last_agent_message: 'Review completed.'
  }));

  await waitUntil(() => events.some((entry) => entry.type === 'turn_complete'));
  assert.equal(events.find((entry) => entry.type === 'bound').prompt, prompt);
  assert.equal(events.find((entry) => entry.type === 'final').text, 'Review completed.');
  reader.stopAll();
}

async function testQueuedIdenticalPromptsBindInOrder() {
  const fixture = createFixture();
  const prompt = '排队中的相同任务';
  const firstAt = Date.now();
  const secondAt = firstAt + 100;
  const firstEvents = [];
  const secondEvents = [];
  const reader = createReader(fixture.codexHome);
  reader.beginTurn({
    prompt,
    cwd: fixture.cwd,
    startedAt: firstAt,
    onEvent: (event) => firstEvents.push(event),
    onError: (error) => {
      throw error;
    }
  });
  reader.beginTurn({
    prompt,
    cwd: fixture.cwd,
    startedAt: firstAt,
    skipPromptMatches: 1,
    onEvent: (event) => secondEvents.push(event),
    onError: (error) => {
      throw error;
    }
  });

  appendJson(fixture.historyPath, {
    session_id: fixture.sessionId,
    ts: firstAt / 1000,
    text: prompt
  });
  appendJson(fixture.historyPath, {
    session_id: fixture.sessionId,
    ts: secondAt / 1000,
    text: prompt
  });
  appendRollout(fixture.rolloutPath, [
    eventAt(new Date(firstAt).toISOString(), 'event_msg', {
      type: 'task_started',
      turn_id: 'turn-queued-first'
    }),
    eventAt(new Date(firstAt).toISOString(), 'turn_context', {
      turn_id: 'turn-queued-first',
      cwd: fixture.cwd
    }),
    eventAt(new Date(firstAt).toISOString(), 'event_msg', {
      type: 'user_message',
      message: prompt
    }),
    eventAt(new Date(firstAt).toISOString(), 'event_msg', {
      type: 'agent_message',
      phase: 'final_answer',
      message: '第一个排队答案'
    }),
    eventAt(new Date(firstAt).toISOString(), 'event_msg', {
      type: 'task_complete',
      turn_id: 'turn-queued-first',
      last_agent_message: '第一个排队答案'
    }),
    eventAt(new Date(secondAt).toISOString(), 'event_msg', {
      type: 'task_started',
      turn_id: 'turn-queued-second'
    }),
    eventAt(new Date(secondAt).toISOString(), 'turn_context', {
      turn_id: 'turn-queued-second',
      cwd: fixture.cwd
    }),
    eventAt(new Date(secondAt).toISOString(), 'event_msg', {
      type: 'user_message',
      message: prompt
    }),
    eventAt(new Date(secondAt).toISOString(), 'event_msg', {
      type: 'agent_message',
      phase: 'final_answer',
      message: '第二个排队答案'
    }),
    eventAt(new Date(secondAt).toISOString(), 'event_msg', {
      type: 'task_complete',
      turn_id: 'turn-queued-second',
      last_agent_message: '第二个排队答案'
    })
  ]);

  await waitUntil(() => (
    firstEvents.some((event) => event.type === 'turn_complete') &&
    secondEvents.some((event) => event.type === 'turn_complete')
  ));
  assert.equal(firstEvents.find((event) => event.type === 'bound').turnId, 'turn-queued-first');
  assert.equal(secondEvents.find((event) => event.type === 'bound').turnId, 'turn-queued-second');
  assert.equal(firstEvents.find((event) => event.type === 'final').text, '第一个排队答案');
  assert.equal(secondEvents.find((event) => event.type === 'final').text, '第二个排队答案');
}

async function testNextTaskBoundaryCannotLeakIntoBoundTurn() {
  const fixture = createFixture();
  const prompt = '当前任务缺少完成事件';
  const startedAt = Date.now();
  const events = [];
  const errors = [];
  const reader = createReader(fixture.codexHome);
  reader.beginTurn({
    prompt,
    cwd: fixture.cwd,
    startedAt,
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error)
  });
  appendJson(fixture.historyPath, {
    session_id: fixture.sessionId,
    ts: startedAt / 1000,
    text: prompt
  });
  appendRollout(fixture.rolloutPath, [
    event('event_msg', { type: 'task_started', turn_id: 'turn-incomplete' }),
    event('turn_context', { turn_id: 'turn-incomplete', cwd: fixture.cwd }),
    event('event_msg', { type: 'user_message', message: prompt })
  ]);
  await waitUntil(() => events.some((event) => event.type === 'bound'));

  appendRollout(fixture.rolloutPath, [
    event('event_msg', { type: 'task_started', turn_id: 'turn-next' }),
    event('event_msg', {
      type: 'agent_message',
      phase: 'final_answer',
      message: '下一任务的内容绝不能泄漏'
    })
  ]);
  await waitUntil(() => errors.length === 1);
  assert.match(errors[0].message, /new rollout task started/i);
  assert.doesNotMatch(JSON.stringify(events), /下一任务的内容绝不能泄漏/);
}

async function testRecentIdenticalPromptDoesNotBindPreviousTurn() {
  const fixture = createFixture();
  const prompt = '短时间内重复的同一条任务';
  const startedAt = Date.now();
  const oldAt = new Date(startedAt - 1000).toISOString();
  appendRollout(fixture.rolloutPath, [
    eventAt(oldAt, 'event_msg', { type: 'task_started', turn_id: 'turn-recent-old' }),
    eventAt(oldAt, 'turn_context', { turn_id: 'turn-recent-old', cwd: fixture.cwd }),
    eventAt(oldAt, 'event_msg', { type: 'user_message', message: prompt }),
    eventAt(oldAt, 'event_msg', {
      type: 'agent_message',
      phase: 'final_answer',
      message: '不应绑定的最近旧答案'
    }),
    eventAt(oldAt, 'event_msg', {
      type: 'task_complete',
      turn_id: 'turn-recent-old',
      last_agent_message: '不应绑定的最近旧答案'
    })
  ]);

  const events = [];
  const reader = createReader(fixture.codexHome);
  reader.beginTurn({
    prompt,
    cwd: fixture.cwd,
    startedAt,
    onEvent: (event) => events.push(event),
    onError: (error) => {
      throw error;
    }
  });
  appendJson(fixture.historyPath, {
    session_id: fixture.sessionId,
    ts: startedAt / 1000,
    text: prompt
  });
  appendRollout(fixture.rolloutPath, [
    event('event_msg', { type: 'task_started', turn_id: 'turn-current-repeat' }),
    event('turn_context', { turn_id: 'turn-current-repeat', cwd: fixture.cwd }),
    event('event_msg', { type: 'user_message', message: prompt }),
    event('event_msg', {
      type: 'agent_message',
      phase: 'final_answer',
      message: '当前重复任务答案'
    }),
    event('event_msg', {
      type: 'task_complete',
      turn_id: 'turn-current-repeat',
      last_agent_message: '当前重复任务答案'
    })
  ]);

  await waitUntil(() => events.some((event) => event.type === 'turn_complete'));
  assert.equal(events.find((event) => event.type === 'bound').turnId, 'turn-current-repeat');
  assert.equal(events.find((event) => event.type === 'final').text, '当前重复任务答案');
  assert.doesNotMatch(JSON.stringify(events), /不应绑定的最近旧答案/);
}

async function testIncrementalRolloutEventsAreSemanticAndOrdered() {
  const fixture = createFixture();
  const events = [];
  const errors = [];
  const prompt = '检查当前项目并分段说明';
  const startedAt = Date.now();
  const turnId = 'turn-current';
  const reader = createReader(fixture.codexHome);
  const turn = reader.beginTurn({
    prompt,
    cwd: fixture.cwd,
    startedAt,
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error)
  });

  appendJson(fixture.historyPath, {
    session_id: fixture.sessionId,
    ts: Math.floor(startedAt / 1000),
    text: prompt
  });
  appendRollout(fixture.rolloutPath, [
    event('event_msg', { type: 'task_started', turn_id: turnId }),
    event('turn_context', { turn_id: turnId, cwd: fixture.cwd }),
    event('event_msg', { type: 'user_message', message: prompt })
  ]);

  await waitUntil(() => events.some((event) => event.type === 'bound'));

  const first = '第一段来自 commentary，不经过终端解析。';
  const second = '第二段保留换行：\n\n- 项目文件：69\n- 代码行数：23,212';
  appendRollout(fixture.rolloutPath, [
    event('event_msg', {
      type: 'agent_message',
      phase: 'commentary',
      message: first
    }),
    event('response_item', {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: first }]
    })
  ]);

  const partialRecord = Buffer.from(JSON.stringify(event('event_msg', {
    type: 'agent_message',
    phase: 'commentary',
    message: second
  })), 'utf8');
  const chineseStart = partialRecord.indexOf(Buffer.from('第二', 'utf8'));
  const splitAt = chineseStart + 1;
  fs.appendFileSync(fixture.rolloutPath, partialRecord.subarray(0, splitAt));
  await wait(20);
  assert.equal(events.filter((event) => event.type === 'progress').length, 1);
  fs.appendFileSync(
    fixture.rolloutPath,
    Buffer.concat([partialRecord.subarray(splitAt), Buffer.from('\n')])
  );

  const finalText = [
    '最终结果：',
    '',
    '- 文件数：69',
    '- 代码行数：23,212',
    '',
    '```text',
    'line one',
    'line two',
    '```'
  ].join('\n');
  appendRollout(fixture.rolloutPath, [
    event('event_msg', {
      type: 'agent_message',
      phase: 'final_answer',
      message: finalText
    }),
    event('response_item', {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: finalText }]
    }),
    event('event_msg', {
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: finalText,
      duration_ms: 1234,
      time_to_first_token_ms: 456
    })
  ]);

  await waitUntil(() => events.some((event) => event.type === 'turn_complete'));
  turn.stop();

  assert.deepEqual(errors, []);
  assert.deepEqual(
    events.filter((event) => event.type === 'progress').map((event) => event.text),
    [first, second]
  );
  assert.equal(events.filter((event) => event.type === 'final').length, 1);
  assert.equal(events.find((event) => event.type === 'final').text, finalText);
  assert.equal(
    events.find((event) => event.type === 'turn_complete').finalText,
    finalText
  );
  assert.equal(events.find((event) => event.type === 'bound').turnId, turnId);
}

async function testResumeAppendsWithoutReplayingPreviousTurns() {
  const fixture = createFixture();
  const reader = createReader(fixture.codexHome);
  const firstPrompt = '第一次任务';
  const firstProgress = '第一次任务的旧进度';
  const firstFinal = '第一次任务的旧最终答案';
  const oldAt = new Date(Date.now() - 60000).toISOString();
  appendRollout(fixture.rolloutPath, [
    eventAt(oldAt, 'event_msg', { type: 'task_started', turn_id: 'turn-old' }),
    eventAt(oldAt, 'turn_context', { turn_id: 'turn-old', cwd: fixture.cwd }),
    eventAt(oldAt, 'event_msg', { type: 'user_message', message: firstPrompt }),
    eventAt(oldAt, 'event_msg', {
      type: 'agent_message',
      phase: 'commentary',
      message: firstProgress
    }),
    eventAt(oldAt, 'event_msg', {
      type: 'agent_message',
      phase: 'final_answer',
      message: firstFinal
    }),
    eventAt(oldAt, 'event_msg', {
      type: 'task_complete',
      turn_id: 'turn-old',
      last_agent_message: firstFinal
    })
  ]);

  const prompt = 'resume 后的新任务';
  const progress = '只发送 resume 后的新进度';
  const finalText = '只发送 resume 后的新最终答案';
  const events = [];
  const startedAt = Date.now();
  reader.beginTurn({
    prompt,
    cwd: fixture.cwd,
    startedAt,
    onEvent: (event) => events.push(event),
    onError: (error) => {
      throw error;
    }
  });

  appendJson(fixture.historyPath, {
    session_id: fixture.sessionId,
    ts: Math.floor(startedAt / 1000),
    text: prompt
  });
  appendRollout(fixture.rolloutPath, [
    event('event_msg', { type: 'task_started', turn_id: 'turn-new' }),
    event('turn_context', { turn_id: 'turn-new', cwd: fixture.cwd }),
    event('event_msg', { type: 'user_message', message: prompt }),
    event('event_msg', {
      type: 'agent_message',
      phase: 'commentary',
      message: progress
    }),
    event('event_msg', {
      type: 'agent_message',
      phase: 'final_answer',
      message: finalText
    }),
    event('event_msg', {
      type: 'task_complete',
      turn_id: 'turn-new',
      last_agent_message: finalText
    })
  ]);

  await waitUntil(() => events.some((event) => event.type === 'turn_complete'));
  const allText = events.map((event) => event.text || event.finalText || '').join('\n');
  assert.match(allText, /只发送 resume 后的新进度/);
  assert.match(allText, /只发送 resume 后的新最终答案/);
  assert.doesNotMatch(allText, /第一次任务的旧进度|第一次任务的旧最终答案/);
  assert.equal(events.find((event) => event.type === 'bound').turnId, 'turn-new');
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-rollout-'));
  const codexHome = path.join(root, '.codex');
  const cwd = path.join(root, 'project');
  const sessionId = '019fb235-8fe9-70c0-bb29-92871d7d9165';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '30');
  const historyPath = path.join(codexHome, 'history.jsonl');
  const rolloutPath = path.join(
    sessionDir,
    `rollout-2026-07-30T08-48-02-${sessionId}.jsonl`
  );
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(historyPath, '');
  fs.writeFileSync(rolloutPath, `${JSON.stringify({
    timestamp: new Date(Date.now() - 120000).toISOString(),
    type: 'session_meta',
    payload: {
      id: sessionId,
      cwd,
      cli_version: '0.142.5',
      source: 'cli',
      originator: 'codex-tui'
    }
  })}\n`);
  return { root, codexHome, cwd, sessionId, historyPath, rolloutPath };
}

function createReader(codexHome) {
  return new CodexRolloutReader({
    codexHome,
    pollIntervalMs: 5,
    bindTimeoutMs: 1000,
    turnTimeoutMs: 2000,
    logger: {
      event() {},
      warn() {}
    }
  });
}

function appendRollout(filePath, records) {
  fs.appendFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

function appendJson(filePath, record) {
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

function event(type, payload) {
  return eventAt(new Date().toISOString(), type, payload);
}

function eventAt(timestamp, type, payload) {
  return { timestamp, type, payload };
}

async function waitUntil(predicate, timeoutMs = 1500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await wait(5);
  }
  throw new Error('Timed out waiting for rollout event.');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
