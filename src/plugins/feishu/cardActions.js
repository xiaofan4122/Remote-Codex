function isSubmitCardAction(action) {
  const value = String(action || '').toLowerCase();
  return ['approve', 'approve_persistent', 'deny', 'enter', 'escape', 'viewer_exit'].includes(value) ||
    isPermissionModeAction(value);
}

function isNavigationCardAction(action) {
  return ['up', 'down', 'page_up', 'page_down', 'home', 'end', 'left', 'right', 'tab'].includes(
    String(action || '').toLowerCase()
  );
}

function isBlockingNativePageSubmitAction(action) {
  const value = String(action || '').toLowerCase();
  return ['enter', 'escape', 'viewer_exit'].includes(value) || isPermissionModeAction(value);
}

function isPermissionModeAction(action) {
  return ['permission_default', 'permission_auto_review', 'permission_full_access'].includes(
    String(action || '').toLowerCase()
  );
}

function formatRemoteActionLabel(action) {
  const value = String(action || '').toLowerCase();
  return {
    approve: '允许一次',
    approve_persistent: '总是允许',
    deny: '拒绝/退出',
    escape: '退出',
    enter: '确认',
    up: '上移',
    down: '下移',
    page_up: '上一页',
    page_down: '下一页',
    home: '顶部',
    end: '底部',
    viewer_exit: '关闭查看器',
    status: '状态',
    resume: '历史会话',
    permission: '权限',
    tail: '最近输出',
    stop: '中断任务'
  }[value] || value || '操作';
}

function formatActionSubmittedNotice(action) {
  return `已提交「${formatRemoteActionLabel(action)}」，等待 Codex 更新。`;
}

function formatActionStateText(status, action, page = '') {
  if (status === 'submitted') return formatActionFeedback(action, page).status;
  return '正在处理。';
}

function formatActionFeedback(action, page = '') {
  const value = String(action || '').toLowerCase();
  if (value === 'enter' && page === '/resume') {
    return {
      title: '正在恢复会话',
      status: '已提交恢复请求，正在等待 Codex 切换到所选会话。按钮已锁定，避免重复恢复。',
      detail: '确认本地 Codex 已离开历史会话列表后，这张卡片会自动更新。'
    };
  }
  if (isPermissionModeAction(value)) {
    const mode = formatPermissionModeActionLabel(value);
    return {
      title: '正在更新权限模式',
      status: `正在将 Codex 权限模式切换为 ${mode}。按钮已锁定，避免重复提交。`,
      detail: '确认本地 Codex 已应用该模式后，这张卡片会自动更新。'
    };
  }
  if (value === 'enter') {
    return {
      title: '正在确认选择',
      status: '已提交当前选择，正在等待 Codex 更新。',
      detail: '请等待当前页面刷新。'
    };
  }
  if (value === 'escape') {
    return {
      title: '正在退出页面',
      status: '已提交退出请求，正在返回 Codex 命令界面。按钮已锁定，避免重复退出。',
      detail: '确认本地 Codex 已离开当前页面后，这张卡片会自动更新。'
    };
  }
  if (value === 'viewer_exit') {
    return {
      title: '正在关闭查看器',
      status: '已提交关闭请求，正在返回 Codex 命令界面。',
      detail: '确认本地 Codex 已离开查看器后，这张卡片会自动更新。'
    };
  }
  if (isNavigationCardAction(value)) {
    return {
      title: '正在刷新选择',
      status: `已提交「${formatRemoteActionLabel(value)}」，正在更新当前选项。`,
      detail: '选中项刷新后会继续显示在当前卡片中。'
    };
  }
  if (value === 'stop') {
    return {
      title: '正在中断任务',
      status: '已请求中断当前任务，Codex 会话会继续保留。',
      detail: '稍后可以继续发送新的任务。'
    };
  }
  if (['resume', 'permission', 'status', 'tail'].includes(value)) {
    return {
      title: '正在打开页面',
      status: `已提交「${formatRemoteActionLabel(value)}」请求。`,
      detail: '新页面加载后会显示对应内容。'
    };
  }
  if (isSubmitCardAction(value)) {
    return {
      title: '操作已提交',
      status: `已提交「${formatRemoteActionLabel(value)}」。`,
      detail: '这张卡片已锁定，避免重复确认。'
    };
  }
  return {
    title: '操作处理中',
    status: `已提交「${formatRemoteActionLabel(value)}」。`,
    detail: '正在等待 Codex 更新。'
  };
}

function formatPermissionModeActionLabel(action) {
  return {
    permission_default: 'Ask for approval',
    permission_auto_review: 'Approve for me',
    permission_full_access: 'Full Access'
  }[String(action || '').toLowerCase()] || formatRemoteActionLabel(action);
}

function buildStreamingActionFeedback({ action, page = '', currentText = '' } = {}) {
  const feedback = formatActionFeedback(action, page);
  if (isNavigationCardAction(action)) {
    const content = String(currentText || '').trim();
    return [
      content,
      '',
      '**操作状态**',
      `- ${feedback.status}`
    ].filter(Boolean).join('\n');
  }
  return [
    `**${feedback.title}**`,
    `- ${feedback.status}`,
    `- ${feedback.detail}`
  ].join('\n');
}

function isControlAckText(text) {
  return /^已发送/.test(String(text || '').trim()) ||
    /请勿重复点击/.test(String(text || ''));
}

module.exports = {
  buildStreamingActionFeedback,
  formatActionFeedback,
  formatActionStateText,
  formatActionSubmittedNotice,
  formatRemoteActionLabel,
  isBlockingNativePageSubmitAction,
  isControlAckText,
  isNavigationCardAction,
  isPermissionModeAction,
  isSubmitCardAction
};
