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
const automaticUpdatesCheckbox = document.getElementById('automaticUpdatesEnabled');
const updateStatusElement = document.getElementById('updateStatus');
const updateActionButton = document.getElementById('updateAction');
const latexRenderingCheckbox = document.getElementById('feishuLatexRenderingEnabled');
const latexMaxFormulasInput = document.getElementById('feishuLatexMaxFormulas');
const connectFeishuButton = document.getElementById('connectFeishu');
const cancelFeishuConnectButton = document.getElementById('cancelFeishuConnect');
const openFeishuConnectButton = document.getElementById('openFeishuConnect');
const feishuConnectState = document.getElementById('feishuConnectState');
const feishuConnectQr = document.getElementById('feishuConnectQr');
const feishuConnectLink = document.getElementById('feishuConnectLink');
const feishuConnectBox = document.getElementById('feishuConnectBox');
const onboardingWelcome = document.getElementById('onboardingWelcome');
const openSettingsFromOnboardingButton = document.getElementById('openSettingsFromOnboarding');
const dismissOnboardingWelcomeButton = document.getElementById('dismissOnboardingWelcome');
const feishuOnboardingGuide = document.getElementById('feishuOnboardingGuide');
const tryFeishuFromOnboardingButton = document.getElementById('tryFeishuFromOnboarding');
const dismissOnboardingConnectButton = document.getElementById('dismissOnboardingConnect');
const settingsStatus = document.getElementById('settingsStatus');

let currentCwd = null;
let currentConfig = null;
let currentLanguage = 'zh-CN';
let currentFeishuStatus = { status: 'idle' };
let currentUpdateStatus = null;
let feishuConnectUrl = '';
let fitFrame = null;
let snapshotTimer = null;
let lastSize = { cols: 0, rows: 0 };
let lastTerminalLayoutSignature = '';
let scrollbarSyncing = false;
let onboardingInitialized = false;
let onboardingStage = 'inactive';
let onboardingCompleting = false;
const TERMINAL_MIN_COLS = 2;
const TERMINAL_MIN_ROWS = 1;

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
    softwareUpdates: '软件更新',
    automaticUpdatesEnabled: '自动检查并下载更新',
    automaticUpdatesHelp: '下载完成后将在退出时安装，也可以立即安装并重启。',
    checkForUpdates: '检查更新',
    downloadUpdate: '下载更新',
    installAndRestart: '安装并重启',
    updateStatusLoading: '正在读取当前版本...',
    updateStatusIdle: '当前版本 v{version}',
    updateStatusChecking: '正在检查更新 · 当前版本 v{version}',
    updateStatusCurrent: '已是最新版本 v{version}',
    updateStatusAvailable: '发现新版本 v{version}',
    updateStatusDownloading: '正在下载 v{version} · {percent}%',
    updateStatusDownloaded: 'v{version} 已下载，退出时将自动安装。',
    updateStatusDownloadedManual: 'v{version} 已下载，可以立即安装。',
    updateStatusInstalling: '正在安装 v{version}...',
    updateStatusUnsupported: '当前安装方式不支持应用内更新。',
    updateStatusDevelopment: '开发模式不执行应用更新。',
    updateStatusError: '更新失败：{error}',
    latexRenderingEnabled: '将 LaTeX 公式渲染为图片',
    latexMaxFormulas: '每条回复最多渲染的公式区域',
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
    feishuStatusError: '飞书连接失败。',
    onboardingStepOne: '首次使用 · 第 1 步',
    onboardingStepTwo: '首次使用 · 第 2 步',
    onboardingWelcomeTitle: '从连接飞书开始',
    onboardingWelcomeBody: '打开设置面板，即可让手机上的飞书连接到当前 Codex 会话。',
    onboardingOpenSettings: '打开设置',
    onboardingConnectTitle: '尝试连接飞书',
    onboardingConnectBody: '点击后会打开飞书授权流程。连接成功后，就能从飞书远程控制当前 Codex 会话。',
    onboardingTryConnect: '尝试连接',
    onboardingLater: '稍后再说',
    onboardingSaveFailed: '无法保存首次使用引导状态。'
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
    softwareUpdates: 'Software Updates',
    automaticUpdatesEnabled: 'Automatically check for and download updates',
    automaticUpdatesHelp: 'Downloaded updates install when the app exits, or you can install and restart now.',
    checkForUpdates: 'Check for Updates',
    downloadUpdate: 'Download Update',
    installAndRestart: 'Install and Restart',
    updateStatusLoading: 'Reading the current version...',
    updateStatusIdle: 'Current version v{version}',
    updateStatusChecking: 'Checking for updates · Current version v{version}',
    updateStatusCurrent: 'Remote Codex is up to date · v{version}',
    updateStatusAvailable: 'Version v{version} is available',
    updateStatusDownloading: 'Downloading v{version} · {percent}%',
    updateStatusDownloaded: 'v{version} is downloaded and will install on exit.',
    updateStatusDownloadedManual: 'v{version} is downloaded and ready to install.',
    updateStatusInstalling: 'Installing v{version}...',
    updateStatusUnsupported: 'This installation cannot be updated in the app.',
    updateStatusDevelopment: 'Application updates are disabled in development mode.',
    updateStatusError: 'Update failed: {error}',
    latexRenderingEnabled: 'Render LaTeX formulas as images',
    latexMaxFormulas: 'Maximum formula regions per reply',
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
    feishuStatusError: 'Feishu connection failed.',
    onboardingStepOne: 'First use · Step 1',
    onboardingStepTwo: 'First use · Step 2',
    onboardingWelcomeTitle: 'Start by connecting Feishu',
    onboardingWelcomeBody: 'Open Settings to connect Feishu on your phone to the current Codex session.',
    onboardingOpenSettings: 'Open Settings',
    onboardingConnectTitle: 'Try connecting Feishu',
    onboardingConnectBody: 'This starts Feishu authorization. Once connected, Feishu can remotely control the current Codex session.',
    onboardingTryConnect: 'Try Connection',
    onboardingLater: 'Maybe Later',
    onboardingSaveFailed: 'Could not save the first-use guide state.'
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

term.attachCustomKeyEventHandler((event) => {
  return !isImeSwitchKeyEvent(event);
});

term.loadAddon(fitAddon);
term.open(terminalElement);
focusTerminalSoon();

terminalElement.addEventListener('pointerdown', () => {
  focusTerminalSoon();
});

window.addEventListener('focus', () => {
  const active = document.activeElement;
  if (!active || active === document.body || active === terminalElement) {
    focusTerminalSoon();
  }
});

window.addEventListener('keydown', (event) => {
  if (!isImeSwitchKeyEvent(event)) return;
  event.stopImmediatePropagation();
}, true);

window.addEventListener('keyup', (event) => {
  if (!isImeSwitchKeyEvent(event)) return;
  event.stopImmediatePropagation();
}, true);

function focusTerminalSoon() {
  setTimeout(() => {
    term.focus();
  }, 0);
}

function isImeSwitchKeyEvent(event) {
  if (!event) return false;
  if (event.metaKey || event.altKey) return false;
  const key = String(event.key || '').toLowerCase();
  const code = String(event.code || '');
  const ctrlSpace = event.ctrlKey && !event.shiftKey && (
    key === ' ' ||
    key === 'spacebar' ||
    code === 'Space'
  );
  const ctrlShift = event.ctrlKey && event.shiftKey && (
    key === 'control' ||
    key === 'shift' ||
    code.startsWith('Control') ||
    code.startsWith('Shift')
  );
  return ctrlSpace || ctrlShift;
}

function fit() {
  const previousLayoutSignature = lastTerminalLayoutSignature;
  const size = proposeTerminalSize();
  let resized = false;
  if (size) {
    if (term.cols !== size.cols || term.rows !== size.rows) {
      clearTerminalRenderCache();
      term.resize(size.cols, size.rows);
      refreshTerminalViewport();
      resized = true;
    }
  } else {
    fitAddon.fit();
    resized = true;
  }
  updateTerminalScrollbar();

  const nextLayoutSignature = getTerminalLayoutSignature();
  const layoutChanged =
    Boolean(nextLayoutSignature) &&
    Boolean(previousLayoutSignature) &&
    nextLayoutSignature !== previousLayoutSignature;
  lastTerminalLayoutSignature = nextLayoutSignature || previousLayoutSignature;

  if (!resized && layoutChanged) {
    clearTerminalRenderCache();
    refreshTerminalViewport();
    scheduleTerminalSnapshot();
  }

  if (term.cols === lastSize.cols && term.rows === lastSize.rows) {
    return;
  }

  lastSize = {
    cols: term.cols,
    rows: term.rows
  };
  window.codexShell.resize(lastSize);
}

function clearTerminalRenderCache() {
  term._core?._renderService?.clear?.();
}

function refreshTerminalViewport() {
  term.refresh(0, Math.max(0, term.rows - 1));
}

function getTerminalLayoutSignature() {
  const screen = terminalElement.querySelector('.xterm-screen');
  const viewport = terminalElement.querySelector('.xterm-viewport');
  const cellSize = term._core?._renderService?.dimensions?.css?.cell;
  return [
    terminalElement.clientWidth,
    terminalElement.clientHeight,
    screen?.clientWidth || 0,
    screen?.clientHeight || 0,
    viewport?.clientWidth || 0,
    viewport?.clientHeight || 0,
    Math.round((cellSize?.width || 0) * 1000),
    Math.round((cellSize?.height || 0) * 1000),
    Math.round((window.devicePixelRatio || 1) * 1000)
  ].join('x');
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
    refreshTerminalViewport();
    requestFit();
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
  initializeOnboarding(config);
  if (settingsPanel.getAttribute('aria-hidden') === 'false') {
    populateSettings(config);
  }
});
window.codexShell.onFeishuConnectStatus((status) => {
  renderFeishuConnectStatus(status);
  if (status.status === 'complete') {
    loadSettings();
    if (onboardingStage !== 'inactive') {
      completeOnboarding('feishu_connected');
    }
  }
});
window.codexShell.onUpdateStatus((status) => {
  currentUpdateStatus = status;
  renderUpdateStatus(status);
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
    sendTerminalSnapshot();
  }, 40);
}

function sendTerminalSnapshot() {
  window.codexShell.snapshot({
    scrollback: readTerminalSnapshot(),
    viewport: readTerminalViewportSnapshot(),
    styledScrollback: readTerminalStyledSnapshot(),
    styledViewport: readTerminalStyledViewportSnapshot()
  });
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
  await openSettingsPanel({ advanceOnboarding: onboardingStage === 'settings' });
});

closeSettingsButton.addEventListener('click', () => {
  closeSettingsPanel();
});

settingsPanel.addEventListener('click', (event) => {
  if (event.target === settingsPanel) {
    closeSettingsPanel();
  }
});

openSettingsFromOnboardingButton.addEventListener('click', async () => {
  await openSettingsPanel({ advanceOnboarding: true });
});

dismissOnboardingWelcomeButton.addEventListener('click', () => {
  completeOnboarding('welcome_dismissed');
});

dismissOnboardingConnectButton.addEventListener('click', () => {
  completeOnboarding('connect_dismissed');
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
  renderUpdateStatus(currentUpdateStatus);
});

latexRenderingCheckbox.addEventListener('change', syncLatexSettingsState);

updateActionButton.addEventListener('click', async () => {
  const status = currentUpdateStatus?.status;
  try {
    if (status === 'available') {
      currentUpdateStatus = await window.codexShell.downloadUpdate();
    } else if (status === 'downloaded') {
      currentUpdateStatus = await window.codexShell.installUpdate();
    } else {
      currentUpdateStatus = await window.codexShell.checkForUpdates();
    }
    renderUpdateStatus(currentUpdateStatus);
  } catch (error) {
    renderUpdateStatus({
      ...currentUpdateStatus,
      status: 'error',
      error: error.message || 'Unknown error'
    });
  }
});

connectFeishuButton.addEventListener('click', () => {
  startFeishuConnection({ fromOnboarding: onboardingStage === 'feishu' });
});

tryFeishuFromOnboardingButton.addEventListener('click', () => {
  startFeishuConnection({ fromOnboarding: true });
});

async function startFeishuConnection({ fromOnboarding = false } = {}) {
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
    if (fromOnboarding && status?.status !== 'error') {
      await completeOnboarding('feishu_connect_started');
    }
  } catch (error) {
    renderFeishuConnectStatus({
      status: 'error',
      message: error.message || t('failedStartFeishuAuthorization')
    });
  }
}

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

window.addEventListener('resize', requestFit);
new ResizeObserver(requestFit).observe(terminalElement);
setTimeout(requestFit, 100);

window.codexShell.getConfig().then((config) => {
  currentConfig = config;
  setLanguage(config.ui?.language);
  initializeOnboarding(config);
}).catch(() => {
  setLanguage(currentLanguage);
});

async function openSettingsPanel({ advanceOnboarding = false } = {}) {
  settingsPanel.setAttribute('aria-hidden', 'false');
  await loadSettings();
  if (advanceOnboarding && onboardingStage !== 'inactive') {
    setOnboardingStage('feishu');
  }
}

function closeSettingsPanel() {
  settingsPanel.setAttribute('aria-hidden', 'true');
  if (onboardingStage === 'feishu') {
    setOnboardingStage('settings');
  }
}

function initializeOnboarding(config) {
  if (config?.ui?.onboardingCompleted === true || config?.plugins?.feishu?.appId) {
    onboardingInitialized = true;
    setOnboardingStage('inactive');
    return;
  }
  if (onboardingInitialized) return;
  onboardingInitialized = true;
  if (config?.ui?.firstRun === true) {
    setOnboardingStage('settings');
  }
}

function setOnboardingStage(stage) {
  onboardingStage = ['settings', 'feishu'].includes(stage) ? stage : 'inactive';
  onboardingWelcome.setAttribute(
    'aria-hidden',
    onboardingStage === 'settings' ? 'false' : 'true'
  );
  feishuOnboardingGuide.hidden = onboardingStage !== 'feishu';
  settingsButton.classList.toggle('onboarding-target', onboardingStage === 'settings');
  feishuConnectBox.classList.toggle('onboarding-target', onboardingStage === 'feishu');

  if (onboardingStage === 'feishu') {
    requestAnimationFrame(() => {
      feishuOnboardingGuide.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
}

async function completeOnboarding(reason) {
  if (onboardingCompleting) return;
  onboardingCompleting = true;
  try {
    currentConfig = await window.codexShell.completeOnboarding(reason);
    setOnboardingStage('inactive');
  } catch (error) {
    setSettingsStatus(error.message || t('onboardingSaveFailed'));
  } finally {
    onboardingCompleting = false;
  }
}

async function loadSettings() {
  setSettingsStatus(t('loadingSettings'));
  currentConfig = await window.codexShell.getConfig();
  populateSettings(currentConfig);
  currentUpdateStatus = await window.codexShell.getUpdateStatus();
  renderUpdateStatus(currentUpdateStatus);
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
  const feishu = config.plugins?.feishu || {};
  automaticUpdatesCheckbox.checked = config.updates?.automaticEnabled !== false;
  latexRenderingCheckbox.checked = feishu.latexRenderingEnabled !== false;
  latexMaxFormulasInput.value = String(feishu.latexMaxFormulas || 64);
  syncLatexSettingsState();
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
  next.ui = next.ui || {};
  next.remoteControl = next.remoteControl || {};
  next.updates = next.updates || {};
  next.plugins = next.plugins || {};
  next.plugins.feishu = next.plugins.feishu || {};

  next.ui.language = normalizeLanguage(getValue('uiLanguage'));
  next.updates.automaticEnabled = automaticUpdatesCheckbox.checked;
  const feishu = next.plugins.feishu;
  next.remoteControl.autoCreateSession = true;
  next.remoteControl.sendOutput = true;
  next.remoteControl.outputMode = 'final';
  feishu.sendOutput = true;
  feishu.outputMode = 'final';
  feishu.singleCardOutput = true;
  feishu.streaming = true;
  feishu.segmentedOutput = false;
  feishu.ackReactionEnabled = true;
  feishu.ackReactionEmoji = '了解';
  feishu.latexRenderingEnabled = latexRenderingCheckbox.checked;
  feishu.latexMaxFormulas = clampInteger(latexMaxFormulasInput.value, 1, 64, 64);

  return next;
}

function syncLatexSettingsState() {
  latexMaxFormulasInput.disabled = !latexRenderingCheckbox.checked;
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
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

function renderUpdateStatus(status) {
  if (!updateStatusElement || !updateActionButton) return;
  if (!status) {
    updateStatusElement.textContent = t('updateStatusLoading');
    updateActionButton.textContent = t('checkForUpdates');
    updateActionButton.disabled = true;
    return;
  }

  const version = status.latestVersion || status.currentVersion || '';
  const percent = Number.isFinite(Number(status.percent))
    ? Math.max(0, Math.min(100, Math.round(Number(status.percent))))
    : 0;
  const messageKey = {
    idle: 'updateStatusIdle',
    checking: 'updateStatusChecking',
    up_to_date: 'updateStatusCurrent',
    available: 'updateStatusAvailable',
    downloading: 'updateStatusDownloading',
    downloaded: status.automaticEnabled
      ? 'updateStatusDownloaded'
      : 'updateStatusDownloadedManual',
    installing: 'updateStatusInstalling',
    unsupported: status.installMode === 'development'
      ? 'updateStatusDevelopment'
      : 'updateStatusUnsupported',
    error: 'updateStatusError'
  }[status.status] || 'updateStatusIdle';

  updateStatusElement.textContent = t(messageKey, {
    version,
    percent,
    error: status.error || 'Unknown error'
  });
  updateActionButton.textContent = status.status === 'available'
    ? t('downloadUpdate')
    : status.status === 'downloaded'
      ? t('installAndRestart')
      : t('checkForUpdates');
  updateActionButton.disabled = [
    'checking',
    'downloading',
    'installing',
    'unsupported'
  ].includes(status.status);
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
    setSettingsStatus(status.message || t('feishuConnectedSaved'));
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
  renderUpdateStatus(currentUpdateStatus);
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
