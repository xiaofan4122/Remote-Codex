const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

class CodexExecRunner extends EventEmitter {
  constructor({ config, logger = console }) {
    super();
    this.config = config;
    this.logger = logger;
  }

  updateConfig(config) {
    this.config = config;
  }

  run({ prompt, cwd, threadId, signal, onActivity, onFinalDraft, onEvent } = {}) {
    const command = this.config.codex?.command || 'codex';
    const args = buildExecArgs({
      prompt,
      threadId,
      execArgs: this.config.codex?.execArgs
    });
    const child = spawn(command, args, {
      cwd: cwd || this.config.codex?.defaultCwd || process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stdin.end();

    const state = {
      threadId: threadId || '',
      finalText: '',
      activityText: '',
      rawEvents: []
    };

    let stdoutBuffer = '';
    let stderr = '';

    const emitEvent = (event) => {
      state.rawEvents.push(event);
      if (event.type === 'thread.started' && event.thread_id) {
        state.threadId = event.thread_id;
      }

      const formatted = formatExecEvent(event);
      if (formatted) {
        state.activityText = mergeActivity(state.activityText, formatted);
        onActivity?.({
          text: state.activityText,
          event,
          threadId: state.threadId
        });
        this.emit('activity', {
          text: state.activityText,
          event,
          threadId: state.threadId
        });
      }

      const finalText = extractFinalText(event);
      if (finalText) {
        state.finalText = finalText;
        onFinalDraft?.({
          text: finalText,
          event,
          threadId: state.threadId
        });
        this.emit('final-draft', {
          text: finalText,
          event,
          threadId: state.threadId
        });
      }

      this.emit('event', event);
      onEvent?.(event);
    };

    const parseStdout = (data) => {
      stdoutBuffer += data;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          emitEvent(JSON.parse(trimmed));
        } catch (error) {
          this.logger.warn?.('Codex exec JSON parse failed:', error.message);
          this.emit('activity', {
            text: trimmed,
            event: null,
            threadId: state.threadId
          });
          onActivity?.({
            text: trimmed,
            event: null,
            threadId: state.threadId
          });
        }
      }
    };

    child.stdout.on('data', (data) => parseStdout(data.toString('utf8')));
    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8');
    });

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          child.kill('SIGTERM');
        },
        { once: true }
      );
    }

    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, closeSignal) => {
        if (stdoutBuffer.trim()) {
          try {
            emitEvent(JSON.parse(stdoutBuffer.trim()));
          } catch {
            state.activityText = mergeActivity(state.activityText, stdoutBuffer.trim());
          }
        }

        if (code && code !== 0) {
          const message = cleanStderr(stderr) || `Codex exec exited with code ${code}.`;
          const error = new Error(message);
          error.code = code;
          error.signal = closeSignal;
          error.state = state;
          reject(error);
          return;
        }

        resolve({
          threadId: state.threadId,
          finalText: state.finalText,
          activityText: state.activityText,
          rawEvents: state.rawEvents
        });
      });
    });
  }
}

function buildExecArgs({ prompt, threadId, execArgs }) {
  const baseArgs = Array.isArray(execArgs) && execArgs.length > 0
    ? [...execArgs]
    : ['--json', '--color', 'never', '--skip-git-repo-check'];

  if (threadId) {
    return [
      'exec',
      'resume',
      ...filterResumeArgs(baseArgs),
      threadId,
      String(prompt || '')
    ];
  }

  return ['exec', ...baseArgs, String(prompt || '')];
}

function filterResumeArgs(args) {
  const supported = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--color') {
      index += 1;
      continue;
    }
    supported.push(arg);
  }
  return supported;
}

function formatExecEvent(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'turn.started') return 'Codex started.';
  if (event.type === 'turn.completed') return '';
  if (event.type !== 'item.started' && event.type !== 'item.completed') return '';

  const item = event.item || {};
  if (item.type === 'command_execution') {
    const command = item.command || '';
    if (event.type === 'item.started') {
      return command ? `Running: ${command}` : 'Running command...';
    }
    const lines = [`Ran: ${command || 'command'}`];
    if (Number.isInteger(item.exit_code)) {
      lines.push(`Exit: ${item.exit_code}`);
    }
    const output = String(item.aggregated_output || '').trim();
    if (output) lines.push(fenceOutput(output));
    return lines.join('\n');
  }

  if (item.type === 'agent_message') {
    return '';
  }

  return item.type ? `${event.type}: ${item.type}` : '';
}

function extractFinalText(event) {
  if (event?.type !== 'item.completed') return '';
  const item = event.item || {};
  if (item.type !== 'agent_message') return '';
  return String(item.text || '').trim();
}

function mergeActivity(previous, next) {
  const value = String(next || '').trim();
  if (!value) return previous || '';
  const lines = String(previous || '')
    .split('\n\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[lines.length - 1] !== value) lines.push(value);
  return lines.slice(-8).join('\n\n');
}

function fenceOutput(output) {
  const text = String(output || '').trim();
  if (!text) return '';
  return `\`\`\`\n${text}\n\`\`\``;
}

function cleanStderr(stderr) {
  return String(stderr || '')
    .split('\n')
    .filter((line) => !/^WARNING: proceeding/.test(line))
    .join('\n')
    .trim();
}

module.exports = {
  CodexExecRunner,
  buildExecArgs,
  formatExecEvent,
  extractFinalText
};
