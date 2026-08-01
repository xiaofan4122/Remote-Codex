function hasSavedFeishuCredentials(config) {
  const feishu = config?.plugins?.feishu || {};
  return Boolean(String(feishu.appId || '').trim() && String(feishu.appSecret || '').trim());
}

function clearFeishuConnection(config) {
  const next = JSON.parse(JSON.stringify(config || {}));
  next.plugins = next.plugins || {};
  next.plugins.feishu = {
    ...(next.plugins.feishu || {}),
    enabled: false,
    mode: 'long_connection',
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
  };
  return next;
}

async function resetFeishuConnection({
  config,
  persistConfig,
  restartPlugins,
  registrationManager,
  logger = console
}) {
  const previousAppId = config?.plugins?.feishu?.appId || '';
  const savedConfig = await persistConfig(clearFeishuConnection(config));

  await restartPlugins(savedConfig);
  logger.event?.('feishu.connection.reset', {
    previousAppId: maskAppId(previousAppId)
  });

  return {
    config: savedConfig,
    status: registrationManager.start()
  };
}

async function connectOrReconnectFeishu({
  config,
  restartPlugins,
  getFeishuPlugin,
  registrationManager,
  logger = console,
  connectionTimeoutMs = 15000
}) {
  const feishu = config?.plugins?.feishu || {};
  if (!hasSavedFeishuCredentials(config)) {
    return registrationManager.start();
  }

  try {
    await restartPlugins();
    const plugin = getFeishuPlugin?.();
    if (!plugin) {
      throw new Error('Feishu plugin did not start.');
    }
    if (typeof plugin.waitUntilConnected === 'function') {
      const connected = await plugin.waitUntilConnected(connectionTimeoutMs);
      if (!connected) {
        throw new Error('Timed out waiting for the saved Feishu app to reconnect.');
      }
    }
    return registrationManager.completeExistingConnection({
      appId: feishu.appId,
      userOpenId: feishu.authorizedOpenId || '',
      tenantBrand: feishu.tenantBrand || '',
      connectedAt: new Date().toISOString()
    });
  } catch (error) {
    logger.warn?.('Failed to reconnect saved Feishu app', {
      appId: maskAppId(feishu.appId),
      error: error.message
    });
    return registrationManager.failExistingConnection({
      appId: feishu.appId,
      error: error.message
    });
  }
}

function maskAppId(appId) {
  const value = String(appId || '');
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

module.exports = {
  clearFeishuConnection,
  connectOrReconnectFeishu,
  hasSavedFeishuCredentials,
  resetFeishuConnection
};
