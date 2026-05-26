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
const connectFeishuButton = document.getElementById('connectFeishu');
const cancelFeishuConnectButton = document.getElementById('cancelFeishuConnect');
const openFeishuConnectButton = document.getElementById('openFeishuConnect');
const feishuConnectState = document.getElementById('feishuConnectState');
const feishuConnectQr = document.getElementById('feishuConnectQr');
const feishuConnectLink = document.getElementById('feishuConnectLink');
const settingsStatus = document.getElementById('settingsStatus');

let currentCwd = null;
let currentConfig = null;
let feishuConnectUrl = '';
let fitFrame = null;
let snapshotTimer = null;
let lastSize = { cols: 0, rows: 0 };
let scrollbarSyncing = false;

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
    window.codexShell.snapshot(readTerminalSnapshot());
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

connectFeishuButton.addEventListener('click', async () => {
  if (!currentConfig) {
    currentConfig = await window.codexShell.getConfig();
  }

  const nextConfig = collectSettings(currentConfig);
  renderFeishuConnectStatus({
    status: 'starting',
    message: 'Preparing Feishu authorization...'
  });

  try {
    const status = await window.codexShell.startFeishuConnect(nextConfig);
    renderFeishuConnectStatus(status);
  } catch (error) {
    renderFeishuConnectStatus({
      status: 'error',
      message: error.message || 'Failed to start Feishu authorization.'
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
      message: error.message || 'Failed to cancel Feishu authorization.'
    });
  }
});

openFeishuConnectButton.addEventListener('click', async () => {
  if (!feishuConnectUrl) return;

  try {
    await window.codexShell.openExternal(feishuConnectUrl);
  } catch (error) {
    setSettingsStatus(error.message || 'Could not open Feishu link.');
  }
});

window.addEventListener('resize', requestFit);
new ResizeObserver(requestFit).observe(terminalElement);
setTimeout(requestFit, 100);

async function loadSettings() {
  setSettingsStatus('Loading settings...');
  currentConfig = await window.codexShell.getConfig();
  populateSettings(currentConfig);
  renderFeishuConnectStatus(await window.codexShell.getFeishuConnectStatus());
  setSettingsStatus('Settings loaded.');
}

async function saveSettings() {
  if (!currentConfig) {
    currentConfig = await window.codexShell.getConfig();
  }

  const nextConfig = collectSettings(currentConfig);
  setSettingsStatus('Saving settings...');
  const result = await window.codexShell.saveConfig(nextConfig);
  currentConfig = result.config;
  populateSettings(currentConfig);

  if (result.pluginError) {
    setSettingsStatus(`Saved. Plugin error: ${result.pluginError}`);
    return;
  }

  setSettingsStatus('Settings saved.');
}

function populateSettings(config) {
  const feishu = config.plugins?.feishu || {};

  setValue('codexDefaultCwd', config.codex?.defaultCwd || '');

  if (feishu.appId) {
    feishuConnectState.textContent = `Configured: ${maskValue(feishu.appId)}`;
    connectFeishuButton.textContent = 'Reconnect Feishu';
  } else {
    feishuConnectState.textContent = 'Not connected.';
    connectFeishuButton.textContent = 'Connect Feishu';
  }
}

function collectSettings(baseConfig) {
  const next = structuredClone(baseConfig);
  next.codex = next.codex || {};
  next.remoteControl = next.remoteControl || {};
  next.plugins = next.plugins || {};
  next.plugins.feishu = next.plugins.feishu || {};

  next.codex.defaultCwd = getValue('codexDefaultCwd');

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

  const message = status.message || status.status || 'Not connected.';
  if (status.status === 'complete') {
    feishuConnectState.textContent = status.pluginError
      ? status.message
      : `Connected: ${maskValue(status.appId)}`;
    connectFeishuButton.textContent = 'Reconnect Feishu';
    openFeishuConnectButton.disabled = true;
    cancelFeishuConnectButton.disabled = true;
    feishuConnectQr.hidden = true;
    feishuConnectLink.textContent = '';
    feishuConnectUrl = '';
    setSettingsStatus(status.pluginError ? status.message : 'Feishu connected and saved.');
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
