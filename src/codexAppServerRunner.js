const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

class CodexAppServerRunner extends EventEmitter {
  constructor({ config, logger = console }) {
    super();
    this.config = config;
    this.logger = logger;
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.started = null;
    this.threads = new Map();
  }

  updateConfig(config) {
    this.config = config;
  }

  async ensureStarted() {
    if (this.started) return this.started;

    this.started = new Promise((resolve, reject) => {
      const command = this.config.codex?.command || 'codex';
      this.child = spawn(command, ['app-server', '--listen', 'stdio://'], {
        cwd: this.config.codex?.defaultCwd || process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.child.stdout.on('data', (data) => this.handleStdout(data));
      this.child.stderr.on('data', (data) => {
        const text = data.toString('utf8').trim();
        if (text) this.logger.warn?.('Codex app-server:', text);
      });
      this.child.on('error', reject);
      this.child.on('close', (code, signal) => {
        this.emit('status', {
          type: 'backendStatus',
          status: 'closed',
          code,
          signal: signal || null
        });
        this.child = null;
        this.started = null;
        for (const pending of this.pending.values()) {
          pending.reject(new Error(`Codex app-server exited with code ${code}.`));
        }
        this.pending.clear();
      });

      this.request('initialize', {
        clientInfo: {
          name: 'remote-codex',
          title: 'Remote Codex',
          version: '0.1.0'
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false
        }
      })
        .then((result) => {
          this.emit('status', {
            type: 'backendStatus',
            status: 'ready',
            userAgent: result.userAgent,
            codexHome: result.codexHome
          });
          resolve(result);
        })
        .catch(reject);
    });

    return this.started;
  }

  async run({ prompt, cwd, threadId, signal, onActivity, onFinalDraft, onEvent } = {}) {
    await this.ensureStarted();
    const thread = threadId
      ? this.threads.get(threadId) || { threadId, cwd: cwd || this.config.codex?.defaultCwd }
      : await this.startThread({ cwd });

    const state = {
      threadId: thread.threadId,
      turnId: '',
      finalText: '',
      activityText: '',
      completed: false
    };

    const cleanup = this.attachRunListeners({
      state,
      onActivity,
      onFinalDraft,
      onEvent
    });

    const abort = () => {
      if (!state.turnId) return;
      this.request('turn/interrupt', {
        threadId: state.threadId,
        turnId: state.turnId
      }).catch((error) => {
        this.logger.warn?.('Codex app-server interrupt failed:', error.message);
      });
    };
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const started = await this.request('turn/start', {
        threadId: state.threadId,
        input: [
          {
            type: 'text',
            text: String(prompt || ''),
            text_elements: []
          }
        ],
        cwd: cwd || thread.cwd || null
      });
      state.turnId = started.turn?.id || state.turnId;

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Codex app-server turn timed out.'));
        }, Number(this.config.codex?.appServerTurnTimeoutMs) || 10 * 60 * 1000);

        const checkCompleted = (event) => {
          if (
            event.method === 'turn/completed' &&
            event.params?.threadId === state.threadId &&
            event.params?.turn?.id === state.turnId
          ) {
            clearTimeout(timeout);
            this.off('notification', checkCompleted);
            resolve();
          }
        };
        this.on('notification', checkCompleted);
      });

      return {
        threadId: state.threadId,
        finalText: state.finalText.trim(),
        activityText: state.activityText.trim()
      };
    } finally {
      signal?.removeEventListener?.('abort', abort);
      cleanup();
    }
  }

  async startThread({ cwd } = {}) {
    await this.ensureStarted();
    const result = await this.request('thread/start', {
      cwd: cwd || this.config.codex?.defaultCwd || process.cwd(),
      experimentalRawEvents: false,
      persistExtendedHistory: false
    });
    const threadId = result.thread?.id;
    if (!threadId) throw new Error('Codex app-server did not return a thread id.');
    const thread = {
      threadId,
      cwd: result.cwd || cwd || this.config.codex?.defaultCwd || process.cwd()
    };
    this.threads.set(threadId, thread);
    return thread;
  }

  attachRunListeners({ state, onActivity, onFinalDraft, onEvent }) {
    const handle = (event) => {
      if (event.params?.threadId && event.params.threadId !== state.threadId) return;
      onEvent?.(event);

      const formatted = formatAppServerActivity(event);
      if (formatted) {
        state.activityText = mergeActivity(state.activityText, formatted);
        onActivity?.({
          text: state.activityText,
          event,
          threadId: state.threadId
        });
      }

      if (event.method === 'item/agentMessage/delta') {
        state.finalText += event.params?.delta || '';
        onFinalDraft?.({
          text: state.finalText,
          event,
          threadId: state.threadId
        });
      }

      if (event.method === 'item/completed') {
        const item = event.params?.item;
        if (item?.type === 'agentMessage' && item.text) {
          state.finalText = item.text;
          onFinalDraft?.({
            text: state.finalText,
            event,
            threadId: state.threadId
          });
        }
      }
    };

    this.on('notification', handle);
    return () => this.off('notification', handle);
  }

  request(method, params) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error('Codex app-server is not running.'));
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
  }

  respond(id, result) {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  handleStdout(data) {
    this.buffer += data.toString('utf8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.logger.warn?.('Codex app-server JSON parse failed:', error.message);
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id') && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || `${pending.method} failed`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      const event = {
        method: message.method,
        params: message.params || {},
        at: new Date().toISOString()
      };
      if (message.id !== undefined) {
        this.handleServerRequest(message);
      }
      this.emit('notification', event);
      this.emit('event', event);
    }
  }

  handleServerRequest(message) {
    this.emit('serverRequest', message);
    if (message.method === 'item/commandExecution/requestApproval') {
      this.respond(message.id, { decision: 'denied' });
      return;
    }
    if (message.method === 'item/fileChange/requestApproval') {
      this.respond(message.id, { decision: 'denied' });
      return;
    }
  }

  stop() {
    if (this.child) {
      this.child.kill('SIGTERM');
    }
  }
}

function formatAppServerActivity(event) {
  if (!event?.method) return '';
  if (event.method === 'turn/started') return 'Codex started.';
  if (event.method === 'item/started') {
    const item = event.params?.item;
    if (item?.type === 'commandExecution') return `Running: ${item.command}`;
    if (item?.type === 'reasoning') return 'Thinking...';
  }
  if (event.method === 'item/completed') {
    const item = event.params?.item;
    if (item?.type === 'commandExecution') {
      const lines = [`Ran: ${item.command}`];
      if (Number.isInteger(item.exitCode)) lines.push(`Exit: ${item.exitCode}`);
      if (item.aggregatedOutput) lines.push(fenceOutput(item.aggregatedOutput));
      return lines.join('\n');
    }
  }
  if (event.method === 'item/commandExecution/outputDelta') {
    const delta = String(event.params?.delta || '').trim();
    return delta ? `Output:\n${fenceOutput(delta)}` : '';
  }
  if (event.method === 'error') return event.params?.message || 'Codex error.';
  return '';
}

function mergeActivity(previous, next) {
  const value = String(next || '').trim();
  if (!value) return previous || '';
  const parts = String(previous || '')
    .split('\n\n')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts[parts.length - 1] !== value) parts.push(value);
  return parts.slice(-8).join('\n\n');
}

function fenceOutput(output) {
  const text = String(output || '').trim();
  if (!text) return '';
  return `\`\`\`\n${text}\n\`\`\``;
}

module.exports = {
  CodexAppServerRunner,
  formatAppServerActivity
};
