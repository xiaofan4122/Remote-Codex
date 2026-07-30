const fs = require('node:fs');
const path = require('node:path');

const REMOTE_FILE_DIRECTIVE_PATTERN = /^\s*\[\[remote-codex-file:(.+)\]\]\s*$/;
const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024;

function extractRemoteFileDirectives(value) {
  const files = [];
  const seen = new Set();
  const textLines = [];

  for (const line of String(value || '').replace(/\r\n?/g, '\n').split('\n')) {
    const match = line.match(REMOTE_FILE_DIRECTIVE_PATTERN);
    if (!match) {
      textLines.push(line);
      continue;
    }
    const filePath = String(match[1] || '').trim();
    if (filePath && !seen.has(filePath)) {
      seen.add(filePath);
      files.push(filePath);
    }
  }

  return {
    text: textLines.join('\n').replace(/^\n+|\n+$/g, ''),
    files
  };
}

function validateRemoteFile(filePath, options = {}) {
  const requestedPath = String(filePath || '').trim();
  const cwd = String(options.cwd || '').trim();
  const maxBytes = normalizeMaxBytes(options.maxBytes);

  if (!requestedPath || !path.isAbsolute(requestedPath)) {
    throw fileError('path_not_absolute', '文件路径必须是绝对路径。');
  }
  if (!cwd) {
    throw fileError('missing_cwd', '当前 Codex 会话没有工作目录。');
  }

  let root;
  let target;
  try {
    root = fs.realpathSync(cwd);
  } catch {
    throw fileError('invalid_cwd', '当前 Codex 工作目录不存在。');
  }
  try {
    target = fs.realpathSync(requestedPath);
  } catch {
    throw fileError('file_not_found', '文件不存在。');
  }

  if (!isPathInside(root, target)) {
    throw fileError('outside_workspace', '只允许发送当前 Codex 工作目录内的文件。');
  }

  const stat = fs.statSync(target);
  if (!stat.isFile()) {
    throw fileError('not_regular_file', '只能发送普通文件。');
  }
  if (stat.size <= 0) {
    throw fileError('empty_file', '不能发送空文件。');
  }
  if (stat.size > maxBytes) {
    throw fileError(
      'file_too_large',
      `文件超过 ${formatBytes(maxBytes)} 的发送上限。`
    );
  }

  return {
    path: target,
    name: path.basename(target),
    size: stat.size
  };
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function normalizeMaxBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return FEISHU_FILE_MAX_BYTES;
  return Math.min(Math.floor(number), FEISHU_FILE_MAX_BYTES);
}

function fileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function formatBytes(bytes) {
  const mib = Number(bytes) / (1024 * 1024);
  return Number.isInteger(mib) ? `${mib} MB` : `${mib.toFixed(1)} MB`;
}

module.exports = {
  FEISHU_FILE_MAX_BYTES,
  extractRemoteFileDirectives,
  validateRemoteFile
};
