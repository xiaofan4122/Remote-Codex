const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const shellFiles = [
  path.join(projectRoot, 'install.sh'),
  ...fs.readdirSync(__dirname)
    .filter((name) => name.endsWith('.sh'))
    .map((name) => path.join(__dirname, name))
].sort();

for (const file of shellFiles) {
  const result = spawnSync('bash', ['-n', file], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || `Shell syntax failed: ${file}`);
}

process.stdout.write(`Shell syntax tests passed (${shellFiles.length} files).\n`);
