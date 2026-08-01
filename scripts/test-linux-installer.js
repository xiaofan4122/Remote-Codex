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
  for (const expectedStage of [
    '[1/8] Checking system compatibility',
    '[2/8] Resolving the release version',
    `[3/8] Downloading Remote Codex ${version}`,
    '[4/8] Verifying release integrity',
    '[5/8] Inspecting and extracting the archive',
    '[6/8] Installing application files atomically',
    '[7/8] Installing command and desktop integrations',
    '[8/8] Installation complete'
  ]) {
    assert.ok(firstInstall.stdout.includes(expectedStage), `missing installer stage: ${expectedStage}`);
  }
  assert.match(firstInstall.stdout, /Download complete: [0-9.]+ (?:bytes|KiB|MiB|GiB)/);
  assert.match(firstInstall.stdout, /SHA-256 verified: [0-9a-f]{64}/);
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
  assert.match(secondInstall.stdout, /Release already present; reusing/);

  testInteractiveDownloadConfiguration();

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

function testInteractiveDownloadConfiguration() {
  const fakeBinDirectory = path.join(testRoot, 'fake-bin');
  const fakeCurlPath = path.join(fakeBinDirectory, 'curl');
  const curlLogPath = path.join(testRoot, 'curl-arguments.log');
  fs.mkdirSync(fakeBinDirectory, { recursive: true });
  fs.writeFileSync(fakeCurlPath, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$@" >> "$REMOTE_CODEX_TEST_CURL_LOG"
remote_codex_destination=''
remote_codex_url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      remote_codex_destination="$2"
      shift 2
      ;;
    *)
      remote_codex_url="$1"
      shift
      ;;
  esac
done
cp "$REMOTE_CODEX_TEST_RELEASE_DIR/\${remote_codex_url##*/}" "$remote_codex_destination"
`, { mode: 0o755 });

  const result = spawnSync('bash', ['install.sh', '--version', version, '--no-desktop'], {
    cwd: projectRoot,
    env: {
      ...installerEnvironment,
      PATH: `${fakeBinDirectory}:${process.env.PATH}`,
      REMOTE_CODEX_DOWNLOAD_BASE: 'https://downloads.example.test/remote-codex',
      REMOTE_CODEX_PROGRESS: 'always',
      REMOTE_CODEX_TEST_CURL_LOG: curlLogPath,
      REMOTE_CODEX_TEST_RELEASE_DIR: releaseDirectory
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal((result.stdout.match(/Progress:/g) || []).length, 2);

  const curlArguments = fs.readFileSync(curlLogPath, 'utf8');
  for (const expectedArgument of [
    '--retry',
    '--retry-delay',
    '--connect-timeout',
    '--speed-limit',
    '--speed-time'
  ]) {
    assert.ok(curlArguments.includes(expectedArgument), `missing curl option: ${expectedArgument}`);
  }
  assert.equal(curlArguments.includes('--silent'), false);
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
