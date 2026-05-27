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

    if (isNativeCodexSlashCommand(command)) {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await message.reply('Native Codex slash commands require visual_terminal mode.');
        return;
      }
      await this.handleNativeSlashCommand(key, message, text);
      return;
    }

    if (isRemoteStatusCommand(command)) {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await this.sendExecStatus(key, message);
        return;
      }
      await this.sendStatus(key, message);
      return;
    }

    if (isCommandPanelCommand(command)) {
      await this.sendCommandPanel(key, message);
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

    if (isApprovePersistentCommand(command)) {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await message.reply('Approval prompts are handled by Codex exec policy in JSON mode.');
        return;
      }
      await this.sendControlInput(key, message, 'approve_persistent');
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
    state.replyPanel = message.replyPanel;
    state.createReplyStream = message.createReplyStream;
    await this.flushPendingReply(state);
    if (isVisualSessionBusy(state)) {
      const approval = this.getApprovalPrompt(state);
      if (approval) {
        await this.sendPermissionPanel(key, message, state, approval);
        return;
      }
      await message.reply(formatVisualBusyText(state));
      return;
    }

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
        1200,
      finalReplyDebounceMs: normalizeDelayMs(
        pluginConfig.finalReplyDebounceMs ??
          this.config.remoteControl?.finalReplyDebounceMs,
        6000
      )
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
    const payload = this.buildExecStatusPayload(key, message, state);
    await this.replyPanelOrText(message, payload, formatStatusPanelText(payload));
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
      replyPanel: message.replyPanel,
      session,
      shared: acquired.shared,
      cursor: 0,
      outputBuffer: '',
      flushTimer: null,
      streamFinishTimer: null,
      pendingReplyTimer: null,
      createReplyStream: message.createReplyStream,
      replyStream: null,
      lastReplyText: '',
      lastStreamText: '',
      lastSentReplyText: '',
      pendingReplyText: '',
      lastApprovalSignature: '',
      lastInputText: '',
      nativeCommand: null,
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
    const payload = this.buildVisualStatusPayload(key, message, state);
    await this.replyPanelOrText(message, payload, formatStatusPanelText(payload));
  }

  async sendCommandPanel(key, message) {
    const visualState = this.sessions.get(key);
    const execState = this.execSessions.get(key);
    const payload = {
      kind: 'commands',
      title: 'Remote Codex 快捷命令',
      source: this.shouldUseStructuredRunner(message.pluginId)
        ? 'exec_json'
        : 'visual_terminal',
      attached: Boolean(visualState || execState),
      actions: ['resume', 'permission', 'status', 'tail', 'stop']
    };
    await this.replyPanelOrText(message, payload, formatCommandPanelText(payload));
  }

  async replyPanelOrText(message, payload, fallbackText) {
    if (typeof message.replyPanel === 'function') {
      await message.replyPanel({
        ...payload,
        fallbackText
      });
      return;
    }
    await message.reply(fallbackText);
  }

  buildVisualStatusPayload(key, message, state, options = {}) {
    const sessionStatus = state?.session?.status?.() || null;
    const outputConfig = this.getOutputConfig(message.pluginId);
    const responseSource =
      this.getPluginConfig(message.pluginId).responseSource ||
      this.config.remoteControl?.responseSource ||
      'visual_terminal';

    return {
      kind: 'status',
      title: 'Remote Codex 状态',
      source: responseSource,
      notice: options.notice || '',
      attached: Boolean(state),
      running: Boolean(sessionStatus && !sessionStatus.exited),
      busy: Boolean(state?.turnStartedAt && !state?.lastReplyText),
      shared: Boolean(state?.shared),
      session: sessionStatus,
      remote: {
        key,
        pluginId: message.pluginId,
        conversationId: message.conversationId,
        userId: message.userId
      },
      config: {
        outputMode: outputConfig.outputMode,
        sendOutput: outputConfig.sendOutput,
        responseSource,
        rawOutputLogEnabled: Boolean(this.config.remoteControl?.rawOutputLogEnabled)
      },
      lastInputText: state?.lastInputText || '',
      turnStartedAt: state?.turnStartedAt || 0,
      actions: ['resume', 'permission', 'tail', 'stop']
    };
  }

  buildExecStatusPayload(key, message, state, options = {}) {
    return {
      kind: 'status',
      title: 'Remote Codex 状态',
      source: 'exec_json',
      notice: options.notice || '',
      attached: Boolean(state),
      running: Boolean(state),
      busy: Boolean(state?.running),
      shared: false,
      session: state
        ? {
            id: state.threadId || '',
            cwd: state.cwd,
            createdAt: state.createdAt,
            cursor: 0,
            exited: false
          }
        : null,
      remote: {
        key,
        pluginId: message.pluginId,
        conversationId: message.conversationId,
        userId: message.userId
      },
      config: {
        outputMode: this.getOutputConfig(message.pluginId).outputMode,
        sendOutput: this.getOutputConfig(message.pluginId).sendOutput,
        responseSource: 'exec_json',
        rawOutputLogEnabled: Boolean(this.config.remoteControl?.rawOutputLogEnabled)
      },
      lastInputText: state?.lastReplyText ? 'Last reply is available in /tail.' : '',
      turnStartedAt: state?.running ? Date.now() : 0,
      actions: ['resume', 'tail', 'stop']
    };
  }

  async handleNativeSlashCommand(key, message, text) {
    const commandText = normalizeNativeCodexSlashText(text);
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
    state.replyPanel = message.replyPanel;
    state.createReplyStream = message.createReplyStream;
    await this.flushPendingReply(state);
    if (isVisualSessionBusy(state)) {
      const approval = this.getApprovalPrompt(state);
      if (approval) {
        await this.sendPermissionPanel(key, message, state, approval);
        return;
      }
      await message.reply(formatVisualBusyText(state));
      return;
    }

    state.lastInputText = commandText;
    state.turnStartedAt = Date.now();
    state.nativeCommand = {
      command: commandText.split(/\s+/)[0].toLowerCase(),
      text: commandText,
      startedAt: Date.now()
    };
    this.emitRemoteInput(message, commandText, state);
    this.resetPendingOutput(state);
    state.nativeCommand = {
      command: commandText.split(/\s+/)[0].toLowerCase(),
      text: commandText,
      startedAt: Date.now()
    };
    await this.startReplyStream(state, message).catch((error) => {
      this.logger.warn?.('Remote reply stream unavailable:', error.message);
    });
    await writeNativeSlashCommand(state.session, commandText);
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

    state.reply = message.reply;
    state.replyPanel = message.replyPanel;
    state.createReplyStream = message.createReplyStream;

    const approvalAction = isApprovalControlAction(action);
    const approval = approvalAction ? this.getApprovalPrompt(state) : null;
    if (requiresApprovalPrompt(action) && !approval) {
      await this.sendPermissionPanel(key, message, state, null, {
        notice: '当前没有检测到 Codex 权限确认弹窗。'
      });
      return;
    }

    const input = buildControlInput(action);
    if (!input) {
      await message.reply(`Unknown control action: ${action}`);
      return;
    }

    state.session.write(input);
    if (approvalAction) {
      state.outputBuffer = '';
    }
    this.logger.event?.('remote.control.sent', {
      pluginId: message.pluginId,
      conversationId: message.conversationId,
      action,
      approval: Boolean(approval)
    });

    if (approvalAction) {
      await message.reply(formatApprovalControlAck(action));
    }
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
      const approval = this.getApprovalPrompt(state, output);
      if (approval && !state.replyStream) {
        const signature = approvalPromptSignature(approval);
        if (signature && signature !== state.lastApprovalSignature) {
          state.lastApprovalSignature = signature;
          const panel = this.buildPermissionPanelPayload(
            state.key,
            null,
            state,
            approval
          );
          this.safeReplyPanel(state, panel, formatPermissionPanelText(panel));
        }
        state.outputBuffer = '';
        return;
      }
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
      if (outputConfig.outputMode === 'final') {
        this.scheduleFinalReply(state, formatted, outputConfig.finalReplyDebounceMs);
        return;
      }
      this.safeReply(state, formatted);
    }, outputConfig.flushIntervalMs);
  }

  scheduleFinalReply(state, text, delayMs) {
    const value = String(text || '').trim();
    if (!value) return;

    state.pendingReplyText = value;
    if (state.pendingReplyTimer) {
      clearTimeout(state.pendingReplyTimer);
      state.pendingReplyTimer = null;
    }

    state.pendingReplyTimer = setTimeout(() => {
      state.pendingReplyTimer = null;
      const finalText = state.pendingReplyText;
      state.pendingReplyText = '';
      if (!finalText || finalText === state.lastSentReplyText) return;
      this.safeReply(state, finalText).then(() => {
        state.turnStartedAt = 0;
      });
    }, delayMs);
  }

  async flushPendingReply(state) {
    const finalText = String(state.pendingReplyText || '').trim();
    if (!finalText) return;
    if (state.pendingReplyTimer) {
      clearTimeout(state.pendingReplyTimer);
      state.pendingReplyTimer = null;
    }
    state.pendingReplyText = '';
    if (finalText === state.lastSentReplyText) return;
    await this.safeReply(state, finalText);
    state.turnStartedAt = 0;
  }

  async startReplyStream(state, message) {
    if (typeof state.createReplyStream !== 'function') return;
    const initialText = this.formatRunningFallback(state);
    state.replyStream = await state.createReplyStream({
      message,
      title: state.nativeCommand
        ? `Remote Codex ${state.nativeCommand.command}`
        : 'Remote Codex',
      initialText,
      controlMode: state.nativeCommand ? 'navigation' : 'default'
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
        state.lastSentReplyText = text;
      }
    } catch (error) {
      this.logger.warn?.('Remote reply failed:', error.message);
    }
  }

  async safeReplyPanel(state, panel, fallbackText) {
    const text = String(fallbackText || panel?.fallbackText || '').trim();
    try {
      if (typeof state.replyPanel === 'function') {
        this.logger.event?.('remote.panel.sent', {
          pluginId: state.pluginId,
          conversationId: state.conversationId,
          sessionId: state.session.id,
          kind: panel?.kind || '',
          text: clipForLog(text)
        });
        await state.replyPanel({
          ...panel,
          fallbackText: text
        });
        return;
      }

      if (text) {
        await this.safeReply(state, text);
      }
    } catch (error) {
      this.logger.warn?.('Remote panel reply failed:', error.message);
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
    if (state.nativeCommand) {
      const rendered = formatNativeSlashOutput({
        snapshot: state.session.visualViewportSnapshot || state.session.visualSnapshot,
        raw: data,
        command: state.nativeCommand.command,
        inputText: state.lastInputText
      });
      if (rendered) return rendered;
    }

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
    if (state.nativeCommand) {
      return (
        formatNativeSlashOutput({
          snapshot: state.session.visualViewportSnapshot || state.session.visualSnapshot,
          raw: data,
          command: state.nativeCommand.command,
          inputText: state.lastInputText
        }) || this.formatRunningFallback(state)
      );
    }

    const activity = state.shared
      ? formatVisualProgressSnapshot(state.session.visualSnapshot, state.lastInputText, {
          finalText
        })
      : formatTerminalProgress(data, { finalText });
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
        visualViewportSnapshot: clipForLog(
          state.session?.visualViewportSnapshot || '',
          12000
        ),
        formatted: clipForLog(formatted, 12000),
        streamText: clipForLog(streamText, 12000)
      };
      fs.appendFile(target, `${JSON.stringify(sample)}\n`, () => {});
    } catch (error) {
      this.logger.warn?.('Cleaning corpus capture failed:', error.message);
    }
  }

  getApprovalPrompt(state, pendingOutput = '') {
    if (!state?.session) return null;

    const snapshots = [
      state.session.visualViewportSnapshot,
      state.session.visualSnapshot
    ];
    for (const snapshot of snapshots) {
      const prompt = extractApprovalPrompt(collectNativeVisualLines(snapshot));
      if (prompt) return prompt;
    }

    if (pendingOutput) {
      const prompt = extractApprovalPrompt(collectNativeRawLines(pendingOutput));
      if (prompt) return prompt;
    }

    try {
      const recent = state.session
        .readAfter(Math.max(0, Number(state.cursor || 0) - 120))
        .chunks.map((chunk) => chunk.data)
        .join('');
      return extractApprovalPrompt(collectNativeRawLines(recent));
    } catch {
      return null;
    }
  }

  async sendPermissionPanel(key, message, state, approval, options = {}) {
    const payload = this.buildPermissionPanelPayload(
      key,
      message,
      state,
      approval,
      options
    );
    await this.replyPanelOrText(message, payload, formatPermissionPanelText(payload));
  }

  buildPermissionPanelPayload(key, message, state, approval, options = {}) {
    const sessionStatus = state?.session?.status?.() || null;
    const active = Boolean(approval);
    return {
      kind: 'permission',
      title: active ? 'Remote Codex 权限确认' : 'Remote Codex 权限',
      notice: options.notice || '',
      attached: Boolean(state),
      active,
      approval: approval || null,
      session: sessionStatus,
      remote: message
        ? {
            key,
            pluginId: message.pluginId,
            conversationId: message.conversationId,
            userId: message.userId
          }
        : {
            key,
            pluginId: state?.pluginId || '',
            conversationId: state?.conversationId || '',
            userId: ''
          },
      message: active
        ? 'Codex 正在等待权限确认。'
        : options.notice || '当前没有检测到权限确认弹窗。',
      progressText: active ? formatApprovalPrompt(approval) : '',
      actions: active
        ? ['approve', 'approve_persistent', 'deny', 'up', 'down', 'enter']
        : ['tail', 'status']
    };
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
    if (state.pendingReplyTimer) {
      clearTimeout(state.pendingReplyTimer);
      state.pendingReplyTimer = null;
    }
    if (state.replyStream && state.lastReplyText) {
      state.replyStream.finish(state.lastReplyText).catch((error) => {
        this.logger.warn?.('Remote reply stream finish failed:', error.message);
      });
    }
    state.outputBuffer = '';
    state.lastReplyText = '';
    state.lastStreamText = '';
    state.lastSentReplyText = '';
    state.pendingReplyText = '';
    state.lastApprovalSignature = '';
    state.nativeCommand = null;
    state.replyStream = null;
  }

  disposeState(state, options = {}) {
    state.stopped = true;
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    if (state.streamFinishTimer) {
      clearTimeout(state.streamFinishTimer);
      state.streamFinishTimer = null;
    }
    if (state.pendingReplyTimer) {
      clearTimeout(state.pendingReplyTimer);
      state.pendingReplyTimer = null;
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
      '/remote-status - show Remote Codex session status',
      '/status - send native Codex status command',
      '/resume - send native Codex resume command',
      '/permission - send native Codex permissions command',
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
  if (input && promptIndex < 0) return '';
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

function formatVisualProgressSnapshot(snapshot, inputText = '', options = {}) {
  const input = normalizeComparableText(inputText);
  const lines = String(snapshot || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .filter((line) => !BOX_ONLY_PATTERN.test(line.trim()));
  const promptIndex = findLastSubmittedPrompt(lines, input);
  if (input && promptIndex < 0) return '';
  const afterPrompt = promptIndex >= 0 ? lines.slice(promptIndex + 1) : lines;
  return renderCodexProgressState(parseCodexProgressState(afterPrompt, options));
}

function formatNativeSlashOutput({ snapshot, raw, command, inputText } = {}) {
  const normalizedCommand = normalizeNativeCodexCommand(command);
  const visualLines = collectNativeVisualLines(snapshot);
  const rawLines = collectNativeRawLines(raw);
  const lines = visualLines.length > 0 ? visualLines : rawLines;
  if (lines.length === 0) return '';

  if (normalizedCommand === '/resume') {
    return formatResumeSlashOutput(lines, inputText);
  }

  if (normalizedCommand === '/permissions') {
    return formatPermissionsSlashOutput(lines, inputText);
  }

  if (normalizedCommand === '/status') {
    return formatStatusSlashOutput(lines, inputText);
  }

  return formatGenericSlashOutput(lines, normalizedCommand, inputText);
}

function collectNativeVisualLines(snapshot) {
  return String(snapshot || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .filter((line) => !BOX_ONLY_PATTERN.test(line.trim()));
}

function collectNativeRawLines(raw) {
  return stripTerminalControls(raw)
    .replace(/\u001b/g, '')
    .replace(/\r+/g, '\n')
    .replace(/\b\d+;[^\n\r]{0,240}/g, '\n')
    .replace(/\b(?:10|11|12|13|14|15);[?0-9;]*/g, '')
    .replace(CONTROL_PATTERN, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .filter((line) => !BOX_ONLY_PATTERN.test(line.trim()));
}

function formatResumeSlashOutput(lines, inputText = '') {
  const options = extractPickerOptions(lines);
  if (options.length > 0) {
    return renderPickerPage({
      title: '**/resume 会话列表**',
      intro: '选择要恢复的历史会话。',
      options,
      pageSize: 8,
      footer: '点击卡片里的 Up/Down/Enter，或发送 `/up`、`/down`、`/enter`。'
    });
  }

  const resumeRows = extractResumeRows(lines);
  if (resumeRows.items.length > 0) {
    return renderResumeRows(resumeRows);
  }

  const disabled = findNativeSlashDisabledMessage(lines, '/resume');
  if (disabled) {
    return ['**/resume**', `- ${disabled}`, '', '当前 Codex 还在处理任务；等任务结束后再发送 `/resume`。'].join('\n');
  }

  return suppressNativeIntroOnly(formatGenericSlashOutput(lines, '/resume', inputText, {
    title: '**/resume**',
    emptyText: 'Codex 没有返回可解析的历史会话列表。'
  }));
}

function formatPermissionsSlashOutput(lines, inputText = '') {
  const options = extractPickerOptions(lines);
  if (options.length > 0) {
    return renderPickerPage({
      title: '**权限选项**',
      intro: findNativeTitleLine(lines, ['Update Model Permissions']) || '选择 Codex 权限模式。',
      options,
      pageSize: 5,
      footer: '点击 Up/Down/Enter 选择，或发送 `/esc` 返回。'
    });
  }

  const disabled = findNativeSlashDisabledMessage(lines, '/permissions');
  if (disabled) {
    return ['**/permissions**', `- ${disabled}`, '', '当前 Codex 还在处理任务；等任务结束后再调整权限。'].join('\n');
  }

  return suppressNativeIntroOnly(formatGenericSlashOutput(lines, '/permissions', inputText, {
    title: '**权限**',
    emptyText: '当前没有可解析的权限面板内容。'
  }));
}

function formatStatusSlashOutput(lines, inputText = '') {
  const normalized = lines
    .map((line) => normalizeNativeLine(line))
    .filter(Boolean);
  const panelStart = normalized.findLastIndex((line) =>
    /^>_\s+OpenAI Codex/i.test(line)
  );
  const panelLines = panelStart >= 0 ? normalized.slice(panelStart) : normalized;
  const useful = selectUsefulNativeLines(panelLines, '/status', inputText)
    .filter((line) => !/^Tip:/i.test(line))
    .filter((line) => !/^model:\s+.*\/model to change/i.test(line))
    .filter((line) => !/^directory:\s+~/i.test(line) || /^Directory:/i.test(line));

  if (useful.length === 0) return '';
  const status = parseCodexStatusLines(useful);
  if (status.hasStructuredData) {
    return renderCodexStatusPanel(status);
  }
  return ['**Codex 状态**', ...useful.slice(0, 16).map((line) => `- ${line}`)].join('\n');
}

function parseCodexStatusLines(lines) {
  const status = {
    version: '',
    intro: [],
    fields: {},
    usage: [],
    hasStructuredData: false
  };

  for (const line of lines) {
    const versionMatch = line.match(/^>_\s+OpenAI Codex\s+\(([^)]+)\)/i);
    if (versionMatch) {
      status.version = versionMatch[1];
      status.hasStructuredData = true;
      continue;
    }

    const fieldMatch = line.match(/^([^:]{2,36}):\s+(.+)$/);
    if (!fieldMatch) {
      if (/^Visit\s+https?:\/\//i.test(line) || /^information on\b/i.test(line)) {
        status.intro.push(line);
      }
      continue;
    }

    const key = fieldMatch[1].trim();
    const value = fieldMatch[2].trim();
    const usage = parseCodexUsageField(key, value);
    if (usage) {
      status.usage.push(usage);
      status.hasStructuredData = true;
      continue;
    }

    status.fields[normalizeStatusFieldKey(key)] = {
      label: key,
      value
    };
    status.hasStructuredData = true;
  }

  return status;
}

function parseCodexUsageField(key, value) {
  if (!/\blimit\b/i.test(key)) return null;
  const barMatch = value.match(/^(\[[^\]]+\])\s*(.*)$/);
  const text = (barMatch ? barMatch[2] : value).trim();
  const percentMatch = text.match(/(\d+(?:\.\d+)?)%\s+left/i);
  const resetMatch = text.match(/\((resets[^)]*)\)/i);
  return {
    label: formatUsageLabel(key),
    originalLabel: key,
    bar: barMatch?.[1] || '',
    text,
    percentLeft: percentMatch ? Number(percentMatch[1]) : null,
    reset: resetMatch?.[1] || ''
  };
}

function renderCodexStatusPanel(status) {
  const lines = ['**Codex 状态**'];
  if (status.version) lines.push(`- 版本: \`${status.version}\``);

  if (status.usage.length > 0) {
    lines.push('', '**剩余用量**');
    for (const usage of status.usage) {
      const remaining = Number.isFinite(usage.percentLeft)
        ? `${usage.percentLeft}% 剩余`
        : usage.text;
      const reset = usage.reset ? `，重置 ${usage.reset.replace(/^resets\s*/i, '')}` : '';
      const warning = Number.isFinite(usage.percentLeft) && usage.percentLeft <= 25
        ? '低余量 '
        : '';
      lines.push(`- ${usage.label}: ${warning}${remaining}${reset}`);
      if (usage.bar) lines.push(`  ${usage.bar}`);
    }
  }

  const fieldLines = [
    ['model', '模型'],
    ['permissions', '权限'],
    ['directory', '目录'],
    ['account', '账号'],
    ['collaboration mode', '协作模式'],
    ['agents.md', 'Agents.md'],
    ['session', 'Session']
  ]
    .map(([key, label]) => {
      const field = status.fields[key];
      if (!field?.value) return '';
      return `- ${label}: ${formatStatusFieldValue(key, field.value)}`;
    })
    .filter(Boolean);

  if (fieldLines.length > 0) {
    lines.push('', '**运行信息**', ...fieldLines);
  }

  if (status.intro.length > 0) {
    lines.push('', status.intro.join(' '));
  }

  return lines.join('\n');
}

function normalizeStatusFieldKey(key) {
  return String(key || '').trim().toLowerCase();
}

function formatUsageLabel(label) {
  const value = String(label || '').trim();
  if (/^5h/i.test(value)) return '5 小时额度';
  if (/weekly/i.test(value)) return '每周额度';
  return value;
}

function formatStatusFieldValue(key, value) {
  if (key === 'session' || key === 'directory') {
    return `\`${String(value).replace(/`/g, "'")}\``;
  }
  return value;
}

function formatGenericSlashOutput(lines, command, inputText = '', options = {}) {
  const useful = selectUsefulNativeLines(lines, command, inputText);
  if (useful.length === 0) return '';

  const title = options.title || `**${command || 'Codex'}**`;
  return [title, ...useful.slice(0, 16).map((line) => `- ${line}`)].join('\n');
}

function suppressNativeIntroOnly(text) {
  const value = String(text || '');
  if (!value) return '';
  const withoutTitle = value
    .split('\n')
    .filter((line) => !/^\*\*[^*]+\*\*$/.test(line.trim()))
    .join('\n');
  if (/OpenAI Codex|Start a fresh idea|\/model to change|directory:/i.test(withoutTitle)) {
    return '';
  }
  return value;
}

function selectUsefulNativeLines(lines, command, inputText = '') {
  const commandText = normalizeComparableText(command || '');
  const input = normalizeComparableText(inputText || command || '');
  const useful = [];

  for (const rawLine of lines) {
    const line = normalizeNativeLine(rawLine);
    if (!line) continue;
    const comparable = normalizeComparableText(line);
    if (!comparable) continue;
    if (commandText && comparable === commandText) continue;
    if (input && comparable === input) continue;
    if (isNativeSlashNoiseLine(line, command)) continue;
    if (useful[useful.length - 1] === line) continue;
    useful.push(line);
  }

  return useful;
}

function extractPickerOptions(lines) {
  const options = [];
  let current = null;

  for (const rawLine of lines) {
    const line = normalizeNativeLine(rawLine);
    if (!line) continue;

    const match = line.match(/^(?:[>›]\s*)?(\d+)\.\s+(.+)$/);
    if (match) {
      current = {
        selected: /^[>›]/.test(line),
        index: Number(match[1]),
        text: match[2].trim(),
        details: []
      };
      options.push(current);
      continue;
    }

    if (isNativeSlashNoiseLine(line, '')) continue;

    if (current && isPickerContinuationLine(rawLine, line)) {
      current.details.push(line);
    }
  }

  return compactPickerOptions(options);
}

function compactPickerOptions(options) {
  const compacted = [];
  const seen = new Set();
  for (const option of options) {
    const signature = `${option.index}:${option.text}:${option.details.join('|')}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    compacted.push(option);
  }
  return compacted;
}

function renderPickerPage({ title, intro, options, pageSize, footer }) {
  const selectedIndex = options.findIndex((option) => option.selected);
  const safePageSize = Math.max(1, Number(pageSize) || 8);
  const pageIndex =
    selectedIndex >= 0 ? Math.floor(selectedIndex / safePageSize) : 0;
  const start = pageIndex * safePageSize;
  const pageOptions = options.slice(start, start + safePageSize);
  const totalPages = Math.max(1, Math.ceil(options.length / safePageSize));
  const lines = [
    title,
    `- ${intro}`,
    `- 第 ${pageIndex + 1}/${totalPages} 页，当前可见 ${pageOptions.length}/${options.length} 项。`,
    '',
    '**列表**'
  ];

  for (const option of pageOptions) {
    const prefix = option.selected ? '>' : '-';
    lines.push(`${prefix} ${option.index}. ${option.text}`);
    for (const detail of option.details.slice(0, 2)) {
      lines.push(`  ${detail}`);
    }
  }

  if (footer) lines.push('', footer);
  return lines.join('\n');
}

function extractResumeRows(lines) {
  const items = [];
  let current = null;
  let pageLabel = '';
  let hasMore = false;

  for (const rawLine of lines) {
    const line = normalizeNativeLine(rawLine);
    if (!line) continue;

    const pageMatch = line.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    if (pageMatch) {
      pageLabel = `${pageMatch[1]} / ${pageMatch[2]}`;
      continue;
    }
    if (/more\b/i.test(line) && /[↓↑]/.test(line)) {
      hasMore = true;
      continue;
    }
    if (isResumeNoiseLine(line)) continue;

    const match = line.match(/^(?:(❯|>|›)\s*)?((?:just now|\d+\s*[smhdw]\s+ago|\d+\s*d\s+ago|\d+\s*h\s+ago|\d+\s*m\s+ago|\d+\s*s\s+ago|\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2}\s+\d{1,2}))\s+(.+)$/i);
    if (match) {
      current = {
        selected: Boolean(match[1]),
        time: match[2].replace(/\s+/g, ' ').trim(),
        title: match[3].trim()
      };
      items.push(current);
      continue;
    }

    if (current && /^\s{2,}\S/.test(rawLine) && !isNativeSlashNoiseLine(line, '/resume')) {
      current.title = `${current.title}${line}`;
    }
  }

  return {
    items: compactResumeRows(items),
    pageLabel,
    hasMore
  };
}

function compactResumeRows(items) {
  const compacted = [];
  const seen = new Set();
  for (const item of items) {
    const signature = `${item.time}:${item.title}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    compacted.push(item);
  }
  return compacted;
}

function renderResumeRows({ items, pageLabel, hasMore }) {
  const lines = [
    '**/resume 会话列表**',
    `- 卡片显示 ${Math.min(items.length, 12)}/${items.length} 项${pageLabel ? `，位置 ${pageLabel}` : ''}。`,
    '',
    '**列表**'
  ];

  for (const item of items.slice(0, 12)) {
    const prefix = item.selected ? '>' : '-';
    lines.push(`${prefix} ${item.time} ${item.title}`);
  }

  if (hasMore || items.length > 12) {
    lines.push('', '还有更多历史会话；点击 Down 或发送 `/down` 继续浏览。');
  }
  lines.push('', '点击 Enter 或发送 `/enter` 恢复选中的会话，发送 `/esc` 退出。');
  return lines.join('\n');
}

function isResumeNoiseLine(line) {
  return (
    /^Resume a previous session$/i.test(line) ||
    /^Type to search\b/i.test(line) ||
    /^(?:enter resume|esc exit|ctrl\+|tab focus|←|↑|↓)/i.test(line)
  );
}

function isPickerContinuationLine(rawLine, line) {
  if (!line) return false;
  if (/^(?:[>›]\s*)?\d+\.\s+/.test(line)) return false;
  if (/^(?:Press enter|esc to|tab to|gpt-[\w.-]+)/i.test(line)) return false;
  return /^\s{2,}\S/.test(rawLine) || line.length >= 20;
}

function findNativeSlashDisabledMessage(lines, command) {
  const normalized = normalizeNativeCodexCommand(command);
  const aliases = normalized === '/permissions'
    ? ["'/permissions'", "'/permission'"]
    : [`'${normalized}'`];

  for (const rawLine of lines) {
    const line = normalizeNativeLine(rawLine);
    if (!/disabled while a task is in progress/i.test(line)) continue;
    if (aliases.some((alias) => line.includes(alias))) return line;
  }
  return '';
}

function findNativeTitleLine(lines, candidates = []) {
  for (const rawLine of lines) {
    const line = normalizeNativeLine(rawLine);
    if (!line) continue;
    if (candidates.some((candidate) => line.includes(candidate))) return line;
  }
  return '';
}

function normalizeNativeLine(line) {
  return String(line || '')
    .replace(/^[│┃]\s*/, '')
    .replace(/\s*[│┃]$/, '')
    .replace(FINAL_PREFIX_PATTERN, '')
    .replace(/[•●◦○■]\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNativeSlashNoiseLine(line, command) {
  const value = String(line || '').trim();
  if (!value) return true;
  if (/^›\s*$/.test(value)) return true;
  if (/^›\s+/.test(value)) return true;
  if (command && value === command) return true;
  if (/^tab to queue message/i.test(value)) return true;
  if (/^(?:Press enter to confirm|esc to go back|esc to cancel)$/i.test(value)) return true;
  if (/^gpt-[\w.-]+\s+\w+/i.test(value) && /[~/]|·/.test(value)) return true;
  if (/^Booting MCP server:/i.test(value)) return true;
  if (/^MCP startup/i.test(value)) return true;
  if (/^Use \/skills/i.test(value)) return true;
  if (/^\/[a-z][\s\S]*\/[a-z]/i.test(value) && !/^\d+\.\s+/.test(value)) return true;
  return false;
}

function formatTerminalProgress(data, options = {}) {
  const lines = stripTerminalControls(data)
    .replace(/\u001b/g, '')
    .replace(/\r+/g, '\n')
    .replace(/\b\d+;[^\n\r]{0,240}/g, '\n')
    .replace(/\b(?:10|11|12|13|14|15);[?0-9;]*/g, '')
    .replace(CONTROL_PATTERN, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  return renderCodexProgressState(parseCodexProgressState(lines, options));
}

function parseCodexProgressState(lines, options = {}) {
  const approvalPrompt = extractApprovalPrompt(lines);
  if (approvalPrompt) {
    return {
      kind: 'approval',
      approval: approvalPrompt
    };
  }

  const state = {
    kind: 'progress',
    status: '',
    items: []
  };
  const finalComparable = normalizeComparableText(options.finalText || '');
  let current = null;

  for (const rawLine of lines) {
    const entry = normalizeProgressEntry(rawLine);
    if (!entry.value) continue;
    if (isProgressNoiseLine(entry.value)) continue;
    if (isProgressFinalDuplicate(entry.value, finalComparable)) continue;

    if (isProgressWarning(entry.value)) {
      current = addProgressItem(state, 'warning', formatProgressWarning(entry.value));
      continue;
    }

    if (RUNNING_STATUS_PATTERN.test(entry.value)) {
      const status = normalizeRunningStatus(entry.value);
      if (/^(?:Working|Thinking)\b/i.test(status)) {
        state.status = status;
        current = null;
      } else {
        current = addProgressItem(state, 'running', status);
      }
      continue;
    }

    if (ACTIVITY_LINE_PATTERN.test(entry.value)) {
      current = addProgressItem(state, 'activity', entry.value);
      continue;
    }

    if (current && isProgressDetailEntry(entry)) {
      addProgressDetail(current, normalizeProgressDetail(entry.value));
      continue;
    }

    if (entry.isBullet && isUsefulProgressNote(entry.value)) {
      current = addProgressItem(state, 'note', entry.value);
    }
  }

  state.items = compactProgressItems(state.items).slice(-8);
  return state;
}

function renderCodexProgressState(state) {
  if (!state) return '';
  if (state.kind === 'approval') {
    return formatApprovalPrompt(state.approval);
  }

  const items = [];
  if (state.status) items.push({ type: 'status', text: state.status, details: [] });
  items.push(...(state.items || []));
  if (items.length === 0) return '';

  return [
    '**进度**',
    ...items.flatMap((item) => formatProgressItem(item.text, item.details))
  ].join('\n');
}

function normalizeProgressEntry(line) {
  const raw = String(line || '').trimEnd();
  const trimmed = raw.trim();
  const bulletMatch = trimmed.match(/^([•●◦○■])\s*(.*)$/);
  const value = (bulletMatch ? bulletMatch[2] : trimmed)
    .replace(/\s+•\s*esc to interrupt\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    raw,
    trimmed,
    value,
    bullet: bulletMatch?.[1] || '',
    isBullet: Boolean(bulletMatch),
    isIndented: /^\s{2,}\S/.test(raw),
    isTree: /^[└├│]\s*/.test(value)
  };
}

function normalizeProgressLine(line) {
  return normalizeProgressEntry(line).value;
}

function normalizeRunningStatus(line) {
  return String(line || '')
    .replace(/\((\d+s)[^)]*\)/i, '($1)')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatProgressItem(text, details = []) {
  const lines = [`- ${text}`];
  for (const detail of details) {
    lines.push(`  ${detail}`);
  }
  return lines;
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
  if (/^(?:Press enter to confirm|esc to cancel|tab to queue message)/i.test(value)) {
    return true;
  }
  return false;
}

function isProgressWarning(value) {
  return /^⚠/.test(value) || /^You've hit your usage limit\b/i.test(value);
}

function formatProgressWarning(value) {
  return /^⚠/.test(value) ? value : `Error: ${value}`;
}

function addProgressItem(state, type, text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const previous = state.items[state.items.length - 1];
  if (previous && previous.type === type && previous.text === value) {
    return previous;
  }
  const item = { type, text: value, details: [] };
  state.items.push(item);
  return item;
}

function addProgressDetail(item, detail) {
  if (!item || !detail) return;
  if (item.details[item.details.length - 1] === detail) return;
  item.details.push(detail);
  if (item.details.length > 5) {
    item.details.splice(0, item.details.length - 5);
  }
}

function isProgressDetailEntry(entry) {
  if (!entry) return false;
  if (entry.isTree) return true;
  if (!entry.isIndented) return false;
  return (
    /^[+~-]\s/.test(entry.value) ||
    /^[|│]/.test(entry.value) ||
    /^\d+[:.)]\s/.test(entry.value) ||
    /^\.{3}\s*\+\d+\s+lines/i.test(entry.value) ||
    /\bctrl\s*\+\s*t\b/i.test(entry.value)
  );
}

function normalizeProgressDetail(value) {
  return String(value || '')
    .replace(/^└\s*/, '└ ')
    .replace(/^├\s*/, '├ ')
    .replace(/^│\s*/, '│ ')
    .trim();
}

function isUsefulProgressNote(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (ACTIVITY_LINE_PATTERN.test(text) || RUNNING_STATUS_PATTERN.test(text)) return false;
  if (/^(?:Would you like|Reason:|\$\s+|\d+\.)/i.test(text)) return false;
  if (/^(?:Use \/skills|Tip:|OpenAI Codex|model:|directory:)/i.test(text)) return false;
  return text.length >= 8;
}

function isProgressFinalDuplicate(value, finalComparable) {
  if (!finalComparable) return false;
  const comparable = normalizeComparableText(value);
  return comparable.length >= 12 && finalComparable.includes(comparable);
}

function compactProgressItems(items) {
  const compacted = [];
  for (const item of items) {
    if (!item?.text) continue;
    const previous = compacted[compacted.length - 1];
    const signature = progressItemSignature(item);
    if (previous && progressItemSignature(previous) === signature) continue;
    compacted.push(item);
  }
  return compacted;
}

function progressItemSignature(item) {
  return `${item.type}:${item.text}:${(item.details || []).join('|')}`;
}

function extractApprovalPrompt(lines) {
  const values = lines
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .filter((line) => !BOX_ONLY_PATTERN.test(line));
  const questionIndex = values.findLastIndex((line) => isApprovalQuestionLine(line));
  if (questionIndex < 0) return null;

  const before = values.slice(0, questionIndex).reverse();
  const statusLine = before.find((line) =>
    RUNNING_STATUS_PATTERN.test(normalizeProgressLine(line)) ||
    ACTIVITY_LINE_PATTERN.test(normalizeProgressLine(line))
  );
  const block = values.slice(questionIndex);
  const question = block[0];
  const reason = block.find((line) => /^Reason:/i.test(line)) || '';
  const commandLine = block.find((line) => /^\$\s+/.test(line)) || '';
  const options = block
    .filter((line) => /^(?:>\s*)?\d+\.\s+/.test(line))
    .map((line) => line.replace(/^>\s*/, '').trim());

  return {
    status: statusLine ? normalizeProgressLine(statusLine) : '',
    question,
    reason,
    command: commandLine.replace(/^\$\s+/, '').trim(),
    options
  };
}

function isApprovalQuestionLine(line) {
  const value = String(line || '').trim();
  if (/^(?:Would you like to|Do you want to)\b/i.test(value)) return true;
  if (/^Allow\b/i.test(value) && /\?$/.test(value)) return true;
  if (/\b(?:run|execute)\b.*\bcommand\b.*\?/i.test(value)) return true;
  return false;
}

function formatApprovalPrompt(prompt) {
  const lines = ['**等待确认**'];
  if (prompt.status) lines.push(`- ${prompt.status}`);
  if (prompt.question) lines.push(`- ${prompt.question}`);
  if (prompt.reason) lines.push(`- ${prompt.reason}`);
  if (prompt.command) {
    lines.push('', '```bash', prompt.command, '```');
  }
  if (prompt.options.length > 0) {
    lines.push('', '**选项**');
    for (const option of prompt.options) {
      lines.push(`- ${option}`);
    }
  }
  lines.push('', '可在卡片按钮中选择，也可以发送 `/approve`、`/always` 或 `/deny`。');
  return lines.join('\n');
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
    const promptText = normalized
      .replace(/^›/, '')
      .replace(/….*$/, '');
    if (normalized.includes(input)) return index;
    if (promptText.length >= 12 && input.includes(promptText)) return index;
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

function formatStatusPanelText(payload) {
  const lines = [];
  if (payload.notice) lines.push(payload.notice, '');

  if (!payload.attached || !payload.session) {
    lines.push('Remote Codex 当前没有接入的会话。');
    lines.push('发送 `/start` 可启动会话，`/resume` 会作为 Codex 原生命令透传。');
    return lines.join('\n').trim();
  }

  const session = payload.session;
  lines.push(payload.running ? 'Remote Codex 会话运行中。' : 'Remote Codex 会话未运行。');
  lines.push(`模式: ${payload.source || 'visual_terminal'}`);
  lines.push(`cwd: ${session.cwd || 'unknown'}`);
  if (session.id) lines.push(`id: ${session.id}`);
  if (session.cursor !== undefined) lines.push(`cursor: ${session.cursor}`);
  if (session.createdAt) lines.push(`created: ${session.createdAt}`);
  lines.push(`输出: ${payload.config?.sendOutput ? payload.config.outputMode : 'silent'}`);
  lines.push(`原始日志: ${payload.config?.rawOutputLogEnabled ? 'on' : 'off'}`);
  if (payload.lastInputText) lines.push(`最近输入: ${payload.lastInputText}`);
  lines.push('', '快捷命令: /resume /permission /status /tail /stop /remote-status');
  return lines.join('\n').trim();
}

function formatPermissionPanelText(payload) {
  const lines = [];
  if (payload.notice) lines.push(payload.notice, '');
  if (!payload.notice || payload.message !== payload.notice) {
    lines.push(payload.message || '当前没有权限状态。');
  }

  if (payload.active && payload.approval) {
    if (payload.approval.status) lines.push(`状态: ${payload.approval.status}`);
    if (payload.approval.question) lines.push(payload.approval.question);
    if (payload.approval.reason) lines.push(payload.approval.reason);
    if (payload.approval.command) {
      lines.push('', payload.approval.command);
    }
    lines.push('', '发送 /approve、/always 或 /deny 处理；也可以用 /up、/down、/enter 精确选择。');
    return lines.join('\n').trim();
  }

  if (payload.progressText) lines.push('', payload.progressText);
  lines.push('', '快捷命令: /resume /permission /status');
  return lines.join('\n').trim();
}

function formatCommandPanelText(payload) {
  return [
    payload.attached
      ? 'Remote Codex 快捷命令已就绪。'
      : 'Remote Codex 还没有接入会话。',
    '',
    '/resume - 打开 Codex 原生历史会话列表',
    '/permission - 打开 Codex 原生权限面板',
    '/status - 打开 Codex 原生状态面板',
    '/tail - 查看最近输出',
    '/stop - 停止远程会话',
    '/remote-status - 查看 Remote Codex 自身状态'
  ].join('\n');
}

function clipForLog(text, max = 1200) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated]`;
}

function normalizeDelayMs(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, number);
}

function buildSubmitInput(text) {
  const value = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (isPassthroughSlashCommand(value)) {
    return `${value}\r`;
  }
  return `\x1b[200~${value}\x1b[201~\r`;
}

function isVisualSessionBusy(state) {
  if (!state || !state.turnStartedAt) return false;
  if (state.lastReplyText || state.pendingReplyText) return false;
  if (state.session?.status?.().exited) return false;
  return true;
}

function formatVisualBusyText(state) {
  const startedAt = Number(state?.turnStartedAt) || Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return [
    `Codex 还在处理上一条消息 (${elapsedSeconds}s)。`,
    '这条输入暂时没有发送，避免覆盖当前回复。',
    '可以等回复结束后再发，或发送 /tail 查看最近输出，/stop 取消当前任务。'
  ].join('\n');
}

function isPassthroughSlashCommand(text) {
  const value = String(text || '').trim();
  return value.startsWith('/') && !value.includes('\n');
}

function isApproveCommand(command) {
  return ['/approve', '/allow', '/yes', '/y'].includes(String(command || '').toLowerCase());
}

function isNativeCodexSlashCommand(command) {
  return ['/resume', '/status', '/permission', '/permissions', '/perm'].includes(
    String(command || '').toLowerCase()
  );
}

function isRemoteStatusCommand(command) {
  return ['/remote-status', '/rc-status', '/session', '/session-status'].includes(
    String(command || '').toLowerCase()
  );
}

function isCommandPanelCommand(command) {
  return ['/commands', '/menu', '/快捷命令'].includes(String(command || '').toLowerCase());
}

function isApprovePersistentCommand(command) {
  return ['/always', '/approve-always', '/approve_persistent', '/persist', '/p'].includes(
    String(command || '').toLowerCase()
  );
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
  if (value === 'right') return '\x1b[C';
  if (value === 'left') return '\x1b[D';
  if (value === 'tab') return '\t';
  return '';
}

function isApprovalControlAction(action) {
  const value = String(action || '').toLowerCase();
  return [
    'approve',
    'yes',
    'approve_persistent',
    'always',
    'persist',
    'deny',
    'escape',
    'cancel',
    'no'
  ].includes(value);
}

function requiresApprovalPrompt(action) {
  const value = String(action || '').toLowerCase();
  return [
    'approve',
    'yes',
    'approve_persistent',
    'always',
    'persist'
  ].includes(value);
}

function formatApprovalControlAck(action) {
  const value = String(action || '').toLowerCase();
  if (value === 'approve' || value === 'yes') {
    return '已发送允许操作。';
  }
  if (value === 'approve_persistent' || value === 'always' || value === 'persist') {
    return '已发送总是允许操作。';
  }
  return '已发送拒绝/取消操作。';
}

function approvalPromptSignature(prompt) {
  if (!prompt) return '';
  return [
    prompt.question || '',
    prompt.reason || '',
    prompt.command || '',
    ...(prompt.options || [])
  ]
    .join('|')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeNativeCodexSlashText(text) {
  const value = String(text || '').trim();
  const [command, ...args] = value.split(/\s+/);
  const normalizedCommand = normalizeNativeCodexCommand(command);
  return [normalizedCommand, ...args].join(' ').trim();
}

function normalizeNativeCodexCommand(command) {
  const value = String(command || '').trim().toLowerCase();
  if (value === '/permission' || value === '/perm') return '/permissions';
  if (value === '/permissions') return '/permissions';
  if (value === '/resume') return '/resume';
  if (value === '/status') return '/status';
  return value || '/status';
}

function buildNativeSlashInput(text) {
  const value = normalizeNativeCodexSlashText(text);
  return `\x15${value}\r`;
}

async function writeNativeSlashCommand(session, text, options = {}) {
  const value = normalizeNativeCodexSlashText(text);
  const keyDelayMs = Number(options.keyDelayMs) || 12;
  const enterDelayMs = Number(options.enterDelayMs) || 80;

  session.write('\x15');
  await delay(keyDelayMs);
  for (const char of value) {
    session.write(char);
    await delay(keyDelayMs);
  }
  await delay(enterDelayMs);
  session.write('\r');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

module.exports = {
  RemoteSessionController,
  stripTerminalControls,
  formatTerminalText,
  formatTerminalFinalAnswer,
  formatVisualSnapshot,
  formatVisualProgressSnapshot,
  formatTerminalProgress,
  formatNativeSlashOutput,
  parseCodexProgressState,
  renderCodexProgressState,
  buildSubmitInput,
  buildControlInput,
  buildNativeSlashInput,
  writeNativeSlashCommand
};
