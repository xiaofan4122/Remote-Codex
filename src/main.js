const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, saveConfig } = require('./config');
const { CodexSessionManager } = require('./codexSessionManager');
const { CodexAppServerRunner } = require('./codexAppServerRunner');
const { CodexExecRunner } = require('./codexExecRunner');
const { RemoteSessionController } = require('./remoteSessionController');
const { PluginManager } = require('./plugins/pluginManager');
const { FeishuRegistrationManager } = require('./plugins/feishu/registrationManager');
const { createLogger } = require('./logger');
const { RawOutputRecorder } = require('./rawOutputRecorder');
const { readCaptureView } = require('./terminalCaptureViewer');
const { parseLaunchOptions, buildCodexArgs } = require('./launchOptions');

let mainWindow;
let currentSession;
let config = loadConfig();
let remoteController;
let pluginManager;
let feishuRegistrationManager;
const launchOptions = parseLaunchOptions();

const MAIN_I18N = {
  'zh-CN': {
    chooseProjectDirectory: '选择项目目录',
    contextCopy: '复制',
    contextPaste: '粘贴',
    contextSelectAll: '全选'
  },
  en: {
    chooseProjectDirectory: 'Choose project directory',
    contextCopy: 'Copy',
    contextPaste: 'Paste',
    contextSelectAll: 'Select All'
  }
};

const logger = createLogger();
const rawOutputRecorder = new RawOutputRecorder({ config, logger });
const manager = new CodexSessionManager({ config, outputRecorder: rawOutputRecorder });
const execRunner = new CodexExecRunner({ config, logger });
const appServerRunner = new CodexAppServerRunner({ config, logger });

function createPluginRuntime() {
  remoteController = new RemoteSessionController({
    sessionManager: manager,
    execRunner: appServerRunner,
    config,
    logger,
    sharedSessionProvider: ({ cwd, restart }) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return null;
      }

      if (restart || !currentSession) {
        return { session: startCodex(cwd) };
      }

      return { session: currentSession };
    },
    onRemoteInput: ({ message, text, state }) => {
      if (!state.shared) return;
      writeVisualNotice(`Feishu ${message.userId || 'user'}: ${text}`);
    }
  });
  pluginManager = new PluginManager({
    config,
    services: { sessionManager: manager, remoteController },
    logger
  });
  logger.info('Remote Codex logger initialized', { logFile: logger.logFile });
}

async function restartPlugins() {
  remoteController?.updateConfig(config);
  rawOutputRecorder.updateConfig(config);
  manager.updateConfig(config);
  execRunner.updateConfig(config);
  appServerRunner.updateConfig(config);
  await pluginManager?.restart(config);
}

function cloneConfig(value = config) {
  return JSON.parse(JSON.stringify(value));
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
  execRunner.updateConfig(config);
  appServerRunner.updateConfig(config);

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

  mainWindow?.webContents.send('config:updated', config);
  return { configPath: config.configPath, pluginError };
}

function getFeishuRegistrationManager() {
  if (!feishuRegistrationManager) {
    feishuRegistrationManager = new FeishuRegistrationManager({
      logger,
      onComplete: applyFeishuRegistration,
      onUpdate: (status) => {
        mainWindow?.webContents.send('feishu:connect-status', status);
      }
    });
  }

  return feishuRegistrationManager;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'Remote Codex',
    backgroundColor: '#111418',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
  installContextMenu(mainWindow);
}

function installContextMenu(window) {
  window.webContents.on('context-menu', (_event, params) => {
    Menu.buildFromTemplate([
      {
        label: mainText('contextCopy'),
        role: 'copy',
        enabled: Boolean(params.selectionText)
      },
      {
        label: mainText('contextPaste'),
        role: 'paste'
      },
      { type: 'separator' },
      {
        label: mainText('contextSelectAll'),
        role: 'selectAll'
      }
    ]).popup({ window });
  });
}

function writeVisualNotice(message) {
  const safeMessage = String(message || '').replace(/\r/g, '').trim();
  if (!safeMessage) return;
  mainWindow?.webContents.send(
    'terminal:data',
    `\r\n\x1b[38;5;111m[Remote Codex] ${safeMessage}\x1b[0m\r\n`
  );
}

function startCodex(cwd = config.codex.defaultCwd) {
  if (currentSession) {
    manager.delete(currentSession.id);
    currentSession = null;
  }

  const args = buildCodexArgs(config.codex.args, launchOptions);
  currentSession = manager.create({ cwd, args, cols: 120, rows: 34 });
  const session = currentSession;
  logger.event('visual.session.started', {
    sessionId: session.id,
    cwd,
    args
  });

  session.on('data', (chunk) => {
    mainWindow?.webContents.send('terminal:data', chunk.data);
  });

  session.on('exit', ({ exitCode, signal }) => {
    mainWindow?.webContents.send(
      'terminal:data',
      `\r\n[Codex exited: code=${exitCode}, signal=${signal || 'none'}]\r\n`
    );
    if (currentSession?.id === session.id) {
      currentSession = null;
    }
    logger.event('visual.session.exited', {
      sessionId: session.id,
      exitCode,
      signal: signal || null
    });
  });

  mainWindow?.webContents.send('session:cwd', cwd);
  return session;
}

app.whenReady().then(() => {
  createPluginRuntime();
  createWindow();

  ipcMain.handle('session:start', (_event, cwd) => {
    startCodex(cwd || config.codex.defaultCwd);
  });

  ipcMain.handle('session:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mainText('chooseProjectDirectory'),
      defaultPath: config.codex.defaultCwd,
      properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const cwd = result.filePaths[0];
    startCodex(cwd);
    return cwd;
  });

  ipcMain.handle('config:get', () => config);

  ipcMain.handle('config:save', async (_event, nextConfig) => {
    config = saveConfig(nextConfig || config);
    rawOutputRecorder.updateConfig(config);
    manager.updateConfig(config);
    execRunner.updateConfig(config);
    appServerRunner.updateConfig(config);

    let pluginError = '';
    try {
      await restartPlugins();
    } catch (error) {
      pluginError = error.message;
      console.error('Failed to restart plugins:', error);
      logger.error('Failed to restart plugins', { error: error.message });
    }

    return { config, pluginError };
  });

  ipcMain.handle('plugins:status', () => pluginManager.getStatuses());

  ipcMain.handle('plugins:action', async (_event, pluginId, action, payload) => {
    return pluginManager.invoke(pluginId, action, payload);
  });

  ipcMain.handle('logs:open-raw-output', async () => {
    const logPath = rawOutputRecorder.logPath;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.closeSync(fs.openSync(logPath, 'a'));
    const error = await shell.openPath(logPath);
    if (error) {
      shell.showItemInFolder(logPath);
    }
    return { ok: true, path: logPath, openedFile: !error };
  });

  ipcMain.handle('logs:capture-view', (_event, options) => {
    return readCaptureView(rawOutputRecorder.logPath, options);
  });

  ipcMain.handle('debug:state', () => {
    return remoteController?.buildDebugState(currentSession) || {
      at: new Date().toISOString(),
      phase: currentSession ? 'idle' : 'detached',
      busy: false,
      hasRemoteState: false,
      remote: null,
      session: currentSession?.status?.() || null,
      detection: {},
      text: {}
    };
  });

  ipcMain.handle('feishu:connect-start', async (_event, nextConfig) => {
    if (nextConfig && typeof nextConfig === 'object') {
      config = saveConfig(nextConfig);
      rawOutputRecorder.updateConfig(config);
      manager.updateConfig(config);
      execRunner.updateConfig(config);
      appServerRunner.updateConfig(config);
      remoteController?.updateConfig(config);
      mainWindow?.webContents.send('config:updated', config);
    }

    return getFeishuRegistrationManager().start();
  });

  ipcMain.handle('feishu:connect-cancel', () => {
    return getFeishuRegistrationManager().cancel();
  });

  ipcMain.handle('feishu:connect-status', () => {
    return getFeishuRegistrationManager().getStatus();
  });

  ipcMain.handle('open-external', async (_event, targetUrl) => {
    const url = new URL(String(targetUrl || ''));
    if (url.protocol !== 'https:') {
      throw new Error('Only HTTPS links can be opened.');
    }

    await shell.openExternal(url.toString());
    return { ok: true };
  });

  ipcMain.on('terminal:input', (_event, data) => {
    currentSession?.write(data);
  });

  ipcMain.on('terminal:resize', (_event, size) => {
    if (!currentSession || !size) return;
    currentSession.resize(size.cols, size.rows);
  });

  ipcMain.on('terminal:snapshot', (_event, text) => {
    if (!currentSession) return;
    currentSession.recordSnapshot(text);
    if (text && typeof text === 'object') {
      currentSession.visualSnapshot = String(text.scrollback || '');
      currentSession.visualViewportSnapshot = String(text.viewport || '');
      currentSession.visualStyledSnapshot = normalizeStyledSnapshot(
        text.styledScrollback
      );
      currentSession.visualStyledViewportSnapshot = normalizeStyledSnapshot(
        text.styledViewport
      );
      return;
    }
    currentSession.visualSnapshot = String(text || '');
    currentSession.visualViewportSnapshot = String(text || '');
    currentSession.visualStyledSnapshot = null;
    currentSession.visualStyledViewportSnapshot = null;
  });

  mainWindow.webContents.once('did-finish-load', () => {
    startCodex(config.codex.defaultCwd);
    runVisualSmokeTestIfRequested();
  });

  pluginManager.startEnabled().catch((error) => {
    console.error('Failed to start plugins:', error);
    logger.error('Failed to start plugins', { error: error.message });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  feishuRegistrationManager?.cancel();
  pluginManager?.stopAll().catch((error) => {
    console.error('Failed to stop plugins:', error);
    logger.error('Failed to stop plugins', { error: error.message });
  });
  manager.killAll();
  appServerRunner.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function runVisualSmokeTestIfRequested() {
  const text = process.env.REMOTE_CODEX_VISUAL_SMOKE_TEXT;
  if (!text) return;

  setTimeout(async () => {
    let replied = false;
    const timeout = setTimeout(() => {
      if (!replied) {
        console.error('[visual-smoke] timed out waiting for remote reply');
        app.exit(2);
      }
    }, Number(process.env.REMOTE_CODEX_VISUAL_SMOKE_TIMEOUT_MS) || 60000);

    try {
      await remoteController.handleMessage({
        pluginId: 'visual-smoke',
        conversationId: 'visual-smoke',
        userId: 'visual-smoke',
        text,
        reply: async (replyText) => {
          replied = true;
          clearTimeout(timeout);
          console.log(`[visual-smoke-reply] ${replyText}`);
          if (process.env.REMOTE_CODEX_VISUAL_SMOKE_PRINT_SNAPSHOT === '1') {
            console.log(
              `[visual-smoke-snapshot] ${currentSession?.visualSnapshot || ''}`
            );
          }
          app.exit(0);
        }
      });
    } catch (error) {
      clearTimeout(timeout);
      console.error('[visual-smoke] failed', error);
      app.exit(1);
    }
  }, Number(process.env.REMOTE_CODEX_VISUAL_SMOKE_DELAY_MS) || 12000);
}

function mainText(key) {
  const language = config.ui?.language === 'en' ? 'en' : 'zh-CN';
  return MAIN_I18N[language]?.[key] || MAIN_I18N.en[key] || key;
}

function normalizeStyledSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.lines)) {
    return null;
  }

  const lines = snapshot.lines
    .map(normalizeStyledSnapshotLine)
    .filter((line) => line && line.text.trim());

  return lines.length > 0 ? { lines } : null;
}

function normalizeStyledSnapshotLine(line) {
  if (!line || typeof line !== 'object') return null;
  return {
    text: String(line.text || '').trimEnd(),
    firstChar: String(line.firstChar || '').slice(0, 8),
    firstStyle: normalizeTerminalCellStyle(line.firstStyle),
    bulletStyle: normalizeTerminalCellStyle(line.bulletStyle)
  };
}

function normalizeTerminalCellStyle(style) {
  if (!style || typeof style !== 'object') return null;
  const fgMode = normalizeTerminalColorMode(style.fgMode);
  const bgMode = normalizeTerminalColorMode(style.bgMode);
  return {
    fgMode,
    fg: normalizeColorNumber(style.fg),
    bgMode,
    bg: normalizeColorNumber(style.bg),
    bold: Boolean(style.bold),
    dim: Boolean(style.dim),
    italic: Boolean(style.italic)
  };
}

function normalizeTerminalColorMode(mode) {
  return mode === 'rgb' || mode === 'palette' ? mode : 'default';
}

function normalizeColorNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
