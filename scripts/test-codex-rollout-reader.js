#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CodexRolloutReader,
  extractEscalatedExecRequests,
  parseAllowedExecPrefixes,
  parseRolloutAuthorizationRequest
} = require('../src/codexRolloutReader');

async function main() {
  await testBindsNextUnknownPrompt();
  await testBindsCodex0147ResponseItemUserPrompt();
  await testGoalCommandBindsStructuredGoalTurn();
  await testGoalResumeBindsNextStructuredGoalTurn();
  await testIncrementalRolloutEventsAreSemanticAndOrdered();
  await testAuthorizationEventsComeFromStructuredRolloutRecords();
  await testResumeAppendsWithoutReplayingPreviousTurns();
  await testRecentIdenticalPromptDoesNotBindPreviousTurn();
  await testQueuedIdenticalPromptsBindInOrder();
  await testNextTaskBoundaryCannotLeakIntoBoundTurn();
  console.log('Codex rollout reader tests passed.');
}

async function testBindsCodex0147ResponseItemUserPrompt() {
  const fixture = createFixture();
  const startedAt = Date.now();
  const prompt = '检查新版本 rollout 绑定';
  const turnId = 'turn-codex-0147';
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
    event('event_msg', { type: 'task_started', turn_id: turnId }),
    event('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>fixture</environment_context>' }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId }
    }),
    event('turn_context', { turn_id: turnId, cwd: fixture.cwd }),
    responseItemUserMessage(turnId, prompt),
    responseItemAssistantMessage(turnId, 'commentary', '正在处理新格式任务。'),
    responseItemAssistantMessage(turnId, 'final_answer', '新格式绑定成功。'),
    event('event_msg', {
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: '新格式绑定成功。'
    })
  ]);

  await waitUntil(() => (
    events.some((entry) => entry.type === 'turn_complete') || errors.length > 0
  ));
  assert.deepEqual(errors, []);
  assert.equal(events.find((entry) => entry.type === 'bound').turnId, turnId);
  assert.equal(
    events.find((entry) => entry.type === 'progress').text,
    '正在处理新格式任务。'
  );
  assert.equal(events.find((entry) => entry.type === 'final').text, '新格式绑定成功。');
  reader.stopAll();
}

async function testGoalCommandBindsStructuredGoalTurn() {
  const fixture = createFixture();
  const startedAt = Date.now();
  const command = '/goal 将 IMU 策略移植到 Elevator-LIO';
  const objective = '将 IMU 策略移植到 Elevator-LIO';
  const turnId = 'turn-goal-create';
  const events = [];
  const reader = createReader(fixture.codexHome);
  reader.beginTurn({
    prompt: 'local terminal placeholder',
    matchNextPrompt: true,
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
    text: command
  });
  appendRollout(fixture.rolloutPath, [
    event('event_msg', { type: 'task_started', turn_id: turnId }),
    event('turn_context', { turn_id: turnId, cwd: fixture.cwd }),
    goalContextEvent(turnId, objective),
    responseItemAssistantMessage(
      turnId,
      'commentary',
      '已经从 goal 结构化记录绑定当前任务。'
    ),
    responseItemAssistantMessage(turnId, 'final_answer', 'Goal 任务处理完成。'),
    event('event_msg', {
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: 'Goal 任务处理完成。'
    })
  ]);

  await waitUntil(() => events.some((entry) => entry.type === 'turn_complete'));
  assert.equal(events.find((entry) => entry.type === 'bound').prompt, command);
  assert.equal(events.find((entry) => entry.type === 'bound').turnId, turnId);
  assert.equal(
    events.find((entry) => entry.type === 'progress').text,
    '已经从 goal 结构化记录绑定当前任务。'
  );
  assert.equal(events.find((entry) => entry.type === 'final').text, 'Goal 任务处理完成。');
  reader.stopAll();
}

async function testGoalResumeBindsNextStructuredGoalTurn() {
  const fixture = createFixture();
  const startedAt = Date.now();
  const oldAt = new Date(startedAt - 1000).toISOString();
  const turnId = 'turn-goal-resume';
  const events = [];
  appendRollout(fixture.rolloutPath, [
    eventAt(oldAt, 'event_msg', { type: 'task_started', turn_id: 'turn-old-goal' }),
    eventAt(oldAt, 'turn_context', { turn_id: 'turn-old-goal', cwd: fixture.cwd }),
    goalContextEvent('turn-old-goal', '不应重放的旧 goal', oldAt),
    responseItemAssistantMessage(
      'turn-old-goal',
      'final_answer',
      '不应重放的旧 goal 答案',
      oldAt
    ),
    eventAt(oldAt, 'event_msg', {
      type: 'task_complete',
      turn_id: 'turn-old-goal',
      last_agent_message: '不应重放的旧 goal 答案'
    })
  ]);

  const reader = createReader(fixture.codexHome);
  reader.beginTurn({
    prompt: '/goal resume',
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
    text: '/goal resume'
  });
  appendRollout(fixture.rolloutPath, [
    event('event_msg', { type: 'task_started', turn_id: turnId }),
    event('turn_context', { turn_id: turnId, cwd: fixture.cwd }),
    goalContextEvent(turnId, '继续执行的 goal'),
    responseItemAssistantMessage(
      turnId,
      'final_answer',
      '只返回当前 goal 续执的答案。'
    ),
    event('event_msg', {
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: '只返回当前 goal 续执的答案。'
    })
  ]);

  await waitUntil(() => events.some((entry) => entry.type === 'turn_complete'));
  assert.equal(events.find((entry) => entry.type === 'bound').turnId, turnId);
  assert.equal(
    events.find((entry) => entry.type === 'final').text,
    '只返回当前 goal 续执的答案。'
  );
  assert.doesNotMatch(JSON.stringify(events), /不应重放/);
  reader.stopAll();
}

async function testAuthorizationEventsComeFromStructuredRolloutRecords() {
  const fixture = createFixture();
  const rulesDir = path.join(fixture.codexHome, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(
    path.join(rulesDir, 'default.rules'),
    [
      'prefix_rule(pattern=["git", "tag"], decision="allow")',
      'prefix_rule(pattern=["lark-cli", "apps"], decision="allow")'
    ].join('\n') + '\n'
  );
  const prompt = '连续执行两个需要授权的操作';
  const startedAt = Date.now();
  const turnId = 'turn-authorization';
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
    event('event_msg', { type: 'task_started', turn_id: turnId }),
    event('turn_context', { turn_id: turnId, cwd: fixture.cwd }),
    responseItemUserMessage(turnId, prompt)
  ]);
  await waitUntil(() => events.some((entry) => entry.type === 'bound'));

  const firstRequest = event('response_item', {
    type: 'custom_tool_call',
    name: 'exec',
    call_id: 'call-authorization-first',
    input: [
      'const r = await tools.exec_command({',
      '  cmd: "sudo -n /usr/bin/true",',
      `  workdir: ${JSON.stringify(fixture.cwd)},`,
      '  sandbox_permissions: "require_escalated",',
      '  justification: "验证第一项授权"',
      '});',
      'text(r.output);'
    ].join('\n'),
    internal_chat_message_metadata_passthrough: { turn_id: turnId }
  });
  const secondRequest = event('response_item', {
    type: 'custom_tool_call',
    name: 'exec',
    call_id: 'call-authorization-second',
    input: [
      'const r = await tools.exec_command({',
      '  cmd: "xdotool windowactivate 42",',
      `  workdir: ${JSON.stringify(fixture.cwd)},`,
      '  sandbox_permissions: "require_escalated",',
      '  justification: "验证第二项授权"',
      '});',
      'text(r.output);'
    ].join('\n'),
    internal_chat_message_metadata_passthrough: { turn_id: turnId }
  });
  const automaticallyAllowedRequest = event('response_item', {
    type: 'custom_tool_call',
    name: 'exec',
    call_id: 'call-automatically-allowed',
    input: [
      'const r = await tools.exec_command({',
      '  cmd: "git tag --list",',
      `  workdir: ${JSON.stringify(fixture.cwd)},`,
      '  sandbox_permissions: "require_escalated",',
      '  justification: "该操作已被本地规则放行",',
      '  prefix_rule: ["git", "tag"]',
      '});',
      'text(r.output);'
    ].join('\n'),
    internal_chat_message_metadata_passthrough: { turn_id: turnId }
  });
  const jsonSerializedRequest = event('response_item', {
    type: 'custom_tool_call',
    name: 'exec',
    call_id: 'call-authorization-json-properties',
    input: 'const r = await tools.exec_command({' + [
      '"cmd":".venv-demo/bin/python -m pip install gradio==5.17.1 einops"',
      `"workdir":${JSON.stringify(fixture.cwd)}`,
      '"yield_time_ms":30000',
      '"sandbox_permissions":"require_escalated"',
      '"justification":"是否允许联网下载缺失依赖？"',
      '"prefix_rule":[".venv-demo/bin/python","-m","pip","install"]'
    ].join(',') + '}); text(r.output);\n',
    internal_chat_message_metadata_passthrough: { turn_id: turnId }
  });
  const envPrefixedRequest = event('response_item', {
    type: 'custom_tool_call',
    name: 'exec',
    call_id: 'call-env-prefixed-authorization',
    input: 'const r = await tools.exec_command({' + [
      '"cmd":"LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 lark-cli apps +create --name \\\"轻松小游戏\\\""',
      `"workdir":${JSON.stringify(fixture.cwd)}`,
      '"yield_time_ms":30000',
      '"sandbox_permissions":"require_escalated"',
      '"justification":"是否允许连接飞书妙搭服务，创建并发布这个小游戏？"',
      '"prefix_rule":["lark-cli","apps"]'
    ].join(',') + '}); text(JSON.stringify(r));\n',
    internal_chat_message_metadata_passthrough: { turn_id: turnId }
  });
  appendRollout(fixture.rolloutPath, [
    firstRequest,
    firstRequest,
    event('response_item', {
      type: 'custom_tool_call_output',
      call_id: 'call-authorization-first',
      output: [{ type: 'input_text', text: 'ok' }]
    }),
    event('response_item', {
      type: 'custom_tool_call_output',
      call_id: 'call-authorization-first',
      output: [{ type: 'input_text', text: 'duplicate' }]
    }),
    event('response_item', {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-not-an-authorization',
      input: 'text("sandbox_permissions: require_escalated; cmd: terminal garbage");'
    }),
    automaticallyAllowedRequest,
    event('response_item', {
      type: 'custom_tool_call_output',
      call_id: 'call-automatically-allowed',
      output: [{ type: 'input_text', text: 'auto approved' }]
    }),
    secondRequest,
    event('response_item', {
      type: 'custom_tool_call_output',
      call_id: 'call-authorization-second',
      output: [{ type: 'input_text', text: 'ok' }]
    }),
    envPrefixedRequest,
    event('response_item', {
      type: 'custom_tool_call_output',
      call_id: 'call-env-prefixed-authorization',
      output: 'aborted by user after 61.1s'
    }),
    jsonSerializedRequest,
    event('response_item', {
      type: 'custom_tool_call_output',
      call_id: 'call-authorization-json-properties',
      output: [{ type: 'input_text', text: 'ok' }]
    }),
    responseItemAssistantMessage(turnId, 'final_answer', '两个操作均已处理。'),
    event('event_msg', {
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: '两个操作均已处理。'
    })
  ]);

  await waitUntil(() => events.some((entry) => entry.type === 'turn_complete'));
  assert.deepEqual(
    events
      .filter((entry) => entry.type === 'authorization_requested')
      .map((entry) => entry.callId),
    [
      'call-authorization-first',
      'call-authorization-second',
      'call-env-prefixed-authorization',
      'call-authorization-json-properties'
    ]
  );
  assert.deepEqual(
    events
      .filter((entry) => entry.type === 'authorization_completed')
      .map((entry) => entry.callId),
    [
      'call-authorization-first',
      'call-authorization-second',
      'call-env-prefixed-authorization',
      'call-authorization-json-properties'
    ]
  );
  const approvals = events
    .filter((entry) => entry.type === 'authorization_requested')
    .map((entry) => entry.approval);
  assert.equal(approvals[0].source, 'rollout_jsonl');
  assert.equal(approvals[0].command, 'sudo -n /usr/bin/true');
  assert.equal(approvals[0].reason, 'Reason: 验证第一项授权');
  assert.deepEqual(
    approvals[0].options.map((option) => option.action),
    ['approve', 'deny'],
    'commands without a reusable prefix rule must expose only allow and deny'
  );
  assert.equal(approvals[1].command, 'xdotool windowactivate 42');
  assert.deepEqual(
    approvals[1].options.map((option) => option.action),
    ['approve', 'deny']
  );
  assert.equal(
    approvals[2].command,
    'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 lark-cli apps +create --name "轻松小游戏"'
  );
  assert.equal(
    approvals[2].reason,
    'Reason: 是否允许连接飞书妙搭服务，创建并发布这个小游戏？'
  );
  assert.deepEqual(
    approvals[2].options.map((option) => option.action),
    ['approve', 'approve_persistent', 'deny'],
    'an environment-prefixed command still needs authorization when Codex does not apply the stored command prefix'
  );
  assert.equal(
    approvals[3].command,
    '.venv-demo/bin/python -m pip install gradio==5.17.1 einops'
  );
  assert.equal(approvals[3].reason, 'Reason: 是否允许联网下载缺失依赖？');
  assert.deepEqual(
    approvals[3].options.map((option) => option.action),
    ['approve', 'approve_persistent', 'deny'],
    'a reusable prefix rule enables the persistent approval option'
  );
  assert.doesNotMatch(JSON.stringify(approvals), /terminal garbage|�|\u0000/);

  assert.deepEqual(
    extractEscalatedExecRequests(firstRequest.payload.input),
    [{ command: 'sudo -n /usr/bin/true', justification: '验证第一项授权' }]
  );
  assert.deepEqual(
    extractEscalatedExecRequests(automaticallyAllowedRequest.payload.input),
    [{
      command: 'git tag --list',
      justification: '该操作已被本地规则放行',
      prefixRule: ['git', 'tag']
    }]
  );
  assert.deepEqual(
    extractEscalatedExecRequests(jsonSerializedRequest.payload.input),
    [{
      command: '.venv-demo/bin/python -m pip install gradio==5.17.1 einops',
      justification: '是否允许联网下载缺失依赖？',
      prefixRule: ['.venv-demo/bin/python', '-m', 'pip', 'install']
    }],
    'current Codex JSON-serialized tool arguments must trigger authorization'
  );
  assert.deepEqual(
    parseAllowedExecPrefixes([
      'prefix_rule(pattern=["git", "tag"], decision="allow")',
      'prefix_rule(pattern=["sudo", "blocked"], decision="deny")'
    ].join('\n')),
    [['git', 'tag']]
  );
  assert.deepEqual(
    extractEscalatedExecRequests(String.raw`tools.exec_command({
      cmd: "sudo \u4f60\u597d",
      sandbox_permissions: "require_escalated",
      justification: "\u5141\u8bb8"
    });`),
    [{ command: 'sudo 你好', justification: '允许' }]
  );
  assert.deepEqual(
    extractEscalatedExecRequests(
      'tools.exec_command({ justification: "🧪 验证", cmd: "sudo true", sandbox_permissions: "require_escalated" });'
    ),
    [{ command: 'sudo true', justification: '🧪 验证' }]
  );
  assert.equal(parseRolloutAuthorizationRequest({
    type: 'custom_tool_call',
    name: 'exec',
    call_id: 'call-safe',
    input: 'text("sandbox_permissions: require_escalated");'
  }), null);
  reader.stopAll();
}

async function testBindsNextUnknownPrompt() {
  const fixture = createFixture();
  const events = [];
  const reader = createReader(fixture.codexHome);
  const terminalNoise = '\u001b]10;rgb:e8e8/eded/f2f2\u001b\\'.repeat(6);
  reader.beginTurn({
    prompt: terminalNoise,
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
    type: 'task_started',
    turn_id: 'turn-next'
  }));
  appendJson(fixture.rolloutPath, event('turn_context', {
    turn_id: 'turn-next',
    cwd: fixture.cwd
  }));
  appendJson(fixture.rolloutPath, responseItemUserMessage('turn-next', prompt));
  appendJson(
    fixture.rolloutPath,
    responseItemAssistantMessage('turn-next', 'final_answer', 'Review completed.')
  );
  appendJson(fixture.rolloutPath, event('event_msg', {
    type: 'task_complete',
    turn_id: 'turn-next',
    last_agent_message: 'Review completed.'
  }));

  await waitUntil(() => events.some((entry) => entry.type === 'turn_complete'));
  assert.equal(events.find((entry) => entry.type === 'bound').prompt, prompt);
  assert.doesNotMatch(
    JSON.stringify(events),
    /rgb:e8e8|\]10;/,
    'matchNextPrompt must replace terminal input noise with history.jsonl text'
  );
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
    responseItemUserMessage(
      'turn-queued-first',
      prompt,
      new Date(firstAt).toISOString()
    ),
    responseItemAssistantMessage(
      'turn-queued-first',
      'final_answer',
      '第一个排队答案',
      new Date(firstAt).toISOString()
    ),
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
    responseItemUserMessage(
      'turn-queued-second',
      prompt,
      new Date(secondAt).toISOString()
    ),
    responseItemAssistantMessage(
      'turn-queued-second',
      'final_answer',
      '第二个排队答案',
      new Date(secondAt).toISOString()
    ),
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
    responseItemUserMessage('turn-incomplete', prompt)
  ]);
  await waitUntil(() => events.some((event) => event.type === 'bound'));

  appendRollout(fixture.rolloutPath, [
    event('event_msg', { type: 'task_started', turn_id: 'turn-next' }),
    responseItemAssistantMessage(
      'turn-next',
      'final_answer',
      '下一任务的内容绝不能泄漏'
    )
  ]);
  await waitUntil(() => errors.length === 1);
  assert.match(errors[0].message, /new rollout task started/i);
  assert.equal(errors[0].code, 'CODEX_ROLLOUT_TURN_REPLACED');
  assert.equal(errors[0].turnId, 'turn-incomplete');
  assert.equal(errors[0].nextTurnId, 'turn-next');
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
    responseItemUserMessage('turn-recent-old', prompt, oldAt),
    responseItemAssistantMessage(
      'turn-recent-old',
      'final_answer',
      '不应绑定的最近旧答案',
      oldAt
    ),
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
    responseItemUserMessage('turn-current-repeat', prompt),
    responseItemAssistantMessage(
      'turn-current-repeat',
      'final_answer',
      '当前重复任务答案'
    ),
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
    responseItemUserMessage(turnId, prompt)
  ]);

  await waitUntil(() => events.some((event) => event.type === 'bound'));

  const first = '第一段来自 commentary，不经过终端解析。';
  const second = '第二段保留换行：\n\n- 项目文件：69\n- 代码行数：23,212';
  const firstRecord = responseItemAssistantMessage(turnId, 'commentary', first);
  firstRecord.payload.id = 'message-commentary-first';
  appendRollout(fixture.rolloutPath, [
    firstRecord,
    firstRecord
  ]);

  const partialRecord = Buffer.from(JSON.stringify(
    responseItemAssistantMessage(turnId, 'commentary', second)
  ), 'utf8');
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
    responseItemAssistantMessage(turnId, 'final_answer', finalText),
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
    responseItemUserMessage('turn-old', firstPrompt, oldAt),
    responseItemAssistantMessage('turn-old', 'commentary', firstProgress, oldAt),
    responseItemAssistantMessage('turn-old', 'final_answer', firstFinal, oldAt),
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
    responseItemUserMessage('turn-new', prompt),
    responseItemAssistantMessage('turn-new', 'commentary', progress),
    responseItemAssistantMessage('turn-new', 'final_answer', finalText),
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
      cli_version: '0.147.0',
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

function goalContextEvent(turnId, objective, timestamp = new Date().toISOString()) {
  return eventAt(timestamp, 'response_item', {
    type: 'message',
    role: 'user',
    content: [{
      type: 'input_text',
      text: [
        '<codex_internal_context source="goal">',
        'Continue working toward the active thread goal.',
        '',
        '<objective>',
        objective,
        '</objective>',
        '',
        '</codex_internal_context>'
      ].join('\n')
    }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId }
  });
}

function responseItemUserMessage(turnId, text, timestamp = new Date().toISOString()) {
  return eventAt(timestamp, 'response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId }
  });
}

function responseItemAssistantMessage(
  turnId,
  phase,
  text,
  timestamp = new Date().toISOString()
) {
  return eventAt(timestamp, 'response_item', {
    type: 'message',
    role: 'assistant',
    phase,
    content: [{ type: 'output_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId }
  });
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
