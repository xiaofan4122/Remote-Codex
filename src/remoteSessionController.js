const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ANSI_PATTERN =
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const BOX_ONLY_PATTERN = /^[\s┌┐└┘├┤┬┴┼─│╭╮╰╯═║╔╗╚╝╠╣╦╩╬━┃╋╸╺╹╻╴╶╵╷▪▫·•*+\-=~_.,:;|/\\[\](){}<>]+$/;
const SPINNER_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const FINAL_PREFIX_PATTERN = /^\s*[•●]\s+/;
const FINAL_MARKER_PATTERN = /[•●]\s+/;
const INTRO_LINE_PATTERN = /(?:Use \/skills to list available skills|type \/help|press enter to continue)/i;
const ACTIVITY_LINE_PATTERN = /^(?:Ran|Explored|Read|Edited|Updated|Added|Removed|Created|Deleted|Opened|Searched|Found|Checked|Applied|Listed|Viewed|Wrote)\b/i;
const RUNNING_STATUS_PATTERN = /^(?:Working|Thinking|Reading|Writing|Finding|Searching|Running|Checking|Applying|Planning)\b/i;

class RemoteSessionController {
  constructor({
    sessionManager,
    execRunner = null,
    config,
    logger = console,
    sharedSessionProvider = null,
    onRemoteInput = null
  }) {
    this.sessionManager = sessionManager;
    this.execRunner = execRunner;
    this.config = config;
    this.logger = logger;
    this.sharedSessionProvider = sharedSessionProvider;
    this.onRemoteInput = onRemoteInput;
    this.sessions = new Map();
    this.execSessions = new Map();
  }

  updateConfig(config) {
    this.config = config;
    this.execRunner?.updateConfig?.(config);
  }

  updateSharedSessionProvider(sharedSessionProvider) {
    this.sharedSessionProvider = sharedSessionProvider;
  }

  async handleMessage(message) {
    const text = String(message.text || '').trim();
    if (!text) return;

    const key = this.getKey(message);
    const [command, ...args] = text.split(/\s+/);
    this.logger.event?.('remote.message.received', {
      pluginId: message.pluginId,
      conversationId: message.conversationId,
      userId: message.userId,
      command,
      text: clipForLog(text)
    });

    if (command === '/help') {
      await message.reply(this.helpText());
      return;
    }

    if (command === '/start') {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await this.startExecSession(key, message, args.join(' '));
        return;
      }
      await this.startSession(key, message, args.join(' '), {
        restartShared: true
      });
      return;
    }

    if (command === '/stop') {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await this.stopExecSession(key, message);
        return;
      }
      await this.stopSession(key, message);
      return;
    }

    if (command === '/status') {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await this.sendExecStatus(key, message);
        return;
      }
      await this.sendStatus(key, message);
      return;
    }

    if (command === '/tail') {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await this.sendExecTail(key, message);
        return;
      }
      await this.sendTail(key, message);
      return;
    }

    if (isApproveCommand(command)) {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await message.reply('Approval prompts are handled by Codex exec policy in JSON mode.');
        return;
      }
      await this.sendControlInput(key, message, 'approve');
      return;
    }

    if (isDenyCommand(command)) {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await this.stopExecSession(key, message, { silentIfIdle: true });
        return;
      }
      await this.sendControlInput(key, message, 'deny');
      return;
    }

    if (isEscapeCommand(command)) {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await this.stopExecSession(key, message, { silentIfIdle: true });
        return;
      }
      await this.sendControlInput(key, message, 'escape');
      return;
    }

    const keyAction = parseKeyCommand(command);
    if (keyAction) {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await message.reply('This control command is only available for visual terminal sessions.');
        return;
      }
      await this.sendControlInput(key, message, keyAction);
      return;
    }

    if (this.shouldUseStructuredRunner(message.pluginId)) {
      await this.handleExecMessage(key, message, text);
      return;
    }

    let state = this.sessions.get(key);
    if (!state) {
      if (!this.config.remoteControl.autoCreateSession) {
        await message.reply('No Codex session is running. Send /start first.');
        return;
      }
      state = await this.startSession(key, message, '', {
        restartShared: false,
        announce: false
      });
    }

    state.reply = message.reply;
    state.createReplyStream = message.createReplyStream;
    state.replyStream = null;
    state.lastInputText = text;
    state.turnStartedAt = Date.now();
    this.emitRemoteInput(message, text, state);
    this.resetPendingOutput(state);
    await this.startReplyStream(state, message).catch((error) => {
      this.logger.warn?.('Remote reply stream unavailable:', error.message);
    });
    state.session.write(buildSubmitInput(text));
  }

  getKey(message) {
    return `${message.pluginId}:${message.conversationId}`;
  }

  getPluginConfig(pluginId) {
    return this.config.plugins?.[pluginId] || {};
  }

  shouldUseStructuredRunner(pluginId) {
    if (!this.execRunner) return false;
    const pluginConfig = this.getPluginConfig(pluginId);
    const source =
      pluginConfig.responseSource ||
      this.config.remoteControl?.responseSource ||
      'visual_terminal';
    return source === 'exec_json' || source === 'app_server';
  }

  getOutputConfig(pluginId) {
    const pluginConfig = this.getPluginConfig(pluginId);
    return {
      sendOutput:
        pluginConfig.sendOutput === undefined
          ? this.config.remoteControl.sendOutput
          : pluginConfig.sendOutput,
      outputMode: pluginConfig.outputMode || this.config.remoteControl.outputMode,
      flushIntervalMs:
        Number(pluginConfig.flushIntervalMs) ||
        Number(this.config.remoteControl.flushIntervalMs) ||
        1200
    };
  }

  async startExecSession(key, message, requestedCwd) {
    const cwd = this.resolveCwd(requestedCwd);
    const previous = this.execSessions.get(key);
    if (previous?.abortController) {
      previous.abortController.abort();
    }

    this.execSessions.set(key, {
      key,
      pluginId: message.pluginId,
      conversationId: message.conversationId,
      cwd,
      threadId: '',
      running: false,
      abortController: null,
      lastReplyText: '',
      lastActivityText: '',
      lastStreamText: '',
      createdAt: new Date().toISOString()
    });

    this.logger.event?.('remote.exec.session.started', {
      pluginId: message.pluginId,
      conversationId: message.conversationId,
      cwd
    });
    await message.reply(`Codex event session started.\ncwd: ${cwd}`);
  }

  async stopExecSession(key, message, options = {}) {
    const state = this.execSessions.get(key);
    if (!state) {
      if (!options.silentIfIdle) await message.reply('No Codex event session is running.');
      return;
    }

    if (state.abortController) {
      state.abortController.abort();
    }
    this.execSessions.delete(key);
    if (!options.silentIfIdle) {
      await message.reply('Codex event session stopped.');
    }
  }

  async sendExecStatus(key, message) {
    const state = this.execSessions.get(key);
    if (!state) {
      await message.reply('No Codex event session is running.');
      return;
    }

    await message.reply(
      [
        'Codex event session is running.',
        `cwd: ${state.cwd}`,
        `thread: ${state.threadId || 'not started'}`,
        `busy: ${state.running ? 'yes' : 'no'}`,
        `created: ${state.createdAt}`
      ].join('\n')
    );
  }

  async sendExecTail(key, message) {
    const state = this.execSessions.get(key);
    if (!state) {
      await message.reply('No Codex event session is running.');
      return;
    }

    const text = state.lastReplyText || state.lastActivityText || 'No output yet.';
    await message.reply(text);
  }

  async handleExecMessage(key, message, text) {
    let state = this.execSessions.get(key);
    if (!state) {
      if (!this.config.remoteControl.autoCreateSession) {
        await message.reply('No Codex event session is running. Send /start first.');
        return;
      }
      state = {
        key,
        pluginId: message.pluginId,
        conversationId: message.conversationId,
        cwd: this.resolveCwd(''),
        threadId: '',
        running: false,
        abortController: null,
        lastReplyText: '',
        lastActivityText: '',
        lastStreamText: '',
        createdAt: new Date().toISOString()
      };
      this.execSessions.set(key, state);
    }

    if (state.running) {
      await message.reply('Codex is still running. Send /stop to cancel it first.');
      return;
    }

    state.running = true;
    state.abortController = new AbortController();
    state.lastReplyText = '';
    state.lastActivityText = '';
    state.lastStreamText = '';
    this.emitRemoteInput(message, text, { shared: true });

    let replyStream = null;
    if (typeof message.createReplyStream === 'function') {
      replyStream = await message
        .createReplyStream({
          message,
          title: 'Remote Codex',
          initialText: ''
        })
        .catch((error) => {
          this.logger.warn?.('Remote exec reply stream unavailable:', error.message);
          return null;
        });
    }

    const updateStream = (streamText) => {
      const value = String(streamText || '').trim();
      if (!value || !replyStream || value === state.lastStreamText) return;
      state.lastStreamText = value;
      replyStream.update(value).catch((error) => {
        this.logger.warn?.('Remote exec stream update failed:', error.message);
      });
    };

    try {
      const result = await this.execRunner.run({
        prompt: text,
        cwd: state.cwd,
        threadId: state.threadId,
        signal: state.abortController.signal,
        onActivity: ({ text: activityText, threadId }) => {
          if (threadId) state.threadId = threadId;
          state.lastActivityText = activityText;
          updateStream(activityText);
        },
        onFinalDraft: ({ text: finalText, threadId }) => {
          if (threadId) state.threadId = threadId;
          state.lastReplyText = finalText;
          const combined = state.lastActivityText
            ? `${state.lastActivityText}\n\n${finalText}`
            : finalText;
          updateStream(combined);
        },
        onEvent: (event) => {
          if (event?.type === 'thread.started' && event.thread_id) {
            state.threadId = event.thread_id;
          }
        }
      });

      state.threadId = result.threadId || state.threadId;
      state.lastReplyText = result.finalText || state.lastReplyText;
      state.lastActivityText = result.activityText || state.lastActivityText;
      const finalText = state.lastReplyText || state.lastActivityText || 'Codex finished with no output.';
      if (replyStream) {
        await replyStream.finish(finalText);
      } else {
        await message.reply(finalText);
      }
      this.logger.event?.('remote.exec.reply.sent', {
        pluginId: message.pluginId,
        conversationId: message.conversationId,
        threadId: state.threadId,
        text: clipForLog(finalText)
      });
    } catch (error) {
      const fallback = error.state?.finalText || error.state?.activityText || error.message;
      if (replyStream) {
        await replyStream.finish(fallback).catch((streamError) => {
          this.logger.warn?.('Remote exec stream finish failed:', streamError.message);
        });
      } else {
        await message.reply(fallback);
      }
      this.logger.warn?.('Remote exec failed:', error.message);
    } finally {
      state.running = false;
      state.abortController = null;
    }
  }

  async startSession(key, message, requestedCwd, options = {}) {
    const cwd = this.resolveCwd(requestedCwd);

    if (this.sessions.has(key)) {
      const previous = this.sessions.get(key);
      this.disposeState(previous, { kill: !previous.shared });
      this.sessions.delete(key);
    }

    const acquired = this.acquireSession(message, cwd, options);
    const session = acquired.session;
    const state = {
      key,
      pluginId: message.pluginId,
      conversationId: message.conversationId,
      reply: message.reply,
      session,
      shared: acquired.shared,
      cursor: 0,
      outputBuffer: '',
      flushTimer: null,
      streamFinishTimer: null,
      createReplyStream: message.createReplyStream,
      replyStream: null,
      lastReplyText: '',
      lastStreamText: '',
      lastInputText: '',
      turnStartedAt: 0,
      stopped: false
    };

    state.dataListener = (chunk) => {
      state.cursor = chunk.cursor;
      this.queueOutput(state, chunk.data);
    };

    state.exitListener = ({ exitCode, signal }) => {
      this.sessions.delete(key);
      if (state.stopped) return;
      this.safeReply(
        state,
        `Codex exited: code=${exitCode}, signal=${signal || 'none'}`
      );
    };

    session.on('data', state.dataListener);
    session.on('exit', state.exitListener);

    this.sessions.set(key, state);
    this.logger.event?.('remote.session.started', {
      pluginId: message.pluginId,
      conversationId: message.conversationId,
      sessionId: session.id,
      shared: state.shared,
      cwd: session.cwd || cwd
    });
    if (options.announce !== false) {
      await message.reply(
        state.shared
          ? `Using visual Codex session.\ncwd: ${session.cwd || cwd}`
          : `Codex session started.\ncwd: ${cwd}`
      );
    }
    return state;
  }

  async stopSession(key, message) {
    const state = this.sessions.get(key);
    if (!state) {
      await message.reply('No Codex session is running.');
      return;
    }

    this.disposeState(state, { kill: true });
    this.sessions.delete(key);
    await message.reply('Codex session stopped.');
  }

  async sendStatus(key, message) {
    const state = this.sessions.get(key);
    if (!state) {
      await message.reply('No Codex session is running.');
      return;
    }

    const status = state.session.status();
    await message.reply(
      [
        'Codex session is running.',
        `id: ${status.id}`,
        `cwd: ${status.cwd}`,
        `cursor: ${status.cursor}`,
        `created: ${status.createdAt}`
      ].join('\n')
    );
  }

  async sendTail(key, message) {
    const state = this.sessions.get(key);
    if (!state) {
      await message.reply('No Codex session is running.');
      return;
    }

    const output = state.session
      .readAfter(Math.max(0, state.cursor - 20))
      .chunks.map((chunk) => chunk.data)
      .join('');
    await message.reply(this.formatOutput(message.pluginId, output));
  }

  async sendControlInput(key, message, action) {
    const state = this.sessions.get(key);
    if (!state) {
      await message.reply('No Codex session is running.');
      return;
    }

    const input = buildControlInput(action);
    if (!input) {
      await message.reply(`Unknown control action: ${action}`);
      return;
    }

    state.session.write(input);
    this.logger.event?.('remote.control.sent', {
      pluginId: message.pluginId,
      conversationId: message.conversationId,
      action
    });
  }

  queueOutput(state, data) {
    const outputConfig = this.getOutputConfig(state.pluginId);
    if (!outputConfig.sendOutput || outputConfig.outputMode === 'silent') {
      return;
    }

    if (outputConfig.outputMode === 'status_only') {
      return;
    }

    state.outputBuffer += data;
    if (state.flushTimer) return;

    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      const output = state.outputBuffer;
      const formatted = this.formatStateOutput(state, output);
      const streamText =
        state.replyStream && outputConfig.outputMode === 'final'
          ? this.formatStreamingStateOutput(state, output, formatted)
          : formatted;
      this.captureCleaningSample(state, output, formatted, streamText);
      if (!formatted || formatted === state.lastReplyText) {
        if (
          state.replyStream &&
          streamText &&
          streamText !== state.lastStreamText
        ) {
          state.lastStreamText = streamText;
          this.updateReplyStream(state, streamText, { final: Boolean(formatted) });
        }
        if (!formatted && !streamText && outputConfig.outputMode === 'final') {
          this.logger.event?.('remote.reply.ignored', {
            pluginId: state.pluginId,
            conversationId: state.conversationId,
            sessionId: state.session.id,
            raw: clipForLog(output)
          });
        }
        return;
      }
      state.lastReplyText = formatted;
      if (outputConfig.outputMode !== 'final') {
        state.outputBuffer = '';
      }
      if (state.replyStream) {
        state.lastStreamText = streamText;
        this.updateReplyStream(state, streamText, { final: Boolean(formatted) });
        return;
      }
      this.safeReply(state, formatted);
    }, outputConfig.flushIntervalMs);
  }

  async startReplyStream(state, message) {
    if (typeof state.createReplyStream !== 'function') return;
    const initialText = this.formatRunningFallback(state);
    state.replyStream = await state.createReplyStream({
      message,
      title: 'Remote Codex',
      initialText
    });
    if (state.replyStream) {
      state.lastStreamText = initialText;
    }
  }

  updateReplyStream(state, text, options = {}) {
    state.replyStream
      ?.update(text)
      .catch((error) => {
        this.logger.warn?.('Remote reply stream update failed:', error.message);
      });

    if (state.streamFinishTimer) {
      clearTimeout(state.streamFinishTimer);
      state.streamFinishTimer = null;
    }

    if (!options.final) return;

    state.streamFinishTimer = setTimeout(() => {
      state.streamFinishTimer = null;
      state.replyStream
        ?.finish(text)
        .then(() => {
          state.replyStream = null;
        })
        .catch((error) => {
          this.logger.warn?.('Remote reply stream finish failed:', error.message);
        });
    }, 6000);
  }

  async safeReply(state, text) {
    try {
      if (text.trim()) {
        this.logger.event?.('remote.reply.sent', {
          pluginId: state.pluginId,
          conversationId: state.conversationId,
          sessionId: state.session.id,
          text: clipForLog(text)
        });
        await state.reply(text);
      }
    } catch (error) {
      this.logger.warn?.('Remote reply failed:', error.message);
    }
  }

  formatOutput(pluginId, data) {
    const outputConfig = this.getOutputConfig(pluginId);
    const cleaned =
      outputConfig.outputMode === 'final'
        ? formatTerminalFinalAnswer(data)
        : formatTerminalText(data);
    if (!cleaned) return '';

    if (outputConfig.outputMode === 'full') {
      return cleaned;
    }

    return cleaned;
  }

  formatStateOutput(state, data) {
    const outputConfig = this.getOutputConfig(state.pluginId);
    if (
      outputConfig.outputMode === 'final' &&
      state.shared &&
      state.session.visualSnapshot
    ) {
      const rendered = formatVisualSnapshot(
        state.session.visualSnapshot,
        state.lastInputText
      );
      if (rendered) return rendered;
      return '';
    }

    return this.formatOutput(state.pluginId, data);
  }

  formatStreamingStateOutput(state, data, finalText = '') {
    const activity = state.shared
      ? formatVisualProgressSnapshot(state.session.visualSnapshot, state.lastInputText)
      : formatTerminalProgress(data);
    if (finalText) {
      return activity ? `${activity}\n\n**回复**\n${finalText}` : `**回复**\n${finalText}`;
    }
    return activity || this.formatRunningFallback(state);
  }

  formatRunningFallback(state) {
    const startedAt = Number(state.turnStartedAt) || Date.now();
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    return `**进度**\n- Codex 正在处理 (${elapsedSeconds}s)`;
  }

  captureCleaningSample(state, raw, formatted, streamText) {
    if (!this.config.remoteControl?.captureCleaningCorpus) return;

    try {
      const target =
        this.config.remoteControl.cleaningCorpusPath ||
        process.env.REMOTE_CODEX_CLEANING_CORPUS ||
        path.join(os.homedir(), '.local', 'state', 'remote-codex', 'cleaning-corpus.jsonl');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const sample = {
        at: new Date().toISOString(),
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        shared: Boolean(state.shared),
        input: clipForLog(state.lastInputText || '', 4000),
        raw: clipForLog(raw, 20000),
        visualSnapshot: clipForLog(state.session?.visualSnapshot || '', 20000),
        formatted: clipForLog(formatted, 12000),
        streamText: clipForLog(streamText, 12000)
      };
      fs.appendFile(target, `${JSON.stringify(sample)}\n`, () => {});
    } catch (error) {
      this.logger.warn?.('Cleaning corpus capture failed:', error.message);
    }
  }

  acquireSession(message, cwd, options = {}) {
    if (this.sharedSessionProvider) {
      const shared = this.sharedSessionProvider({
        message,
        cwd,
        restart: Boolean(options.restartShared)
      });
      if (shared?.session) {
        return {
          session: shared.session,
          shared: true
        };
      }
    }

    return {
      session: this.sessionManager.create({ cwd }),
      shared: false
    };
  }

  emitRemoteInput(message, text, state) {
    try {
      this.onRemoteInput?.({
        message,
        text,
        state
      });
    } catch (error) {
      this.logger.warn?.('Remote input display failed:', error.message);
    }
  }

  resetPendingOutput(state) {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    if (state.streamFinishTimer) {
      clearTimeout(state.streamFinishTimer);
      state.streamFinishTimer = null;
    }
    if (state.replyStream && state.lastReplyText) {
      state.replyStream.finish(state.lastReplyText).catch((error) => {
        this.logger.warn?.('Remote reply stream finish failed:', error.message);
      });
    }
    state.outputBuffer = '';
    state.lastReplyText = '';
    state.lastStreamText = '';
    state.replyStream = null;
  }

  disposeState(state, options = {}) {
    state.stopped = true;
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    if (state.dataListener) {
      state.session.off?.('data', state.dataListener);
    }
    if (state.exitListener) {
      state.session.off?.('exit', state.exitListener);
    }
    if (options.kill && state.session && !state.session.exit) {
      state.session.kill();
    }
  }

  resolveCwd(requestedCwd) {
    const defaultCwd = path.resolve(this.config.codex.defaultCwd);
    if (!requestedCwd) {
      return defaultCwd;
    }

    const cwd = path.resolve(requestedCwd);
    const allowed = this.config.codex.allowedWorkdirs || [];
    if (allowed.length === 0) {
      throw new Error('Custom remote cwd is disabled. Configure allowedWorkdirs first.');
    }

    const isAllowed = allowed.some((allowedCwd) => {
      const root = path.resolve(allowedCwd);
      return cwd === root || cwd.startsWith(`${root}${path.sep}`);
    });

    if (!isAllowed) {
      throw new Error(`Remote cwd is not allowed: ${cwd}`);
    }

    return cwd;
  }

  helpText() {
    return [
      'Commands:',
      '/start [cwd] - start or restart Codex',
      '/stop - stop the current Codex session',
      '/status - show session status',
      '/tail - show recent output',
      '/approve - approve the current Codex prompt',
      '/deny - deny/cancel the current Codex prompt',
      '/enter, /up, /down - control an interactive Codex prompt',
      '/help - show this help',
      '',
      'Any other text is sent to Codex.'
    ].join('\n');
  }
}

function stripTerminalControls(data) {
  return String(data || '')
    .replace(OSC_PATTERN, '')
    .replace(ANSI_PATTERN, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

function formatTerminalText(data) {
  const lines = normalizeTerminalLines(data)
    .map((line) => line.text)
    .filter((line, index, list) => index === 0 || line !== list[index - 1]);

  return extractFinalAnswer(lines).trim();
}

function formatTerminalFinalAnswer(data) {
  const lines = normalizeTerminalLines(data);
  const lastAnswerIndex = lines.findLastIndex((line) => line.hasFinalPrefix);
  if (lastAnswerIndex < 0) return '';

  const answer = [];
  for (const line of lines.slice(lastAnswerIndex)) {
    if (!line.text) continue;
    if (!line.hasFinalPrefix && isLikelyPromptOrStatus(line.text)) break;
    answer.push(line.text);
  }

  return answer
    .filter((line, index, list) => index === 0 || line !== list[index - 1])
    .join('\n')
    .trim();
}

function normalizeTerminalLines(data) {
  const cleaned = stripTerminalControls(data)
    .replace(/\u001b/g, '')
    .replace(/\r+/g, '\n')
    .replace(/\b\d+;[^\n\r]{0,240}/g, '\n')
    .replace(/\b(?:10|11|12|13|14|15);[?0-9;]*/g, '')
    .replace(CONTROL_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned) return [];

  return cleaned
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .filter((line) => !BOX_ONLY_PATTERN.test(line.trim()))
    .map((line) => {
      const finalMarkerIndex = findAnswerMarkerIndex(line);
      const hasFinalPrefix = finalMarkerIndex >= 0;
      const text =
        finalMarkerIndex >= 0
          ? line.slice(finalMarkerIndex).replace(FINAL_PREFIX_PATTERN, '').trimEnd()
          : line.replace(FINAL_PREFIX_PATTERN, '').trimEnd();
      return {
        hasFinalPrefix,
        text
      };
    })
    .filter((line) => !isTuiNoiseLine(line.text));
}

function findAnswerMarkerIndex(line) {
  const matches = [...String(line || '').matchAll(new RegExp(FINAL_MARKER_PATTERN, 'g'))];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const before = line.slice(0, match.index).trim();
    const after = line.slice(match.index + match[0].length).trim();
    if (!after) continue;
    if (!isValidAnswerMarkerContext(before, after)) continue;
    if (/^(?:Working|Thinking|Reading|Writing|Finding|Searching|Running|Checking|Applying|Planning)\b/i.test(after)) {
      continue;
    }
    return match.index;
  }
  return -1;
}

function isValidAnswerMarkerContext(before, after) {
  if (SPINNER_PATTERN.test(before)) return false;
  if (before.length > 6) return false;
  if (/;\d*$/.test(before)) return false;
  if (/^(?:\d|Booting|MCP|Working|Thinking|Reading|Writing|Finding|Searching|Running|Checking|Applying|Planning)\b/i.test(after)) {
    return false;
  }
  if (/^(?:esc to interrupt|to interrupt|Use \/skills|gpt-[\w.-]+)/i.test(after)) {
    return false;
  }
  if (/Boo+t/i.test(after) || /codex_apps/i.test(after)) return false;
  return true;
}

function isTuiNoiseLine(line) {
  const value = line.trim();
  if (!value) return true;
  if (SPINNER_PATTERN.test(value)) return true;
  if (/^\d+;/.test(value)) return true;
  if (/^[?;\d]+$/.test(value)) return true;
  if (/^›\s*/.test(value)) return true;
  if (/^\W{0,3}(?:Working|Thinking|Reading|Writing|Finding|Searching|Running|Checking|Applying|Planning)\b/i.test(value)) {
    return true;
  }
  if (/Find and fix a bug in @filename/i.test(value)) return true;
  if (/esc to interrupt/i.test(value)) return true;
  if (INTRO_LINE_PATTERN.test(value)) return true;
  if (/\bgpt-[\w.-]+\b/i.test(value) && /(?:›|@filename|~\/|\/home\/|·)/.test(value)) return true;
  if (/^(?:ubuntu|[A-Za-z0-9._-]+)\s+›\s+/.test(value)) return true;
  return false;
}

function isLikelyPromptOrStatus(line) {
  const value = line.trim();
  if (!value) return true;
  if (/^›\s*/.test(value)) return true;
  if (SPINNER_PATTERN.test(value)) return true;
  if (/^\W{0,3}(?:Working|Thinking|Reading|Writing|Finding|Searching|Running|Checking|Applying|Planning)\b/i.test(value)) {
    return true;
  }
  if (/\bgpt-[\w.-]+\b/i.test(value) && /(?:›|@filename|~\/|\/home\/|·)/.test(value)) return true;
  if (INTRO_LINE_PATTERN.test(value)) return true;
  return false;
}

function extractFinalAnswer(lines) {
  const meaningful = lines.filter(Boolean);
  if (meaningful.length === 0) return '';

  const lastPromptIndex = meaningful.findLastIndex((line) => /^›\s*/.test(line));
  const candidates =
    lastPromptIndex >= 0 ? meaningful.slice(lastPromptIndex + 1) : meaningful;
  if (candidates.length === 0) return '';

  return candidates.join('\n');
}

function formatVisualSnapshot(snapshot, inputText = '') {
  const input = normalizeComparableText(inputText);
  const lines = String(snapshot || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());

  if (lines.length === 0) return '';

  const promptIndex = findLastSubmittedPrompt(lines, input);
  const afterPrompt = promptIndex >= 0 ? lines.slice(promptIndex + 1) : lines;
  const blocks = splitVisualBlocks(afterPrompt);
  const candidates = blocks
    .map((block) => extractVisualAnswerBlock(block, input))
    .map(normalizeCleanedText)
    .filter(Boolean);
  if (candidates.length > 0) return candidates[candidates.length - 1];

  const fallback = extractVisualTailFallback(afterPrompt, input);
  if (fallback) return fallback;

  return '';
}

function splitVisualBlocks(lines) {
  const blocks = [];
  let current = [];

  for (const line of lines) {
    const value = line.trim();
    if (isVisualSeparatorLine(value)) {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }
    if (BOX_ONLY_PATTERN.test(value)) continue;
    current.push(line);
  }

  if (current.length > 0) blocks.push(current);
  return blocks.length > 0 ? blocks : [lines];
}

function extractVisualAnswerBlock(lines, input) {
  const answer = [];
  let hasAnswerMarker = false;
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const value = line.trim();
    if (!value) continue;
    if (isLikelyPromptOrStatus(value)) {
      if (answer.length > 0) break;
      continue;
    }
    if (isVisualNoiseLine(value, input)) continue;

    const markerIndex = findAnswerMarkerIndex(line);
    if (markerIndex >= 0) {
      const text = line
        .slice(markerIndex)
        .replace(FINAL_PREFIX_PATTERN, '')
        .trimEnd();
      if (text && !isVisualNoiseLine(text, input)) {
        answer.push(text);
        hasAnswerMarker = true;
        if (/^```/.test(text.trim())) {
          inCodeBlock = !inCodeBlock;
        }
      }
      continue;
    }

    if (hasAnswerMarker || answer.length > 0) {
      appendVisualAnswerLine(answer, line, { inCodeBlock });
      if (/^```/.test(value)) {
        inCodeBlock = !inCodeBlock;
      }
    }
  }

  if (!hasAnswerMarker && answer.length === 0) return '';
  return answer
    .filter((line, index, list) => index === 0 || line !== list[index - 1])
    .join('\n')
    .trim();
}

function extractVisualTailFallback(lines, input) {
  const candidates = splitVisualBlocks(lines)
    .map((block) => extractVisualTailBlock(block, input))
    .map(normalizeCleanedText)
    .filter((text) => text.length >= 40);

  return candidates[candidates.length - 1] || '';
}

function extractVisualTailBlock(lines, input) {
  const answer = [];
  let inCodeBlock = false;
  let skippingWarningContinuation = false;

  for (const rawLine of lines) {
    const value = rawLine.trimEnd();
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (BOX_ONLY_PATTERN.test(trimmed)) continue;
    if (skippingWarningContinuation) {
      if (/^\s{2,}\S/.test(value) || /^[\w:[\]()./_-]+/.test(trimmed)) {
        continue;
      }
      skippingWarningContinuation = false;
    }
    if (/^⚠\s*(?:MCP client|MCP startup)/i.test(trimmed)) {
      skippingWarningContinuation = true;
      continue;
    }
    if (isLikelyPromptOrStatus(trimmed) || isVisualNoiseLine(trimmed, input)) {
      if (answer.length > 0 && /^›\s*/.test(trimmed)) break;
      continue;
    }
    if (/^[-*+]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed) || /^[#>]/.test(trimmed)) {
      answer.push(trimmed);
    } else {
      appendVisualAnswerLine(answer, value, { inCodeBlock });
    }
    if (/^```/.test(trimmed)) inCodeBlock = !inCodeBlock;
  }

  return answer.join('\n');
}

function formatVisualProgressSnapshot(snapshot, inputText = '') {
  const input = normalizeComparableText(inputText);
  const lines = String(snapshot || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .filter((line) => !BOX_ONLY_PATTERN.test(line.trim()));
  const promptIndex = findLastSubmittedPrompt(lines, input);
  const afterPrompt = promptIndex >= 0 ? lines.slice(promptIndex + 1) : lines;
  return formatProgressLines(afterPrompt);
}

function formatTerminalProgress(data) {
  const lines = stripTerminalControls(data)
    .replace(/\u001b/g, '')
    .replace(/\r+/g, '\n')
    .replace(/\b\d+;[^\n\r]{0,240}/g, '\n')
    .replace(/\b(?:10|11|12|13|14|15);[?0-9;]*/g, '')
    .replace(CONTROL_PATTERN, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  return formatProgressLines(lines);
}

function formatProgressLines(lines) {
  const activity = [];
  let current = null;
  let status = '';

  for (const rawLine of lines) {
    const value = normalizeProgressLine(rawLine);
    if (!value) continue;
    if (isProgressNoiseLine(value)) continue;

    if (RUNNING_STATUS_PATTERN.test(value)) {
      status = normalizeRunningStatus(value);
      continue;
    }

    if (ACTIVITY_LINE_PATTERN.test(value)) {
      if (current) activity.push(current);
      current = value;
      continue;
    }

    if (current && /^└\s+/.test(value)) {
      current = `${current}\n${value}`;
    }
  }

  if (current) activity.push(current);
  const items = [];
  if (status) items.push(status);
  items.push(...dedupeConsecutive(activity).slice(-6));
  if (items.length === 0) return '';

  return [
    '**进度**',
    ...items.flatMap((item) => formatProgressItem(item))
  ].join('\n');
}

function normalizeProgressLine(line) {
  const value = String(line || '')
    .trim()
    .replace(/^[•●◦○]\s*/, '')
    .replace(/\s+•\s*esc to interrupt\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!value) return '';
  return value;
}

function normalizeRunningStatus(line) {
  return String(line || '')
    .replace(/\((\d+s)[^)]*\)/i, '($1)')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatProgressItem(item) {
  return String(item || '')
    .split('\n')
    .map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`));
}

function isProgressNoiseLine(line) {
  const value = String(line || '').trim();
  if (!value) return true;
  if (/^›\s*/.test(value)) return true;
  if (SPINNER_PATTERN.test(value)) return true;
  if (isVisualNoiseLine(value, '')) return true;
  if (/^\W{0,3}You've hit your usage limit\b/i.test(value)) return true;
  if (/^[-─]\s*Worked for\b/i.test(value)) return true;
  if (/^Remote Codex\b/i.test(value)) return true;
  return false;
}

function dedupeConsecutive(items) {
  return items.filter((item, index, list) => index === 0 || item !== list[index - 1]);
}

function appendVisualAnswerLine(answer, line, options = {}) {
  const value = line.trimEnd();
  if (!answer.length) {
    answer.push(value.trim());
    return;
  }

  if (!options.inCodeBlock && isVisualContinuationLine(value, answer[answer.length - 1])) {
    answer[answer.length - 1] = `${answer[answer.length - 1]} ${value.trim()}`.replace(
      /\s+/g,
      ' '
    );
    return;
  }

  answer.push(value.trim());
}

function isVisualContinuationLine(line, previousLine) {
  const value = line.trim();
  if (!value || !previousLine) return false;
  if (!/^\s{2,}\S/.test(line)) return false;
  if (/^[-*+]\s+/.test(value)) return false;
  if (/^\d+[.)]\s+/.test(value)) return false;
  if (/^```/.test(value)) return false;
  if (/^[#>|]/.test(value)) return false;
  if (/^[-*_]{3,}$/.test(value)) return false;
  return true;
}

function findLastSubmittedPrompt(lines, input) {
  if (!input) {
    return lines.findLastIndex((line) => /^›\s+/.test(line.trim()));
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeComparableText(lines[index]);
    if (!normalized.startsWith('›')) continue;
    if (normalized.includes(input)) return index;
  }

  return -1;
}

function isVisualNoiseLine(line, input) {
  const value = line.trim();
  const normalized = normalizeComparableText(value);
  if (!value) return true;
  if (input && normalized === input) return true;
  if (/^›\s*/.test(value)) return true;
  if (isVisualSeparatorLine(value)) return true;
  if (/^[-─]\s*Worked for\b/i.test(value)) return true;
  if (/^(?:tab to queue message|100% context left)$/i.test(value)) return true;
  if (/^Booting MCP server:/i.test(value)) return true;
  if (/^Tip:/i.test(value)) return true;
  if (/^⚠\s*(?:MCP client|MCP startup)/i.test(value)) return true;
  if (/^⚠\s*Heads up\b/i.test(value)) return true;
  if (/OpenAI Codex|model:|directory:|\/model to change/i.test(value)) return true;
  if (INTRO_LINE_PATTERN.test(value)) return true;
  if (/gpt-[\w.-]+\s+\w+/i.test(value) && /[~/]|\bcontext\b/i.test(value)) return true;
  return false;
}

function isVisualSeparatorLine(line) {
  const value = String(line || '').trim();
  if (!value) return false;
  return /^[─━═-]{8,}$/.test(value) || /^[─━═-]+\s*Worked for\b.*[─━═-]*$/i.test(value);
}

function normalizeCleanedText(text) {
  return String(text || '')
    .replace(/^[-─]\s*Worked for\b.*$/gim, '')
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2')
    .replace(/([A-Za-z0-9_./-])\s+([,.;:，。；：])/g, '$1$2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeComparableText(text) {
  return String(text || '')
    .replace(/[›•●]/g, (char) => char)
    .replace(/\s+/g, '')
    .trim();
}

function clipForLog(text, max = 1200) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated]`;
}

function buildSubmitInput(text) {
  const value = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return `\x1b[200~${value}\x1b[201~\r`;
}

function isApproveCommand(command) {
  return ['/approve', '/allow', '/yes', '/y'].includes(String(command || '').toLowerCase());
}

function isDenyCommand(command) {
  return ['/deny', '/reject', '/no', '/n', '/cancel'].includes(
    String(command || '').toLowerCase()
  );
}

function isEscapeCommand(command) {
  return ['/esc', '/escape'].includes(String(command || '').toLowerCase());
}

function parseKeyCommand(command) {
  const value = String(command || '').toLowerCase();
  if (value === '/enter') return 'enter';
  if (value === '/up') return 'up';
  if (value === '/down') return 'down';
  if (value === '/left') return 'left';
  if (value === '/right') return 'right';
  if (value === '/tab') return 'tab';
  return '';
}

function buildControlInput(action) {
  const value = String(action || '').toLowerCase();
  if (value === 'approve' || value === 'enter' || value === 'yes') return '\r';
  if (value === 'deny' || value === 'escape' || value === 'cancel' || value === 'no') {
    return '\x1b';
  }
  if (value === 'up') return '\x1b[A';
  if (value === 'down') return '\x1b[B';
  if (value === 'right') return '\x1b[C';
  if (value === 'left') return '\x1b[D';
  if (value === 'tab') return '\t';
  return '';
}

module.exports = {
  RemoteSessionController,
  stripTerminalControls,
  formatTerminalText,
  formatTerminalFinalAnswer,
  formatVisualSnapshot,
  formatVisualProgressSnapshot,
  formatTerminalProgress,
  buildSubmitInput,
  buildControlInput
};
