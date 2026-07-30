function buildSubmitInput(text) {
  const value = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (isPassthroughSlashCommand(value)) {
    return `${value}\r`;
  }
  return `\x1b[200~${value}\x1b[201~\r`;
}

function isPassthroughSlashCommand(text) {
  const value = String(text || '').trim();
  return value.startsWith('/') && !value.includes('\n');
}

function buildControlInput(action) {
  const value = String(action || '').toLowerCase();
  if (value === 'approve' || value === 'yes') return 'y';
  if (value === 'enter') return '\r';
  if (value === 'approve_persistent' || value === 'always' || value === 'persist') {
    return 'p';
  }
  if (value === 'deny' || value === 'escape' || value === 'cancel' || value === 'no') {
    return '\x1b';
  }
  if (value === 'up') return '\x1b[A';
  if (value === 'down') return '\x1b[B';
  if (value === 'page_up') return '\x1b[5~';
  if (value === 'page_down') return '\x1b[6~';
  if (value === 'home') return '\x1b[H';
  if (value === 'end') return '\x1b[F';
  if (value === 'right') return '\x1b[C';
  if (value === 'left') return '\x1b[D';
  if (value === 'tab') return '\t';
  if (value === 'viewer_exit') return 'q';
  return '';
}

function permissionModeActionIndex(action) {
  return {
    permission_default: 1,
    permission_auto_review: 2,
    permission_full_access: 3
  }[String(action || '').toLowerCase()] || 0;
}

function permissionModeActionLabel(action) {
  return {
    permission_default: 'Ask for approval',
    permission_auto_review: 'Approve for me',
    permission_full_access: 'Full Access'
  }[String(action || '').toLowerCase()] || '';
}

function formatPermissionModeResultHint(mode) {
  return {
    'Ask for approval': '保留工作区读写能力；联网或越界文件操作仍需要确认。',
    'Approve for me': '只对检测为潜在不安全的动作继续询问，适合减少手动审批打断。',
    Default: '保留工作区读写能力；联网或越界文件操作仍需要确认。',
    'Auto-review': '符合条件的确认会先走自动审查，适合减少手动审批打断。',
    'Full Access': 'Codex 可越过工作区和联网审批限制，请只在可信任务中使用。'
  }[mode] || '权限模式已应用。';
}

function isPermissionModeControlAction(action) {
  return Boolean(permissionModeActionIndex(action));
}

module.exports = {
  buildControlInput,
  buildSubmitInput,
  formatPermissionModeResultHint,
  isPassthroughSlashCommand,
  isPermissionModeControlAction,
  permissionModeActionIndex,
  permissionModeActionLabel
};
