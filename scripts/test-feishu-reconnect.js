const assert = require('node:assert/strict');
const feishuModule = require('../src/plugins/feishu');
const {
  clearFeishuConnection,
  connectOrReconnectFeishu,
  hasSavedFeishuCredentials,
  resetFeishuConnection
} = require('../src/feishuConnectionCoordinator');
const { FeishuRegistrationManager } = require('../src/plugins/feishu/registrationManager');

async function main() {
  await testFirstConnectionRegistersAnApp();
  await testReconnectReusesSavedCredentials();
  await testFailedReconnectDoesNotCreateAnotherApp();
  await testResetClearsOldConnectionBeforeRegisteringAgain();
  await testExistingAppReauthorizationTargetsTheSameApp();
  await testPluginConnectionWaiter();
  process.stdout.write('Feishu existing-app reconnect tests passed.\n');
}

async function testResetClearsOldConnectionBeforeRegisteringAgain() {
  const calls = [];
  const config = {
    ui: { language: 'zh-CN' },
    plugins: {
      feishu: {
        enabled: true,
        mode: 'long_connection',
        appId: 'cli_old_app',
        appSecret: 'old-secret',
        encryptKey: 'old-encrypt-key',
        verificationToken: 'old-token',
        defaultChatId: 'oc_old_chat',
        customWebhookUrl: 'https://example.invalid/webhook',
        allowedOpenIds: ['ou_old'],
        allowedChatIds: ['oc_old_chat'],
        connectSource: 'register_app',
        connectedAt: '2026-01-01T00:00:00.000Z',
        authorizedOpenId: 'ou_old',
        tenantBrand: 'feishu',
        latexRenderingEnabled: false
      }
    }
  };
  const cleared = clearFeishuConnection(config);

  assert.equal(config.plugins.feishu.appId, 'cli_old_app', 'reset must not mutate live input');
  assert.deepEqual({
    enabled: cleared.plugins.feishu.enabled,
    appId: cleared.plugins.feishu.appId,
    appSecret: cleared.plugins.feishu.appSecret,
    encryptKey: cleared.plugins.feishu.encryptKey,
    verificationToken: cleared.plugins.feishu.verificationToken,
    defaultChatId: cleared.plugins.feishu.defaultChatId,
    allowedOpenIds: cleared.plugins.feishu.allowedOpenIds,
    allowedChatIds: cleared.plugins.feishu.allowedChatIds,
    connectSource: cleared.plugins.feishu.connectSource,
    connectedAt: cleared.plugins.feishu.connectedAt,
    authorizedOpenId: cleared.plugins.feishu.authorizedOpenId,
    tenantBrand: cleared.plugins.feishu.tenantBrand
  }, {
    enabled: false,
    appId: '',
    appSecret: '',
    encryptKey: '',
    verificationToken: '',
    defaultChatId: '',
    allowedOpenIds: [],
    allowedChatIds: [],
    connectSource: '',
    connectedAt: '',
    authorizedOpenId: '',
    tenantBrand: ''
  });
  assert.equal(cleared.plugins.feishu.latexRenderingEnabled, false);
  assert.equal(
    cleared.plugins.feishu.customWebhookUrl,
    'https://example.invalid/webhook',
    'resetting the app connection must preserve unrelated custom-webhook settings'
  );

  const result = await resetFeishuConnection({
    config,
    persistConfig(nextConfig) {
      calls.push('persist');
      assert.equal(nextConfig.plugins.feishu.appId, '');
      return { ...nextConfig, configPath: '/tmp/remote-codex-reset.json' };
    },
    async restartPlugins(savedConfig) {
      calls.push('stop-old-connection');
      assert.equal(savedConfig.plugins.feishu.enabled, false);
    },
    registrationManager: {
      start() {
        calls.push('start-new-registration');
        return { status: 'starting', connectionMode: 'new_app' };
      }
    },
    logger: { event() {} }
  });

  assert.deepEqual(calls, ['persist', 'stop-old-connection', 'start-new-registration']);
  assert.equal(result.config.plugins.feishu.appId, '');
  assert.equal(result.status.connectionMode, 'new_app');
}

async function testFirstConnectionRegistersAnApp() {
  let registrationStarts = 0;
  const registrationManager = {
    start() {
      registrationStarts += 1;
      return { status: 'starting' };
    }
  };
  const config = { plugins: { feishu: { appId: '', appSecret: '' } } };

  assert.equal(hasSavedFeishuCredentials(config), false);
  const status = await connectOrReconnectFeishu({
    config,
    restartPlugins: () => assert.fail('first connection must not restart saved credentials'),
    registrationManager
  });

  assert.deepEqual(status, { status: 'starting' });
  assert.equal(registrationStarts, 1);
}

async function testReconnectReusesSavedCredentials() {
  const calls = [];
  const config = {
    plugins: {
      feishu: {
        appId: 'cli_0123456789abcdef',
        appSecret: 'saved-secret',
        authorizedOpenId: 'ou_saved',
        tenantBrand: 'feishu'
      }
    }
  };
  const existingControllerState = new Map([['feishu:oc_chat', { sessionId: 'pty-1' }]]);
  const registrationManager = {
    start() {
      assert.fail('reconnect must not register a new Feishu app');
    },
    completeExistingConnection(payload) {
      calls.push({ type: 'complete', payload });
      return { status: 'complete', connectionMode: 'existing_app' };
    },
    failExistingConnection() {
      assert.fail('successful reconnect must not report failure');
    }
  };

  assert.equal(hasSavedFeishuCredentials(config), true);
  const status = await connectOrReconnectFeishu({
    config,
    async restartPlugins() {
      calls.push({ type: 'restart' });
    },
    getFeishuPlugin: () => ({
      async waitUntilConnected(timeoutMs) {
        calls.push({ type: 'wait', timeoutMs });
        return true;
      }
    }),
    registrationManager
  });

  assert.equal(status.connectionMode, 'existing_app');
  assert.deepEqual(calls.map(({ type }) => type), ['restart', 'wait', 'complete']);
  assert.equal(calls[2].payload.appId, 'cli_0123456789abcdef');
  assert.equal(calls[2].payload.userOpenId, 'ou_saved');
  assert.equal(
    existingControllerState.get('feishu:oc_chat').sessionId,
    'pty-1',
    'reconnecting the transport must not replace remote controller state'
  );
}

async function testFailedReconnectDoesNotCreateAnotherApp() {
  let registrationStarts = 0;
  const failures = [];
  const status = await connectOrReconnectFeishu({
    config: {
      plugins: {
        feishu: {
          appId: 'cli_0123456789abcdef',
          appSecret: 'saved-secret'
        }
      }
    },
    async restartPlugins() {},
    getFeishuPlugin: () => ({
      async waitUntilConnected() {
        return false;
      }
    }),
    registrationManager: {
      start() {
        registrationStarts += 1;
      },
      completeExistingConnection() {
        assert.fail('a timed-out reconnect must not be marked complete');
      },
      failExistingConnection(payload) {
        failures.push(payload);
        return { status: 'error', connectionMode: 'existing_app' };
      }
    },
    logger: { warn() {} },
    connectionTimeoutMs: 1
  });

  assert.equal(status.status, 'error');
  assert.equal(registrationStarts, 0, 'failure must not silently create a replacement bot');
  assert.equal(failures[0].appId, 'cli_0123456789abcdef');
}

async function testExistingAppReauthorizationTargetsTheSameApp() {
  let registerOptions;
  const manager = new FeishuRegistrationManager({
    larkSdk: {
      registerApp(options) {
        registerOptions = options;
        options.onQRCodeReady({ url: 'https://example.invalid/qr', expireIn: 60 });
        return Promise.resolve({
          client_id: 'cli_0123456789abcdef',
          client_secret: 'refreshed-secret',
          user_info: { open_id: 'ou_saved', tenant_brand: 'feishu' }
        });
      }
    },
    onComplete: async () => ({ configPath: '/tmp/config.json', pluginError: '' }),
    onUpdate() {},
    logger: { warn() {} }
  });

  manager.start({ appId: 'cli_0123456789abcdef' });
  await manager.promise;

  assert.equal(registerOptions.appId, 'cli_0123456789abcdef');
  assert.equal(manager.getStatus().appId, 'cli_0123456789abcdef');
  assert.equal(manager.getStatus().connectionMode, 'new_app');
}

async function testPluginConnectionWaiter() {
  let wsClient;
  class FakeWSClient {
    constructor(options) {
      this.options = options;
      this.state = 'connecting';
      wsClient = this;
    }

    start() {}

    close() {
      this.state = 'idle';
    }

    getConnectionStatus() {
      return { state: this.state, reconnectAttempts: 0 };
    }
  }
  class FakeEventDispatcher {
    register() {
      return this;
    }
  }
  const plugin = feishuModule.create({
    config: {},
    pluginConfig: {
      mode: 'long_connection',
      appId: 'cli_0123456789abcdef',
      appSecret: 'saved-secret',
      allowedChatIds: []
    },
    services: {
      larkSdk: {
        Client: class FakeClient {},
        WSClient: FakeWSClient,
        EventDispatcher: FakeEventDispatcher,
        LoggerLevel: { info: 'info' }
      }
    },
    logger: { event() {}, warn() {} }
  });

  await plugin.start();
  const waiting = plugin.waitUntilConnected(100);
  wsClient.state = 'connected';
  wsClient.options.onReady();
  assert.equal(await waiting, true);
  assert.equal(plugin.getStatus().connection.state, 'connected');
  await plugin.stop();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
