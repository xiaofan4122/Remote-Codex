const assert = require('node:assert/strict');
const feishuModule = require('../src/plugins/feishu');
const {
  FeishuReplyStream,
  isStreamingModeClosedError,
  isStreamingTimeoutError
} = require('../src/plugins/feishu/replyStream');

async function main() {
  await testStreamingSettingsPayload();
  await testStructuredCardKitError();
  await testProactiveLeaseRenewal();
  await testTimeoutRecovery();
  await testClosedModeRecovery();
  await testPanelInteractionRetryReusesSequence();
  await testApprovalFeedbackPreservesProgressAndResumesStreaming();
  await testStaleApprovalFeedbackCannotReplaceNextPanel();
  await testRenewalFailureLogging();
  await testLongRunningFinalization();
  process.stdout.write('Feishu reply stream lease tests passed.\n');
}

async function testStreamingSettingsPayload() {
  const requests = [];
  const plugin = createFeishuPlugin();
  plugin.cardkitRequest = async (path, request) => {
    requests.push({ path, request });
    return { data: {} };
  };

  await plugin.renewStreamingMode({ cardId: 'card/one', sequence: 12 });

  assert.deepEqual(requests, [
    {
      path: '/cardkit/v1/cards/card%2Fone/settings',
      request: {
        method: 'PATCH',
        body: {
          settings: JSON.stringify({
            config: feishuModule.__private.buildStreamingModeConfig()
          }),
          sequence: 12,
          uuid: 'remote_codex_stream_renew_card/one_12'
        }
      }
    }
  ]);
}

async function testStructuredCardKitError() {
  const plugin = createFeishuPlugin();
  plugin.tenantAccessToken = 'test-token';
  plugin.tenantAccessTokenExpiresAt = Date.now() + 60_000;
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 400,
    async json() {
      return { code: 200510, msg: 'Card streaming timeout' };
    }
  });

  try {
    await assert.rejects(
      plugin.cardkitRequest('/cardkit/v1/cards/card-1', {
        method: 'PUT',
        body: {}
      }),
      (error) => {
        assert.equal(error.name, 'FeishuCardKitError');
        assert.equal(error.httpStatus, 400);
        assert.equal(error.code, 200510);
        assert.equal(error.feishuMessage, 'Card streaming timeout');
        assert.equal(isStreamingTimeoutError(error), true);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testProactiveLeaseRenewal() {
  let now = 1_000;
  const calls = [];
  const plugin = createStreamPlugin({
    async renewStreamingMode(payload) {
      calls.push({ type: 'renew', ...payload });
    },
    async updateStreamingContent(payload) {
      calls.push({ type: 'update', ...payload });
    }
  });
  const stream = createStream(plugin, {
    now: () => now,
    streamRenewAfterMs: 1_000
  });

  await stream.update('第一段进展');
  now = 2_100;
  await stream.update('第二段进展');

  assert.deepEqual(
    calls.map(({ type, sequence }) => [type, sequence]),
    [['update', 2], ['renew', 3], ['update', 4]]
  );
  assert.equal(stream.currentText, '第二段进展');
}

async function testTimeoutRecovery() {
  const calls = [];
  let updateAttempts = 0;
  const plugin = createStreamPlugin({
    async renewStreamingMode(payload) {
      calls.push({ type: 'renew', ...payload });
    },
    async updateStreamingContent(payload) {
      updateAttempts += 1;
      calls.push({ type: 'update', ...payload });
      if (updateAttempts === 1) {
        const error = new Error('Feishu CardKit failed: 400 200510 Card streaming timeout');
        error.code = 200510;
        error.httpStatus = 400;
        throw error;
      }
    }
  });
  const stream = createStream(plugin, {
    streamRenewAfterMs: 60_000
  });

  await stream.update('超时后的进展');

  assert.deepEqual(
    calls.map(({ type, sequence }) => [type, sequence]),
    [['update', 2], ['renew', 3], ['update', 4]]
  );
  assert.equal(stream.currentText, '超时后的进展');
  assert.ok(
    plugin.events.some(({ name }) => name === 'feishu.stream.timeout.recovered'),
    'the recovered timeout must be visible in structured diagnostics'
  );
}

async function testClosedModeRecovery() {
  const calls = [];
  let updateAttempts = 0;
  const plugin = createStreamPlugin({
    async renewStreamingMode(payload) {
      calls.push({ type: 'renew', ...payload });
    },
    async updateStreamingContent(payload) {
      updateAttempts += 1;
      calls.push({ type: 'update', ...payload });
      if (updateAttempts === 1) {
        const error = new Error(
          'Feishu CardKit failed: 200 300309 ErrMsg: streaming mode is closed;'
        );
        error.code = 300309;
        error.httpStatus = 200;
        throw error;
      }
    }
  });
  const stream = createStream(plugin, {
    streamRenewAfterMs: 60_000
  });

  await stream.update('十分钟后仍应更新的进展');

  assert.deepEqual(
    calls.map(({ type, sequence }) => [type, sequence]),
    [['update', 2], ['renew', 3], ['update', 4]]
  );
  assert.equal(stream.currentText, '十分钟后仍应更新的进展');
  assert.equal(isStreamingModeClosedError({ code: 300309 }), true);
  assert.ok(
    plugin.events.some(({ name }) => name === 'feishu.stream.mode_closed.recovered'),
    'a silently closed CardKit stream must reopen and deliver the same update'
  );
}

async function testRenewalFailureLogging() {
  let now = 1_000;
  const plugin = createStreamPlugin({
    async renewStreamingMode() {
      const error = new Error('temporary settings failure');
      error.code = 99991663;
      error.httpStatus = 503;
      throw error;
    }
  });
  const stream = createStream(plugin, {
    now: () => now,
    streamRenewAfterMs: 1_000
  });

  await stream.update('初始进展');
  now = 2_100;
  await stream.update('续期失败但流仍可写');

  assert.equal(stream.currentText, '续期失败但流仍可写');
  assert.equal(plugin.warnings.length, 1);
  assert.deepEqual(plugin.warnings[0].meta, {
    cardId: 'card-1',
    sequence: 3,
    reason: 'lease_expiring',
    leaseAgeMs: 1100,
    error: 'temporary settings failure',
    code: 99991663,
    httpStatus: 503
  });
}

async function testPanelInteractionRetryReusesSequence() {
  const calls = [];
  let attempts = 0;
  const plugin = createStreamPlugin({
    async replaceStreamingText(payload) {
      attempts += 1;
      calls.push({ type: 'replace', ...payload });
      if (attempts === 1) {
        const error = new Error('Card is in an ongoing interaction 200810');
        error.code = 200810;
        error.httpStatus = 400;
        throw error;
      }
    }
  });
  const stream = createStream(plugin);
  stream.panelActive = true;

  await stream.showActionFeedback('approve');

  assert.deepEqual(
    calls.map(({ type, sequence }) => [type, sequence]),
    [['replace', 2], ['replace', 2]]
  );
  assert.equal(stream.sequence, 2);
  assert.equal(stream.panelActive, false);
  assert.ok(
    plugin.events.some(({ name }) => name === 'feishu.stream.interaction.retry')
  );
}

async function testApprovalFeedbackPreservesProgressAndResumesStreaming() {
  const calls = [];
  const plugin = createStreamPlugin({
    async updateStreamingContent(payload) {
      calls.push({ type: 'update', ...payload });
    },
    async replaceStreamingPanel(payload) {
      calls.push({ type: 'panel', ...payload });
      return { sequence: payload.sequence };
    },
    async replaceStreamingText(payload) {
      calls.push({ type: 'replace', ...payload });
    }
  });
  const stream = createStream(plugin);

  await stream.update('我正在检查安装脚本和发布配置。');
  await stream.showPanel({
    kind: 'permission',
    attached: true,
    active: true,
    fallbackText: '带有选项的内部回退文本不应覆盖用户看到的审批内容。',
    approval: {
      reason: '安装系统依赖以完成发布检查。',
      command: 'sudo apt-get install libsecret-1-0',
      question: '是否允许执行命令？',
      options: ['允许一次', '总是允许', '拒绝']
    }
  });
  await stream.showActionFeedback('approve_persistent');

  const feedback = calls.find(({ type }) => type === 'replace')?.text || '';
  assert.match(feedback, /安装系统依赖以完成发布检查/);
  assert.match(feedback, /sudo apt-get install libsecret-1-0/);
  assert.match(feedback, /授权状态/);
  assert.match(feedback, /已提交「总是允许」/);
  assert.match(feedback, /Codex 正在继续执行/);
  assert.doesNotMatch(feedback, /这张卡片已锁定|是否允许执行|允许一次|拒绝|内部回退文本/);

  await stream.update('我正在检查安装脚本和发布配置。\n\n修复已完成，正在运行测试。');
  assert.equal(stream.currentText, '我正在检查安装脚本和发布配置。\n\n修复已完成，正在运行测试。');
  assert.equal(stream.actionFeedbackText, '');
  assert.equal(stream.panelActive, false);
}

async function testStaleApprovalFeedbackCannotReplaceNextPanel() {
  const calls = [];
  const plugin = createStreamPlugin({
    async replaceStreamingPanel(payload) {
      calls.push({ type: 'panel', ...payload });
      return { sequence: payload.sequence };
    },
    async replaceStreamingText(payload) {
      calls.push({ type: 'replace', ...payload });
    }
  });
  const stream = createStream(plugin);

  await stream.showPanel({
    kind: 'permission',
    attached: true,
    active: true,
    approval: {
      reason: 'first approval',
      command: 'command-one'
    }
  });
  const firstPanelRevision = stream.panelRevision;

  await stream.showPanel({
    kind: 'permission',
    attached: true,
    active: true,
    approval: {
      reason: 'second approval',
      command: 'command-two'
    }
  });
  const applied = await stream.showActionFeedback('approve', '', {
    expectedPanelRevision: firstPanelRevision
  });

  assert.equal(applied, false);
  assert.equal(stream.panelActive, true);
  assert.match(stream.panelRestoreText, /second approval/);
  assert.doesNotMatch(stream.panelRestoreText, /first approval/);
  assert.equal(calls.filter(({ type }) => type === 'replace').length, 0);
  assert.ok(
    plugin.events.some(({ name, meta }) => (
      name === 'feishu.stream.action_feedback.ignored' &&
      meta.reason === 'panel_changed'
    ))
  );
}

async function testLongRunningFinalization() {
  let now = 1_000;
  const calls = [];
  const plugin = createStreamPlugin({
    async renewStreamingMode(payload) {
      calls.push({ type: 'renew', ...payload });
    },
    async updateStreamingContent(payload) {
      calls.push({ type: 'update', ...payload });
    },
    async closeStreamingCard(payload) {
      calls.push({ type: 'close', ...payload });
    }
  });
  const stream = createStream(plugin, {
    now: () => now,
    streamRenewAfterMs: 8 * 60 * 1000
  });
  now += 11 * 60 * 1000;

  await stream.finish('十一分钟后的最终答案');

  assert.deepEqual(
    calls.map(({ type, sequence }) => [type, sequence]),
    [['renew', 2], ['update', 3], ['close', 4]]
  );
  assert.equal(stream.closed, true);
}

function createFeishuPlugin() {
  return feishuModule.create({
    config: {},
    pluginConfig: {
      mode: 'long_connection',
      appId: 'app-id',
      appSecret: 'app-secret'
    },
    services: {},
    logger: { event() {}, warn() {} }
  });
}

function createStreamPlugin(overrides = {}) {
  const events = [];
  const warnings = [];
  return {
    replyStreamsByMessageId: new Map(),
    events,
    warnings,
    logger: {
      event(name, meta) {
        events.push({ name, meta });
      },
      warn(message, meta) {
        warnings.push({ message, meta });
      }
    },
    async updateStreamingContent() {},
    async renewStreamingMode() {},
    async replaceStreamingText() {},
    async closeStreamingCard() {},
    ...overrides
  };
}

function createStream(plugin, options = {}) {
  return new FeishuReplyStream({
    plugin,
    cardId: 'card-1',
    elementId: 'content',
    logger: plugin.logger,
    minUpdateIntervalMs: 0,
    wait: async () => {},
    ...options
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
