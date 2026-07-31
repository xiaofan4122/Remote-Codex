const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const { loadConfig, saveConfig } = require('./config');
const {
  CodexSessionManager,
  isCodexUpdateSuccessOutput
} = require('./codexSessionManager');
const { CodexAppServerRunner } = require('./codexAppServerRunner');
const { CodexExecRunner } = require('./codexExecRunner');
const { CodexRolloutReader } = require('./codexRolloutReader');
const { RemoteSessionController } = require('./remoteSessionController');
const { PluginManager } = require('./plugins/pluginManager');
const { FeishuRegistrationManager } = require('./plugins/feishu/registrationManager');
const { createLogger } = require('./logger');
const { RawOutputRecorder } = require('./rawOutputRecorder');
const { parseLaunchOptions, buildCodexArgs } = require('./launchOptions');
const { buildResumeHint } = require('./resumeHint');
const { buildRemoteInputNotice } = require('./remoteVisualNotice');
const { installBundledSkill } = require('./bundledSkillInstaller');
const { configureSingleInstance } = require('./singleInstanceCoordinator');
const { connectOrReconnectFeishu } = require('./feishuConnectionCoordinator');

let mainWindow;
let currentSession;
let config = loadConfig();
let remoteController;
let pluginManager;
let feishuRegistrationManager;
let signalShutdownStarted = false;
const launchOptions = parseLaunchOptions();
const CODEX_UPDATE_RESTART_DELAY_MS = 1200;

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
const hasSingleInstanceLock = configureSingleInstance({
  app,
  getMainWindow: () => mainWindow,
  logger
});
if (hasSingleInstanceLock) {
  installPackagedSkill();
}
const diagnosticOutputRecorder = createDiagnosticOutputRecorder(logger);
const manager = new CodexSessionManager({
  config,
  outputRecorder: diagnosticOutputRecorder
});
const execRunner = new CodexExecRunner({ config, logger });
const appServerRunner = new CodexAppServerRunner({ config, logger });
const rolloutReader = new CodexRolloutReader({ logger });

function installPackagedSkill() {
  try {
    const result = installBundledSkill({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      version: app.getVersion()
    });
    if (result.installed) {
      logger.info('Bundled Codex skill ready', {
        changed: result.changed,
        targetDir: result.targetDir
      });
    } else {
      logger.warn('Bundled Codex skill source is unavailable', {
        sourceDir: result.sourceDir,
        reason: result.reason
      });
    }
  } catch (error) {
    logger.warn('Failed to install bundled Codex skill', { error: error.message });
  }
}

function createDiagnosticOutputRecorder(diagnosticLogger) {
  if (!/^(1|true|yes|on)$/i.test(String(process.env.REMOTE_CODEX_DIAGNOSTIC_CAPTURE || ''))) {
    return null;
  }
  const recorder = new RawOutputRecorder({
    logger: diagnosticLogger,
    config: {
      remoteControl: {
        rawOutputLogEnabled: true,
        rawOutputLogPath: process.env.REMOTE_CODEX_DIAGNOSTIC_CAPTURE_PATH || '',
        rawOutputLogMaxBytes: 50 * 1024 * 1024,
        rawOutputLogRecordTerminalControls: true,
        rawOutputLogRecordParserTrace: true
      }
    }
  });
  diagnosticLogger.info('Native TUI diagnostic capture enabled', {
    logFile: recorder.logPath
  });
  return recorder;
}

function createPluginRuntime() {
  remoteController = new RemoteSessionController({
    sessionManager: manager,
    execRunner,
    appServerRunner,
    rolloutReader,
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
      writeVisualNotice({
        source: 'Feishu',
        userId: message.userId || 'user',
        text
      });
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
  feishu.singleCardOutput = true;
  feishu.streaming = true;
  feishu.segmentedOutput = false;
  feishu.ackReactionEnabled = true;
  feishu.ackReactionEmoji = '了解';
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return mainWindow;
  }

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
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
  installContextMenu(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
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

function writeVisualNotice(notice) {
  const data = buildRemoteInputNotice({
    ...notice,
    cols: currentSession?.cols || 100
  });
  mainWindow?.webContents.send(
    'terminal:data',
    data
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
    const shouldRestartAfterUpdate =
      exitCode === 0 &&
      !signal &&
      isCodexUpdateSuccessOutput(session.outputTail);
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
      signal: signal || null,
      restartAfterUpdate: shouldRestartAfterUpdate
    });
    if (shouldRestartAfterUpdate) {
      mainWindow?.webContents.send(
        'terminal:data',
        '\r\n[Remote Codex] Codex update completed; restarting Codex...\r\n'
      );
      setTimeout(() => {
        if (!currentSession) {
          startCodex(session.cwd || cwd || config.codex.defaultCwd);
        }
      }, CODEX_UPDATE_RESTART_DELAY_MS);
    }
  });

  mainWindow?.webContents.send('session:cwd', cwd);
  return session;
}

if (!hasSingleInstanceLock) {
  // configureSingleInstance already requested shutdown before plugin startup.
} else {
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

  ipcMain.handle('feishu:connect-start', async (_event, nextConfig) => {
    if (nextConfig && typeof nextConfig === 'object') {
      const nextFeishu = nextConfig.plugins?.feishu;
      if (nextFeishu?.appId && nextFeishu?.appSecret) {
        nextFeishu.enabled = true;
        nextFeishu.mode = 'long_connection';
      }
      config = saveConfig(nextConfig);
      manager.updateConfig(config);
      execRunner.updateConfig(config);
      appServerRunner.updateConfig(config);
      remoteController?.updateConfig(config);
      mainWindow?.webContents.send('config:updated', config);
    }

    return connectOrReconnectFeishu({
      config,
      restartPlugins,
      getFeishuPlugin: () => pluginManager?.getInstance('feishu'),
      registrationManager: getFeishuRegistrationManager(),
      logger
    });
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
    ingestTerminalSnapshot(text);
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
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    });
  });
}

app.on('before-quit', () => {
  feishuRegistrationManager?.cancel();
  pluginManager?.stopAll().catch((error) => {
    console.error('Failed to stop plugins:', error);
    logger.error('Failed to stop plugins', { error: error.message });
  });
  rolloutReader.stopAll();
  manager.killAll();
  appServerRunner.stop();
});

function handleProcessSignal(signal) {
  if (signalShutdownStarted) return;
  signalShutdownStarted = true;
  console.error(buildResumeHint({
    command: 'remote-codex',
    cwd: currentSession?.cwd || config.codex.defaultCwd,
    session: currentSession,
    reason: signal
  }));
  app.quit();
}

process.on('SIGINT', () => handleProcessSignal('SIGINT'));
process.on('SIGTERM', () => handleProcessSignal('SIGTERM'));

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

function ingestTerminalSnapshot(text) {
  if (!currentSession) return;

  if (text && typeof text === 'object') {
    const snapshot = { ...text };
    delete snapshot.requestId;
    currentSession.recordSnapshot(snapshot);
    currentSession.visualSnapshot = String(snapshot.scrollback || '');
    currentSession.visualViewportSnapshot = String(snapshot.viewport || '');
    currentSession.visualStyledSnapshot = normalizeStyledSnapshot(
      snapshot.styledScrollback
    );
    currentSession.visualStyledViewportSnapshot = normalizeStyledSnapshot(
      snapshot.styledViewport
    );
    currentSession.emit('snapshot', snapshot);
    return;
  }

  currentSession.recordSnapshot(text);
  currentSession.visualSnapshot = String(text || '');
  currentSession.visualViewportSnapshot = String(text || '');
  currentSession.visualStyledSnapshot = null;
  currentSession.visualStyledViewportSnapshot = null;
  currentSession.emit('snapshot', text);
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
