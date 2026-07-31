#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  getBundledSkillSource,
  installBundledSkill
} = require('../src/bundledSkillInstaller');

const projectRoot = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-bundled-skill-'));
const codexHome = path.join(testRoot, 'codex-home');
const targetDir = path.join(codexHome, 'skills', 'remote-codex-send-files');

try {
  const sourceDir = getBundledSkillSource({ packaged: false, projectRoot });
  const first = installBundledSkill({ sourceDir, codexHome, version: '1.2.3' });
  assert.equal(first.installed, true);
  assert.equal(first.changed, true);
  assert.equal(
    fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8')
  );
  assert.equal(fs.statSync(path.join(targetDir, '.remote-codex-managed')).mode & 0o777, 0o600);

  const second = installBundledSkill({ sourceDir, codexHome, version: '1.2.3' });
  assert.equal(second.changed, false);

  fs.writeFileSync(path.join(targetDir, 'SKILL.md'), 'stale\n');
  const refreshed = installBundledSkill({ sourceDir, codexHome, version: '1.2.3' });
  assert.equal(refreshed.changed, true);
  assert.equal(
    fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8')
  );

  const symlinkHome = path.join(testRoot, 'symlink-home');
  const symlinkTarget = path.join(symlinkHome, 'skills', 'remote-codex-send-files');
  fs.mkdirSync(path.dirname(symlinkTarget), { recursive: true });
  fs.symlinkSync(targetDir, symlinkTarget);
  assert.throws(
    () => installBundledSkill({ sourceDir, codexHome: symlinkHome, version: '1.2.3' }),
    /Refusing symlinked bundled skill path/
  );

  console.log('Bundled Codex skill installer tests passed.');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
