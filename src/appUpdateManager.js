const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LinuxTarUpdater, findManagedTarInstallation } = require('./linuxTarUpdater');

const DEFAULT_STARTUP_DELAY_MS = 10000;

class AppUpdateManager {
  constructor(options = {}) {
    this.app = options.app;
    this.logger = options.logger || console;
    this.updater = options.updater || null;
    this.startupDelayMs = Number.isFinite(options.startupDelayMs)
      ? Math.max(0, options.startupDelayMs)
      : DEFAULT_STARTUP_DELAY_MS;
    this.listeners = new Set();
    this.startupTimer = null;
    this.downloadPromise = null;
    this.checkPromise = null;
    this.started = false;
    this.automaticEnabled = options.config?.updates?.automaticEnabled !== false;
    this.installMode = options.installMode || 'unsupported';
    this.state = {
      status: this.updater ? 'idle' : 'unsupported',
      currentVersion: String(this.app?.getVersion?.() || ''),
      latestVersion: '',
      automaticEnabled: this.automaticEnabled,
      installMode: this.installMode,
      percent: 0,
      transferred: 0,
      total: 0,
      error: ''
    };

    if (this.updater) {
      this.configureUpdater();
      this.bindUpdaterEvents();
    }
  }

  configureUpdater() {
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = this.automaticEnabled;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.allowPrerelease = false;
    this.updater.logger = createUpdaterLogger(this.logger);
  }

  bindUpdaterEvents() {
    this.updater.on('checking-for-update', () => {
      this.setState({ status: 'checking', error: '', percent: 0 });
    });
    this.updater.on('update-available', (info = {}) => {
      this.setState({
        status: 'available',
        latestVersion: String(info.version || ''),
        error: '',
        percent: 0
      });
      if (this.automaticEnabled) {
        void this.download();
      }
    });
    this.updater.on('update-not-available', (info = {}) => {
      this.setState({
        status: 'up_to_date',
        latestVersion: String(info.version || this.state.currentVersion),
        error: '',
        percent: 0
      });
    });
    this.updater.on('download-progress', (progress = {}) => {
      this.setState({
        status: 'downloading',
        percent: clampPercent(progress.percent),
        transferred: normalizeByteCount(progress.transferred),
        total: normalizeByteCount(progress.total),
        error: ''
      });
    });
    this.updater.on('update-downloaded', (info = {}) => {
      this.setState({
        status: 'downloaded',
        latestVersion: String(info.version || this.state.latestVersion || ''),
        percent: 100,
        error: ''
      });
    });
    this.updater.on('error', (error) => {
      this.handleError(error, 'event');
    });
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState() {
    return { ...this.state };
  }

  updateConfig(config) {
    const previous = this.automaticEnabled;
    this.automaticEnabled = config?.updates?.automaticEnabled !== false;
    if (this.updater) {
      this.updater.autoInstallOnAppQuit = this.automaticEnabled;
    }
    this.setState({ automaticEnabled: this.automaticEnabled });

    if (this.started && this.automaticEnabled && !previous && this.state.status !== 'downloaded') {
      this.scheduleAutomaticCheck(0);
    }
    if (!this.automaticEnabled && this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (this.updater && this.automaticEnabled) {
      this.scheduleAutomaticCheck(this.startupDelayMs);
    }
  }

  stop() {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  scheduleAutomaticCheck(delayMs) {
    if (!this.updater || !this.automaticEnabled || this.startupTimer) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.check({ manual: false });
    }, delayMs);
    this.startupTimer.unref?.();
  }

  async check({ manual = true } = {}) {
    if (!this.updater) {
      return this.getState();
    }
    if (this.checkPromise || ['downloading', 'installing'].includes(this.state.status)) {
      return this.getState();
    }

    this.logger.event?.('app_update.check.started', {
      manual,
      installMode: this.installMode,
      currentVersion: this.state.currentVersion
    });
    this.setState({ status: 'checking', error: '', percent: 0 });
    this.checkPromise = Promise.resolve()
      .then(() => this.updater.checkForUpdates())
      .catch((error) => {
        this.handleError(error, 'check');
      })
      .finally(() => {
        this.checkPromise = null;
      });
    await this.checkPromise;
    return this.getState();
  }

  async download() {
    if (!this.updater || this.downloadPromise) {
      return this.getState();
    }
    if (!['available', 'downloading'].includes(this.state.status)) {
      return this.getState();
    }

    this.setState({ status: 'downloading', error: '', percent: 0 });
    this.logger.event?.('app_update.download.started', {
      installMode: this.installMode,
      version: this.state.latestVersion
    });
    this.downloadPromise = Promise.resolve()
      .then(() => this.updater.downloadUpdate())
      .catch((error) => {
        this.handleError(error, 'download');
      })
      .finally(() => {
        this.downloadPromise = null;
      });
    await this.downloadPromise;
    return this.getState();
  }

  installAndRestart() {
    if (!this.updater || this.state.status !== 'downloaded') {
      return this.getState();
    }
    this.setState({ status: 'installing', error: '' });
    this.logger.event?.('app_update.install.started', {
      installMode: this.installMode,
      version: this.state.latestVersion
    });
    try {
      const started = this.updater.quitAndInstall(false, true);
      if (started === false) {
        throw new Error('The update installer could not be started.');
      }
    } catch (error) {
      this.handleError(error, 'install');
    }
    return this.getState();
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.warn?.('App update status listener failed', { error: error.message });
      }
    }
  }

  handleError(error, operation) {
    const message = String(error?.message || error || 'Unknown update error').slice(0, 500);
    this.setState({ status: 'error', error: message });
    this.logger.error?.('App update failed', {
      operation,
      installMode: this.installMode,
      error: message
    });
  }
}

function createAppUpdateManager(options = {}) {
  const app = options.app;
  const logger = options.logger || console;
  const detection = detectLinuxInstallation({
    app,
    resourcesPath: options.resourcesPath,
    execPath: options.execPath,
    homedir: options.homedir
  });
  let updater = options.updater || null;

  if (!updater && detection.mode === 'deb') {
    try {
      updater = require('electron-updater').autoUpdater;
    } catch (error) {
      logger.error?.('Failed to initialize the Debian package updater', {
        error: error.message
      });
    }
  } else if (!updater && detection.mode === 'tar') {
    updater = new LinuxTarUpdater({
      app,
      logger,
      installation: detection.installation,
      resourcesPath: detection.resourcesPath
    });
  }

  return new AppUpdateManager({
    ...options,
    app,
    logger,
    updater,
    installMode: detection.mode
  });
}

function detectLinuxInstallation(options = {}) {
  const app = options.app;
  const resourcesPath = path.resolve(options.resourcesPath || process.resourcesPath || '.');
  if (process.platform !== 'linux') {
    return { mode: 'unsupported', reason: 'platform', resourcesPath };
  }
  if (!app?.isPackaged) {
    return { mode: 'development', reason: 'not_packaged', resourcesPath };
  }

  try {
    const packageType = fs.readFileSync(path.join(resourcesPath, 'package-type'), 'utf8').trim();
    if (packageType === 'deb') {
      return { mode: 'deb', resourcesPath };
    }
  } catch {
    // The user-level tar installer intentionally has no package-type marker.
  }

  const installation = findManagedTarInstallation({
    execPath: options.execPath || process.execPath,
    homedir: options.homedir || os.homedir()
  });
  if (installation) {
    return { mode: 'tar', installation, resourcesPath };
  }
  return { mode: 'unsupported', reason: 'installation', resourcesPath };
}

function createUpdaterLogger(logger) {
  return {
    debug: (message) => logger.debug?.(String(message)),
    info: (message) => logger.info?.(String(message)),
    warn: (message) => logger.warn?.(String(message)),
    error: (message) => logger.error?.(String(message))
  };
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, Math.round(number * 10) / 10));
}

function normalizeByteCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

module.exports = {
  AppUpdateManager,
  createAppUpdateManager,
  detectLinuxInstallation
};
