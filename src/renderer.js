const terminalElement = document.getElementById('terminal');
const terminalScrollbar = document.getElementById('terminalScrollbar');
const terminalScrollSpacer = document.getElementById('terminalScrollSpacer');
const cwdElement = document.getElementById('cwd');
const chooseDirButton = document.getElementById('chooseDir');
const restartButton = document.getElementById('restart');
const settingsButton = document.getElementById('settings');
const captureLogsButton = document.getElementById('captureLogs');
const toggleDebugPanelButton = document.getElementById('toggleDebugPanel');
const settingsPanel = document.getElementById('settingsPanel');
const settingsForm = document.getElementById('settingsForm');
const closeSettingsButton = document.getElementById('closeSettings');
const languageSelect = document.getElementById('uiLanguage');
const debugPanelCheckbox = document.getElementById('debugPanelEnabled');
const rawOutputLogCheckbox = document.getElementById('rawOutputLogEnabled');
const rawOutputLogControlsCheckbox = document.getElementById('rawOutputLogRecordTerminalControls');
const openRawOutputLogButton = document.getElementById('openRawOutputLog');
const connectFeishuButton = document.getElementById('connectFeishu');
const cancelFeishuConnectButton = document.getElementById('cancelFeishuConnect');
const openFeishuConnectButton = document.getElementById('openFeishuConnect');
const feishuConnectState = document.getElementById('feishuConnectState');
const feishuConnectQr = document.getElementById('feishuConnectQr');
const feishuConnectLink = document.getElementById('feishuConnectLink');
const settingsStatus = document.getElementById('settingsStatus');
const captureLogPanel = document.getElementById('captureLogPanel');
const captureLogPath = document.getElementById('captureLogPath');
const captureLogSession = document.getElementById('captureLogSession');
const captureLogType = document.getElementById('captureLogType');
const captureLogAutoRefresh = document.getElementById('captureLogAutoRefresh');
const captureLogIncludeNoise = document.getElementById('captureLogIncludeNoise');
const captureLogStatus = document.getElementById('captureLogStatus');
const captureLogStats = document.getElementById('captureLogStats');
const captureLogEvents = document.getElementById('captureLogEvents');
const captureLogDetailTitle = document.getElementById('captureLogDetailTitle');
const captureLogDetail = document.getElementById('captureLogDetail');
const captureLogContentTab = document.getElementById('captureLogContentTab');
const captureLogMetadataTab = document.getElementById('captureLogMetadataTab');
const refreshCaptureLogsButton = document.getElementById('refreshCaptureLogs');
const openCaptureLogFileButton = document.getElementById('openCaptureLogFile');
const closeCaptureLogsButton = document.getElementById('closeCaptureLogs');
const debugPanel = document.getElementById('debugPanel');
const debugPanelUpdated = document.getElementById('debugPanelUpdated');
const debugPanelBody = document.getElementById('debugPanelBody');
const closeDebugPanelButton = document.getElementById('closeDebugPanel');

let currentCwd = null;
let currentConfig = null;
let currentLanguage = 'zh-CN';
let currentFeishuStatus = { status: 'idle' };
let feishuConnectUrl = '';
let fitFrame = null;
let snapshotTimer = null;
let lastSize = { cols: 0, rows: 0 };
let scrollbarSyncing = false;
let captureLogView = null;
let selectedCaptureEventId = '';
let captureLogDetailMode = 'content';
let captureLogRefreshTimer = null;
let debugPanelRefreshTimer = null;
const TERMINAL_MIN_COLS = 2;
const TERMINAL_MIN_ROWS = 1;

const I18N = {
  'zh-CN': {
    starting: '启动中...',
    openProject: '打开项目',
    restartCodex: '重启 Codex',
    settings: '设置',
    captureLogs: '采集日志',
    close: '关闭',
    interface: '界面',
    language: '语言',
    languageChinese: '中文',
    languageEnglish: 'English',
    debugPanel: '状态调试',
    debugPanelEnabled: '显示状态调试面板',
    debugPanelUnavailable: '状态暂不可用。',
    terminalScrollback: '终端滚动历史',
    defaultWorkingDirectory: '默认工作目录',
    rawOutputLogEnabled: '记录 Codex 原始输出',
    rawOutputLogRecordTerminalControls: '记录终端控制事件',
    openLog: '打开日志',
    rawOutputLogOpened: '日志已打开。',
    rawOutputLogOpenFailed: '打开日志失败。',
    refresh: '刷新',
    openRawFile: '打开原始文件',
    session: '会话',
    allSessions: '全部会话',
    eventType: '事件类型',
    allEventTypes: '全部类型',
    autoRefresh: '自动刷新',
    includeTerminalControls: '显示终端控制事件',
    content: '内容',
    metadata: '元数据',
    selectEvent: '选择事件查看详情',
    captureEmpty: '暂无采集事件。',
    captureLoadFailed: '加载采集日志失败。',
    connection: '连接',
    notConnected: '未连接。',
    connectFeishu: '连接飞书',
    reconnectFeishu: '重新连接飞书',
    openLink: '打开链接',
    cancel: '取消',
    save: '保存',
    loadingSettings: '正在加载设置...',
    settingsLoaded: '设置已加载。',
    savingSettings: '正在保存设置...',
    settingsSaved: '设置已保存。',
    savedPluginError: '已保存。插件错误：{error}',
    couldNotOpenFeishuLink: '无法打开飞书链接。',
    preparingFeishuAuthorization: '正在准备飞书授权...',
    failedStartFeishuAuthorization: '启动飞书授权失败。',
    failedCancelFeishuAuthorization: '取消飞书授权失败。',
    configured: '已配置：{value}',
    connected: '已连接：{value}',
    feishuConnectedSaved: '飞书已连接并保存。请在飞书开发者后台配置并发布悬浮菜单。',
    feishuBotMenuHint: '机器人菜单需在飞书开发者后台配置并发布：状态 /status、历史会话 /resume、权限模式 /permission。建议使用悬浮菜单和“发送文字消息”动作。',
    feishuStatusStarting: '正在准备飞书授权...',
    feishuStatusWaiting: '打开飞书授权链接继续。',
    feishuStatusPolling: '正在等待飞书授权...',
    feishuStatusSlowDown: '飞书要求降低轮询频率。',
    feishuStatusDomainSwitched: '已切换到 Lark 授权域名。',
    feishuStatusAborting: '正在取消飞书授权...',
    feishuStatusAborted: '已取消飞书授权。',
    feishuStatusError: '飞书连接失败。'
  },
  en: {
    starting: 'Starting...',
    openProject: 'Open Project',
    restartCodex: 'Restart Codex',
    settings: 'Settings',
    captureLogs: 'Capture Logs',
    close: 'Close',
    interface: 'Interface',
    language: 'Language',
    languageChinese: '中文',
    languageEnglish: 'English',
    debugPanel: 'State Debug',
    debugPanelEnabled: 'Show state debug panel',
    debugPanelUnavailable: 'State is not available.',
    terminalScrollback: 'Terminal scrollback',
    defaultWorkingDirectory: 'Default working directory',
    rawOutputLogEnabled: 'Record raw Codex output',
    rawOutputLogRecordTerminalControls: 'Record terminal control events',
    openLog: 'Open Log',
    rawOutputLogOpened: 'Log opened.',
    rawOutputLogOpenFailed: 'Failed to open log.',
    refresh: 'Refresh',
    openRawFile: 'Open Raw File',
    session: 'Session',
    allSessions: 'All sessions',
    eventType: 'Event type',
    allEventTypes: 'All types',
    autoRefresh: 'Auto refresh',
    includeTerminalControls: 'Show terminal control events',
    content: 'Content',
    metadata: 'Metadata',
    selectEvent: 'Select an event to inspect',
    captureEmpty: 'No capture events.',
    captureLoadFailed: 'Failed to load capture log.',
    connection: 'Connection',
    notConnected: 'Not connected.',
    connectFeishu: 'Connect Feishu',
    reconnectFeishu: 'Reconnect Feishu',
    openLink: 'Open Link',
    cancel: 'Cancel',
    save: 'Save',
    loadingSettings: 'Loading settings...',
    settingsLoaded: 'Settings loaded.',
    savingSettings: 'Saving settings...',
    settingsSaved: 'Settings saved.',
    savedPluginError: 'Saved. Plugin error: {error}',
    couldNotOpenFeishuLink: 'Could not open Feishu link.',
    preparingFeishuAuthorization: 'Preparing Feishu authorization...',
    failedStartFeishuAuthorization: 'Failed to start Feishu authorization.',
    failedCancelFeishuAuthorization: 'Failed to cancel Feishu authorization.',
    configured: 'Configured: {value}',
    connected: 'Connected: {value}',
    feishuConnectedSaved: 'Feishu connected and saved. Configure and publish the floating bot menu in the Feishu Developer Console.',
    feishuBotMenuHint: 'Configure and publish the bot menu in the Feishu Developer Console: Status /status, Sessions /resume, Permissions /permission. Use the floating menu and Send text message actions.',
    feishuStatusStarting: 'Preparing Feishu authorization...',
    feishuStatusWaiting: 'Open the Feishu authorization link to continue.',
    feishuStatusPolling: 'Waiting for Feishu authorization...',
    feishuStatusSlowDown: 'Feishu asked to slow down polling.',
    feishuStatusDomainSwitched: 'Switched to Lark authorization domain.',
    feishuStatusAborting: 'Cancelling Feishu authorization...',
    feishuStatusAborted: 'Feishu authorization cancelled.',
    feishuStatusError: 'Feishu connection failed.'
  }
};

const fitAddon = new FitAddon.FitAddon();
const term = new Terminal({
  cursorBlink: true,
  convertEol: true,
  scrollback: 50000,
  fastScrollModifier: 'alt',
  fastScrollSensitivity: 5,
  scrollOnUserInput: true,
  smoothScrollDuration: 0,
  fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
  fontSize: 14,
  lineHeight: 1.25,
  theme: {
    background: '#111418',
    foreground: '#e8edf2',
    cursor: '#f7c948',
    selectionBackground: '#334155',
    black: '#111418',
    red: '#ff6b6b',
    green: '#6ee7b7',
    yellow: '#f7c948',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#67e8f9',
    white: '#e8edf2',
    brightBlack: '#64748b',
    brightRed: '#fb7185',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#a5f3fc',
    brightWhite: '#ffffff'
  }
});

term.loadAddon(fitAddon);
term.open(terminalElement);

function fit() {
  const size = proposeTerminalSize();
  if (size) {
    if (term.cols !== size.cols || term.rows !== size.rows) {
      term._core?._renderService?.clear?.();
      term.resize(size.cols, size.rows);
      term.refresh(0, Math.max(0, term.rows - 1));
    }
  } else {
    fitAddon.fit();
  }
  updateTerminalScrollbar();

  if (term.cols === lastSize.cols && term.rows === lastSize.rows) {
    return;
  }

  lastSize = {
    cols: term.cols,
    rows: term.rows
  };
  window.codexShell.resize(lastSize);
}

function proposeTerminalSize() {
  const cellSize = getTerminalCellSize();
  const xtermElement = term.element;
  if (!cellSize || !xtermElement || !terminalElement.clientWidth || !terminalElement.clientHeight) {
    return null;
  }

  const xtermStyle = window.getComputedStyle(xtermElement);
  const horizontalPadding =
    parseCssPixels(xtermStyle.paddingLeft) + parseCssPixels(xtermStyle.paddingRight);
  const verticalPadding =
    parseCssPixels(xtermStyle.paddingTop) + parseCssPixels(xtermStyle.paddingBottom);
  const availableWidth = Math.max(0, terminalElement.clientWidth - horizontalPadding);
  const availableHeight = Math.max(0, terminalElement.clientHeight - verticalPadding);

  return {
    cols: Math.max(TERMINAL_MIN_COLS, Math.floor(availableWidth / cellSize.width)),
    rows: Math.max(TERMINAL_MIN_ROWS, Math.floor(availableHeight / cellSize.height))
  };
}

function getTerminalCellSize() {
  const cell = term._core?._renderService?.dimensions?.css?.cell;
  if (cell?.width > 0 && cell?.height > 0) {
    return {
      width: cell.width,
      height: cell.height
    };
  }

  const screen = terminalElement.querySelector('.xterm-screen');
  if (screen?.clientWidth > 0 && screen?.clientHeight > 0 && term.cols > 0 && term.rows > 0) {
    return {
      width: screen.clientWidth / term.cols,
      height: screen.clientHeight / term.rows
    };
  }

  return null;
}

function parseCssPixels(value) {
  const parsed = Number.parseFloat(String(value || '0'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function requestFit() {
  if (fitFrame) {
    return;
  }

  fitFrame = requestAnimationFrame(() => {
    fitFrame = null;
    fit();
  });
}

window.codexShell.onData((data) => {
  term.write(data, () => {
    scheduleTerminalSnapshot();
    updateTerminalScrollbar();
  });
});
window.codexShell.onCwd((cwd) => {
  currentCwd = cwd;
  cwdElement.textContent = cwd;
});
window.codexShell.onConfigUpdated((config) => {
  currentConfig = config;
  setLanguage(config.ui?.language);
  syncDebugPanel(config);
  if (settingsPanel.getAttribute('aria-hidden') === 'false') {
    populateSettings(config);
  }
});
window.codexShell.onFeishuConnectStatus((status) => {
  renderFeishuConnectStatus(status);
  if (status.status === 'complete') {
    loadSettings();
  }
});

term.onData((data) => window.codexShell.write(data));
term.onScroll(() => updateTerminalScrollbar());

terminalScrollbar.addEventListener('scroll', () => {
  if (scrollbarSyncing) return;
  const rowHeight = getTerminalRowHeight();
  const buffer = term.buffer.active;
  const maxLine = Math.max(0, buffer.length - term.rows);
  const targetLine = Math.min(
    maxLine,
    Math.max(0, Math.round(terminalScrollbar.scrollTop / rowHeight))
  );
  term.scrollToLine(targetLine);
  term.refresh(0, Math.max(0, term.rows - 1));
  scheduleTerminalSnapshot();
});

function scheduleTerminalSnapshot() {
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
  }

  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    window.codexShell.snapshot({
      scrollback: readTerminalSnapshot(),
      viewport: readTerminalViewportSnapshot(),
      styledScrollback: readTerminalStyledSnapshot(),
      styledViewport: readTerminalStyledViewportSnapshot()
    });
  }, 40);
}

function updateTerminalScrollbar() {
  if (!terminalScrollbar || !terminalScrollSpacer) return;

  requestAnimationFrame(() => {
    const rowHeight = getTerminalRowHeight();
    const buffer = term.buffer.active;
    const scrollableRows = Math.max(0, buffer.length - term.rows);
    const maxScrollTop = scrollableRows * rowHeight;
    const spacerHeight = Math.max(
      terminalScrollbar.clientHeight,
      terminalScrollbar.clientHeight + maxScrollTop
    );

    terminalScrollSpacer.style.height = `${spacerHeight}px`;
    const nextScrollTop = Math.min(
      maxScrollTop,
      buffer.viewportY * rowHeight
    );

    if (Math.abs(terminalScrollbar.scrollTop - nextScrollTop) > 1) {
      scrollbarSyncing = true;
      terminalScrollbar.scrollTop = nextScrollTop;
      requestAnimationFrame(() => {
        scrollbarSyncing = false;
      });
    }
  });
}

function getTerminalRowHeight() {
  const screen = terminalElement.querySelector('.xterm-screen');
  const height = screen?.clientHeight || terminalElement.clientHeight || 1;
  return Math.max(1, height / Math.max(1, term.rows));
}

function readTerminalSnapshot() {
  const buffer = term.buffer.active;
  const lines = [];
  const start = Math.max(0, buffer.length - 300);
  let logicalLine = '';

  for (let index = start; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;

    const text = line.translateToString(true);
    if (line.isWrapped) {
      logicalLine += text;
      continue;
    }

    if (logicalLine) {
      lines.push(logicalLine);
    }
    logicalLine = text;
  }

  if (logicalLine) {
    lines.push(logicalLine);
  }

  return lines.join('\n');
}

function readTerminalStyledSnapshot() {
  const buffer = term.buffer.active;
  return readStyledTerminalRange(Math.max(0, buffer.length - 300), buffer.length);
}

function readTerminalViewportSnapshot() {
  const buffer = term.buffer.active;
  const lines = [];
  const start = Math.max(0, buffer.viewportY);
  const end = Math.min(buffer.length, start + term.rows);
  let logicalLine = '';

  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;

    const text = line.translateToString(true);
    if (line.isWrapped) {
      logicalLine += text;
      continue;
    }

    if (logicalLine) {
      lines.push(logicalLine);
    }
    logicalLine = text;
  }

  if (logicalLine) {
    lines.push(logicalLine);
  }

  return lines.join('\n');
}

function readTerminalStyledViewportSnapshot() {
  const buffer = term.buffer.active;
  const start = Math.max(0, buffer.viewportY);
  const end = Math.min(buffer.length, start + term.rows);
  return readStyledTerminalRange(start, end);
}

function readStyledTerminalRange(start, end) {
  const buffer = term.buffer.active;
  const lines = [];
  let logicalLine = null;

  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;

    const physicalLine = readStyledTerminalLine(line);
    if (line.isWrapped) {
      logicalLine = appendStyledLine(logicalLine, physicalLine);
      continue;
    }

    if (logicalLine?.text) {
      lines.push(logicalLine);
    }
    logicalLine = physicalLine;
  }

  if (logicalLine?.text) {
    lines.push(logicalLine);
  }

  return { lines };
}

function readStyledTerminalLine(line) {
  const text = line.translateToString(true);
  const maxCells = Math.min(line.length, term.cols);
  let firstStyle = null;
  let firstChar = '';
  let bulletStyle = null;

  for (let x = 0; x < maxCells; x += 1) {
    const cell = line.getCell(x);
    const chars = cell?.getChars?.() || '';
    if (!chars || !chars.trim()) continue;

    const style = serializeTerminalCellStyle(cell);
    firstStyle = style;
    firstChar = chars;
    if (/^[•●◦○■]$/.test(chars)) {
      bulletStyle = style;
    }
    break;
  }

  return {
    text,
    firstChar,
    firstStyle,
    bulletStyle
  };
}

function appendStyledLine(current, next) {
  if (!current) return next;
  return {
    text: `${current.text || ''}${next?.text || ''}`,
    firstChar: current.firstChar || next?.firstChar || '',
    firstStyle: current.firstStyle || next?.firstStyle || null,
    bulletStyle: current.bulletStyle || next?.bulletStyle || null
  };
}

function serializeTerminalCellStyle(cell) {
  if (!cell) return null;
  return {
    fgMode: getTerminalColorMode(cell, 'fg'),
    fg: Number(cell.getFgColor?.() || 0),
    bgMode: getTerminalColorMode(cell, 'bg'),
    bg: Number(cell.getBgColor?.() || 0),
    bold: Boolean(cell.isBold?.()),
    dim: Boolean(cell.isDim?.()),
    italic: Boolean(cell.isItalic?.())
  };
}

function getTerminalColorMode(cell, channel) {
  if (channel === 'fg') {
    if (cell.isFgRGB?.()) return 'rgb';
    if (cell.isFgPalette?.()) return 'palette';
    return 'default';
  }

  if (cell.isBgRGB?.()) return 'rgb';
  if (cell.isBgPalette?.()) return 'palette';
  return 'default';
}

chooseDirButton.addEventListener('click', async () => {
  await window.codexShell.chooseDirectory();
  setTimeout(requestFit, 100);
});

restartButton.addEventListener('click', async () => {
  term.reset();
  await window.codexShell.start(currentCwd);
  setTimeout(requestFit, 100);
});

settingsButton.addEventListener('click', async () => {
  settingsPanel.setAttribute('aria-hidden', 'false');
  await loadSettings();
});

captureLogsButton.addEventListener('click', async () => {
  captureLogPanel.setAttribute('aria-hidden', 'false');
  await loadCaptureLogView();
  scheduleCaptureLogRefresh();
});

closeCaptureLogsButton.addEventListener('click', closeCaptureLogPanel);

captureLogPanel.addEventListener('click', (event) => {
  if (event.target === captureLogPanel) {
    closeCaptureLogPanel();
  }
});

toggleDebugPanelButton.addEventListener('click', async () => {
  await setDebugPanelEnabled(debugPanel.getAttribute('aria-hidden') === 'true');
});

refreshCaptureLogsButton.addEventListener('click', loadCaptureLogView);

openCaptureLogFileButton.addEventListener('click', async () => {
  try {
    await window.codexShell.openRawOutputLog();
  } catch (error) {
    captureLogStatus.textContent = error.message || t('rawOutputLogOpenFailed');
  }
});

captureLogSession.addEventListener('change', loadCaptureLogView);
captureLogType.addEventListener('change', renderCaptureLogEvents);
captureLogAutoRefresh.addEventListener('change', scheduleCaptureLogRefresh);
captureLogIncludeNoise.addEventListener('change', loadCaptureLogView);
captureLogContentTab.addEventListener('click', () => setCaptureLogDetailMode('content'));
captureLogMetadataTab.addEventListener('click', () => setCaptureLogDetailMode('metadata'));

closeSettingsButton.addEventListener('click', () => {
  settingsPanel.setAttribute('aria-hidden', 'true');
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (captureLogPanel.getAttribute('aria-hidden') === 'false') {
    closeCaptureLogPanel();
  }
});

settingsPanel.addEventListener('click', (event) => {
  if (event.target === settingsPanel) {
    settingsPanel.setAttribute('aria-hidden', 'true');
  }
});

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveSettings();
});

languageSelect.addEventListener('change', () => {
  setLanguage(languageSelect.value);
  if (currentConfig) {
    renderFeishuConfiguredState(currentConfig);
  }
  renderFeishuConnectStatus(currentFeishuStatus);
});

connectFeishuButton.addEventListener('click', async () => {
  if (!currentConfig) {
    currentConfig = await window.codexShell.getConfig();
  }

  const nextConfig = collectSettings(currentConfig);
  renderFeishuConnectStatus({
    status: 'starting',
    message: t('preparingFeishuAuthorization')
  });

  try {
    const status = await window.codexShell.startFeishuConnect(nextConfig);
    renderFeishuConnectStatus(status);
  } catch (error) {
    renderFeishuConnectStatus({
      status: 'error',
      message: error.message || t('failedStartFeishuAuthorization')
    });
  }
});

cancelFeishuConnectButton.addEventListener('click', async () => {
  try {
    const status = await window.codexShell.cancelFeishuConnect();
    renderFeishuConnectStatus(status);
  } catch (error) {
    renderFeishuConnectStatus({
      status: 'error',
      message: error.message || t('failedCancelFeishuAuthorization')
    });
  }
});

openFeishuConnectButton.addEventListener('click', async () => {
  if (!feishuConnectUrl) return;

  try {
    await window.codexShell.openExternal(feishuConnectUrl);
  } catch (error) {
    setSettingsStatus(error.message || t('couldNotOpenFeishuLink'));
  }
});

openRawOutputLogButton.addEventListener('click', async () => {
  try {
    const result = await window.codexShell.openRawOutputLog();
    setSettingsStatus(result?.path ? `${t('rawOutputLogOpened')} ${result.path}` : t('rawOutputLogOpened'));
  } catch (error) {
    setSettingsStatus(error.message || t('rawOutputLogOpenFailed'));
  }
});

closeDebugPanelButton.addEventListener('click', async () => {
  await setDebugPanelEnabled(false);
});

window.addEventListener('resize', requestFit);
new ResizeObserver(requestFit).observe(terminalElement);
setTimeout(requestFit, 100);

window.codexShell.getConfig().then((config) => {
  currentConfig = config;
  setLanguage(config.ui?.language);
  syncDebugPanel(config);
}).catch(() => {
  setLanguage(currentLanguage);
});

async function loadSettings() {
  setSettingsStatus(t('loadingSettings'));
  currentConfig = await window.codexShell.getConfig();
  populateSettings(currentConfig);
  renderFeishuConnectStatus(await window.codexShell.getFeishuConnectStatus());
  setSettingsStatus(t('settingsLoaded'));
}

async function saveSettings() {
  if (!currentConfig) {
    currentConfig = await window.codexShell.getConfig();
  }

  const nextConfig = collectSettings(currentConfig);
  setSettingsStatus(t('savingSettings'));
  const result = await window.codexShell.saveConfig(nextConfig);
  currentConfig = result.config;
  populateSettings(currentConfig);
  syncDebugPanel(currentConfig);

  if (result.pluginError) {
    setSettingsStatus(t('savedPluginError', { error: result.pluginError }));
    return;
  }

  setSettingsStatus(t('settingsSaved'));
}

function populateSettings(config) {
  setLanguage(config.ui?.language);
  setValue('uiLanguage', currentLanguage);
  debugPanelCheckbox.checked = Boolean(config.ui?.debugPanelEnabled);
  setValue('codexDefaultCwd', config.codex?.defaultCwd || '');
  rawOutputLogCheckbox.checked = Boolean(config.remoteControl?.rawOutputLogEnabled);
  rawOutputLogControlsCheckbox.checked = Boolean(
    config.remoteControl?.rawOutputLogRecordTerminalControls
  );
  renderFeishuConfiguredState(config);
}

function renderFeishuConfiguredState(config) {
  const feishu = config.plugins?.feishu || {};
  if (feishu.appId) {
    feishuConnectState.textContent = t('configured', { value: maskValue(feishu.appId) });
    connectFeishuButton.textContent = t('reconnectFeishu');
  } else {
    feishuConnectState.textContent = t('notConnected');
    connectFeishuButton.textContent = t('connectFeishu');
  }
}

function collectSettings(baseConfig) {
  const next = structuredClone(baseConfig);
  next.codex = next.codex || {};
  next.ui = next.ui || {};
  next.remoteControl = next.remoteControl || {};
  next.plugins = next.plugins || {};
  next.plugins.feishu = next.plugins.feishu || {};

  next.ui.language = normalizeLanguage(getValue('uiLanguage'));
  next.ui.debugPanelEnabled = debugPanelCheckbox.checked;
  next.codex.defaultCwd = getValue('codexDefaultCwd');
  next.remoteControl.rawOutputLogEnabled = rawOutputLogCheckbox.checked;
  next.remoteControl.rawOutputLogRecordTerminalControls = rawOutputLogControlsCheckbox.checked;

  const feishu = next.plugins.feishu;
  next.remoteControl.autoCreateSession = true;
  next.remoteControl.sendOutput = true;
  next.remoteControl.outputMode = 'final';
  feishu.sendOutput = true;
  feishu.outputMode = 'final';

  return next;
}

function getValue(id) {
  return document.getElementById(id).value.trim();
}

function setValue(id, value) {
  document.getElementById(id).value = value;
}

function setSettingsStatus(message) {
  settingsStatus.textContent = message;
}

function syncDebugPanel(config = currentConfig) {
  const enabled = Boolean(config?.ui?.debugPanelEnabled);
  debugPanel.setAttribute('aria-hidden', enabled ? 'false' : 'true');
  toggleDebugPanelButton.classList.toggle('is-active', enabled);
  toggleDebugPanelButton.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  if (enabled) {
    refreshDebugPanel();
    scheduleDebugPanelRefresh();
  } else {
    clearDebugPanelRefresh();
  }
}

async function setDebugPanelEnabled(enabled) {
  if (!currentConfig) {
    currentConfig = await window.codexShell.getConfig();
  }
  const nextConfig = structuredClone(currentConfig);
  nextConfig.ui = nextConfig.ui || {};
  nextConfig.ui.debugPanelEnabled = Boolean(enabled);
  const result = await window.codexShell.saveConfig(nextConfig);
  currentConfig = result.config;
  populateSettings(currentConfig);
  syncDebugPanel(currentConfig);
}

function scheduleDebugPanelRefresh() {
  clearDebugPanelRefresh();
  debugPanelRefreshTimer = setInterval(refreshDebugPanel, 1000);
}

function clearDebugPanelRefresh() {
  if (debugPanelRefreshTimer) {
    clearInterval(debugPanelRefreshTimer);
    debugPanelRefreshTimer = null;
  }
}

async function refreshDebugPanel() {
  if (debugPanel.getAttribute('aria-hidden') === 'true') return;
  try {
    const state = await window.codexShell.getDebugState();
    renderDebugPanel(state);
  } catch (error) {
    debugPanelUpdated.textContent = t('debugPanelUnavailable');
    debugPanelBody.textContent = error.message || t('debugPanelUnavailable');
  }
}

function renderDebugPanel(state = {}) {
  debugPanelUpdated.textContent = state.at ? formatEventTime(state.at) : '--';
  debugPanelBody.replaceChildren();

  const summary = document.createElement('dl');
  summary.className = 'debug-summary';
  const session = state.session || {};
  const remote = state.remote || {};
  const detection = state.detection || {};
  const items = [
    ['phase', state.phase || 'unknown'],
    ['busy', String(Boolean(state.busy))],
    ['remote', state.hasRemoteState ? 'attached' : 'visual only'],
    ['session', session.id ? shortId(session.id) : 'none'],
    ['cwd', session.cwd || currentCwd || ''],
    ['cursor', session.cursor ?? ''],
    ['native', remote.nativeCommand || ''],
    ['turnStarted', remote.turnStartedAt ? formatElapsed(remote.turnStartedAt) : ''],
    ['idlePrompt', String(Boolean(detection.visibleIdlePrompt))],
    ['activeSignals', String(Boolean(detection.activeVisualIndicators))],
    ['approval', detection.approval ? 'yes' : 'no']
  ];

  for (const [label, value] of items) {
    if (value === '') continue;
    const termElement = document.createElement('dt');
    termElement.textContent = label;
    const detailElement = document.createElement('dd');
    detailElement.textContent = String(value);
    summary.append(termElement, detailElement);
  }
  debugPanelBody.append(summary);

  if (remote.lastInputText) {
    debugPanelBody.append(buildDebugBlock('last input', remote.lastInputText));
  }
  if (detection.approval?.question) {
    debugPanelBody.append(buildDebugBlock('approval', detection.approval.question));
  }
  debugPanelBody.append(buildDebugBlock('viewport', state.text?.viewportTail || ''));
  debugPanelBody.append(buildDebugBlock('output tail', state.text?.lastOutputTail || ''));
}

function buildDebugBlock(title, text) {
  const section = document.createElement('section');
  section.className = 'debug-block';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const body = document.createElement('pre');
  body.textContent = text || '--';
  section.append(heading, body);
  return section;
}

function formatElapsed(startedAt) {
  const value = Number(startedAt) || Date.parse(startedAt);
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  return `${seconds}s ago`;
}

async function loadCaptureLogView() {
  captureLogStatus.textContent = t('loadingSettings');
  try {
    const previousSession = captureLogSession.value;
    captureLogView = await window.codexShell.getCaptureLogView({
      sessionId: previousSession,
      includeNoise: captureLogIncludeNoise.checked,
      limit: 800
    });
    renderCaptureLogView(previousSession);
  } catch (error) {
    captureLogStatus.textContent = error.message || t('captureLoadFailed');
  }
}

function renderCaptureLogView(previousSession = '') {
  if (!captureLogView) return;
  captureLogPath.textContent = captureLogView.path || '';
  fillSelect(
    captureLogSession,
    [{ value: '', label: t('allSessions') }].concat(
      (captureLogView.sessions || []).map((session) => ({
        value: session.sessionId,
        label: `${shortId(session.sessionId)} (${session.events})`
      }))
    ),
    previousSession
  );
  fillSelect(
    captureLogType,
    [{ value: '', label: t('allEventTypes') }].concat(
      Object.keys(captureLogView.typeCounts || {}).sort().map((type) => ({
        value: type,
        label: `${type} (${captureLogView.typeCounts[type]})`
      }))
    ),
    captureLogType.value
  );
  const errorCount = (captureLogView.readErrors || []).length;
  captureLogStatus.textContent = [
    `${captureLogView.matchedEvents}/${captureLogView.totalEvents} events`,
    captureLogView.hiddenNoiseEvents ? `${captureLogView.hiddenNoiseEvents} control events hidden` : '',
    formatBytes(captureLogView.sizeBytes),
    errorCount ? `${errorCount} errors` : ''
  ].filter(Boolean).join(' · ');
  renderCaptureLogStats();
  renderCaptureLogEvents();
}

function renderCaptureLogStats() {
  captureLogStats.replaceChildren();
  const items = [
    ['sessions', (captureLogView.sessions || []).length],
    ...Object.entries(captureLogView.typeCounts || {})
  ];
  for (const [label, value] of items) {
    const item = document.createElement('span');
    item.textContent = `${label}: ${value}`;
    captureLogStats.append(item);
  }
}

function renderCaptureLogEvents() {
  captureLogEvents.replaceChildren();
  const type = captureLogType.value;
  const events = (captureLogView?.events || []).filter((event) => !type || event.type === type);
  if (!events.length) {
    const empty = document.createElement('li');
    empty.className = 'capture-log-empty';
    empty.textContent = t('captureEmpty');
    captureLogEvents.append(empty);
    renderCaptureLogDetail(null);
    return;
  }

  const selected = events.find((event) => event.id === selectedCaptureEventId) || events.at(-1);
  selectedCaptureEventId = selected.id;
  for (const event of [...events].reverse()) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'capture-log-event';
    if (event.id === selectedCaptureEventId) button.classList.add('is-selected');
    const heading = document.createElement('strong');
    heading.textContent = `#${event.sequence} ${event.type}`;
    const meta = document.createElement('span');
    meta.textContent = `${formatEventTime(event.at)} · ${shortId(event.sessionId)}${event.cursor === null ? '' : ` · cursor ${event.cursor}`}`;
    const preview = document.createElement('small');
    preview.textContent = event.preview || '';
    button.append(heading, meta, preview);
    button.addEventListener('click', () => {
      selectedCaptureEventId = event.id;
      renderCaptureLogEvents();
      renderCaptureLogDetail(event);
    });
    item.append(button);
    captureLogEvents.append(item);
  }

  renderCaptureLogDetail(selected);
}

function renderCaptureLogDetail(event) {
  if (!event) {
    captureLogDetailTitle.textContent = t('selectEvent');
    captureLogDetail.textContent = '';
    return;
  }
  captureLogDetailTitle.textContent = `#${event.sequence} ${event.type}`;
  captureLogDetail.textContent = captureLogDetailMode === 'metadata'
    ? JSON.stringify(event.metadata, null, 2)
    : event.content || '';
}

function setCaptureLogDetailMode(mode) {
  captureLogDetailMode = mode;
  captureLogContentTab.classList.toggle('is-active', mode === 'content');
  captureLogMetadataTab.classList.toggle('is-active', mode === 'metadata');
  const selected = (captureLogView?.events || []).find(
    (event) => event.id === selectedCaptureEventId
  );
  renderCaptureLogDetail(selected);
}

function closeCaptureLogPanel() {
  captureLogPanel.setAttribute('aria-hidden', 'true');
  if (captureLogRefreshTimer) {
    clearTimeout(captureLogRefreshTimer);
    captureLogRefreshTimer = null;
  }
}

function scheduleCaptureLogRefresh() {
  if (captureLogRefreshTimer) clearTimeout(captureLogRefreshTimer);
  captureLogRefreshTimer = null;
  if (
    captureLogPanel.getAttribute('aria-hidden') === 'true' ||
    !captureLogAutoRefresh.checked
  ) {
    return;
  }
  captureLogRefreshTimer = setTimeout(async () => {
    captureLogRefreshTimer = null;
    await loadCaptureLogView();
    scheduleCaptureLogRefresh();
  }, 2000);
}

function fillSelect(select, options, selectedValue) {
  select.replaceChildren();
  for (const option of options) {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    select.append(element);
  }
  select.value = options.some((option) => option.value === selectedValue)
    ? selectedValue
    : '';
}

function shortId(value) {
  const text = String(value || '');
  return text.length > 12 ? `${text.slice(0, 8)}...` : text;
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatEventTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleTimeString();
}

function renderFeishuConnectStatus(status = { status: 'idle' }) {
  currentFeishuStatus = status;
  const activeStatuses = new Set([
    'starting',
    'waiting',
    'polling',
    'slow_down',
    'domain_switched',
    'aborting'
  ]);
  const isActive = activeStatuses.has(status.status);

  if (status.url) {
    feishuConnectUrl = status.url;
  }

  connectFeishuButton.disabled = isActive;
  cancelFeishuConnectButton.disabled = !isActive;
  openFeishuConnectButton.disabled = !feishuConnectUrl || status.status === 'complete';

  if (status.qrDataUrl) {
    feishuConnectQr.src = status.qrDataUrl;
    feishuConnectQr.hidden = false;
  } else if (!isActive) {
    feishuConnectQr.hidden = true;
    feishuConnectQr.removeAttribute('src');
  }

  if (feishuConnectUrl && isActive) {
    feishuConnectLink.textContent = feishuConnectUrl;
  } else {
    feishuConnectLink.textContent = '';
  }

  const message = getFeishuStatusMessage(status);
  if (status.status === 'complete') {
    feishuConnectState.textContent = status.pluginError
      ? status.message
      : t('connected', { value: maskValue(status.appId) });
    connectFeishuButton.textContent = t('reconnectFeishu');
    openFeishuConnectButton.disabled = true;
    cancelFeishuConnectButton.disabled = true;
    feishuConnectQr.hidden = true;
    feishuConnectLink.textContent = '';
    feishuConnectUrl = '';
    setSettingsStatus(status.pluginError ? status.message : t('feishuConnectedSaved'));
    return;
  }

  if (status.status === 'error' || status.status === 'aborted') {
    feishuConnectState.textContent = message;
    if (!status.url) {
      feishuConnectUrl = '';
      feishuConnectLink.textContent = '';
      openFeishuConnectButton.disabled = true;
    }
    connectFeishuButton.disabled = false;
    cancelFeishuConnectButton.disabled = true;
    return;
  }

  if (status.status && status.status !== 'idle') {
    feishuConnectState.textContent = message;
  }
}

function maskValue(value) {
  const text = String(value || '');
  if (text.length <= 10) return text;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function setLanguage(language) {
  currentLanguage = normalizeLanguage(language);
  document.documentElement.lang = currentLanguage;
  languageSelect.value = currentLanguage;

  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }

  if (!currentCwd) {
    cwdElement.textContent = t('starting');
  }
  terminalScrollbar.setAttribute('aria-label', t('terminalScrollback'));
}

function normalizeLanguage(language) {
  return language === 'en' ? 'en' : 'zh-CN';
}

function t(key, params = {}) {
  const dictionary = I18N[currentLanguage] || I18N['zh-CN'];
  const fallback = I18N.en[key] || key;
  const template = dictionary[key] || fallback;
  return template.replace(/\{(\w+)\}/g, (_match, name) => params[name] ?? '');
}

function getFeishuStatusMessage(status = {}) {
  if (status.status === 'error' && status.message) {
    return status.message;
  }

  const statusKey = {
    idle: 'notConnected',
    starting: 'feishuStatusStarting',
    waiting: 'feishuStatusWaiting',
    polling: 'feishuStatusPolling',
    slow_down: 'feishuStatusSlowDown',
    domain_switched: 'feishuStatusDomainSwitched',
    aborting: 'feishuStatusAborting',
    aborted: 'feishuStatusAborted',
    error: 'feishuStatusError'
  }[status.status];

  if (statusKey) return t(statusKey);
  return status.message || status.status || t('notConnected');
}
