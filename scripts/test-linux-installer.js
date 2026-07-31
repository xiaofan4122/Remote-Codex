#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-linux-installer-'));
const releaseDirectory = path.join(testRoot, 'release');
const payloadDirectory = path.join(testRoot, 'payload');
const homeDirectory = path.join(testRoot, 'home');
const installRoot = path.join(homeDirectory, '.local', 'opt', 'remote-codex');
const binDirectory = path.join(homeDirectory, '.local', 'bin');
const desktopDirectory = path.join(homeDirectory, '.local', 'share', 'applications');
const codexHomeDirectory = path.join(homeDirectory, '.codex');
const archiveName = 'remote-codex-linux-x64.tar.gz';
const archivePath = path.join(releaseDirectory, archiveName);
const checksumPath = `${archivePath}.sha256`;
const version = '9.8.7';

const installerEnvironment = {
  ...process.env,
  HOME: homeDirectory,
  REMOTE_CODEX_DOWNLOAD_BASE: `file://${releaseDirectory}`,
  REMOTE_CODEX_INSTALL_ROOT: installRoot,
  REMOTE_CODEX_BIN_DIR: binDirectory,
  REMOTE_CODEX_DESKTOP_DIR: desktopDirectory,
  REMOTE_CODEX_CODEX_HOME_DIR: codexHomeDirectory,
  REMOTE_CODEX_ARCH: 'x64'
};

try {
  prepareFakeRelease();

  const firstInstall = runInstaller();
  assert.equal(firstInstall.status, 0, firstInstall.stderr || firstInstall.stdout);
  assert.match(firstInstall.stdout, /Checksum verified/);
  assert.match(firstInstall.stdout, new RegExp(`Installed Remote Codex ${version}`));
  assertInstallation();

  const releaseEntriesBefore = fs.readdirSync(path.join(installRoot, 'releases'));
  const secondInstall = runInstaller();
  assert.equal(secondInstall.status, 0, secondInstall.stderr || secondInstall.stdout);
  assert.deepEqual(
    fs.readdirSync(path.join(installRoot, 'releases')),
    releaseEntriesBefore,
    'reinstalling an immutable release should be idempotent'
  );

  fs.writeFileSync(checksumPath, `${'0'.repeat(64)}  ${archiveName}\n`);
  const rejectedInstall = runInstaller();
  assert.notEqual(rejectedInstall.status, 0);
  assert.match(rejectedInstall.stderr, /checksum verification failed/);
  assertInstallation();

  const configPath = path.join(homeDirectory, '.remote-codex.json');
  fs.writeFileSync(configPath, '{"preserved":true}\n');
  const uninstall = spawnSync(path.join(binDirectory, 'remote-codex-uninstall'), ['--yes'], {
    cwd: projectRoot,
    env: installerEnvironment,
    encoding: 'utf8'
  });
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.equal(fs.existsSync(installRoot), false);
  assert.equal(fs.existsSync(path.join(binDirectory, 'remote-codex')), false);
  assert.equal(fs.existsSync(path.join(binDirectory, 'remote-codex-uninstall')), false);
  assert.equal(fs.existsSync(path.join(desktopDirectory, 'remote-codex.desktop')), false);
  assert.equal(
    fs.existsSync(path.join(codexHomeDirectory, 'skills', 'remote-codex-send-files')),
    false
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{"preserved":true}\n');

  console.log('Remote Codex Linux installer tests passed.');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}

function prepareFakeRelease() {
  const resources = path.join(payloadDirectory, 'resources');
  const skillSource = path.join(projectRoot, 'skills', 'remote-codex-send-files');
  fs.mkdirSync(path.join(resources, 'install'), { recursive: true });
  fs.mkdirSync(path.join(resources, 'skills'), { recursive: true });
  fs.cpSync(skillSource, path.join(resources, 'skills', 'remote-codex-send-files'), {
    recursive: true
  });
  fs.copyFileSync(
    path.join(projectRoot, 'scripts', 'uninstall-linux.sh'),
    path.join(resources, 'install', 'uninstall-linux.sh')
  );
  fs.writeFileSync(path.join(resources, 'icon.png'), 'test icon\n');
  fs.writeFileSync(
    path.join(payloadDirectory, 'remote-codex'),
    '#!/usr/bin/env bash\nprintf \'fake remote-codex\\n\'\n',
    { mode: 0o755 }
  );

  fs.mkdirSync(releaseDirectory, { recursive: true });
  const archive = spawnSync('tar', ['-czf', archivePath, '-C', payloadDirectory, '.'], {
    encoding: 'utf8'
  });
  assert.equal(archive.status, 0, archive.stderr || archive.stdout);

  const checksum = crypto
    .createHash('sha256')
    .update(fs.readFileSync(archivePath))
    .digest('hex');
  fs.writeFileSync(checksumPath, `${checksum}  ${archiveName}\n`);
  fs.writeFileSync(path.join(releaseDirectory, 'remote-codex-version.txt'), `${version}\n`);
}

function runInstaller() {
  return spawnSync('bash', ['install.sh'], {
    cwd: projectRoot,
    env: installerEnvironment,
    encoding: 'utf8'
  });
}

function assertInstallation() {
  const commandPath = path.join(binDirectory, 'remote-codex');
  const uninstallPath = path.join(binDirectory, 'remote-codex-uninstall');
  const desktopPath = path.join(desktopDirectory, 'remote-codex.desktop');
  const installedSkill = path.join(
    codexHomeDirectory,
    'skills',
    'remote-codex-send-files'
  );

  assert.equal(fs.lstatSync(commandPath).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(uninstallPath).isSymbolicLink(), true);
  assert.match(fs.readFileSync(desktopPath, 'utf8'), /X-Remote-Codex-Managed=true/);
  assert.equal(
    fs.readFileSync(path.join(installedSkill, 'SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(projectRoot, 'skills', 'remote-codex-send-files', 'SKILL.md'), 'utf8')
  );
  assert.match(
    fs.readFileSync(path.join(installedSkill, '.remote-codex-managed'), 'utf8'),
    new RegExp(`version=${version}`)
  );

  const command = spawnSync(commandPath, [], { encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr || command.stdout);
  assert.equal(command.stdout, 'fake remote-codex\n');
}
