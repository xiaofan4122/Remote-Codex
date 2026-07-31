#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AppUpdateManager,
  detectLinuxInstallation
} = require('../src/appUpdateManager');
const {
  LinuxTarUpdater,
  findManagedTarInstallation,
  parseChecksum
} = require('../src/linuxTarUpdater');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-app-updates-'));

async function run() {
  await testManualUpdateLifecycle();
  await testAutomaticDownloadAndConfigToggle();
  testInstallModeDetection();
  await testManagedTarUpdate();
  console.log('Application update tests passed.');
}

async function testManualUpdateLifecycle() {
  const updater = new FakeUpdater();
  const manager = new AppUpdateManager({
    app: fakeApp('1.2.3'),
    updater,
    installMode: 'deb',
    config: { updates: { automaticEnabled: false } },
    logger: silentLogger()
  });
  const states = [];
  manager.subscribe((state) => states.push(state.status));

  await manager.check({ manual: true });
  assert.equal(manager.getState().status, 'available');
  assert.equal(manager.getState().latestVersion, '1.3.0');
  assert.equal(updater.downloadCalls, 0, 'manual mode must not download automatically');

  await manager.download();
  assert.equal(manager.getState().status, 'downloaded');
  assert.equal(manager.getState().percent, 100);
  assert.equal(updater.downloadCalls, 1);
  assert.ok(states.includes('downloading'));

  manager.installAndRestart();
  assert.equal(updater.installCalls, 1);
  assert.equal(manager.getState().status, 'installing');
}

async function testAutomaticDownloadAndConfigToggle() {
  const updater = new FakeUpdater();
  const manager = new AppUpdateManager({
    app: fakeApp('1.2.3'),
    updater,
    installMode: 'deb',
    config: { updates: { automaticEnabled: true } },
    logger: silentLogger()
  });
  assert.equal(updater.autoInstallOnAppQuit, true);

  await manager.check({ manual: false });
  await waitFor(() => manager.getState().status === 'downloaded');
  assert.equal(updater.downloadCalls, 1);

  manager.updateConfig({ updates: { automaticEnabled: false } });
  assert.equal(manager.getState().automaticEnabled, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
}

function testInstallModeDetection() {
  const resourcesPath = path.join(fixtureRoot, 'deb-resources');
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.writeFileSync(path.join(resourcesPath, 'package-type'), 'deb\n');
  assert.equal(detectLinuxInstallation({
    app: { isPackaged: true },
    resourcesPath,
    execPath: '/missing'
  }).mode, 'deb');
  assert.equal(detectLinuxInstallation({
    app: { isPackaged: false },
    resourcesPath,
    execPath: '/missing'
  }).mode, 'development');
}

async function testManagedTarUpdate() {
  const home = path.join(fixtureRoot, 'home');
  const installRoot = path.join(home, '.local', 'opt', 'remote-codex');
  const releaseDirectory = path.join(installRoot, 'releases', '1.2.3-x64-deadbeef');
  const executable = path.join(releaseDirectory, 'remote-codex');
  const resourcesPath = path.join(releaseDirectory, 'resources');
  const userData = path.join(home, '.config', 'remote-codex');
  fs.mkdirSync(path.join(resourcesPath, 'install'), { recursive: true });
  fs.writeFileSync(executable, '#!/bin/sh\n');
  fs.chmodSync(executable, 0o755);
  fs.symlinkSync('releases/1.2.3-x64-deadbeef', path.join(installRoot, 'current'));
  fs.writeFileSync(path.join(resourcesPath, 'install', 'install-linux.sh'), '#!/bin/sh\n');

  const installation = findManagedTarInstallation({ execPath: executable, homedir: home });
  assert.equal(installation.installRoot, installRoot);
  assert.equal(detectLinuxInstallation({
    app: { isPackaged: true },
    resourcesPath,
    execPath: executable,
    homedir: home
  }).mode, 'tar');

  const archive = Buffer.from('verified full tar archive fixture');
  const checksum = crypto.createHash('sha256').update(archive).digest('hex');
  const calls = { urls: [], installs: [], relaunches: [], quit: 0 };
  const app = new EventEmitter();
  app.getVersion = () => '1.2.3';
  app.getPath = () => userData;
  app.relaunch = (options) => calls.relaunches.push(options);
  app.quit = () => {
    calls.quit += 1;
  };

  const updater = new LinuxTarUpdater({
    app,
    installation,
    resourcesPath,
    releaseOrigin: 'https://updates.example.test/project',
    logger: silentLogger(),
    fetchText: async (url) => {
      calls.urls.push(url);
      if (url.endsWith('remote-codex-version.txt')) return '1.3.0\n';
      if (url.endsWith('.sha256')) return `${checksum}  remote-codex-linux-x64.tar.gz\n`;
      throw new Error(`Unexpected URL: ${url}`);
    },
    downloadFile: async (url, destination, options) => {
      calls.urls.push(url);
      fs.writeFileSync(destination, archive);
      options.onProgress({ percent: 100, transferred: archive.length, total: archive.length });
      return { sha256: checksum, transferred: archive.length, total: archive.length };
    },
    installRunner: (options) => {
      calls.installs.push(options);
      return { status: 0, stdout: '', stderr: '' };
    }
  });
  updater.on('error', () => {});

  const check = await updater.checkForUpdates();
  assert.equal(check.isUpdateAvailable, true);
  assert.ok(calls.urls[0].includes('/releases/latest/download/'));
  const downloaded = await updater.downloadUpdate();
  assert.equal(downloaded.length, 1);
  assert.ok(calls.urls.some((url) => url.includes('/releases/download/v1.3.0/')));
  assert.equal(parseChecksum(`${checksum}  remote-codex-linux-x64.tar.gz`, 'remote-codex-linux-x64.tar.gz'), checksum);

  assert.equal(updater.quitAndInstall(false, true), true);
  assert.equal(calls.installs.length, 1);
  assert.equal(calls.installs[0].downloadDirectory, path.join(userData, 'updates', '1.3.0'));
  assert.equal(calls.relaunches[0].execPath, path.join(installRoot, 'current', 'remote-codex'));
  assert.equal(calls.quit, 1);
}

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.downloadCalls = 0;
    this.installCalls = 0;
  }

  async checkForUpdates() {
    this.emit('checking-for-update');
    const updateInfo = { version: '1.3.0' };
    this.emit('update-available', updateInfo);
    return { isUpdateAvailable: true, updateInfo };
  }

  async downloadUpdate() {
    this.downloadCalls += 1;
    this.emit('download-progress', { percent: 42.5, transferred: 425, total: 1000 });
    await new Promise((resolve) => setImmediate(resolve));
    this.emit('update-downloaded', { version: '1.3.0' });
    return ['/tmp/fake-update.deb'];
  }

  quitAndInstall() {
    this.installCalls += 1;
    return true;
  }
}

function fakeApp(version) {
  return {
    getVersion: () => version
  };
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    event() {}
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for update state.');
}

run().finally(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
