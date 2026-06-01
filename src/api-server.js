const http = require('node:http');
const { URL } = require('node:url');
const { loadConfig, saveConfig } = require('./config');
const { CodexSessionManager } = require('./codexSessionManager');
const { RemoteSessionController } = require('./remoteSessionController');
const { PluginManager } = require('./plugins/pluginManager');
const { FeishuRegistrationManager } = require('./plugins/feishu/registrationManager');
const { createLogger } = require('./logger');
const { RawOutputRecorder } = require('./rawOutputRecorder');
const { buildResumeHint } = require('./resumeHint');

let config = loadConfig();
const host = config.api.host;
const port = Number(config.api.port);
const allowCommandOverride = Boolean(config.api.allowCommandOverride);
const apiToken = config.api.token || '';
const logger = createLogger();
const rawOutputRecorder = new RawOutputRecorder({ config, logger });
const manager = new CodexSessionManager({ config, outputRecorder: rawOutputRecorder });
const remoteController = new RemoteSessionController({
  sessionManager: manager,
  config,
  logger
});
const pluginManager = new PluginManager({
  config,
  services: { sessionManager: manager, remoteController },
  logger
});
let feishuRegistrationManager;

function cloneConfig(value = config) {
  return JSON.parse(JSON.stringify(value));
}

async function restartPlugins() {
  remoteController.updateConfig(config);
  rawOutputRecorder.updateConfig(config);
  manager.updateConfig(config);
  await pluginManager.restart(config);
}

async function applyFeishuRegistration(result) {
  const nextConfig = cloneConfig();
  const feishu = nextConfig.plugins.feishu || {};
  const userOpenId = result.user_info?.open_id || '';

  feishu.enabled = true;
  feishu.mode = 'long_connection';
  feishu.appId = result.client_id;
  feishu.appSecret = result.client_secret;
  feishu.connectSource = 'register_app';
  feishu.connectedAt = new Date().toISOString();
  feishu.authorizedOpenId = userOpenId;
  feishu.tenantBrand = result.user_info?.tenant_brand || '';
  feishu.allowedOpenIds = Array.isArray(feishu.allowedOpenIds)
    ? feishu.allowedOpenIds
    : [];

  if (userOpenId && !feishu.allowedOpenIds.includes(userOpenId)) {
    feishu.allowedOpenIds.push(userOpenId);
  }

  nextConfig.plugins.feishu = feishu;
  config = saveConfig(nextConfig);
  rawOutputRecorder.updateConfig(config);
  manager.updateConfig(config);

  let pluginError = '';
  try {
    await restartPlugins();
  } catch (error) {
    pluginError = error.message;
    console.error('Failed to restart plugins after Feishu registration:', error);
    logger.error('Failed to restart plugins after Feishu registration', {
      error: error.message
    });
  }

  return { configPath: config.configPath, pluginError };
}

function getFeishuRegistrationManager() {
  if (!feishuRegistrationManager) {
    feishuRegistrationManager = new FeishuRegistrationManager({
      logger,
      onComplete: applyFeishuRegistration
    });
  }

  return feishuRegistrationManager;
}

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'access-control-allow-origin': config.api.corsOrigin || 'http://localhost',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type'
  });
  res.end(data);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function matchSessionPath(pathname, suffix) {
  const match = pathname.match(/^\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return null;
  if ((suffix || '') !== (match[2] || '')) return null;
  return decodeURIComponent(match[1]);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (apiToken) {
    const expected = `Bearer ${apiToken}`;
    if (req.headers.authorization !== expected) {
      sendError(res, 401, 'Unauthorized');
      return;
    }
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      defaultCommand: manager.defaultCommand,
      defaultCwd: manager.defaultCwd,
      sessions: manager.list().length
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/sessions') {
    sendJson(res, 200, { sessions: manager.list() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/plugins') {
    sendJson(res, 200, { plugins: pluginManager.getStatuses() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/plugins/feishu/connect') {
    sendJson(res, 200, getFeishuRegistrationManager().getStatus());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/plugins/feishu/connect') {
    const body = await readBody(req);
    const status = getFeishuRegistrationManager().start({
      source: body.source || 'remote-codex-api'
    });
    sendJson(res, 202, status);
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/plugins/feishu/connect') {
    sendJson(res, 200, getFeishuRegistrationManager().cancel());
    return;
  }

  const pluginAction = url.pathname.match(/^\/plugins\/([^/]+)\/actions\/([^/]+)$/);
  if (req.method === 'POST' && pluginAction) {
    const body = await readBody(req);
    const result = await pluginManager.invoke(
      decodeURIComponent(pluginAction[1]),
      decodeURIComponent(pluginAction[2]),
      body
    );
    sendJson(res, 200, result || { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/sessions') {
    const body = await readBody(req);
    const session = manager.create({
      ...body,
      command: allowCommandOverride ? body.command : undefined,
      args: allowCommandOverride ? body.args : undefined
    });
    sendJson(res, 201, { session: session.status() });
    return;
  }

  const statusId = matchSessionPath(url.pathname, '');
  if (req.method === 'GET' && statusId) {
    sendJson(res, 200, { session: manager.get(statusId).status() });
    return;
  }

  const inputId = matchSessionPath(url.pathname, 'input');
  if (req.method === 'POST' && inputId) {
    const body = await readBody(req);
    if (typeof body.data !== 'string') {
      sendError(res, 400, '`data` must be a string');
      return;
    }
    manager.get(inputId).write(body.data);
    sendJson(res, 200, { ok: true });
    return;
  }

  const resizeId = matchSessionPath(url.pathname, 'resize');
  if (req.method === 'POST' && resizeId) {
    const body = await readBody(req);
    manager.get(resizeId).resize(body.cols, body.rows);
    sendJson(res, 200, { session: manager.get(resizeId).status() });
    return;
  }

  const outputId = matchSessionPath(url.pathname, 'output');
  if (req.method === 'GET' && outputId) {
    const cursor = Number(url.searchParams.get('cursor') || 0);
    sendJson(res, 200, manager.get(outputId).readAfter(cursor));
    return;
  }

  const deleteId = matchSessionPath(url.pathname, '');
  if (req.method === 'DELETE' && deleteId) {
    sendJson(res, 200, { session: manager.delete(deleteId) });
    return;
  }

  sendError(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    const notFound = /^Unknown session:/.test(error.message);
    sendError(res, notFound ? 404 : 500, error.message);
  });
});

server.listen(port, host, () => {
  console.log(`Codex API listening on http://${host}:${port}`);
  console.log(`Default command: ${manager.defaultCommand}`);
  console.log(`Default cwd: ${manager.defaultCwd}`);
  console.log(`Config path: ${config.configPath}`);
  console.log(`Log file: ${logger.logFile}`);
  logger.info('Remote Codex API started', {
    host,
    port,
    defaultCommand: manager.defaultCommand,
    defaultCwd: manager.defaultCwd,
    configPath: config.configPath,
    logFile: logger.logFile
  });
});

pluginManager.startEnabled().catch((error) => {
  console.error('Failed to start plugins:', error);
  logger.error('Failed to start plugins', { error: error.message });
});

let shuttingDown = false;
async function shutdown(signal = '') {
  if (shuttingDown) return;
  shuttingDown = true;
  if (signal) {
    const sessions = manager.list();
    const lastSession = sessions[sessions.length - 1];
    console.error(buildResumeHint({
      command: 'remote-codex-api',
      cwd: lastSession?.cwd || config.codex.defaultCwd,
      session: lastSession,
      reason: signal
    }));
  }
  await pluginManager.stopAll().catch((error) => {
    console.error('Failed to stop plugins:', error);
    logger.error('Failed to stop plugins', { error: error.message });
  });
  manager.killAll();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
