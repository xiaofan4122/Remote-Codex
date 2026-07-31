const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const semver = require('semver');

const REPOSITORY = 'xiaofan4122/Remote-Codex';
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

class LinuxTarUpdater extends EventEmitter {
  constructor(options = {}) {
    super();
    this.app = options.app;
    this.runtimeLogger = options.logger || console;
    this.installation = options.installation;
    this.resourcesPath = path.resolve(options.resourcesPath || process.resourcesPath || '.');
    this.fetchText = options.fetchText || fetchText;
    this.downloadFile = options.downloadFile || downloadFile;
    this.installRunner = options.installRunner || runInstaller;
    this.releaseOrigin = String(
      options.releaseOrigin || `https://github.com/${REPOSITORY}`
    ).replace(/\/$/, '');
    this.latestInfo = null;
    this.downloadedInfo = null;
    this.autoDownload = false;
    this.autoInstallOnAppQuit = false;
    this.autoRunAppAfterInstall = true;
    this.allowPrerelease = false;
    this.loggerAdapter = null;
    this.quitInstallAttempted = false;

    this.app?.on?.('will-quit', () => {
      if (!this.autoInstallOnAppQuit || !this.downloadedInfo || this.quitInstallAttempted) return;
      this.quitInstallAttempted = true;
      try {
        this.installDownloadedUpdate();
      } catch (error) {
        this.runtimeLogger.error?.('Failed to install downloaded tar update while quitting', {
          error: error.message
        });
      }
    });
  }

  set logger(value) {
    this.loggerAdapter = value;
  }

  get logger() {
    return this.loggerAdapter;
  }

  async checkForUpdates() {
    this.emit('checking-for-update');
    try {
      const versionUrl = `${this.releaseOrigin}/releases/latest/download/remote-codex-version.txt`;
      const rawVersion = await this.fetchText(versionUrl, { maxBytes: MAX_METADATA_BYTES });
      const version = normalizeVersion(rawVersion);
      const currentVersion = normalizeVersion(this.app.getVersion());
      const info = {
        version,
        releaseName: `Remote Codex v${version}`,
        releaseDate: ''
      };
      this.latestInfo = info;
      if (semver.gt(version, currentVersion)) {
        this.emit('update-available', info);
        return { isUpdateAvailable: true, updateInfo: info };
      }
      this.emit('update-not-available', info);
      return { isUpdateAvailable: false, updateInfo: info };
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async downloadUpdate() {
    if (!this.latestInfo?.version) {
      throw new Error('Check for updates before downloading.');
    }
    const version = this.latestInfo.version;
    const architecture = normalizeArchitecture(process.arch);
    const asset = `remote-codex-linux-${architecture}.tar.gz`;
    const releaseBase = `${this.releaseOrigin}/releases/download/v${version}`;
    const updateDirectory = path.join(this.app.getPath('userData'), 'updates', version);
    const archivePath = path.join(updateDirectory, asset);
    const archiveTempPath = `${archivePath}.part`;
    fs.mkdirSync(updateDirectory, { recursive: true, mode: 0o700 });

    try {
      const checksumText = await this.fetchText(`${releaseBase}/${asset}.sha256`, {
        maxBytes: MAX_METADATA_BYTES
      });
      const expectedSha256 = parseChecksum(checksumText, asset);
      if (fs.existsSync(archiveTempPath)) fs.unlinkSync(archiveTempPath);
      const result = await this.downloadFile(`${releaseBase}/${asset}`, archiveTempPath, {
        maxBytes: MAX_ARCHIVE_BYTES,
        onProgress: (progress) => this.emit('download-progress', progress)
      });
      const actualSha256 = String(result.sha256 || hashFile(archiveTempPath)).toLowerCase();
      if (actualSha256 !== expectedSha256) {
        throw new Error('Release checksum verification failed.');
      }
      fs.renameSync(archiveTempPath, archivePath);
      fs.writeFileSync(path.join(updateDirectory, `${asset}.sha256`), checksumText, {
        mode: 0o600
      });
      fs.writeFileSync(path.join(updateDirectory, 'remote-codex-version.txt'), `${version}\n`, {
        mode: 0o600
      });
      this.downloadedInfo = { version, asset, archivePath, updateDirectory };
      this.emit('update-downloaded', {
        ...this.latestInfo,
        downloadedFile: archivePath
      });
      return [archivePath];
    } catch (error) {
      if (fs.existsSync(archiveTempPath)) fs.unlinkSync(archiveTempPath);
      this.emit('error', error);
      throw error;
    }
  }

  quitAndInstall(_isSilent = false, isForceRunAfter = true) {
    if (!this.downloadedInfo || this.quitInstallAttempted) return false;
    this.quitInstallAttempted = true;
    try {
      this.installDownloadedUpdate();
      if (isForceRunAfter && this.autoRunAppAfterInstall) {
        this.app.relaunch({
          execPath: path.join(this.installation.installRoot, 'current', 'remote-codex'),
          args: process.argv.slice(1)
        });
      }
      this.app.quit();
      return true;
    } catch (error) {
      this.quitInstallAttempted = false;
      this.emit('error', error);
      throw error;
    }
  }

  installDownloadedUpdate() {
    const installerPath = path.join(this.resourcesPath, 'install', 'install-linux.sh');
    if (!fs.statSync(installerPath).isFile()) {
      throw new Error('The bundled Linux installer is missing.');
    }
    const result = this.installRunner({
      installerPath,
      version: this.downloadedInfo.version,
      downloadDirectory: this.downloadedInfo.updateDirectory,
      installation: this.installation
    });
    if (result?.status !== 0) {
      throw new Error(
        String(result?.stderr || result?.stdout || 'The Linux updater installer failed.').trim()
      );
    }
  }
}

function findManagedTarInstallation(options = {}) {
  let executablePath;
  try {
    executablePath = fs.realpathSync(path.resolve(options.execPath || process.execPath));
  } catch {
    return null;
  }
  const releaseDirectory = path.dirname(executablePath);
  const releasesDirectory = path.dirname(releaseDirectory);
  if (path.basename(releasesDirectory) !== 'releases') return null;
  const installRoot = path.dirname(releasesDirectory);
  const currentExecutable = path.join(installRoot, 'current', 'remote-codex');
  try {
    if (fs.realpathSync(currentExecutable) !== executablePath) return null;
  } catch {
    return null;
  }

  const home = path.resolve(options.homedir || os.homedir());
  return {
    installRoot,
    binDirectory: process.env.REMOTE_CODEX_BIN_DIR || path.join(home, '.local', 'bin'),
    desktopDirectory:
      process.env.REMOTE_CODEX_DESKTOP_DIR || path.join(home, '.local', 'share', 'applications'),
    codexHomeDirectory:
      process.env.REMOTE_CODEX_CODEX_HOME_DIR ||
      process.env.CODEX_HOME ||
      path.join(home, '.codex')
  };
}

function runInstaller(options) {
  return spawnSync('bash', [options.installerPath, '--version', options.version], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REMOTE_CODEX_DOWNLOAD_BASE: `file://${options.downloadDirectory}`,
      REMOTE_CODEX_INSTALL_ROOT: options.installation.installRoot,
      REMOTE_CODEX_BIN_DIR: options.installation.binDirectory,
      REMOTE_CODEX_DESKTOP_DIR: options.installation.desktopDirectory,
      REMOTE_CODEX_CODEX_HOME_DIR: options.installation.codexHomeDirectory
    }
  });
}

async function fetchText(url, options = {}) {
  const response = await fetchHttps(url, options);
  const contentLength = Number(response.headers.get('content-length') || 0);
  const maxBytes = options.maxBytes || MAX_METADATA_BYTES;
  if (contentLength > maxBytes) throw new Error('Update metadata is too large.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('Update metadata is too large.');
  return buffer.toString('utf8');
}

async function downloadFile(url, destination, options = {}) {
  const response = await fetchHttps(url, { timeoutMs: 30 * 60 * 1000 });
  const maxBytes = options.maxBytes || MAX_ARCHIVE_BYTES;
  const total = Number(response.headers.get('content-length') || 0);
  if (total > maxBytes) throw new Error('Update package is too large.');
  const handle = await fs.promises.open(destination, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let transferred = 0;
  try {
    for await (const chunk of response.body) {
      transferred += chunk.length;
      if (transferred > maxBytes) throw new Error('Update package is too large.');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (bytesWritten <= 0) throw new Error('Could not write the update package.');
        offset += bytesWritten;
      }
      options.onProgress?.({
        percent: total > 0 ? (transferred / total) * 100 : 0,
        transferred,
        total
      });
    }
    await handle.close();
    return { sha256: hash.digest('hex'), transferred, total };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function fetchHttps(url, options = {}) {
  const parsed = new URL(String(url));
  if (parsed.protocol !== 'https:') throw new Error('Update URLs must use HTTPS.');
  const response = await fetch(parsed, {
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs || 30000),
    headers: { 'User-Agent': 'Remote-Codex-Updater' }
  });
  if (!response.ok) throw new Error(`Update server returned HTTP ${response.status}.`);
  if (new URL(response.url).protocol !== 'https:') {
    throw new Error('Update download redirected to a non-HTTPS URL.');
  }
  return response;
}

function normalizeVersion(value) {
  const version = semver.valid(String(value || '').trim().replace(/^v/, ''));
  if (!version) throw new Error('The update server returned an invalid version.');
  return version;
}

function normalizeArchitecture(architecture) {
  if (architecture === 'x64') return 'x64';
  if (architecture === 'arm64') return 'arm64';
  throw new Error(`Unsupported Linux architecture: ${architecture}`);
}

function parseChecksum(text, asset) {
  const match = String(text || '').trim().match(/^([0-9a-fA-F]{64})(?:\s+\*?([^\s]+))?/);
  if (!match) throw new Error('Release checksum is invalid.');
  if (match[2] && path.basename(match[2]) !== asset) {
    throw new Error('Release checksum names a different package.');
  }
  return match[1].toLowerCase();
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

module.exports = {
  LinuxTarUpdater,
  findManagedTarInstallation,
  normalizeVersion,
  parseChecksum
};
