function buildResumeHint(options = {}) {
  const command = String(options.command || 'remote-codex').trim() || 'remote-codex';
  const sessionId = extractCodexSessionId(options.session || options.text || '');
  const cwd = String(options.cwd || options.session?.cwd || '').trim();
  const resumeTarget = sessionId ? shellQuote(sessionId) : '--last';
  const resumeCommand = `${command} --resume ${resumeTarget}`;
  const promptCommand = `${resumeCommand} ${shellQuote('继续刚才的任务')}`;
  const lines = [];

  lines.push('');
  lines.push('[Remote Codex] 已停止。可以用下面的命令恢复 Codex 会话：');
  if (cwd) {
    lines.push(`  cd ${shellQuote(cwd)}`);
  }
  lines.push(`  ${resumeCommand}`);
  lines.push('');
  lines.push('也可以直接带上下一条消息：');
  lines.push(`  ${promptCommand}`);
  if (!sessionId) {
    lines.push('');
    lines.push('未能从当前画面读取原生 Codex Session ID，已使用 --last 恢复最近会话。');
  }
  lines.push('');
  return lines.join('\n');
}

function extractCodexSessionId(source) {
  const text = typeof source === 'string'
    ? source
    : [
        source?.visualViewportSnapshot,
        source?.visualSnapshot,
        source?.snapshot,
        source?.raw
      ].filter(Boolean).join('\n');
  const match = String(text || '').match(/\bSession:\s*([0-9a-f]{8}-[0-9a-f-]{20,}|[A-Za-z0-9_-]{8,})\b/i);
  return match ? match[1] : '';
}

function shellQuote(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

module.exports = {
  buildResumeHint,
  extractCodexSessionId,
  shellQuote
};
