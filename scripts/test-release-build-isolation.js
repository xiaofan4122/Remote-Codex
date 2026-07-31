const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const script = fs.readFileSync(
  path.join(projectRoot, 'scripts', 'build-linux-release-container.sh'),
  'utf8'
);
const ciWorkflow = fs.readFileSync(
  path.join(projectRoot, '.github', 'workflows', 'ci.yml'),
  'utf8'
);
const releaseWorkflow = fs.readFileSync(
  path.join(projectRoot, '.github', 'workflows', 'release.yml'),
  'utf8'
);
const builderConfig = fs.readFileSync(
  path.join(projectRoot, 'electron-builder.yml'),
  'utf8'
);

assert.match(script, /REMOTE_CODEX_BUILD_WORK_DIR=.*mktemp -d/);
assert.match(script, /REMOTE_CODEX_PROJECT_ROOT}:\/source:ro/);
assert.match(script, /REMOTE_CODEX_BUILD_WORK_DIR}:\/workspace/);
assert.match(script, /REMOTE_CODEX_PROJECT_ROOT}\/dist:\/output/);
assert.match(script, /--exclude=.\/node_modules/);
assert.match(script, /--exclude=.\/dist/);
assert.doesNotMatch(script, /REMOTE_CODEX_PROJECT_ROOT}:\/workspace/);
assert.match(script, /REMOTE_CODEX_DOCKER_STATUS.*-ne 125/s);
assert.match(ciWorkflow, /apt-get install[^\n]+fonts-noto-cjk/);
assert.match(releaseWorkflow, /apt-get install[^\n]+fonts-noto-cjk/);
assert.match(script, /REMOTE_CODEX_UPDATE_METADATA=latest-linux\.yml/);
assert.match(script, /REMOTE_CODEX_UPDATE_METADATA=latest-linux-arm64\.yml/);
assert.match(releaseWorkflow, /release-assets\/latest-linux\.yml/);
assert.match(releaseWorkflow, /release-assets\/latest-linux-arm64\.yml/);
assert.match(builderConfig, /provider: github/);
assert.match(builderConfig, /repo: Remote-Codex/);
assert.match(builderConfig, /to: install\/install-linux\.sh/);

const retried = runContainerScriptWithMockDocker('retry');
assert.equal(retried.status, 0, retried.stderr);
assert.equal(retried.dockerRuns, 2);
assert.match(retried.stderr, /retrying once/);

const buildFailure = runContainerScriptWithMockDocker('build_failure');
assert.equal(buildFailure.status, 37);
assert.equal(buildFailure.dockerRuns, 1);
assert.doesNotMatch(buildFailure.stderr, /retrying once/);

process.stdout.write('Release build isolation tests passed.\n');

function runContainerScriptWithMockDocker(mode) {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'remote-codex-release-container-test-')
  );
  try {
    const fixtureScripts = path.join(fixtureRoot, 'scripts');
    const fixtureBin = path.join(fixtureRoot, 'bin');
    const fixtureHome = path.join(fixtureRoot, 'home');
    const dockerCountPath = path.join(fixtureRoot, 'docker-count');
    fs.mkdirSync(fixtureScripts, { recursive: true });
    fs.mkdirSync(fixtureBin, { recursive: true });
    fs.mkdirSync(fixtureHome, { recursive: true });

    const fixtureScript = path.join(
      fixtureScripts,
      'build-linux-release-container.sh'
    );
    fs.copyFileSync(
      path.join(projectRoot, 'scripts', 'build-linux-release-container.sh'),
      fixtureScript
    );
    fs.chmodSync(fixtureScript, 0o755);

    const dockerMock = path.join(fixtureBin, 'docker');
    fs.writeFileSync(dockerMock, `#!/usr/bin/env bash
set -eu
count=0
if [ -f "\${REMOTE_CODEX_TEST_DOCKER_COUNT}" ]; then
  count="$(<"\${REMOTE_CODEX_TEST_DOCKER_COUNT}")"
fi
count=$((count + 1))
printf '%s\\n' "\${count}" > "\${REMOTE_CODEX_TEST_DOCKER_COUNT}"
if [ "\${REMOTE_CODEX_TEST_DOCKER_MODE}" = retry ] && [ "\${count}" -eq 1 ]; then
  exit 125
fi
if [ "\${REMOTE_CODEX_TEST_DOCKER_MODE}" = build_failure ]; then
  exit 37
fi
exit 0
`);
    fs.chmodSync(dockerMock, 0o755);

    const sleepMock = path.join(fixtureBin, 'sleep');
    fs.writeFileSync(sleepMock, '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(sleepMock, 0o755);

    const result = spawnSync('bash', [fixtureScript, 'x64'], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        HOME: fixtureHome,
        PATH: `${fixtureBin}:${process.env.PATH}`,
        REMOTE_CODEX_TEST_DOCKER_COUNT: dockerCountPath,
        REMOTE_CODEX_TEST_DOCKER_MODE: mode,
        XDG_CACHE_HOME: path.join(fixtureRoot, 'cache')
      },
      encoding: 'utf8'
    });
    return {
      status: result.status,
      stderr: result.stderr,
      dockerRuns: Number(fs.readFileSync(dockerCountPath, 'utf8').trim())
    };
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
