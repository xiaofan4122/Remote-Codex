#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const disableScript = path.join(__dirname, 'disable-development-version.sh');
const restoreScript = path.join(__dirname, 'restore-development-version.sh');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-toggle-'));
const fakeHome = path.join(tempRoot, 'home');
const fakeSource = path.join(tempRoot, 'source');
const fakeProc = path.join(tempRoot, 'proc');
const fakeTools = path.join(tempRoot, 'tools');
const killLog = path.join(tempRoot, 'kill.log');
const desktopLog = path.join(tempRoot, 'desktop.log');
const launcher = path.join(fakeHome, '.local/bin/remote-codex');
const desktop = path.join(fakeHome, '.local/share/applications/remote-codex.desktop');
const suffix = '.development-disabled';

fs.mkdirSync(path.join(fakeSource, 'scripts'), { recursive: true });
fs.mkdirSync(path.dirname(launcher), { recursive: true });
fs.mkdirSync(path.dirname(desktop), { recursive: true });
fs.mkdirSync(fakeProc, { recursive: true });
fs.mkdirSync(fakeTools, { recursive: true });
fs.writeFileSync(path.join(fakeSource, 'package.json'), '{"name":"remote-codex"}\n');
fs.writeFileSync(path.join(fakeSource, 'scripts/start-electron.sh'), '#!/usr/bin/env bash\n');
const fakeElectron = path.join(fakeSource, 'node_modules/electron/dist/electron');
fs.mkdirSync(path.dirname(fakeElectron), { recursive: true });
fs.writeFileSync(fakeElectron, '');

const fakeKill = path.join(fakeTools, 'fake-kill');
fs.writeFileSync(fakeKill, `#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\\n' "$1" "$2" >> "${killLog}"
rm -rf "${fakeProc}/$2"
`);
const fakeDesktopUpdate = path.join(fakeTools, 'update-desktop-database');
fs.writeFileSync(fakeDesktopUpdate, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1" >> "${desktopLog}"
`);
fs.chmodSync(fakeKill, 0o755);
fs.chmodSync(fakeDesktopUpdate, 0o755);

function writeLaunchers() {
  fs.writeFileSync(launcher, `#!/usr/bin/env bash\nAPP_DIR="${fakeSource}"\n`);
  fs.writeFileSync(desktop, `[Desktop Entry]\nExec=${launcher}\nIcon=${fakeSource}/build/icons/512x512.png\n`);
  fs.chmodSync(launcher, 0o755);
  fs.chmodSync(desktop, 0o744);
}

function addProcess(pid, cwd, commandLine, executable = null) {
  const processDir = path.join(fakeProc, String(pid));
  fs.mkdirSync(processDir, { recursive: true });
  fs.symlinkSync(cwd, path.join(processDir, 'cwd'));
  if (executable) {
    fs.symlinkSync(executable, path.join(processDir, 'exe'));
  }
  fs.writeFileSync(path.join(processDir, 'cmdline'), Buffer.from(`${commandLine.split(' ').join('\0')}\0`));
}

function run(script) {
  return spawnSync('bash', [script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fakeHome,
      PATH: `${fakeTools}:${process.env.PATH}`,
      REMOTE_CODEX_SOURCE_DIR: fakeSource,
      REMOTE_CODEX_PROC_ROOT: fakeProc,
      REMOTE_CODEX_KILL_COMMAND: fakeKill
    }
  });
}

function assertSuccess(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

writeLaunchers();
const originalLauncher = fs.readFileSync(launcher);
const originalDesktop = fs.readFileSync(desktop);
const originalLauncherMode = fs.statSync(launcher).mode & 0o777;
const originalDesktopMode = fs.statSync(desktop).mode & 0o777;
addProcess(101, fakeSource, '/usr/bin/npm start');
addProcess(102, '/opt/Remote Codex', '/opt/Remote Codex/remote-codex');
addProcess(103, fakeSource, '/usr/bin/codex');
addProcess(104, tempRoot, '/usr/bin/electron .');
addProcess(105, fakeSource, `${fakeElectron} .`, fakeElectron);

let result = run(disableScript);
assertSuccess(result);
assert.equal(fs.existsSync(launcher), false);
assert.equal(fs.existsSync(desktop), false);
assert.equal(fs.existsSync(`${launcher}${suffix}`), true);
assert.equal(fs.existsSync(`${desktop}${suffix}`), true);
assert.deepEqual(fs.readFileSync(killLog, 'utf8').trim().split('\n').sort(), ['-TERM 101', '-TERM 105']);
assert.equal(fs.existsSync(path.join(fakeProc, '102')), true, 'must not stop the /opt package');
assert.equal(fs.existsSync(path.join(fakeProc, '103')), true, 'must not stop Codex CLI');
assert.equal(fs.existsSync(path.join(fakeProc, '104')), true, 'must not stop unrelated Electron');

result = run(disableScript);
assertSuccess(result);
assert.match(result.stdout, /已经处于屏蔽状态/);

result = run(restoreScript);
assertSuccess(result);
assert.equal(fs.existsSync(launcher), true);
assert.equal(fs.existsSync(desktop), true);
assert.equal(fs.existsSync(`${launcher}${suffix}`), false);
assert.equal(fs.existsSync(`${desktop}${suffix}`), false);
assert.deepEqual(fs.readFileSync(launcher), originalLauncher);
assert.deepEqual(fs.readFileSync(desktop), originalDesktop);
assert.equal(fs.statSync(launcher).mode & 0o777, originalLauncherMode);
assert.equal(fs.statSync(desktop).mode & 0o777, originalDesktopMode);

result = run(restoreScript);
assertSuccess(result);
assert.match(result.stdout, /已经恢复/);

fs.copyFileSync(launcher, `${launcher}${suffix}`);
result = run(disableScript);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /同时存在，拒绝覆盖/);
assert.equal(fs.existsSync(launcher), true);
assert.equal(fs.existsSync(`${launcher}${suffix}`), true);
result = run(restoreScript);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /同时存在，拒绝覆盖/);
fs.rmSync(`${launcher}${suffix}`);

fs.writeFileSync(launcher, '#!/usr/bin/env bash\nexec /opt/Remote\\ Codex/remote-codex\n');
result = run(disableScript);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /不属于当前源码仓库/);
assert.equal(fs.existsSync(launcher), true);

fs.rmSync(launcher);
fs.rmSync(desktop);
result = run(disableScript);
assertSuccess(result);
assert.match(result.stdout, /不存在，跳过/);
result = run(restoreScript);
assertSuccess(result);
assert.match(result.stdout, /均不存在，跳过/);

assert.ok(fs.readFileSync(desktopLog, 'utf8').trim().split('\n').length >= 4);
fs.rmSync(tempRoot, { recursive: true, force: true });
process.stdout.write('Development-version toggle tests passed.\n');
