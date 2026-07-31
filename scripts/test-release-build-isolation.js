const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

assert.match(script, /REMOTE_CODEX_BUILD_WORK_DIR=.*mktemp -d/);
assert.match(script, /REMOTE_CODEX_PROJECT_ROOT}:\/source:ro/);
assert.match(script, /REMOTE_CODEX_BUILD_WORK_DIR}:\/workspace/);
assert.match(script, /REMOTE_CODEX_PROJECT_ROOT}\/dist:\/output/);
assert.match(script, /--exclude=.\/node_modules/);
assert.match(script, /--exclude=.\/dist/);
assert.doesNotMatch(script, /REMOTE_CODEX_PROJECT_ROOT}:\/workspace/);
assert.match(ciWorkflow, /apt-get install[^\n]+fonts-noto-cjk/);
assert.match(releaseWorkflow, /apt-get install[^\n]+fonts-noto-cjk/);

process.stdout.write('Release build isolation tests passed.\n');
