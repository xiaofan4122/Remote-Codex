const assert = require('node:assert/strict');
const feishuModule = require('../src/plugins/feishu');
const {
  connectOrReconnectFeishu,
  hasSavedFeishuCredentials
} = require('../src/feishuConnectionCoordinator');
const { FeishuRegistrationManager } = require('../src/plugins/feishu/registrationManager');

async function main() {
  await testFirstConnectionRegistersAnApp();
  await testReconnectReusesSavedCredentials();
  await testFailedReconnectDoesNotCreateAnotherApp();
  await testExistingAppReauthorizationTargetsTheSameApp();
  await testPluginConnectionWaiter();
  process.stdout.write('Feishu existing-app reconnect tests passed.\n');
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
