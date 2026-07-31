function hasSavedFeishuCredentials(config) {
  const feishu = config?.plugins?.feishu || {};
  return Boolean(String(feishu.appId || '').trim() && String(feishu.appSecret || '').trim());
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
  connectOrReconnectFeishu,
  hasSavedFeishuCredentials
};
