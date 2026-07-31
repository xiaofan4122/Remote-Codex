const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SKILL_NAME = 'remote-codex-send-files';
const MANAGED_MARKER = '.remote-codex-managed';

function getBundledSkillSource(options = {}) {
  const packaged = options.packaged ?? Boolean(process.resourcesPath);
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  if (packaged && resourcesPath) {
    return path.join(resourcesPath, 'skills', SKILL_NAME);
  }
  return path.join(options.projectRoot || path.resolve(__dirname, '..'), 'skills', SKILL_NAME);
}

function installBundledSkill(options = {}) {
  const sourceDir = options.sourceDir || getBundledSkillSource(options);
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const targetDir = path.join(codexHome, 'skills', SKILL_NAME);
  const files = [
    ['SKILL.md'],
    ['agents', 'openai.yaml']
  ];

  for (const parts of files) {
    const sourceFile = path.join(sourceDir, ...parts);
    if (!isRegularFile(sourceFile)) {
      return { installed: false, reason: 'source_missing', sourceDir, targetDir };
    }
  }

  assertNotSymlink(targetDir);
  assertNotSymlink(path.join(targetDir, 'agents'));
  for (const parts of files) {
    assertNotSymlink(path.join(targetDir, ...parts));
  }

  fs.mkdirSync(path.join(targetDir, 'agents'), { recursive: true, mode: 0o700 });

  let changed = false;
  for (const parts of files) {
    changed = copyFileIfChanged(
      path.join(sourceDir, ...parts),
      path.join(targetDir, ...parts),
      0o644
    ) || changed;
  }

  const version = String(options.version || '').trim();
  const marker = `repository=xiaofan4122/Remote-Codex\nversion=${version}\n`;
  changed = writeFileIfChanged(path.join(targetDir, MANAGED_MARKER), marker, 0o600) || changed;

  return { installed: true, changed, sourceDir, targetDir };
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function assertNotSymlink(filePath) {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`Refusing symlinked bundled skill path: ${filePath}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function copyFileIfChanged(source, target, mode) {
  const content = fs.readFileSync(source);
  return writeFileIfChanged(target, content, mode);
}

function writeFileIfChanged(target, content, mode) {
  try {
    const current = fs.readFileSync(target);
    const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (current.equals(next)) {
      fs.chmodSync(target, mode);
      return false;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporary = `${target}.remote-codex-${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, mode);
  return true;
}

module.exports = {
  SKILL_NAME,
  getBundledSkillSource,
  installBundledSkill
};
