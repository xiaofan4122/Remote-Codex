const { shouldBindNextRollout } = require('./nativeSlashCommands');
const { getSnapshotTextLines } = require('./visualSessionState');

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

class LocalTerminalInputTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.buffer = '';
    this.hasUserContent = false;
    this.bracketedPaste = false;
  }

  push(data) {
    const value = String(data || '');
    let index = 0;
    let submitted = null;

    while (index < value.length) {
      if (value.startsWith(BRACKETED_PASTE_START, index)) {
        this.bracketedPaste = true;
        this.hasUserContent = true;
        index += BRACKETED_PASTE_START.length;
        continue;
      }
      if (value.startsWith(BRACKETED_PASTE_END, index)) {
        this.bracketedPaste = false;
        index += BRACKETED_PASTE_END.length;
        continue;
      }

      const char = value[index];
      if (!this.bracketedPaste && char === '\r') {
        if (this.hasUserContent) {
          submitted = {
            text: this.buffer,
            needsSnapshotText: !this.buffer.trim()
          };
        }
        this.reset();
        index += 1;
        continue;
      }
      if (!this.bracketedPaste && char === '\x15') {
        this.buffer = '';
        this.hasUserContent = false;
        index += 1;
        continue;
      }
      if (!this.bracketedPaste && (char === '\x7f' || char === '\b')) {
        this.buffer = removeLastCodePoint(this.buffer);
        this.hasUserContent = Boolean(this.buffer);
        index += 1;
        continue;
      }
      if (!this.bracketedPaste && char === '\x1b') {
        const sequence = readEscapeSequence(value, index);
        if (/^\x1b\[[AB]/.test(sequence)) {
          this.hasUserContent = true;
        }
        index += sequence.length;
        continue;
      }
      if (char === '\n' && this.bracketedPaste) {
        this.buffer += '\n';
        this.hasUserContent = true;
        index += 1;
        continue;
      }
      if (char >= ' ' && char !== '\x7f') {
        this.buffer += char;
        this.hasUserContent = true;
      }
      index += 1;
    }

    return submitted;
  }
}

function resolveLocalSubmissionPrompt(submission, snapshot) {
  const tracked = String(submission?.text || '').trim();
  if (tracked) return tracked;
  if (!submission?.needsSnapshotText) return '';
  const lines = getSnapshotTextLines(snapshot);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = String(lines[index] || '').trim().match(/^›\s+(.+)$/);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function shouldObserveLocalSubmission(prompt) {
  const value = String(prompt || '').trim();
  if (!value) return false;
  if (!value.startsWith('/')) return true;
  return shouldBindNextRollout(value);
}

function readEscapeSequence(value, index) {
  if (value[index + 1] !== '[') return value.slice(index, index + 1);
  let end = index + 2;
  while (end < value.length && !/[A-Za-z~]/.test(value[end])) end += 1;
  return value.slice(index, Math.min(value.length, end + 1));
}

function removeLastCodePoint(value) {
  return Array.from(String(value || '')).slice(0, -1).join('');
}

module.exports = {
  LocalTerminalInputTracker,
  resolveLocalSubmissionPrompt,
  shouldObserveLocalSubmission
};
