#!/usr/bin/env node

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeConfig } = require('../src/config');
const { RemoteSessionController } = require('../src/remoteSessionController');
const feishuPlugin = require('../src/plugins/feishu');

async function main() {
  testSingleCardConfigOverridesLegacyMultiCardValues();
  await testSingleCardRolloutEventsProduceExactOrderedUpdates();
  await testFinalFileDirectiveUploadsFileAndStaysOutOfCard();
  await testFileUploadPermissionIsAppliedAndRetried();
  await testInvalidFinalFileDirectiveIsReportedOnOriginalCard();
  await testFileUploadFailureIsReportedOnOriginalCard();
  await testApprovalSnapshotUpdatesOriginalCardImmediately();
  await testConsecutiveRolloutApprovalsIgnoreTerminalGarbage();
  await testTerminalRepaintsCannotBecomeRemoteMessages();
  await testResumeGenerationCannotReplayPreviousTurn();
  await testCardKitStreamingUsesRolloutSegmentsAndFinalOnly();
  await testFinalCardRecoversFromContentUpdateFailureWithoutFallbackCard();
  await testPermanentCloseFailureDoesNotCreateFallbackCard();
  await testRolloutBindingFailureDoesNotFallBackToTerminalText();
  await testStreamingBindingFailureClosesOriginalCard();
  await testCodexExitStopsRolloutAndRejectsLateEvents();
  console.log('Feishu rollout JSONL turn simulation tests passed.');
}

async function testFinalFileDirectiveUploadsFileAndStaysOutOfCard() {
  const harness = createHarness();
  const finalText = [
    '测试报告已经生成。',
    '',
    `[[remote-codex-file:${__filename}]]`
  ].join('\n');
  await harness.plugin.handleReceiveMessage(
    feishuMessage('生成测试报告并发送文件', 'om_file_success')
  );
  const turn = harness.rolloutReader.latest();
  turn.emit(boundEvent('session-file-success', 'turn-file-success'));
  turn.emit({ type: 'turn_started', turnId: 'turn-file-success' });
  turn.emit({ type: 'final', text: finalText });
  turn.emit({ type: 'turn_complete', turnId: 'turn-file-success', finalText });
  await waitUntil(() => harness.closes.length === 1 && harness.fileMessages.length === 1);

  const closed = parseClosedStreamingCard(harness.closes[0]);
  assert.equal(streamingCardMarkdown(closed), '测试报告已经生成。');
  assert.equal(closed.header.template, 'green');
  assert.doesNotMatch(streamingCardMarkdown(closed), /remote-codex-file/);
  assert.equal(harness.fileUploads.length, 1);
  assert.equal(harness.fileUploads[0].data.file_type, 'stream');
  assert.equal(harness.fileUploads[0].data.file_name, path.basename(__filename));
  assert.equal(path.resolve(harness.fileUploads[0].data.file.path), path.resolve(__filename));
  assert.equal(harness.fileMessages[0].data.msg_type, 'file');
  assert.deepEqual(JSON.parse(harness.fileMessages[0].data.content), {
    file_key: 'file_test_key'
  });
  assert.equal(harness.cardMessages.length, 1);
  assert.equal(harness.textFallbacks.length, 0);
  assert.deepEqual(harness.deliveryEvents, [
    'card_create',
    'card_message',
    'file_upload',
    'file_message',
    'card_close'
  ]);
  cleanupHarness(harness);
}

async function testFileUploadPermissionIsAppliedAndRetried() {
  const harness = createHarness({ failFilePermissionOnce: true });
  const finalText = [
    '权限补齐后发送文件。',
    `[[remote-codex-file:${__filename}]]`
  ].join('\n');
  await harness.plugin.handleReceiveMessage(
    feishuMessage('模拟文件权限首次缺失', 'om_file_permission')
  );
  const turn = harness.rolloutReader.latest();
  turn.emit(boundEvent('session-file-permission', 'turn-file-permission'));
  turn.emit({ type: 'turn_started', turnId: 'turn-file-permission' });
  turn.emit({ type: 'final', text: finalText });
  turn.emit({ type: 'turn_complete', turnId: 'turn-file-permission', finalText });
  await waitUntil(() => harness.closes.length === 1 && harness.fileMessages.length === 1);

  const closed = parseClosedStreamingCard(harness.closes[0]);
  assert.equal(streamingCardMarkdown(closed), '权限补齐后发送文件。');
  assert.equal(closed.header.template, 'green');
  assert.equal(harness.fileUploads.length, 2);
  assert.equal(harness.scopeApplies.length, 1);
  assert.equal(harness.fileMessages.length, 1);
  cleanupHarness(harness);
}

async function testInvalidFinalFileDirectiveIsReportedOnOriginalCard() {
  const outsidePath = path.join(os.tmpdir(), `remote-codex-outside-${process.pid}.txt`);
  fs.writeFileSync(outsidePath, 'outside workspace\n');
  const harness = createHarness();
  const finalText = [
    '文件处理完成。',
    `[[remote-codex-file:${outsidePath}]]`
  ].join('\n');

  try {
    await harness.plugin.handleReceiveMessage(
      feishuMessage('发送工作区外文件', 'om_file_outside')
    );
    const turn = harness.rolloutReader.latest();
    turn.emit(boundEvent('session-file-outside', 'turn-file-outside'));
    turn.emit({ type: 'turn_started', turnId: 'turn-file-outside' });
    turn.emit({ type: 'final', text: finalText });
    turn.emit({ type: 'turn_complete', turnId: 'turn-file-outside', finalText });
    await waitUntil(() => harness.closes.length === 1);

    const closed = parseClosedStreamingCard(harness.closes[0]);
    const closedText = streamingCardMarkdown(closed);
    assert.match(closedText, /\*\*文件未发送\*\*/);
    assert.match(closedText, /只允许发送当前 Codex 工作目录内的文件/);
    assert.doesNotMatch(closedText, /remote-codex-file/);
    assert.doesNotMatch(closedText, new RegExp(escapeRegExp(outsidePath)));
    assert.equal(closed.header.template, 'orange');
    assert.equal(closed.header.subtitle.content, '已完成，文件未全部发送');
    assert.equal(harness.fileUploads.length, 0);
    assert.equal(harness.fileMessages.length, 0);
    assert.equal(harness.cardMessages.length, 1);
  } finally {
    cleanupHarness(harness);
    fs.rmSync(outsidePath, { force: true });
  }
}

async function testFileUploadFailureIsReportedOnOriginalCard() {
  const harness = createHarness({ failFileUpload: true });
  const finalText = [
    '文件已经生成。',
    `[[remote-codex-file:${__filename}]]`
  ].join('\n');
  await harness.plugin.handleReceiveMessage(
    feishuMessage('模拟飞书文件上传失败', 'om_file_upload_failure')
  );
  const turn = harness.rolloutReader.latest();
  turn.emit(boundEvent('session-file-failure', 'turn-file-failure'));
  turn.emit({ type: 'turn_started', turnId: 'turn-file-failure' });
  turn.emit({ type: 'final', text: finalText });
  turn.emit({ type: 'turn_complete', turnId: 'turn-file-failure', finalText });
  await waitUntil(() => harness.closes.length === 1);

  const closed = parseClosedStreamingCard(harness.closes[0]);
  const closedText = streamingCardMarkdown(closed);
  assert.match(closedText, /\*\*文件未发送\*\*/);
  assert.match(closedText, /simulated file upload failure/);
  assert.doesNotMatch(closedText, /remote-codex-file/);
  assert.equal(closed.header.template, 'orange');
  assert.equal(closed.header.subtitle.content, '已完成，文件未全部发送');
  assert.equal(harness.fileUploads.length, 1);
  assert.equal(harness.fileMessages.length, 0);
  assert.equal(harness.cardMessages.length, 1);
  assert.equal(harness.textFallbacks.length, 0);
  cleanupHarness(harness);
}

async function testPermanentCloseFailureDoesNotCreateFallbackCard() {
  const harness = createHarness({ failCloseAttempts: 2 });
  const finalText = '整卡收尾失败时仍不得补发第二张卡。';
  await harness.plugin.handleReceiveMessage(
    feishuMessage('模拟 CardKit 整卡收尾持续失败', 'om_close_failure')
  );
  const turn = harness.rolloutReader.latest();
  turn.emit(boundEvent('session-close-failure', 'turn-close-failure'));
  turn.emit({ type: 'turn_started', turnId: 'turn-close-failure' });
  turn.emit({ type: 'final', text: finalText });
  turn.emit({
    type: 'turn_complete',
    turnId: 'turn-close-failure',
    finalText
  });
  await waitUntil(() => harness.finished === 1, 2500);

  assert.equal(harness.closeRequests.length, 2);
  assert.equal(harness.closes.length, 0);
  assert.equal(harness.cardCreates.length, 1);
  assert.equal(harness.cardMessages.length, 1);
  assert.equal(harness.textFallbacks.length, 0);
  assert.equal(normalizeSentMarkdown(latestContent(harness.updates)), finalText);
  cleanupHarness(harness);
}

function testSingleCardConfigOverridesLegacyMultiCardValues() {
  const config = normalizeConfig({
    plugins: {
      feishu: {
        streaming: false,
        segmentedOutput: true
      }
    }
  }, '/tmp/remote-codex-single-card-test.json');
  assert.equal(config.plugins.feishu.singleCardOutput, true);
  assert.equal(config.plugins.feishu.streaming, true);
  assert.equal(config.plugins.feishu.segmentedOutput, false);
  assert.equal(config.plugins.feishu.fileTransferEnabled, true);
  assert.equal(config.plugins.feishu.fileTransferMaxBytes, 30 * 1024 * 1024);
  assert.equal(config.plugins.feishu.fileTransferMaxFiles, 5);

  const legacy = normalizeConfig({
    plugins: {
      feishu: {
        singleCardOutput: false,
        streaming: false,
        segmentedOutput: true
      }
    }
  }, '/tmp/remote-codex-legacy-card-test.json');
  assert.equal(legacy.plugins.feishu.singleCardOutput, false);
  assert.equal(legacy.plugins.feishu.streaming, false);
  assert.equal(legacy.plugins.feishu.segmentedOutput, true);
}

async function testFinalCardRecoversFromContentUpdateFailureWithoutFallbackCard() {
  const harness = createHarness({ failContentUpdates: true });
  const finalText = '局部更新失败后，最终整卡更新仍然成功。';
  await harness.plugin.handleReceiveMessage(
    feishuMessage('模拟 CardKit 局部更新失败', 'om_update_failure')
  );
  const turn = harness.rolloutReader.latest();
  turn.emit(boundEvent('session-update-failure', 'turn-update-failure'));
  turn.emit({ type: 'turn_started', turnId: 'turn-update-failure' });
  turn.emit({ type: 'progress', text: '这条进度的局部更新会失败。' });
  turn.emit({ type: 'final', text: finalText });
  turn.emit({
    type: 'turn_complete',
    turnId: 'turn-update-failure',
    finalText
  });
  await waitUntil(() => harness.closes.length === 1);

  const closed = parseClosedStreamingCard(harness.closes[0]);
  assert.equal(streamingCardMarkdown(closed), finalText);
  assert.equal(closed.header.template, 'green');
  assert.equal(harness.cardCreates.length, 1);
  assert.equal(harness.cardMessages.length, 1);
  assert.equal(harness.closes.length, 1);
  assert.equal(harness.textFallbacks.length, 0);
  cleanupHarness(harness);
}

async function testCodexExitStopsRolloutAndRejectsLateEvents() {
  const harness = createHarness();
  await harness.plugin.handleReceiveMessage(
    feishuMessage('模拟 Codex 进程退出', 'om_process_exit')
  );
  const turn = harness.rolloutReader.latest();
  turn.emit(boundEvent('session-exit', 'turn-exit'));
  turn.emit({ type: 'turn_started', turnId: 'turn-exit' });
  harness.session.emit('exit', { exitCode: 1, signal: null });
  await waitUntil(() => harness.closes.length === 1);

  turn.emit({ type: 'progress', text: '退出后不应发送的迟到进度' });
  turn.emit({ type: 'final', text: '退出后不应发送的迟到最终答案' });
  turn.emit({
    type: 'turn_complete',
    turnId: 'turn-exit',
    finalText: '退出后不应发送的迟到最终答案'
  });
  await wait(30);

  const closed = parseClosedStreamingCard(harness.closes[0]);
  const text = streamingCardMarkdown(closed);
  assert.match(text, /Codex exited: code=1, signal=none/);
  assert.match(text, /不会回退到终端正文解析/);
  assert.doesNotMatch(text, /迟到进度|迟到最终答案/);
  assert.equal(harness.cardMessages.length, 1);
  assert.equal(harness.cardCreates.length, 1);
  assert.equal(harness.closes.length, 1);
  assert.equal(closed.header.template, 'red');
  assert.equal(closed.header.subtitle.content, '输出失败');
  assert.equal(turn.stopped, true);
  cleanupHarness(harness);
}

async function testStreamingBindingFailureClosesOriginalCard() {
  const harness = createHarness({ streaming: true, segmentedOutput: false });
  await harness.plugin.handleReceiveMessage(
    feishuMessage('模拟流式 JSONL 绑定失败', 'om_stream_failure')
  );
  await waitUntil(() => harness.cardCreates.length === 1);
  harness.rolloutReader.latest().fail(new Error('rollout bind timeout'));
  await waitUntil(() => harness.closes.some((item) => item.method === 'PUT'), 2000);

  const closed = parseClosedStreamingCard(
    harness.closes.find((item) => item.method === 'PUT')
  );
  const text = normalizeSentMarkdown(
    String(closed.body?.elements?.find((element) => element.tag === 'markdown')?.content || '')
  );
  assert.match(text, /无法绑定当前 Codex 的结构化 JSONL 输出/);
  assert.match(text, /不会回退到终端正文解析/);
  assert.equal(closed.header.template, 'red');
  assert.equal(closed.header.subtitle.content, '输出失败');
  assert.equal(harness.cardMessages.length, 1);
  assert.equal(harness.textFallbacks.length, 0);
  cleanupHarness(harness);
}

async function testSingleCardRolloutEventsProduceExactOrderedUpdates() {
  const harness = createHarness();
  const prompt = '检查当前项目有多少文件多少行代码';
  const first = '我先按仓库视角统计当前项目文件。';
  const second = [
    '统计工具不可用，我改用本地文件列表。',
    '',
    '- 排除 `.git`',
    '- 排除 `node_modules`'
  ].join('\n');
  const finalText = [
    '按当前工作区统计结果：',
    '',
    '- 当前可见项目文件：69 个',
    '- 代码文件：56 个',
    '- 代码行数：23,212 行',
    '',
    '```text',
    '源码统计保持原始换行',
    '最终卡片不得折叠列表',
    '```'
  ].join('\n');

  await harness.plugin.handleReceiveMessage(feishuMessage(prompt));
  await waitUntil(() => harness.cardCreates.length === 1);
  assert.match(harness.session.writes[0], new RegExp(escapeRegExp(prompt)));
  const initialCard = parseCreatedStreamingCard(harness.cardCreates[0]);
  assert.equal(initialCard.schema, '2.0');
  assert.equal(initialCard.header.template, 'blue');
  assert.equal(initialCard.header.subtitle.content, '正在处理');
  assert.match(streamingCardMarkdown(initialCard), /正在等待 Codex 输出/);

  const turn = harness.rolloutReader.latest();
  turn.emit(boundEvent('session-jsonl', 'turn-jsonl'));
  turn.emit({ type: 'turn_started', turnId: 'turn-jsonl' });
  turn.emit({ type: 'progress', text: first });
  turn.emit({ type: 'progress', text: second });
  await waitUntil(() => harness.updates.length >= 2);
  assert.equal(
    normalizeSentMarkdown(latestContent(harness.updates)),
    normalizeSentMarkdown(`${first}\n\n${second}`)
  );

  turn.emit({ type: 'final', text: finalText });
  turn.emit({ type: 'turn_complete', turnId: 'turn-jsonl', finalText });
  await waitUntil(() => harness.closes.length === 1);

  const closed = parseClosedStreamingCard(harness.closes[0]);
  assert.equal(closed.header.template, 'green');
  assert.equal(closed.header.subtitle.content, '已完成');
  assert.equal(streamingCardMarkdown(closed), finalText);
  assert.doesNotMatch(streamingCardMarkdown(closed), /仓库视角|统计工具不可用/);
  assert.equal(harness.cardCreates.length, 1);
  assert.equal(harness.cardMessages.length, 1);
  assert.equal(harness.closes.length, 1);
  assert.equal(harness.textFallbacks.length, 0);
  assert.equal(harness.finished, 1);
  assert.deepEqual(
    harness.parserTraces.map((trace) => trace.reason),
    [
      'rollout_bound',
      'rollout_turn_started',
      'rollout_progress',
      'rollout_progress',
      'rollout_final',
      'rollout_turn_complete'
    ]
  );
  assert.ok(harness.parserTraces.every((trace) => trace.source === 'rollout_jsonl'));
  assert.equal(
    Buffer.from(harness.parserTraces[2].rollout.textBase64, 'base64').toString('utf8'),
    first
  );
  assert.equal(
    Buffer.from(harness.parserTraces[4].outputs.formattedBase64, 'base64').toString('utf8'),
    finalText
  );
  cleanupHarness(harness);
}

async function testTerminalRepaintsCannotBecomeRemoteMessages() {
  const harness = createHarness();
  const prompt = '只允许 JSONL 事件输出';
  await harness.plugin.handleReceiveMessage(feishuMessage(prompt, 'om_terminal_noise'));
  await waitUntil(() => harness.session.writes.length === 1);

  harness.session.emitOutput({
    data: 'Booting MC•ooting MCP : codex_ap codex_apps ingng Working•orking•rking',
    snapshot: [
      `› ${prompt}`,
      'Booting MC•ooting MCP',
      ': codex_ap codex_appcodex_apps',
      'king6ing•ngg7WWo•Wor•WorkWorking'
    ].join('\n')
  });
  await wait(30);
  assert.equal(harness.cardMessages.length, 1);
  assert.equal(harness.cardCreates.length, 1);
  assert.deepEqual(harness.updates, []);

  const turn = harness.rolloutReader.latest();
  const progress = '这是唯一允许发送的结构化进度。';
  const finalText = '这是唯一允许发送的结构化最终答案。';
  turn.emit(boundEvent('session-clean', 'turn-clean'));
  turn.emit({ type: 'turn_started', turnId: 'turn-clean' });
  turn.emit({ type: 'progress', text: progress });
  turn.emit({ type: 'final', text: finalText });
  turn.emit({ type: 'turn_complete', turnId: 'turn-clean', finalText });
  await waitUntil(() => harness.closes.length === 1);

  const all = [harness.updates.map((update) => latestContent([update])).join('\n'), streamingCardMarkdown(
    parseClosedStreamingCard(harness.closes[0])
  )].join('\n');
  assert.match(all, /唯一允许发送的结构化进度/);
  assert.match(all, /唯一允许发送的结构化最终答案/);
  assert.doesNotMatch(all, /Booting MC|codex_app|king6ing|ngg7WWo|Working•/);
  cleanupHarness(harness);
}

async function testApprovalSnapshotUpdatesOriginalCardImmediately() {
  const harness = createHarness();
  const prompt = '运行需要确认的命令';
  await harness.plugin.handleReceiveMessage(
    feishuMessage(prompt, 'om_approval_prompt')
  );
  await waitUntil(() => harness.cardCreates.length === 1);
  const firstTurn = harness.rolloutReader.latest();
  firstTurn.emit(boundEvent('session-approval', 'turn-approval'));
  firstTurn.emit({ type: 'turn_started', turnId: 'turn-approval' });
  firstTurn.emit({
    type: 'progress',
    text: '我正在验证发布流程，当前进展需要在授权后继续保留。'
  });
  await waitUntil(() => harness.updates.length >= 1);

  firstTurn.emit(authorizationRequested(
    'call-feishu-approval',
    'turn-approval',
    'npm test',
    'verify the release'
  ));

  await waitUntil(() => harness.cardReplacements.length === 1);
  const approvalCard = parseClosedStreamingCard(harness.cardReplacements[0]);
  assert.equal(approvalCard.schema, '2.0');
  assert.equal(approvalCard.header.template, 'orange');
  assert.equal(approvalCard.header.subtitle.content, '等待确认');
  const approvalMarkdown = streamingCardMarkdown(approvalCard);
  const approvalActions = streamingCardButtons(approvalCard);
  assert.match(approvalMarkdown, /verify the release/);
  assert.match(approvalMarkdown, /npm test/);
  assert.doesNotMatch(
    approvalMarkdown,
    /Would you like to run|选项|Yes|`\/approve`|Codex 正在等待/
  );
  assert.deepEqual(
    approvalActions.map((action) => buttonCallbackValue(action).remote_codex_action),
    ['approve', 'approve_persistent', 'deny']
  );
  const approvalColumnSet = approvalCard.body.elements
    .find((element) => element.tag === 'column_set');
  const approvalColumns = approvalColumnSet.columns;
  assert.equal(approvalColumnSet.flex_mode, 'flow');
  assert.deepEqual(
    approvalColumns.map((column) => [column.width, column.weight]),
    [['weighted', 1], ['weighted', 1], ['weighted', 1]]
  );
  assert.deepEqual(
    approvalActions.map((action) => [action.width, action.size]),
    [['fill', 'large'], ['fill', 'large'], ['fill', 'large']]
  );
  const approvalContext = buttonCallbackValue(approvalActions[0]).remote_codex_context;
  assert.match(approvalContext, /^[a-f0-9]{24}$/);
  assert.deepEqual(
    approvalActions.map((action) => buttonCallbackValue(action).remote_codex_context),
    [approvalContext, approvalContext, approvalContext]
  );
  assert.equal(
    approvalCard.body.elements.some((element) => element.tag === 'action'),
    false,
    'CardKit schema 2.0 must not contain the legacy action container'
  );
  assert.equal(approvalCard.config.streaming_mode, false);
  assert.equal(harness.streamingModeUpdates.length, 1);
  assert.deepEqual(
    JSON.parse(harness.streamingModeUpdates[0].body.settings),
    { config: { streaming_mode: false } }
  );
  assert.equal(harness.streamingModeUpdates[0].body.sequence, 3);
  assert.equal(harness.cardReplacements[0].body.sequence, 4);
  assert.equal(harness.cardCreates.length, 1);
  assert.equal(harness.cardMessages.length, 1);
  assert.equal(harness.textFallbacks.length, 0);

  const corruptedTerminalApproval = [
    `› ${prompt}`,
    '•ngg5WWo•Wor•WorkWorki',
    'Reason: terminal garbage must never be sent',
    '$ printf corrupted-terminal-command',
    '> 2. No'
  ].join('\n');
  harness.session.emitOutput({
    data: '•ngg5WWo•Wor•WorkWorki approval repaint',
    snapshot: corruptedTerminalApproval
  });
  await wait(30);
  assert.equal(
    harness.cardReplacements.length,
    1,
    'terminal approval text must not create or replace a rollout approval card'
  );
  assert.doesNotMatch(
    streamingCardMarkdown(parseClosedStreamingCard(harness.cardReplacements[0])),
    /terminal garbage|corrupted-terminal-command|ngg5WWo/
  );

  await harness.plugin.handleReceiveMessage(
    feishuMessage('审批期间的普通消息', 'om_during_approval')
  );
  await wait(30);
  assert.equal(harness.cardCreates.length, 1);
  assert.equal(harness.cardMessages.length, 1);

  assert.equal(harness.cardReplacements.length, 1);

  await harness.plugin.handleCardAction(
    feishuApprovalAction('approve', approvalContext)
  );
  await waitUntil(() => harness.cardReplacements.length === 2);
  await waitUntil(() => harness.session.writes.at(-1) === 'y');
  const submittedCard = parseClosedStreamingCard(harness.cardReplacements[1]);
  assert.equal(submittedCard.header.template, 'blue');
  assert.equal(
    submittedCard.body.elements.some((element) => element.tag === 'action'),
    false
  );
  const submittedMarkdown = streamingCardMarkdown(submittedCard);
  assert.match(submittedMarkdown, /verify the release/);
  assert.match(submittedMarkdown, /npm test/);
  assert.match(submittedMarkdown, /授权状态/);
  assert.match(submittedMarkdown, /Codex 正在继续执行/);
  assert.doesNotMatch(submittedMarkdown, /这张卡片已锁定|Options:|Yes|No/);
  assert.equal(harness.session.writes.at(-1), 'y');
  assert.equal(harness.cardCreates.length, 1);
  assert.equal(harness.cardMessages.length, 1);

  firstTurn.emit({
    type: 'authorization_completed',
    callId: 'call-feishu-approval',
    turnId: 'turn-approval'
  });
  await waitUntil(() => (
    harness.controller.sessions.get('feishu:oc_chat')?.pendingRolloutApproval === null
  ));

  await harness.plugin.handleReceiveMessage(
    feishuMessage('授权后立即追加的任务', 'om_after_approval')
  );
  await waitUntil(() => harness.rolloutReader.turns.length === 2);
  assert.match(harness.session.writes.at(-1), /授权后立即追加的任务/);
  await waitUntil(() => harness.closes.length === 1);
  await waitUntil(() => harness.cardCreates.length === 2);
  const handoffCard = parseClosedStreamingCard(harness.closes[0]);
  const handoffMarkdown = streamingCardMarkdown(handoffCard);
  assert.equal(handoffCard.header.template, 'blue');
  assert.match(handoffMarkdown, /当前进展需要在授权后继续保留/);
  assert.match(handoffMarkdown, /已收到后续消息/);
  assert.doesNotMatch(handoffMarkdown, /Remote Codex 输出失败|无法绑定/);

  const secondTurn = harness.rolloutReader.latest();
  secondTurn.emit(boundEvent('session-approval', 'turn-after-approval'));
  secondTurn.emit({ type: 'turn_started', turnId: 'turn-after-approval' });
  secondTurn.emit({ type: 'final', text: '追加任务已正常完成。' });
  secondTurn.emit({
    type: 'turn_complete',
    turnId: 'turn-after-approval',
    finalText: '追加任务已正常完成。'
  });
  await waitUntil(() => harness.closes.length === 2);
  assert.equal(
    streamingCardMarkdown(parseClosedStreamingCard(harness.closes[1])),
    '追加任务已正常完成。'
  );
  cleanupHarness(harness);
}

async function testConsecutiveRolloutApprovalsIgnoreTerminalGarbage() {
  const harness = createHarness();
  const prompt = '连续授权回归';
  await harness.plugin.handleReceiveMessage(
    feishuMessage(prompt, 'om_consecutive_approvals')
  );
  await waitUntil(() => harness.cardCreates.length === 1);
  const turn = harness.rolloutReader.latest();
  turn.emit(boundEvent('session-consecutive', 'turn-consecutive'));
  turn.emit({ type: 'turn_started', turnId: 'turn-consecutive' });

  turn.emit(authorizationRequested(
    'call-consecutive-first',
    'turn-consecutive',
    'sudo -n /usr/bin/true',
    'first clean approval'
  ));
  await waitUntil(() => harness.cardReplacements.length === 1);
  const firstCard = parseClosedStreamingCard(harness.cardReplacements[0]);
  const firstContext = buttonCallbackValue(streamingCardButtons(firstCard)[0])
    .remote_codex_context;
  assert.match(streamingCardMarkdown(firstCard), /first clean approval/);
  assert.match(streamingCardMarkdown(firstCard), /sudo -n \/usr\/bin\/true/);

  harness.session.emitOutput({
    data: '•ngg5WWo•Wor•WorkWorki',
    snapshot: [
      'Would you like to run?',
      'Reason: corrupted repaint',
      '$ terminal-corrupted-command'
    ].join('\n')
  });
  await wait(30);
  assert.equal(harness.cardReplacements.length, 1);

  turn.emit({
    type: 'authorization_completed',
    callId: 'call-consecutive-first',
    turnId: 'turn-consecutive'
  });
  turn.emit(authorizationRequested(
    'call-consecutive-second',
    'turn-consecutive',
    'xdotool windowactivate 42',
    'second clean approval'
  ));
  await waitUntil(() => harness.cardReplacements.length === 2);

  const secondCard = parseClosedStreamingCard(harness.cardReplacements[1]);
  const secondMarkdown = streamingCardMarkdown(secondCard);
  const secondContext = buttonCallbackValue(streamingCardButtons(secondCard)[0])
    .remote_codex_context;
  assert.match(secondMarkdown, /second clean approval/);
  assert.match(secondMarkdown, /xdotool windowactivate 42/);
  assert.doesNotMatch(
    secondMarkdown,
    /first clean approval|corrupted repaint|terminal-corrupted-command|ngg5WWo/
  );
  assert.notEqual(secondContext, firstContext);
  assert.equal(harness.cardCreates.length, 1);
  assert.equal(harness.cardMessages.length, 1);

  turn.emit(authorizationRequested(
    'call-consecutive-second',
    'turn-consecutive',
    'must not replace the card',
    'duplicate request'
  ));
  await wait(30);
  assert.equal(harness.cardReplacements.length, 2);

  turn.emit({
    type: 'authorization_completed',
    callId: 'call-consecutive-second',
    turnId: 'turn-consecutive'
  });
  turn.emit({ type: 'final', text: '连续授权任务完成。' });
  turn.emit({
    type: 'turn_complete',
    turnId: 'turn-consecutive',
    finalText: '连续授权任务完成。'
  });
  await waitUntil(() => harness.closes.length === 1);
  assert.equal(
    streamingCardMarkdown(parseClosedStreamingCard(harness.closes[0])),
    '连续授权任务完成。'
  );
  cleanupHarness(harness);
}

async function testResumeGenerationCannotReplayPreviousTurn() {
  const harness = createHarness();
  const firstPrompt = '第一轮任务';
  await harness.plugin.handleReceiveMessage(feishuMessage(firstPrompt, 'om_first'));
  const firstTurn = harness.rolloutReader.latest();
  firstTurn.emit(boundEvent('session-resume', 'turn-first'));
  firstTurn.emit({ type: 'turn_started', turnId: 'turn-first' });
  firstTurn.emit({ type: 'progress', text: '第一轮进度' });
  firstTurn.emit({ type: 'final', text: '第一轮最终答案' });
  firstTurn.emit({ type: 'turn_complete', turnId: 'turn-first', finalText: '第一轮最终答案' });
  await waitUntil(() => harness.closes.length === 1);

  await harness.plugin.handleReceiveMessage(feishuMessage('resume 后第二轮任务', 'om_second'));
  await waitUntil(() => harness.cardCreates.length === 2);
  const secondTurn = harness.rolloutReader.latest();
  assert.notEqual(secondTurn, firstTurn);

  firstTurn.emit({ type: 'progress', text: '不应重放的第一轮迟到内容' });
  secondTurn.emit(boundEvent('session-resume', 'turn-second'));
  secondTurn.emit({ type: 'turn_started', turnId: 'turn-second' });
  secondTurn.emit({ type: 'progress', text: '第二轮新进度' });
  secondTurn.emit({ type: 'final', text: '第二轮新最终答案' });
  secondTurn.emit({
    type: 'turn_complete',
    turnId: 'turn-second',
    finalText: '第二轮新最终答案'
  });
  await waitUntil(() => harness.closes.length === 2);

  const secondCard = parseClosedStreamingCard(harness.closes[1]);
  assert.equal(streamingCardMarkdown(secondCard), '第二轮新最终答案');
  assert.doesNotMatch(streamingCardMarkdown(secondCard), /第一轮|迟到内容/);
  assert.equal(harness.cardMessages.length, 2);
  cleanupHarness(harness);
}

async function testCardKitStreamingUsesRolloutSegmentsAndFinalOnly() {
  const harness = createHarness();
  const prompt = '用 CardKit 显示结构化事件';
  const first = '第一条结构化进度';
  const second = '第二条结构化进度';
  const finalText = [
    '最终答案只包含最终内容。',
    '',
    '- 保留列表第一行',
    '- 保留列表第二行'
  ].join('\n');

  await harness.plugin.handleReceiveMessage(feishuMessage(prompt, 'om_streaming'));
  await waitUntil(() => harness.cardCreates.length === 1);
  const turn = harness.rolloutReader.latest();
  turn.emit(boundEvent('session-stream', 'turn-stream'));
  turn.emit({ type: 'turn_started', turnId: 'turn-stream' });
  turn.emit({ type: 'progress', text: first });
  turn.emit({ type: 'progress', text: second });
  await waitUntil(() => harness.updates.length >= 2);
  assert.match(normalizeSentMarkdown(latestContent(harness.updates)), /第一条结构化进度\n\n第二条结构化进度/);

  turn.emit({ type: 'final', text: finalText });
  turn.emit({ type: 'turn_complete', turnId: 'turn-stream', finalText });
  await waitUntil(() => harness.closes.length >= 1, 2000);

  const closed = parseClosedStreamingCard(harness.closes.find((item) => item.method === 'PUT'));
  const closedText = normalizeSentMarkdown(
    String(closed.body?.elements?.find((element) => element.tag === 'markdown')?.content || '')
  );
  assert.equal(closed.header.template, 'green');
  assert.equal(closed.header.subtitle.content, '已完成');
  assert.equal(closedText, finalText);
  assert.doesNotMatch(closedText, /第一条结构化进度|第二条结构化进度/);
  assert.equal(harness.cardMessages.length, 1);
  assert.equal(harness.textFallbacks.length, 0);
  cleanupHarness(harness);
}

async function testRolloutBindingFailureDoesNotFallBackToTerminalText() {
  const harness = createHarness();
  const prompt = '模拟 JSONL 绑定失败';
  await harness.plugin.handleReceiveMessage(feishuMessage(prompt, 'om_failure'));
  const turn = harness.rolloutReader.latest();
  turn.fail(new Error('history.jsonl did not contain the submitted prompt'));
  await waitUntil(() => harness.closes.length === 1);

  harness.session.emitOutput({
    data: 'Working•orking•rking TERMINAL FALLBACK MUST NOT SEND',
    snapshot: [
      `› ${prompt}`,
      '• TERMINAL FALLBACK MUST NOT SEND',
      '› '
    ].join('\n')
  });
  await wait(30);

  const closed = parseClosedStreamingCard(harness.closes[0]);
  const text = streamingCardMarkdown(closed);
  assert.match(text, /无法绑定当前 Codex 的结构化 JSONL 输出/);
  assert.match(text, /不会回退到终端正文解析/);
  assert.doesNotMatch(text, /TERMINAL FALLBACK MUST NOT SEND|Working•/);
  assert.equal(harness.cardMessages.length, 1);
  assert.equal(harness.cardCreates.length, 1);
  assert.equal(harness.closes.length, 1);
  assert.equal(closed.header.template, 'red');
  cleanupHarness(harness);
}

function createHarness(options = {}) {
  const session = new FakeVisualSession();
  const parserTraces = [];
  session.outputRecorder = {
    recordParserTrace(_session, payload) {
      parserTraces.push(payload);
    }
  };
  const rolloutReader = new FakeRolloutReader();
  const cardCreates = [];
  const cardMessages = [];
  const fileUploads = [];
  const fileMessages = [];
  const scopeApplies = [];
  const deliveryEvents = [];
  const updates = [];
  const closes = [];
  const cardReplacements = [];
  const streamingModeUpdates = [];
  const closeRequests = [];
  const textFallbacks = [];
  let finished = 0;
  const singleCardOutput = options.singleCardOutput === undefined
    ? true
    : Boolean(options.singleCardOutput);
  const streaming = options.streaming === undefined
    ? singleCardOutput
    : Boolean(options.streaming);
  const segmentedOutput = options.segmentedOutput === undefined
    ? !singleCardOutput && !streaming
    : Boolean(options.segmentedOutput);
  const controller = new RemoteSessionController({
    sessionManager: null,
    rolloutReader,
    sharedSessionProvider: () => ({ session }),
    logger: quietLogger(),
    config: {
      codex: {
        defaultCwd: process.cwd(),
        allowedWorkdirs: []
      },
      remoteControl: {
        autoCreateSession: true,
        responseSource: 'rollout_jsonl',
        sendOutput: true,
        outputMode: 'final',
        flushIntervalMs: 1,
        finalReplyDebounceMs: 1
      },
      plugins: {
        feishu: {
          mode: 'long_connection',
          responseSource: 'rollout_jsonl',
          singleCardOutput,
          streaming,
          segmentedOutput,
          flushIntervalMs: 1,
          finalReplyDebounceMs: 1
        }
      }
    }
  });
  const plugin = createFakeFeishuPlugin({
    controller,
    cardCreates,
    cardMessages,
    fileUploads,
    fileMessages,
    scopeApplies,
    deliveryEvents,
    updates,
    closes,
    cardReplacements,
    streamingModeUpdates,
    closeRequests,
    textFallbacks,
    singleCardOutput,
    streaming,
    segmentedOutput,
    failContentUpdates: Boolean(options.failContentUpdates),
    failFileUpload: Boolean(options.failFileUpload),
    failFilePermissionOnce: Boolean(options.failFilePermissionOnce),
    failCloseAttempts: Number(options.failCloseAttempts) || 0,
    onFinished: () => {
      finished += 1;
    }
  });
  return {
    session,
    rolloutReader,
    controller,
    plugin,
    cardCreates,
    cardMessages,
    fileUploads,
    fileMessages,
    scopeApplies,
    deliveryEvents,
    updates,
    closes,
    cardReplacements,
    streamingModeUpdates,
    closeRequests,
    textFallbacks,
    parserTraces,
    get finished() {
      return finished;
    }
  };
}

function createFakeFeishuPlugin({
  controller,
  cardCreates,
  cardMessages,
  fileUploads,
  fileMessages,
  scopeApplies,
  deliveryEvents,
  updates,
  closes,
  cardReplacements,
  streamingModeUpdates,
  closeRequests,
  textFallbacks,
  singleCardOutput,
  streaming,
  segmentedOutput,
  failContentUpdates,
  failFileUpload,
  failFilePermissionOnce,
  failCloseAttempts,
  onFinished
}) {
  const plugin = feishuPlugin.create({
    config: {},
    pluginConfig: {
      mode: 'long_connection',
      singleCardOutput,
      streaming,
      segmentedOutput,
      ackReactionEnabled: false,
      doneReactionEnabled: false,
      appId: 'app',
      appSecret: 'secret'
    },
    services: { remoteController: controller },
    logger: quietLogger()
  });

  plugin.cardkitRequest = async (requestPath, { method, body }) => {
    if (method === 'POST' && requestPath === '/cardkit/v1/cards') {
      deliveryEvents.push('card_create');
      cardCreates.push({ path: requestPath, method, body });
      return { data: { card_id: 'card_stream' } };
    }
    if (method === 'PUT' && requestPath.includes('/elements/content')) {
      if (failContentUpdates) {
        throw new Error('simulated CardKit content update failure');
      }
      updates.push({ path: requestPath, method, body });
      return {};
    }
    if (method === 'PUT' && /^\/cardkit\/v1\/cards\/[^/]+$/.test(requestPath)) {
      const card = JSON.parse(body.card?.data || '{}');
      if (
        card.config?.streaming_mode === true ||
        String(body.uuid || '').startsWith('remote_codex_panel_')
      ) {
        cardReplacements.push({ path: requestPath, method, body });
        return {};
      }
      deliveryEvents.push('card_close');
      closeRequests.push({ path: requestPath, method, body });
      if (closeRequests.length <= failCloseAttempts) {
        throw new Error('simulated CardKit close failure');
      }
      closes.push({ path: requestPath, method, body });
      return {};
    }
    if (method === 'PATCH' && requestPath.endsWith('/settings')) {
      const settings = JSON.parse(body.settings || '{}');
      if (settings.config?.streaming_mode === false) {
        streamingModeUpdates.push({ path: requestPath, method, body });
        return {};
      }
      closes.push({ path: requestPath, method, body });
      return {};
    }
    throw new Error(`Unexpected CardKit request: ${method} ${requestPath}`);
  };
  plugin.client = {
    im: {
      v1: {
        file: {
          async create(payload) {
            fileUploads.push(payload);
            deliveryEvents.push('file_upload');
            if (failFilePermissionOnce && fileUploads.length === 1) {
              throw new Error('permission denied 99991663');
            }
            if (failFileUpload) {
              throw new Error('simulated file upload failure');
            }
            return { data: { file_key: 'file_test_key' } };
          }
        },
        message: {
          async create(payload) {
            if (payload.data?.msg_type === 'file') {
              deliveryEvents.push('file_message');
              fileMessages.push(payload);
              return { data: { message_id: 'om_file' } };
            }
            deliveryEvents.push('card_message');
            cardMessages.push(payload);
            return { data: { message_id: 'om_stream' } };
          }
        }
      }
    },
    application: {
      scope: {
        async apply(payload) {
          scopeApplies.push(payload);
          return { code: 0 };
        }
      }
    }
  };
  plugin.sendText = async (message) => {
    textFallbacks.push(message);
  };
  const originalHandle = plugin.handleReceiveMessage.bind(plugin);
  plugin.handleReceiveMessage = async (event) => {
    const before = controller.sessions.get('feishu:oc_chat');
    await originalHandle(event);
    const state = controller.sessions.get('feishu:oc_chat') || before;
    if (state) state.onTurnFinished = onFinished;
  };
  return plugin;
}

class FakeRolloutReader {
  constructor() {
    this.turns = [];
  }

  beginTurn(options) {
    const turn = new FakeRolloutTurn(options);
    this.turns.push(turn);
    return turn;
  }

  latest() {
    const turn = this.turns.at(-1);
    assert.ok(turn, 'expected an active fake rollout turn');
    return turn;
  }
}

class FakeRolloutTurn {
  constructor(options) {
    this.options = options;
    this.stopped = false;
  }

  emit(event) {
    this.options.onEvent?.(event);
  }

  fail(error) {
    this.options.onError?.(error);
  }

  stop() {
    this.stopped = true;
  }
}

class FakeVisualSession extends EventEmitter {
  constructor() {
    super();
    this.id = 's-feishu-sim';
    this.cwd = process.cwd();
    this.cursor = 0;
    this.output = [];
    this.writes = [];
    this.visualSnapshot = '› ';
    this.visualViewportSnapshot = '› ';
  }

  write(data) {
    this.writes.push(data);
  }

  emitOutput({ data, snapshot }) {
    this.visualSnapshot = snapshot;
    this.visualViewportSnapshot = snapshot;
    const chunk = {
      cursor: ++this.cursor,
      data,
      at: new Date().toISOString()
    };
    this.output.push(chunk);
    this.emit('data', chunk);
  }

  readAfter(cursor = 0) {
    return {
      cursor: this.cursor,
      chunks: this.output.filter((chunk) => chunk.cursor > cursor),
      exited: false,
      exit: null
    };
  }

  status() {
    return {
      id: this.id,
      cwd: this.cwd,
      cursor: this.cursor,
      exited: false
    };
  }
}

function boundEvent(sessionId, turnId) {
  return {
    type: 'bound',
    sessionId,
    turnId,
    rolloutPath: `/tmp/rollout-${sessionId}.jsonl`,
    cwd: process.cwd(),
    cliVersion: '0.142.5'
  };
}

function authorizationRequested(callId, turnId, command, justification) {
  return {
    type: 'authorization_requested',
    callId,
    turnId,
    approval: {
      id: callId,
      callId,
      source: 'rollout_jsonl',
      turnId,
      question: '是否允许执行以下操作？',
      reason: `Reason: ${justification}`,
      command,
      options: [
        { selected: true, index: 1, text: 'Yes, proceed (y)' },
        { selected: false, index: 2, text: "Yes, and don't ask again (p)" },
        { selected: false, index: 3, text: 'No (esc)' }
      ]
    }
  };
}

function feishuMessage(text, messageId = 'om_input') {
  return {
    message: {
      chat_id: 'oc_chat',
      message_id: messageId,
      create_time: String(Date.now()),
      content: JSON.stringify({ text })
    },
    sender: {
      sender_id: {
        open_id: 'ou_user'
      }
    }
  };
}

function feishuApprovalAction(action, context = '') {
  return {
    action: {
      value: {
        remote_codex_action: action,
        remote_codex_context: context
      }
    },
    context: {
      open_chat_id: 'oc_chat',
      open_message_id: 'om_stream'
    },
    operator: {
      operator_id: {
        open_id: 'ou_user'
      }
    }
  };
}

function latestContent(updates) {
  return String(updates.at(-1)?.body?.content || '');
}

function parseCreatedStreamingCard(create) {
  return JSON.parse(create?.body?.data || '{}');
}

function parseClosedStreamingCard(close) {
  return JSON.parse(close?.body?.card?.data || '{}');
}

function streamingCardMarkdown(card) {
  return normalizeSentMarkdown(
    String(card?.body?.elements?.find((element) => element.tag === 'markdown')?.content || '')
  );
}

function streamingCardButtons(card) {
  return (card?.body?.elements || [])
    .filter((element) => element?.tag === 'column_set')
    .flatMap((element) => element.columns || [])
    .flatMap((column) => column.elements || [])
    .filter((element) => element?.tag === 'button');
}

function buttonCallbackValue(button) {
  return button?.behaviors?.find((behavior) => behavior.type === 'callback')?.value || {};
}

function normalizeSentMarkdown(text) {
  return String(text || '')
    .replace(/<font\s+color='[^']+'>/g, '')
    .replace(/<\/font>/g, '')
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) return line;
      return line.replace(/`([^`\n]+)`/g, '$1');
    })
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

function cleanupHarness(harness) {
  for (const state of harness.controller.sessions.values()) {
    if (state.flushTimer) clearTimeout(state.flushTimer);
    if (state.pendingReplyTimer) clearTimeout(state.pendingReplyTimer);
    if (state.streamFinishTimer) clearTimeout(state.streamFinishTimer);
    if (state.streamHeartbeatTimer) clearTimeout(state.streamHeartbeatTimer);
    state.rolloutTurn?.stop?.();
    state.replyStream?.unregister?.();
  }
}

function quietLogger() {
  return {
    event() {},
    warn() {}
  };
}

async function waitUntil(predicate, timeoutMs = 1200) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) return;
    await wait(5);
  }
  assert.fail('Timed out waiting for async Feishu rollout condition.');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
