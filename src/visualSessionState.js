const SPINNER_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const RUNNING_STATUS_PATTERN = /^(?:(?:Working|Thinking|Reading|Writing|Finding|Searching|Running|Checking|Applying|Planning)(?=$|[\s(.])|Booting MCP server|MCP startup|Starting MCP)/i;

function getSnapshotTextLines(snapshot) {
  if (!snapshot) return [];
  if (Array.isArray(snapshot)) {
    return snapshot.map(snapshotLineText).filter(Boolean);
  }
  if (typeof snapshot === 'object' && Array.isArray(snapshot.lines)) {
    return snapshot.lines.map(snapshotLineText).filter(Boolean);
  }
  return String(snapshot)
    .split('\n')
    .map(snapshotLineText)
    .filter(Boolean);
}

function snapshotLineText(line) {
  if (line && typeof line === 'object') {
    return String(line.text || '').trimEnd();
  }
  return String(line || '').trimEnd();
}

function hasVisibleIdlePrompt(snapshot) {
  return getSnapshotTextLines(snapshot)
    .map((line) => line.trim())
    .some((line) => /^›(?:\s+.*)?$/.test(line));
}

function hasActiveVisualIndicators(snapshot) {
  return getSnapshotTextLines(snapshot)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) =>
      RUNNING_STATUS_PATTERN.test(stripLeadingMarker(line)) ||
      SPINNER_PATTERN.test(line) ||
      isApprovalQuestionLine(line) ||
      /^Running shell command\b/i.test(line) ||
      /^Would you like to\b/i.test(line) ||
      /^Do you want to\b/i.test(line)
    );
}

function stripLeadingMarker(line) {
  return String(line || '').replace(/^[•●*-]\s+/, '').trim();
}

function isApprovalQuestionLine(line) {
  const value = String(line || '').trim();
  if (/^(?:Would you like to|Do you want to)\b/i.test(value)) return true;
  if (/^Allow\b/i.test(value) && /\?$/.test(value)) return true;
  if (/\b(?:run|execute)\b.*\bcommand\b.*\?/i.test(value)) return true;
  return false;
}

function hasIdlePromptAfterSubmittedPrompt(snapshot, inputText = '') {
  const input = normalizeComparableText(inputText);
  const lines = getSnapshotTextLines(snapshot)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const promptIndex = findLastSubmittedPrompt(lines, input);
  if (input && promptIndex < 0) return false;

  const afterPrompt = promptIndex >= 0 ? lines.slice(promptIndex + 1) : lines;
  return afterPrompt.some((line) => /^›(?:\s+.*)?$/.test(line.trim()));
}

function findLastSubmittedPrompt(lines, input) {
  if (!input) {
    return lines.findLastIndex((line) => /^›\s+/.test(line.trim()));
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeComparableText(lines[index]);
    if (!normalized.startsWith('›')) continue;
    const promptText = normalized
      .replace(/^›/, '')
      .replace(/….*$/, '');
    if (normalized.includes(input)) return index;
    if (promptText.length >= 12 && input.includes(promptText)) return index;
  }

  return -1;
}

function normalizeComparableText(text) {
  return String(text || '')
    .replace(/[›•●]/g, (char) => char)
    .replace(/\s+/g, '')
    .trim();
}

function isVisualTurnSettled(state) {
  if (!state?.session) return false;
  const snapshot = state.session.visualSnapshot || state.session.visualViewportSnapshot || '';
  if (hasActiveVisualIndicators(snapshot)) return false;

  const inputText = String(state.lastInputText || '').trim();
  if (!inputText) return true;
  if (hasIdlePromptAfterSubmittedPrompt(snapshot, inputText)) return true;
  if (hasVisibleSubmittedPrompt(snapshot, inputText)) return false;
  return hasVisibleIdlePrompt(snapshot);
}

function hasVisibleSubmittedPrompt(snapshot, inputText = '') {
  const input = normalizeComparableText(inputText);
  if (!input) return false;
  return getSnapshotTextLines(snapshot)
    .map((line) => normalizeComparableText(line))
    .some((line) => {
      if (!line.startsWith('›')) return false;
      const promptText = line.replace(/^›/, '').replace(/….*$/, '');
      return line.includes(input) || (promptText.length >= 12 && input.includes(promptText));
    });
}

module.exports = {
  RUNNING_STATUS_PATTERN,
  SPINNER_PATTERN,
  getSnapshotTextLines,
  hasActiveVisualIndicators,
  hasIdlePromptAfterSubmittedPrompt,
  hasVisibleIdlePrompt,
  hasVisibleSubmittedPrompt,
  isApprovalQuestionLine,
  isVisualTurnSettled
};
