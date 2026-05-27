const terminalElement = document.getElementById('terminal');
const terminalScrollbar = document.getElementById('terminalScrollbar');
const terminalScrollSpacer = document.getElementById('terminalScrollSpacer');
const cwdElement = document.getElementById('cwd');
const chooseDirButton = document.getElementById('chooseDir');
const restartButton = document.getElementById('restart');
const settingsButton = document.getElementById('settings');
const settingsPanel = document.getElementById('settingsPanel');
const settingsForm = document.getElementById('settingsForm');
const closeSettingsButton = document.getElementById('closeSettings');
const languageSelect = document.getElementById('uiLanguage');
const rawOutputLogCheckbox = document.getElementById('rawOutputLogEnabled');
const openRawOutputLogButton = document.getElementById('openRawOutputLog');
const connectFeishuButton = document.getElementById('connectFeishu');
const cancelFeishuConnectButton = document.getElementById('cancelFeishuConnect');
const openFeishuConnectButton = document.getElementById('openFeishuConnect');
const feishuConnectState = document.getElementById('feishuConnectState');
const feishuConnectQr = document.getElementById('feishuConnectQr');
const feishuConnectLink = document.getElementById('feishuConnectLink');
const settingsStatus = document.getElementById('settingsStatus');

let currentCwd = null;
let currentConfig = null;
let currentLanguage = 'zh-CN';
let currentFeishuStatus = { status: 'idle' };
let feishuConnectUrl = '';
let fitFrame = null;
let snapshotTimer = null;
let lastSize = { cols: 0, rows: 0 };
let scrollbarSyncing = false;

const I18N = {
  'zh-CN': {
    starting: '启动中...',
    openProject: '打开项目',
    restartCodex: '重启 Codex',
    settings: '设置',
    close: '关闭',
    interface: '界面',
    language: '语言',
    languageChinese: '中文',
    languageEnglish: 'English',
    terminalScrollback: '终端滚动历史',
    defaultWorkingDirectory: '默认工作目录',
    rawOutputLogEnabled: '记录 Codex 原始输出',
    openLog: '打开日志',
    rawOutputLogOpened: '日志已打开。',
    rawOutputLogOpenFailed: '打开日志失败。',
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
    feishuConnectedSaved: '飞书已连接并保存。',
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
    close: 'Close',
    interface: 'Interface',
    language: 'Language',
    languageChinese: '中文',
    languageEnglish: 'English',
    terminalScrollback: 'Terminal scrollback',
    defaultWorkingDirectory: 'Default working directory',
    rawOutputLogEnabled: 'Record raw Codex output',
    openLog: 'Open Log',
    rawOutputLogOpened: 'Log opened.',
    rawOutputLogOpenFailed: 'Failed to open log.',
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
    feishuConnectedSaved: 'Feishu connected and saved.',
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
  fitAddon.fit();
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
  const targetLine = Math.round(terminalScrollbar.scrollTop / rowHeight);
  term.scrollToLine(targetLine);
});

function scheduleTerminalSnapshot() {
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
  }

  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    window.codexShell.snapshot({
      scrollback: readTerminalSnapshot(),
      viewport: readTerminalViewportSnapshot()
    });
  }, 40);
}

function updateTerminalScrollbar() {
  if (!terminalScrollbar || !terminalScrollSpacer) return;

  requestAnimationFrame(() => {
    const rowHeight = getTerminalRowHeight();
    const buffer = term.buffer.active;
    const scrollableRows = Math.max(0, buffer.length - term.rows);
    const spacerHeight = Math.max(
      terminalScrollbar.clientHeight,
      (scrollableRows + term.rows) * rowHeight
    );

    terminalScrollSpacer.style.height = `${spacerHeight}px`;
    const nextScrollTop = Math.min(
      scrollableRows * rowHeight,
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

closeSettingsButton.addEventListener('click', () => {
  settingsPanel.setAttribute('aria-hidden', 'true');
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

window.addEventListener('resize', requestFit);
new ResizeObserver(requestFit).observe(terminalElement);
setTimeout(requestFit, 100);

window.codexShell.getConfig().then((config) => {
  currentConfig = config;
  setLanguage(config.ui?.language);
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

  if (result.pluginError) {
    setSettingsStatus(t('savedPluginError', { error: result.pluginError }));
    return;
  }

  setSettingsStatus(t('settingsSaved'));
}

function populateSettings(config) {
  setLanguage(config.ui?.language);
  setValue('uiLanguage', currentLanguage);
  setValue('codexDefaultCwd', config.codex?.defaultCwd || '');
  rawOutputLogCheckbox.checked = Boolean(config.remoteControl?.rawOutputLogEnabled);
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
  next.codex.defaultCwd = getValue('codexDefaultCwd');
  next.remoteControl.rawOutputLogEnabled = rawOutputLogCheckbox.checked;

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
