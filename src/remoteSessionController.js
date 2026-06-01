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
const PROGRESS_ITEM_LIMIT = 32;
const STREAM_FINAL_SETTLE_MS = 1500;
const STREAM_FINAL_DEBOUNCE_MS = 15000;
const STREAM_WORKING_HEARTBEAT_MS = 5000;
const VISUAL_BUSY_STALE_MS = 30 * 60 * 1000;
const REMOTE_CODEX_COLOR_MARKER_PREFIX = '<!--remote-codex-color:';
const REMOTE_CODEX_COLOR_MARKER_SUFFIX = '-->';
const TERMINAL_THEME_PALETTE = {
  0: [17, 20, 24],
  1: [255, 107, 107],
  2: [110, 231, 183],
  3: [247, 201, 72],
  4: [96, 165, 250],
  5: [192, 132, 252],
  6: [103, 232, 249],
  7: [232, 237, 242],
  8: [100, 116, 139],
  9: [251, 113, 133],
  10: [134, 239, 172],
  11: [253, 230, 138],
  12: [147, 197, 253],
  13: [216, 180, 254],
  14: [165, 243, 252],
  15: [255, 255, 255]
};
const TERMINAL_ROLE_COLORS = {
  approval: 'rgba(247,201,72,1)',
  command: 'rgba(96,165,250,1)',
  emphasis: 'rgba(255,255,255,1)',
  error: 'rgba(255,107,107,1)',
  info: 'rgba(103,232,249,1)',
  muted: 'rgba(100,116,139,1)',
  running: 'rgba(247,201,72,1)',
  status: 'rgba(247,201,72,1)',
  success: 'rgba(110,231,183,1)',
  warning: 'rgba(247,201,72,1)'
};

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
      await this.interruptSession(key, message);
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

    const permissionModeAction = parsePermissionModeCommand(command);
    if (permissionModeAction) {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await message.reply('Permission mode controls require visual_terminal mode.');
        return;
      }
      await this.sendControlInput(key, message, permissionModeAction);
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
    this.refreshVisualBusyState(state, 'incoming_message');
    if (isVisualSessionBusy(state)) {
      const approval = this.getApprovalPrompt(state);
      if (approval) {
        await this.sendPermissionPanel(key, message, state, approval);
        return;
      }
      await message.reply(formatVisualBusyText(state));
      return;
    }

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
      streamHeartbeatTimer: null,
      nativePageExitTimer: null,
      nativePageActionTimer: null,
      pendingReplyTimer: null,
      createReplyStream: message.createReplyStream,
      replyStream: null,
      replyStreamStarting: false,
      lastReplyText: '',
      lastStreamText: '',
      lastSentReplyText: '',
      lastReplySignature: '',
      lastStreamSignature: '',
      lastSentReplySignature: '',
      pendingReplyText: '',
      streamedThisTurn: false,
      streamFinishedForTurn: false,
      streamClosedText: '',
      nativePanelUpdateRequested: false,
      controlActionLocks: new Map(),
      lastApprovalSignature: '',
      lastInputText: '',
      nativeCommand: null,
      nativePageAction: null,
      phase: 'idle',
      turnStartedAt: 0,
      stopped: false
    };

    state.dataListener = (chunk) => {
      state.cursor = chunk.cursor;
      this.queueOutput(state, chunk.data);
    };

    state.exitListener = ({ exitCode, signal }) => {
      this.sessions.delete(key);
      this.clearStreamHeartbeat(state);
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

  async interruptSession(key, message) {
    const state = this.sessions.get(key);
    if (!state) {
      await message.reply('No Codex session is running.');
      return;
    }

    const phase = this.refreshSessionPhase(state, 'interrupt_requested');
    if (phase === 'idle') {
      await message.reply('Codex 当前没有正在执行的任务。');
      return;
    }

    state.session.write('\x1b');
    this.logger.event?.('remote.session.interrupt.sent', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      phase
    });
    await message.reply('已请求中断当前任务，Codex 会话仍保持运行。');
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
    const phase = state ? this.refreshSessionPhase(state, 'status_requested') : 'detached';
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
      phase,
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
      phase: state?.running ? 'working' : state ? 'idle' : 'detached',
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
    const command = commandText.split(/\s+/)[0].toLowerCase();
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
    this.discardPendingReply(state, 'native_slash_command');
    this.logger.event?.('remote.native_slash.start', {
      pluginId: message.pluginId,
      conversationId: message.conversationId,
      sessionId: state.session?.id || '',
      command,
      hasReplyPanel: typeof message.replyPanel === 'function',
      hasReplyStreamFactory: typeof message.createReplyStream === 'function',
      hadReplyStream: Boolean(state.replyStream),
      hadLastReply: Boolean(state.lastReplyText),
      outputBufferChars: String(state.outputBuffer || '').length
    });
    this.refreshSessionPhase(state, 'native_slash_requested');
    if (this.refreshOpenNativeSlashPage(state, command, message)) {
      return;
    }
    this.refreshVisualBusyState(state, 'native_slash_command');
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
      command,
      text: commandText,
      startedAt: Date.now()
    };
    this.refreshSessionPhase(state, 'native_slash_started');
    this.emitRemoteInput(message, commandText, state);
    this.resetPendingOutput(state);
    state.nativeCommand = {
      command,
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
    const pageContext = message.pageContext
      ? normalizeNativeCodexCommand(message.pageContext)
      : '';
    const nativeCommand = state.nativeCommand?.command
      ? normalizeNativeCodexCommand(state.nativeCommand.command)
      : '';
    if (
      message.pageContext &&
      pageContext !== nativeCommand
    ) {
      this.logger.event?.('remote.control.rejected_stale_page', {
        pluginId: message.pluginId,
        conversationId: message.conversationId,
        action,
        pageContext,
        nativeCommand
      });
      await message.reply('当前页面已经变化，请使用最新卡片继续操作。');
      return;
    }

    const phase = this.refreshSessionPhase(state, 'control_received');
    const approvalAction =
      phase === 'awaiting_authorization' &&
      isApprovalControlAction(action);
    const approval = approvalAction ? this.getApprovalPrompt(state) : null;
    if (requiresApprovalPrompt(action) && !approval) {
      await this.sendPermissionPanel(key, message, state, null, {
        notice: '当前没有检测到 Codex 权限确认弹窗。'
      });
      return;
    }
    if (this.isBufferedControlAction(state, action, approval)) {
      await message.reply('操作已收到，正在处理，请勿重复点击。');
      return;
    }

    const input = buildNativeControlInput(state, action);
    if (!input) {
      await message.reply(`Unknown control action: ${action}`);
      return;
    }

    await writeNativeControlInput(state, action, input);
    if (
      state.nativeCommand &&
      ['up', 'down', 'left', 'right', 'tab'].includes(String(action || '').toLowerCase())
    ) {
      state.nativePanelUpdateRequested = true;
    }
    if (
      state.nativeCommand &&
      (
        ['enter', 'escape'].includes(String(action || '').toLowerCase()) ||
        isPermissionModeControlAction(action)
      )
    ) {
      this.beginNativePageAction(state, action);
    }
    this.refreshSessionPhase(state, 'control_sent');
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
      if (this.confirmNativePageActionIfReady(state, 'output')) {
        return;
      }
      if (state.nativePageAction) {
        state.outputBuffer = '';
        return;
      }
      const approval = this.getApprovalPrompt(state, output);
      if (approval && !state.replyStream) {
        this.refreshSessionPhase(state, 'approval_detected');
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
      const canExtractFinal =
        !state.replyStream ||
        outputConfig.outputMode !== 'final' ||
        state.nativeCommand ||
        isVisualTurnSettled(state);
      const formatted = canExtractFinal ? this.formatStateOutput(state, output) : '';
      this.refreshSessionPhase(state, 'output_received');
      const streamText =
        state.replyStream && outputConfig.outputMode === 'final'
          ? this.formatStreamingStateOutput(state, output, formatted)
          : formatted;
      this.captureCleaningSample(state, output, formatted, streamText);
      if (state.nativeCommand && formatted) {
        this.logger.event?.('remote.native_slash.output', {
          pluginId: state.pluginId,
          conversationId: state.conversationId,
          sessionId: state.session?.id || '',
          command: state.nativeCommand.command,
          rawChars: String(output || '').length,
          formattedChars: String(formatted || '').length,
          streamChars: String(streamText || '').length,
          hasReplyStream: Boolean(state.replyStream),
          snapshotLines: collectNativeVisualLines(
            state.session?.visualViewportSnapshot || state.session?.visualSnapshot
          ).length,
          text: clipForLog(formatted)
        });
      }
      const formattedSignature = remoteMessageSignature(formatted);
      const streamSignature = remoteMessageSignature(streamText);
      if (!formatted || formattedSignature === state.lastReplySignature) {
        if (
          state.replyStream &&
          streamText &&
          streamSignature !== state.lastStreamSignature
        ) {
          state.lastStreamText = streamText;
          this.updateReplyStream(state, streamText, {
            final: shouldFinishReplyStream(state, formatted),
            keepOpen: isPersistentNativeSlashPage(state.nativeCommand?.command),
            finishDelayMs: this.getStreamFinishDelayMs(state, outputConfig)
          });
          state.nativePanelUpdateRequested = false;
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
      state.lastReplySignature = formattedSignature;
      if (outputConfig.outputMode !== 'final') {
        state.outputBuffer = '';
      }
      if (state.replyStream) {
        state.lastStreamText = streamText;
        this.updateReplyStream(state, streamText, {
          final: shouldFinishReplyStream(state, formatted),
          keepOpen: isPersistentNativeSlashPage(state.nativeCommand?.command),
          finishDelayMs: this.getStreamFinishDelayMs(state, outputConfig)
        });
        state.nativePanelUpdateRequested = false;
        return;
      }
      if (state.nativeCommand) {
        if (state.replyStreamStarting) {
          this.logger.event?.('remote.native_slash.panel.ignored', {
            pluginId: state.pluginId,
            conversationId: state.conversationId,
            sessionId: state.session.id,
            command: state.nativeCommand.command,
            reason: 'stream_starting',
            raw: clipForLog(output)
          });
          return;
        }
        if (
          normalizeNativeCodexCommand(state.nativeCommand.command) === '/status' &&
          !isCompleteStatusSlashOutput(formatted)
        ) {
          this.logger.event?.('remote.native_slash.panel.ignored', {
            pluginId: state.pluginId,
            conversationId: state.conversationId,
            sessionId: state.session.id,
            command: state.nativeCommand.command,
            reason: 'incomplete_status',
            raw: clipForLog(output)
          });
          return;
        }
        if (state.streamedThisTurn && !state.nativePanelUpdateRequested) {
          this.logger.event?.('remote.native_slash.panel.ignored', {
            pluginId: state.pluginId,
            conversationId: state.conversationId,
            sessionId: state.session.id,
            command: state.nativeCommand.command,
            reason: 'stream_already_sent',
            raw: clipForLog(output)
          });
          return;
        }
        state.nativePanelUpdateRequested = false;
        const panel = this.buildNativeSlashPanelPayload(state, formatted);
        this.safeReplyPanel(state, panel, formatted).then(() => {
          state.turnStartedAt = 0;
        });
        return;
      }
      if (outputConfig.outputMode === 'final') {
        if (state.streamedThisTurn) {
          this.logger.event?.('remote.reply.ignored', {
            pluginId: state.pluginId,
            conversationId: state.conversationId,
            sessionId: state.session.id,
            reason: 'stream_already_sent',
            raw: clipForLog(output)
          });
          return;
        }
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

  discardPendingReply(state, reason = 'discard') {
    if (!state) return;
    const finalText = String(state.pendingReplyText || '').trim();
    if (state.pendingReplyTimer) {
      clearTimeout(state.pendingReplyTimer);
      state.pendingReplyTimer = null;
    }
    state.pendingReplyText = '';
    if (finalText) {
      this.logger.event?.('remote.pending_reply.discarded', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        reason,
        text: clipForLog(finalText)
      });
    }
  }

  async startReplyStream(state, message) {
    if (typeof state.createReplyStream !== 'function') {
      this.logger.event?.('remote.stream.start.skipped', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        reason: 'missing_createReplyStream',
        controlMode: this.getReplyStreamControlMode(state)
      });
      return;
    }
    const initialText = this.formatRunningFallback(state);
    state.replyStreamStarting = true;
    try {
      state.replyStream = await state.createReplyStream({
        message,
        title: state.nativeCommand
          ? `Remote Codex ${state.nativeCommand.command}`
          : 'Remote Codex',
        initialText,
        controlMode: this.getReplyStreamControlMode(state)
      });
    } finally {
      state.replyStreamStarting = false;
    }
    if (state.replyStream) {
      this.logger.event?.('remote.stream.started', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        controlMode: this.getReplyStreamControlMode(state)
      });
      state.lastStreamText = initialText;
      state.streamedThisTurn = true;
      state.streamFinishedForTurn = false;
      state.streamClosedText = '';
      this.scheduleStreamHeartbeat(state);
    } else {
      this.logger.event?.('remote.stream.start.skipped', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        reason: 'factory_returned_null',
        controlMode: this.getReplyStreamControlMode(state)
      });
    }
  }

  getReplyStreamControlMode(state) {
    if (!state?.nativeCommand) return 'default';
    const command = normalizeNativeCodexCommand(state.nativeCommand.command);
    if (command === '/resume') return 'resume';
    if (command === '/permissions') return 'permissions';
    if (command === '/status') return 'status';
    return 'slash';
  }

  refreshOpenNativeSlashPage(state, command, message) {
    const normalized = normalizeNativeCodexCommand(command);
    if (!isPersistentNativeSlashPage(normalized)) return false;
    if (normalizeNativeCodexCommand(state?.nativeCommand?.command) !== normalized) {
      return false;
    }
    if (!isNativeSlashPageVisible(
      state.session?.visualViewportSnapshot || state.session?.visualSnapshot,
      normalized
    )) {
      return false;
    }

    const formatted = this.formatStateOutput(state, state.outputBuffer || '');
    if (!formatted) return true;
    state.lastInputText = normalized;
    state.turnStartedAt = Date.now();
    state.nativePanelUpdateRequested = false;
    if (state.replyStream) {
      state.lastStreamText = formatted;
      this.updateReplyStream(state, formatted, {
        keepOpen: true,
        immediate: true
      });
    }
    this.logger.event?.('remote.native_slash.reused', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      command: normalized
    });
    return true;
  }

  isBufferedControlAction(state, action, approval = null) {
    if (!state) return false;
    const now = Date.now();
    const locks = state.controlActionLocks || new Map();
    state.controlActionLocks = locks;

    for (const [key, lockedAt] of locks) {
      if (now - lockedAt > 10000) {
        locks.delete(key);
      }
    }

    const value = String(action || '').toLowerCase();
    const submit = isSubmitControlAction(value) && !state.nativeCommand;
    const signature = approval
      ? approvalPromptSignature(approval)
      : state.nativeCommand?.command || state.lastInputText || '';
    const key = `${submit ? 'submit' : value}:${signature}`;
    const ttlMs = submit ? 10000 : 700;
    const lockedAt = locks.get(key);
    if (lockedAt && now - lockedAt <= ttlMs) {
      return true;
    }

    locks.set(key, now);
    return false;
  }

  updateReplyStream(state, text, options = {}) {
    const signature = remoteMessageSignature(text);
    if (
      signature &&
      signature === state.lastStreamSignature &&
      !(options.final && signature !== state.lastSentReplySignature)
    ) {
      return;
    }
    state.streamedThisTurn = true;
    state.streamFinishedForTurn = false;
    if (signature) {
      state.lastStreamSignature = signature;
    }
    if (options.final || options.keepOpen) {
      this.clearStreamHeartbeat(state);
    }
    const updateMethod =
      options.immediate && typeof state.replyStream?.replace === 'function'
        ? 'replace'
        : 'update';
    state.replyStream
      ?.[updateMethod](text)
      .catch((error) => {
        this.logger.warn?.('Remote reply stream update failed:', error.message);
        if (options.final && text && text !== state.lastSentReplyText) {
          this.safeReply(state, text).then(() => {
            state.turnStartedAt = 0;
          });
        }
      });

    if (state.streamFinishTimer) {
      clearTimeout(state.streamFinishTimer);
      state.streamFinishTimer = null;
    }

    if (!options.final) {
      if (!options.keepOpen) {
        this.scheduleStreamHeartbeat(state);
      }
      return;
    }

    const finishDelayMs = Number.isFinite(Number(options.finishDelayMs))
      ? Math.max(0, Number(options.finishDelayMs))
      : STREAM_FINAL_DEBOUNCE_MS;
    const stream = state.replyStream;
    state.streamFinishTimer = setTimeout(() => {
      state.streamFinishTimer = null;
      stream
        ?.finish(text)
        .then(() => {
          if (state.replyStream === stream) {
            state.replyStream = null;
          }
          state.streamFinishedForTurn = true;
          state.streamClosedText = text;
          state.lastSentReplyText = text;
          state.lastSentReplySignature = signature;
          state.turnStartedAt = 0;
        })
        .catch((error) => {
          this.logger.warn?.('Remote reply stream finish failed:', error.message);
          if (
            error?.finalUpdateFailed &&
            text &&
            text !== state.lastSentReplyText
          ) {
            this.safeReply(state, text).then(() => {
              state.streamFinishedForTurn = true;
              state.streamClosedText = text;
              state.lastSentReplySignature = signature;
              state.turnStartedAt = 0;
            });
          }
        })
        .finally(() => {
          if (state.replyStream === stream) {
            state.replyStream = null;
          }
        });
    }, finishDelayMs);
  }

  scheduleStreamHeartbeat(state) {
    this.clearStreamHeartbeat(state);
    if (!state?.replyStream || !state.turnStartedAt || state.streamFinishedForTurn) {
      return;
    }

    state.streamHeartbeatTimer = setTimeout(() => {
      state.streamHeartbeatTimer = null;
      this.sendWorkingHeartbeat(state);
    }, STREAM_WORKING_HEARTBEAT_MS);
  }

  clearStreamHeartbeat(state) {
    if (state?.streamHeartbeatTimer) {
      clearTimeout(state.streamHeartbeatTimer);
      state.streamHeartbeatTimer = null;
    }
  }

  sendWorkingHeartbeat(state) {
    if (!state?.replyStream || !state.turnStartedAt || state.streamFinishedForTurn) {
      return;
    }
    if (state.streamFinishTimer) return;

    const streamText = this.formatWorkingHeartbeatText(state);
    if (streamText && streamText !== state.lastStreamText) {
      state.lastStreamText = streamText;
      this.updateReplyStream(state, streamText, { heartbeat: true });
      return;
    }

    this.scheduleStreamHeartbeat(state);
  }

  getStreamFinishDelayMs(state, outputConfig = {}) {
    if (
      normalizeNativeCodexCommand(state?.nativeCommand?.command) === '/status' &&
      isCompleteStatusSlashOutput(state.lastReplyText)
    ) {
      return STREAM_FINAL_SETTLE_MS;
    }
    if (isVisualTurnSettled(state)) {
      return STREAM_FINAL_SETTLE_MS;
    }
    const configured = Number(outputConfig.finalReplyDebounceMs);
    return Math.max(
      STREAM_FINAL_DEBOUNCE_MS,
      Number.isFinite(configured) ? configured : 0
    );
  }

  async safeReply(state, text) {
    const signature = remoteMessageSignature(text);
    if (signature && signature === state.lastSentReplySignature) return;
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
        state.lastSentReplySignature = signature;
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
        if (text) {
          state.lastSentReplyText = text;
          state.lastSentReplySignature = remoteMessageSignature(text);
        }
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
        inputText: state.lastInputText,
        colorMarkers: state.pluginId === 'feishu'
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
          inputText: state.lastInputText,
          colorMarkers: state.pluginId === 'feishu'
        }) || this.formatRunningFallback(state)
      );
    }

    const activity = state.shared
      ? (
          formatClassifiedVisualTurnStream(
            state.session.visualStyledSnapshot,
            state.lastInputText,
            {
              colorMarkers: state.pluginId === 'feishu',
              finalText
            }
          ) ||
          formatClassifiedVisualTurnStream(
            state.session.visualSnapshot,
            state.lastInputText,
            {
              colorMarkers: state.pluginId === 'feishu',
              finalText
            }
          ) ||
          formatVisualProgressSnapshot(
            state.session.visualStyledSnapshot,
            state.lastInputText,
            {
              colorMarkers: state.pluginId === 'feishu',
              finalText
            }
          ) ||
          formatVisualProgressSnapshot(state.session.visualSnapshot, state.lastInputText, {
            colorMarkers: state.pluginId === 'feishu',
            finalText
          }) ||
          formatTerminalProgress(data, {
            colorMarkers: state.pluginId === 'feishu',
            finalText
          })
        )
      : formatTerminalProgress(data, { finalText });
    if (finalText) {
      return activity ? `${activity}\n\n**回复**\n${finalText}` : `**回复**\n${finalText}`;
    }
    return activity || this.formatRunningFallback(state);
  }

  formatRunningFallback(state) {
    const nativeCommand = state?.nativeCommand?.command
      ? normalizeNativeCodexCommand(state.nativeCommand.command)
      : '';
    if (nativeCommand === '/permissions') {
      return formatPermissionsLoadingText();
    }
    if (nativeCommand === '/resume') {
      return '**/resume 会话列表**\n- 正在加载历史会话，请稍候。';
    }
    const line = withRemoteCodexLineColorMarker(
      this.formatWorkingStatusLine(state),
      TERMINAL_ROLE_COLORS.running,
      { colorMarkers: state.pluginId === 'feishu' }
    );
    return `**进度**\n${line}`;
  }

  formatWorkingHeartbeatText(state) {
    const current = String(state.lastStreamText || '').trim();
    const workingLine = this.formatWorkingStatusLine(state);
    if (!current || /\n\n\*\*回复\*\*/.test(current)) {
      return this.formatRunningFallback(state);
    }

    if (!/^\*\*进度\*\*/.test(current)) {
      return `${this.formatRunningFallback(state)}\n\n${current}`;
    }

    const lines = current.split('\n');
    const rest = lines
      .slice(1)
      .filter((line) => !isWorkingStatusLine(line));
    const coloredWorkingLine = withRemoteCodexLineColorMarker(
      workingLine,
      TERMINAL_ROLE_COLORS.running,
      { colorMarkers: state.pluginId === 'feishu' }
    );
    return ['**进度**', coloredWorkingLine, ...rest].join('\n').trim();
  }

  formatWorkingStatusLine(state) {
    const startedAt = Number(state.turnStartedAt) || Date.now();
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    return `- Working (${elapsedSeconds}s)`;
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
        visualStyledSnapshot: clipForLog(
          JSON.stringify(state.session?.visualStyledSnapshot || null),
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
        ? this.buildPermissionPanelActions(approval)
        : ['tail', 'status']
    };
  }

  buildPermissionPanelActions(approval) {
    const actions = ['approve', 'approve_persistent', 'deny'];
    if (approval?.options?.length > 0) {
      actions.push('up', 'down', 'enter');
    }
    return actions;
  }

  buildNativeSlashPanelPayload(state, content) {
    const command = normalizeNativeCodexCommand(state?.nativeCommand?.command);
    return {
      kind: 'native_slash',
      title: `Remote Codex ${command}`,
      command,
      attached: Boolean(state),
      active: true,
      content: String(content || '').trim(),
      message: String(content || '').trim() || 'Codex 没有返回可解析的页面内容。',
      session: state?.session?.status?.() || null,
      actions: buildNativeSlashPanelActions(command),
      fallbackText: String(content || '').trim()
    };
  }

  refreshSessionPhase(state, reason = 'refresh') {
    if (!state) return 'detached';
    const next = detectRemoteSessionPhase(state, this.getApprovalPrompt(state));
    if (state.phase !== next) {
      this.logger.event?.('remote.session.phase.changed', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        from: state.phase || '',
        to: next,
        reason,
        nativeCommand: state.nativeCommand?.command || ''
      });
      state.phase = next;
    }
    return next;
  }

  refreshVisualBusyState(state, reason = 'refresh') {
    if (!state?.turnStartedAt || state.lastReplyText || state.pendingReplyText) {
      return false;
    }
    if (state.session?.status?.().exited) return false;
    if (!isVisualTurnSettled(state) && !isStaleVisualBusyState(state)) {
      return false;
    }

    this.logger.event?.('remote.session.busy_state.cleared', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      reason,
      elapsedMs: Math.max(0, Date.now() - Number(state.turnStartedAt || 0)),
      lastInputText: clipForLog(state.lastInputText || '', 300)
    });
    state.turnStartedAt = 0;
    state.outputBuffer = '';
    this.clearStreamHeartbeat(state);
    this.refreshSessionPhase(state, 'busy_state_cleared');
    return true;
  }

  buildDebugState(session = null) {
    const state = session
      ? [...this.sessions.values()].find((candidate) => candidate.session?.id === session.id)
      : null;
    const targetSession = session || state?.session || null;
    const approval = state
      ? this.getApprovalPrompt(state)
      : extractApprovalPrompt(collectNativeVisualLines(
          targetSession?.visualViewportSnapshot || targetSession?.visualSnapshot || ''
        ));
    const phase = state
      ? this.refreshSessionPhase(state, 'debug_state')
      : detectVisualSessionPhase(targetSession, approval);
    const visualSnapshot = String(targetSession?.visualSnapshot || '');
    const visualViewportSnapshot = String(targetSession?.visualViewportSnapshot || '');
    const visualLines = collectNativeVisualLines(
      visualViewportSnapshot || visualSnapshot
    );

    return {
      at: new Date().toISOString(),
      phase,
      busy: state ? isVisualSessionBusy(state) : phase === 'working',
      hasRemoteState: Boolean(state),
      remote: state
        ? {
            key: state.key || '',
            pluginId: state.pluginId || '',
            conversationId: state.conversationId || '',
            shared: Boolean(state.shared),
            nativeCommand: state.nativeCommand?.command || '',
            turnStartedAt: state.turnStartedAt || 0,
            lastInputText: clipForLog(state.lastInputText || '', 500),
            lastReplyText: clipForLog(state.lastReplyText || '', 500),
            pendingReplyText: clipForLog(state.pendingReplyText || '', 500),
            outputBufferChars: String(state.outputBuffer || '').length,
            streamedThisTurn: Boolean(state.streamedThisTurn),
            streamFinishedForTurn: Boolean(state.streamFinishedForTurn)
          }
        : null,
      session: targetSession?.status?.() || null,
      detection: {
        visibleIdlePrompt: hasVisibleIdlePrompt(visualViewportSnapshot || visualSnapshot),
        activeVisualIndicators: hasActiveVisualIndicators(visualViewportSnapshot || visualSnapshot),
        visualTurnSettled: state ? isVisualTurnSettled(state) : false,
        approval: approval
          ? {
              status: approval.status || '',
              question: approval.question || '',
              options: approval.options || []
            }
          : null,
        visualLineCount: visualLines.length,
        visualSnapshotChars: visualSnapshot.length,
        visualViewportSnapshotChars: visualViewportSnapshot.length
      },
      text: {
        viewportTail: clipForLog(visualLines.slice(-14).join('\n'), 3000),
        lastOutputTail: clipForLog(readSessionOutputTail(targetSession), 3000)
      }
    };
  }

  beginNativePageAction(state, action) {
    if (!state?.nativeCommand) return;
    if (state.nativePageActionTimer) {
      clearTimeout(state.nativePageActionTimer);
      state.nativePageActionTimer = null;
    }
    const command = state.nativeCommand.command;
    state.nativePageAction = {
      action: String(action || '').toLowerCase(),
      command,
      requestedAt: Date.now(),
      checks: 0,
      beforeSignature: nativePageSnapshotSignature(state, command)
    };
    this.scheduleNativePageActionCheck(state, 80);
  }

  scheduleNativePageActionCheck(state, delayMs = 400) {
    if (!state?.nativePageAction) return;
    if (state.nativePageActionTimer) {
      clearTimeout(state.nativePageActionTimer);
    }
    state.nativePageActionTimer = setTimeout(() => {
      state.nativePageActionTimer = null;
      this.confirmNativePageActionIfReady(state, 'timer');
    }, Math.max(0, Number(delayMs) || 0));
    state.nativePageActionTimer.unref?.();
  }

  confirmNativePageActionIfReady(state, reason = 'check') {
    const pending = state?.nativePageAction;
    if (!pending || !state.nativeCommand) return false;
    if (state.nativeCommand.command !== pending.command) {
      state.nativePageAction = null;
      return false;
    }

    if (!isNativePageActionConfirmed(state, pending)) {
      pending.checks = (pending.checks || 0) + 1;
      if (Date.now() - pending.requestedAt < 12000) {
        this.scheduleNativePageActionCheck(
          state,
          pending.checks < 6 ? 160 : 800
        );
      }
      return false;
    }

    if (state.nativePageActionTimer) {
      clearTimeout(state.nativePageActionTimer);
      state.nativePageActionTimer = null;
    }
    const text = formatNativePageActionResult(pending, state);
    const hadStream = Boolean(state.replyStream);
    this.finishNativePageStream(state, text);
    if (typeof state.replyPanel === 'function') {
      const panel = {
        kind: 'native_slash',
        title: `Remote Codex ${normalizeNativeCodexCommand(pending.command)}`,
        command: normalizeNativeCodexCommand(pending.command),
        active: false,
        content: text,
        message: text,
        session: state.session?.status?.() || null,
        actions: [],
        fallbackText: text
      };
      this.safeReplyPanel(state, panel, text);
    }
    this.logger.event?.('remote.native_slash.action.confirmed', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      command: pending.command,
      action: pending.action,
      reason
    });
    state.nativePageAction = null;
    state.nativeCommand = null;
    state.turnStartedAt = 0;
    state.outputBuffer = '';
    this.refreshSessionPhase(state, `native_page_${pending.action}_confirmed`);
    return true;
  }

  finishNativePageStream(state, finalText = '') {
    const stream = state?.replyStream;
    if (!stream) return;

    const text = String(
      finalText ||
      state.lastStreamText ||
      state.lastReplyText ||
      this.formatRunningFallback(state)
    ).trim();
    this.clearStreamHeartbeat(state);
    if (state.streamFinishTimer) {
      clearTimeout(state.streamFinishTimer);
      state.streamFinishTimer = null;
    }
    state.replyStream = null;
    state.replyStreamStarting = false;
    state.streamFinishedForTurn = true;
    state.streamClosedText = text;
    state.lastSentReplyText = text;
    const updateFinal = finalText && typeof stream.replace === 'function'
      ? stream.replace(text)
      : finalText
        ? stream.update?.(text)
        : null;
    Promise.resolve(updateFinal)
      .catch((error) => {
        this.logger.warn?.('Remote native page stream final update failed:', error.message);
      })
      .then(() => stream.finish(text))
      .catch((error) => {
        this.logger.warn?.('Remote native page stream finish failed:', error.message);
      });
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
    if (state.nativePageExitTimer) {
      clearTimeout(state.nativePageExitTimer);
      state.nativePageExitTimer = null;
    }
    if (state.nativePageActionTimer) {
      clearTimeout(state.nativePageActionTimer);
      state.nativePageActionTimer = null;
    }
    this.clearStreamHeartbeat(state);
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
    state.lastReplySignature = '';
    state.lastStreamSignature = '';
    state.lastSentReplySignature = '';
    state.pendingReplyText = '';
    state.controlActionLocks = new Map();
    state.streamedThisTurn = false;
    state.streamFinishedForTurn = false;
    state.streamClosedText = '';
    state.nativePanelUpdateRequested = false;
    state.lastApprovalSignature = '';
    state.nativeCommand = null;
    state.nativePageAction = null;
    state.phase = 'idle';
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
    if (state.nativePageExitTimer) {
      clearTimeout(state.nativePageExitTimer);
      state.nativePageExitTimer = null;
    }
    if (state.nativePageActionTimer) {
      clearTimeout(state.nativePageActionTimer);
      state.nativePageActionTimer = null;
    }
    this.clearStreamHeartbeat(state);
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
      '/stop - interrupt the current task and keep Codex running',
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
    if (isLikelyProgressMarkerText(after)) {
      continue;
    }
    return match.index;
  }
  return -1;
}

function isLikelyProgressMarkerText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (RUNNING_STATUS_PATTERN.test(value)) return true;
  if (ACTIVITY_LINE_PATTERN.test(value)) return true;
  if (isProgressWarning(value)) return true;
  return false;
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
  let skippingProgressContinuation = false;

  for (const rawLine of lines) {
    const value = rawLine.trimEnd();
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (BOX_ONLY_PATTERN.test(trimmed)) continue;
    if (skippingProgressContinuation) {
      if (/^\s{2,}\S/.test(value)) {
        continue;
      }
      skippingProgressContinuation = false;
    }
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
    const progressEntry = normalizeProgressEntry(trimmed);
    if (progressEntry.isBullet && isLikelyProgressMarkerText(progressEntry.value)) {
      skippingProgressContinuation = true;
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
  const records = getSnapshotLineRecords(snapshot)
    .filter((record) => record.text.trim())
    .filter((record) => !BOX_ONLY_PATTERN.test(record.text.trim()));
  const lines = records.map((record) => record.text);
  const promptIndex = findLastSubmittedPrompt(lines, input);
  if (input && promptIndex < 0) return '';
  const afterPrompt = promptIndex >= 0 ? records.slice(promptIndex + 1) : records;
  return renderCodexProgressState(
    parseCodexProgressState(afterPrompt, {
      includeUnstructuredNotes: true,
      ...options
    }),
    options
  );
}

function classifyVisualTurnOutput(snapshot, inputText = '', options = {}) {
  const input = normalizeComparableText(inputText);
  const records = getSnapshotLineRecords(snapshot)
    .filter((record) => record.text.trim())
    .filter((record) => !BOX_ONLY_PATTERN.test(record.text.trim()));
  const lines = records.map((record) => record.text);
  const promptIndex = findLastSubmittedPrompt(lines, input);
  if (input && promptIndex < 0) return emptyTurnOutputClassification();

  const afterPrompt = promptIndex >= 0 ? records.slice(promptIndex + 1) : records;
  const approval = extractApprovalPrompt(afterPrompt.map((record) => record.text));
  const entries = afterPrompt
    .map((record) => normalizeProgressEntry(record))
    .filter((entry) => entry.value)
    .filter((entry) => isProgressWarning(entry.value) || !isProgressNoiseLine(entry.value));
  const hasRunningStatus = entries.some((entry) => RUNNING_STATUS_PATTERN.test(entry.value));
  const hasStructuredProgress = entries.some((entry) =>
    isStructuredProgressEntry(entry)
  );
  const visualText = lines.join('\n');
  const finalText =
    extractClassifiedVisualFinalAnswer(afterPrompt, { active: hasRunningStatus }) ||
    formatVisualSnapshot(visualText, inputText);
  const finalComparable = normalizeComparableText(finalText);
  const classified = emptyTurnOutputClassification();
  classified.approval = approval;
  classified.finalText = finalText;

  let currentActivity = null;
  for (const entry of entries) {
    if (isClassifiedFinalDuplicate(entry.value, finalComparable)) continue;

    if (isProgressWarning(entry.value)) {
      pushUniqueString(classified.warnings, formatProgressWarning(entry.value));
      currentActivity = null;
      continue;
    }

    if (RUNNING_STATUS_PATTERN.test(entry.value)) {
      const status = normalizeRunningStatus(entry.value);
      if (/^(?:Working|Thinking)\b/i.test(status)) {
        classified.status = {
          text: status,
          colorRole: entry.colorRole || '',
          terminalColor: entry.terminalColor || ''
        };
        currentActivity = null;
      } else {
        currentActivity = addClassifiedActivity(classified, entry);
      }
      continue;
    }

    if (ACTIVITY_LINE_PATTERN.test(entry.value)) {
      currentActivity = addClassifiedActivity(classified, entry);
      pushUniqueString(classified.technical, entry.value);
      continue;
    }

    if (currentActivity && isProgressDetailEntry(entry)) {
      pushUniqueString(classified.technical, normalizeProgressDetail(entry.value));
      continue;
    }

    if (currentActivity && entry.isIndented && isUsefulProgressNote(entry.value)) {
      pushUniqueString(classified.explanations, normalizeProgressDetail(entry.value));
      continue;
    }

    if (
      entry.isBullet &&
      (hasStructuredProgress || hasRunningStatus) &&
      isUsefulProgressNote(entry.value)
    ) {
      pushUniqueString(classified.explanations, entry.value);
      currentActivity = null;
      continue;
    }

    if (
      options.includeUnstructuredNotes !== false &&
      hasRunningStatus &&
      !entry.isBullet &&
      !entry.isIndented &&
      isUsefulProgressNote(entry.value)
    ) {
      pushUniqueString(classified.explanations, entry.value);
      currentActivity = null;
      continue;
    }

    if (isTechnicalProgressLine(entry.value)) {
      pushUniqueString(classified.technical, entry.value);
    }
  }

  return classified;
}

function formatClassifiedVisualTurnStream(snapshot, inputText = '', options = {}) {
  const classified = classifyVisualTurnOutput(snapshot, inputText, options);
  return renderClassifiedTurnStream(classified, options);
}

function renderClassifiedTurnStream(classified, options = {}) {
  if (!classified) return '';
  const progressLines = [];
  const warningLines = [];
  const finalText = String(options.finalText || '').trim();

  if (classified.status?.text) {
    const color =
      classified.status.terminalColor ||
      TERMINAL_ROLE_COLORS.running;
    progressLines.push(`- ${withRemoteCodexColorMarker(classified.status.text, color, options)}`);
  }

  for (const explanation of classified.explanations || []) {
    progressLines.push(`- ${withRemoteCodexColorMarker(explanation, TERMINAL_ROLE_COLORS.info, options)}`);
  }

  const seenActivitySummaries = new Set();
  for (const activity of classified.activities || []) {
    const summary = String(activity.summary || '').trim();
    if (!summary || seenActivitySummaries.has(summary)) continue;
    seenActivitySummaries.add(summary);
    progressLines.push(`- ${withRemoteCodexColorMarker(summary, classifiedActivityColor(activity), options)}`);
  }

  for (const warning of classified.warnings || []) {
    warningLines.push(`- ${withRemoteCodexColorMarker(warning, TERMINAL_ROLE_COLORS.warning, options)}`);
  }

  const sections = [];
  if (warningLines.length > 0) {
    sections.push(['**警告**', ...warningLines].join('\n'));
  }
  if (progressLines.length > 0) {
    sections.push(['**进度**', ...progressLines].join('\n'));
  }
  if (finalText) {
    sections.push(`**回复**\n${finalText}`);
  }
  return sections.join('\n\n').trim();
}

function classifiedActivityColor(activity) {
  if (activity?.terminalColor) return activity.terminalColor;
  if (activity?.colorRole && TERMINAL_ROLE_COLORS[activity.colorRole]) {
    return TERMINAL_ROLE_COLORS[activity.colorRole];
  }
  return {
    inspect: TERMINAL_ROLE_COLORS.command,
    edit: TERMINAL_ROLE_COLORS.success,
    verify: TERMINAL_ROLE_COLORS.command,
    running: TERMINAL_ROLE_COLORS.running
  }[activity?.kind] || TERMINAL_ROLE_COLORS.info;
}

function emptyTurnOutputClassification() {
  return {
    kind: 'turn',
    status: null,
    explanations: [],
    activities: [],
    technical: [],
    warnings: [],
    approval: null,
    finalText: ''
  };
}

function isClassifiedFinalDuplicate(value, finalComparable) {
  if (!finalComparable) return false;
  const comparable = normalizeComparableText(value);
  return Boolean(comparable && finalComparable.includes(comparable));
}

function extractClassifiedVisualFinalAnswer(records, options = {}) {
  if (!options.active) return '';
  const lines = records.map((record) => normalizeSnapshotLineRecord(record).text);
  const startIndex = findLastVisualAnswerStartIndex(lines);
  if (startIndex < 0) return '';

  const answer = [];
  let inCodeBlock = false;
  for (const line of lines.slice(startIndex)) {
    const value = line.trim();
    if (!value) continue;
    if (answer.length > 0 && isLikelyPromptOrStatus(value)) break;
    if (isVisualNoiseLine(value, '')) continue;

    const markerIndex = findAnswerMarkerIndex(line);
    if (markerIndex >= 0) {
      const text = line
        .slice(markerIndex)
        .replace(FINAL_PREFIX_PATTERN, '')
        .trimEnd();
      if (text) answer.push(text);
    } else {
      appendVisualAnswerLine(answer, line, { inCodeBlock });
    }
    if (/^```/.test(value)) inCodeBlock = !inCodeBlock;
  }

  return normalizeCleanedText(answer.join('\n'));
}

function findLastVisualAnswerStartIndex(lines) {
  const lastStructuredIndex = lines.findLastIndex((line) => {
    const entry = normalizeProgressEntry(line);
    return isStructuredProgressEntry(entry);
  });
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (index <= lastStructuredIndex) return -1;
    const value = String(lines[index] || '').trim();
    if (!value || isLikelyPromptOrStatus(value) || isVisualNoiseLine(value, '')) continue;
    const markerIndex = findAnswerMarkerIndex(lines[index]);
    if (markerIndex < 0) continue;
    const text = lines[index]
      .slice(markerIndex)
      .replace(FINAL_PREFIX_PATTERN, '')
      .trim();
    if (!text || isLikelyProgressMarkerText(text)) continue;
    return index;
  }
  return -1;
}

function addClassifiedActivity(classified, entry) {
  const activity = {
    kind: classifyProgressActivityKind(entry.value),
    summary: formatProgressActivity(entry.value),
    text: entry.value,
    colorRole: entry.colorRole || '',
    terminalColor: entry.terminalColor || ''
  };
  const signature = `${activity.kind}:${activity.summary}:${activity.text}`;
  if (!classified.activities.some((item) => `${item.kind}:${item.summary}:${item.text}` === signature)) {
    classified.activities.push(activity);
  }
  return activity;
}

function classifyProgressActivityKind(value) {
  const text = String(value || '').trim();
  if (/^(?:Ran|Checked)\b/i.test(text)) return 'verify';
  if (/^(?:Edited|Updated|Added|Removed|Created|Deleted|Applied|Wrote)\b/i.test(text)) {
    return 'edit';
  }
  if (/^(?:Explored|Read|Opened|Searched|Found|Listed|Viewed)\b/i.test(text)) {
    return 'inspect';
  }
  if (RUNNING_STATUS_PATTERN.test(text)) return 'running';
  return 'other';
}

function pushUniqueString(list, value) {
  const text = String(value || '').trim();
  if (!text || list.includes(text)) return;
  list.push(text);
}

function isTechnicalProgressLine(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^\$\s+/.test(text)) return true;
  if (/^(?:└|├|│)\s+/.test(text)) return true;
  if (/\b(?:src|scripts|test|tests|lib|app)\/[\w./-]+/.test(text)) return true;
  if (/\b(?:npm|node|git|rg|sed|cat|python|pytest)\b/.test(text)) return true;
  return false;
}

function getSnapshotLineRecords(snapshot) {
  if (!snapshot) return [];

  if (Array.isArray(snapshot)) {
    return snapshot.map(normalizeSnapshotLineRecord).filter(Boolean);
  }

  if (typeof snapshot === 'object' && Array.isArray(snapshot.lines)) {
    return snapshot.lines.map(normalizeSnapshotLineRecord).filter(Boolean);
  }

  return String(snapshot || '')
    .split('\n')
    .map((line) => normalizeSnapshotLineRecord(line))
    .filter(Boolean);
}

function normalizeSnapshotLineRecord(line) {
  if (line && typeof line === 'object') {
    return {
      text: String(line.text || '').trimEnd(),
      firstChar: String(line.firstChar || ''),
      firstStyle: normalizeTerminalStyle(line.firstStyle),
      bulletStyle: normalizeTerminalStyle(line.bulletStyle)
    };
  }

  return {
    text: String(line || '').trimEnd(),
    firstChar: '',
    firstStyle: null,
    bulletStyle: null
  };
}

function getSnapshotTextLines(snapshot) {
  return getSnapshotLineRecords(snapshot).map((record) => record.text);
}

function formatNativeSlashOutput({ snapshot, raw, command, inputText, colorMarkers = false } = {}) {
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
    return formatStatusSlashOutput(lines, inputText, { colorMarkers });
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
      footer: '点击卡片里的上移/下移/恢复，或发送 `/up`、`/down`、`/enter`。'
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
  const disabled = findNativeSlashDisabledMessage(lines, '/permissions');
  if (disabled) {
    return ['**/permissions**', `- ${disabled}`, '', '当前 Codex 还在处理任务；等任务结束后再调整权限。'].join('\n');
  }

  const options = extractPermissionsPickerOptions(lines);
  if (options.length === 3) {
    return renderPermissionsPickerPage(options);
  }

  return formatPermissionsLoadingText();
}

function extractPermissionsPickerOptions(lines) {
  const titleIndex = lines.findLastIndex((rawLine) =>
    /^Update Model Permissions$/i.test(normalizeNativeLine(rawLine))
  );
  if (titleIndex < 0) return [];

  const options = extractPickerOptions(lines.slice(titleIndex + 1))
    .filter((option) => option.index >= 1 && option.index <= 3)
    .map(normalizePermissionsPickerOption)
    .filter(Boolean);
  const expectedNames = ['Default', 'Auto-review', 'Full Access'];
  if (
    options.length !== expectedNames.length ||
    options.some((option, index) =>
      option.index !== index + 1 ||
      !option.text.toLowerCase().startsWith(expectedNames[index].toLowerCase())
    )
  ) {
    return [];
  }
  return options;
}

function normalizePermissionsPickerOption(option) {
  const match = String(option?.text || '').match(
    /^(Default(?:\s+\(current\))?|Auto-review|Full Access)(?=\s|$)\s*(.*)$/i
  );
  if (!match) return null;
  const details = [...(option.details || [])];
  if (match[2]) details.unshift(match[2]);
  return {
    ...option,
    text: match[1],
    details
  };
}

function renderPermissionsPickerPage(options) {
  const selected = options.find((option) => option.selected);
  const lines = [
    '**权限模式**',
    `- 当前模式: \`${selected ? selected.text.replace(/\s*\(current\)\s*/i, '') : '未标记'}\``,
    '- 点击下方模式按钮会立即应用，不需要再确认。',
    '',
    '**模式**'
  ];
  for (const option of options) {
    const prefix = option.selected ? '>' : '-';
    lines.push(`${prefix} ${option.index}. ${option.text}`);
    for (const detail of option.details.slice(0, 1)) {
      lines.push(`  ${detail}`);
    }
  }
  return lines.join('\n');
}

function formatPermissionsLoadingText() {
  return [
    '**权限模式**',
    '- 正在读取当前权限模式。',
    '- 可直接选择 Default、Auto-review 或 Full Access。'
  ].join('\n');
}

function formatStatusSlashOutput(lines, inputText = '', options = {}) {
  const normalized = lines
    .map((line) => normalizeNativeLine(line))
    .filter(Boolean);
  const panelStart = normalized.findLastIndex((line) =>
    /^>_\s+OpenAI Codex/i.test(line)
  );
  const panelLines = panelStart >= 0 ? normalized.slice(panelStart) : normalized;
  const useful = selectUsefulNativeLines(panelLines, '/status', inputText)
    .filter((line) => !/^Tip:/i.test(line))
    .filter((line) => !/^Visit\s+https?:\/\/chatgpt\.com\/codex\/settings\/usage\b/i.test(line))
    .filter((line) => !/^information on rate limits and credits\b/i.test(line))
    .filter((line) => !/^model:\s+.*\/model to change/i.test(line))
    .filter((line) => !/^directory:\s+~/i.test(line) || /^Directory:/i.test(line));

  if (useful.length === 0) return '';
  const status = parseCodexStatusLines(useful);
  if (status.hasStructuredData) {
    return renderCodexStatusPanel(status, options);
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

function renderCodexStatusPanel(status, options = {}) {
  const lines = ['**Codex 状态**'];
  if (status.version) lines.push(`- 版本: \`${status.version}\``);

  if (status.usage.length > 0) {
    lines.push('', '**剩余用量**');
    for (const usage of status.usage) {
      const remaining = Number.isFinite(usage.percentLeft)
        ? `${usage.percentLeft}% 剩余`
        : usage.text;
      const reset = usage.reset ? `，重置 ${usage.reset.replace(/^resets\s*/i, '')}` : '';
      const level = getUsageLevel(usage.percentLeft);
      lines.push(withRemoteCodexLineColorMarker(
        `- ${usage.label}: ${level.label} ${remaining}${reset}`,
        level.color,
        options
      ));
      if (usage.bar) {
        lines.push(withRemoteCodexColorMarker(`  ${usage.bar}`, level.color, options));
      }
    }
  } else if (hasUsefulStatusFields(status)) {
    lines.push(
      '',
      '**用量提示**',
      withRemoteCodexLineColorMarker(
        '- 本次 `/status` 没有返回剩余用量信息；可以稍后重新发送 `/status` 重试。',
        TERMINAL_ROLE_COLORS.info,
        options
      )
    );
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

function hasUsefulStatusFields(status) {
  return Boolean(
    status?.fields?.model?.value ||
      status?.fields?.permissions?.value ||
      status?.fields?.directory?.value ||
      status?.fields?.session?.value
  );
}

function getUsageLevel(percentLeft) {
  if (!Number.isFinite(percentLeft)) {
    return { label: '用量信息', color: TERMINAL_ROLE_COLORS.info };
  }
  if (percentLeft <= 25) {
    return { label: '余量紧张', color: TERMINAL_ROLE_COLORS.error };
  }
  if (percentLeft <= 60) {
    return { label: '余量适中', color: TERMINAL_ROLE_COLORS.warning };
  }
  return { label: '余量充足', color: TERMINAL_ROLE_COLORS.success };
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
  if (/^(?:enter resume|esc exit)\b/i.test(value)) return true;
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
  return renderCodexProgressState(parseCodexProgressState(lines, options), options);
}

function parseCodexProgressState(lines, options = {}) {
  const records = Array.isArray(lines)
    ? lines.map(normalizeSnapshotLineRecord).filter(Boolean)
    : getSnapshotLineRecords(lines);
  const textLines = records.map((record) => record.text);
  const approvalPrompt = extractApprovalPrompt(textLines);
  if (approvalPrompt) {
    return {
      kind: 'approval',
      approval: approvalPrompt
    };
  }

  const state = {
    kind: 'progress',
    status: '',
    statusColorRole: '',
    statusTerminalColor: '',
    items: []
  };
  const finalComparable = normalizeComparableText(options.finalText || '');
  const entries = records
    .map((record) => normalizeProgressEntry(record))
    .filter((entry) => entry.value)
    .filter((entry) => isProgressWarning(entry.value) || !isProgressNoiseLine(entry.value))
    .filter((entry) => !isProgressFinalDuplicate(entry.value, finalComparable));
  const hasRunningStatus = entries.some((entry) => RUNNING_STATUS_PATTERN.test(entry.value));
  const hasStructuredProgress = entries.some((entry) =>
    isStructuredProgressEntry(entry)
  );
  let current = null;

  for (const entry of entries) {
    if (isProgressWarning(entry.value)) {
      current = addProgressItem(
        state,
        'warning',
        formatProgressWarning(entry.value),
        entry
      );
      continue;
    }

    if (RUNNING_STATUS_PATTERN.test(entry.value)) {
      const status = normalizeRunningStatus(entry.value);
      if (/^(?:Working|Thinking)\b/i.test(status)) {
        state.status = status;
        state.statusColorRole = entry.colorRole;
        state.statusTerminalColor = entry.terminalColor;
        current = null;
      } else {
        current = addProgressItem(state, 'running', status, entry);
      }
      continue;
    }

    if (ACTIVITY_LINE_PATTERN.test(entry.value)) {
      current = addProgressItem(
        state,
        'activity',
        formatProgressActivity(entry.value),
        entry,
        { allowDetails: false }
      );
      continue;
    }

    if (current && isProgressDetailEntry(entry)) {
      addProgressDetail(current, normalizeProgressDetail(entry.value));
      continue;
    }

    if (current && entry.isIndented && isUsefulProgressNote(entry.value)) {
      addProgressDetail(current, normalizeProgressDetail(entry.value));
      continue;
    }

    if (
      entry.isBullet &&
      (hasStructuredProgress || hasRunningStatus) &&
      isUsefulProgressNote(entry.value)
    ) {
      current = addProgressItem(state, 'note', entry.value, entry);
      continue;
    }

    if (
      options.includeUnstructuredNotes &&
      hasRunningStatus &&
      !entry.isBullet &&
      !entry.isIndented &&
      isUsefulProgressNote(entry.value)
    ) {
      current = addProgressItem(state, 'note', entry.value, entry);
    }
  }

  state.items = limitProgressItems(compactProgressItems(state.items));
  return state;
}

function isStructuredProgressEntry(entry) {
  if (!entry?.value) return false;
  return (
    isProgressWarning(entry.value) ||
    RUNNING_STATUS_PATTERN.test(entry.value) ||
    ACTIVITY_LINE_PATTERN.test(entry.value)
  );
}

function renderCodexProgressState(state, options = {}) {
  if (!state) return '';
  if (state.kind === 'approval') {
    return formatApprovalPrompt(state.approval);
  }

  const items = [];
  if (state.status) {
    items.push({
      type: 'status',
      text: state.status,
      details: [],
      colorRole: state.statusColorRole || '',
      terminalColor: state.statusTerminalColor || ''
    });
  }
  items.push(...(state.items || []));
  if (items.length === 0) return '';

  return [
    '**进度**',
    ...items.flatMap((item) => formatProgressItem(item, options))
  ].join('\n');
}

function normalizeProgressEntry(line) {
  const record = line && typeof line === 'object' ? normalizeSnapshotLineRecord(line) : null;
  const raw = String(record?.text ?? line ?? '').trimEnd();
  const trimmed = raw.trim();
  const bulletMatch = trimmed.match(/^([•●◦○■])\s*(.*)$/);
  const bulletStyle = record?.bulletStyle || null;
  const firstStyle = record?.firstStyle || null;
  const terminalStyle = bulletStyle || firstStyle;
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
    isTree: /^[└├│]\s*/.test(value),
    firstStyle,
    bulletStyle,
    colorRole: classifyTerminalColorRole(terminalStyle),
    terminalColor: terminalStyleToRgbaColor(terminalStyle)
  };
}

function normalizeTerminalStyle(style) {
  if (!style || typeof style !== 'object') return null;
  return {
    fgMode: normalizeTerminalColorMode(style.fgMode),
    fg: normalizeFiniteNumber(style.fg),
    bgMode: normalizeTerminalColorMode(style.bgMode),
    bg: normalizeFiniteNumber(style.bg),
    bold: Boolean(style.bold),
    dim: Boolean(style.dim),
    italic: Boolean(style.italic)
  };
}

function normalizeTerminalColorMode(mode) {
  return mode === 'rgb' || mode === 'palette' ? mode : 'default';
}

function normalizeFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function classifyTerminalColorRole(style) {
  if (!style) return '';

  const normalized = normalizeTerminalStyle(style);
  if (!normalized) return '';
  if (normalized.fgMode === 'palette') {
    return classifyPaletteColorRole(normalized.fg, normalized);
  }
  if (normalized.fgMode === 'rgb') {
    return classifyRgbColorRole(normalized.fg, normalized);
  }
  if (normalized.dim) return 'muted';
  if (normalized.bold) return 'emphasis';
  return '';
}

function terminalStyleToRgbaColor(style) {
  if (!style) return '';

  const normalized = normalizeTerminalStyle(style);
  if (!normalized) return '';
  if (normalized.fgMode === 'palette') {
    return paletteColorToRgba(normalized.fg);
  }
  if (normalized.fgMode === 'rgb') {
    return rgbNumberToRgba(normalized.fg);
  }
  if (normalized.dim) return TERMINAL_ROLE_COLORS.muted;
  return '';
}

function paletteColorToRgba(color) {
  const rgb = TERMINAL_THEME_PALETTE[Number(color)];
  return rgb ? rgbArrayToRgba(rgb) : '';
}

function rgbNumberToRgba(color) {
  const value = Number(color);
  if (!Number.isFinite(value)) return '';
  return rgbArrayToRgba([
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff
  ]);
}

function rgbArrayToRgba(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return '';
  const [red, green, blue] = rgb.map((value) =>
    Math.max(0, Math.min(255, Number(value) || 0))
  );
  return `rgba(${red},${green},${blue},1)`;
}

function classifyPaletteColorRole(color, style = {}) {
  const index = Number(color);
  if ([1, 9].includes(index)) return 'error';
  if ([2, 10].includes(index)) return 'success';
  if ([3, 11].includes(index)) return 'warning';
  if ([4, 12].includes(index)) return 'command';
  if ([5, 6, 13, 14].includes(index)) return 'info';
  if (index === 8 || style.dim) return 'muted';
  if (style.bold) return 'emphasis';
  return '';
}

function classifyRgbColorRole(color, style = {}) {
  const value = Number(color);
  if (!Number.isFinite(value)) return '';

  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);

  if (style.dim || (max - min <= 24 && max < 170)) return 'muted';
  if (red >= 180 && green < 150 && blue < 160) return 'error';
  if (green >= 150 && red < 190 && blue < 180) return 'success';
  if (red >= 180 && green >= 150 && blue < 150) return 'warning';
  if (blue >= 170 && red < 180 && green < 200) return 'command';
  if ((green >= 170 && blue >= 170) || (red >= 150 && blue >= 150)) return 'info';
  if (style.bold) return 'emphasis';
  return '';
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

function formatProgressItem(item, options = {}) {
  const text = typeof item === 'string' ? item : item?.text;
  const details = typeof item === 'string' ? [] : item?.details || [];
  const color = progressItemColor(item);
  const lines = [`- ${withRemoteCodexColorMarker(text, color, options)}`];
  for (const detail of details) {
    lines.push(`  ${withRemoteCodexColorMarker(detail, TERMINAL_ROLE_COLORS.muted, options)}`);
  }
  return lines;
}

function withRemoteCodexColorMarker(text, color, options = {}) {
  const value = String(text || '').trim();
  if (!options.colorMarkers || !color) return value;
  return `${REMOTE_CODEX_COLOR_MARKER_PREFIX}${color}${REMOTE_CODEX_COLOR_MARKER_SUFFIX}${value}`;
}

function withRemoteCodexLineColorMarker(line, color, options = {}) {
  const value = String(line || '').trimEnd();
  if (!options.colorMarkers || !color) return value;
  const match = value.match(/^(\s*-\s+)([\s\S]*)$/);
  if (match) {
    return `${match[1]}${withRemoteCodexColorMarker(match[2], color, options)}`;
  }
  return withRemoteCodexColorMarker(value, color, options);
}

function stripRemoteCodexColorMarkers(text) {
  return String(text || '').replace(/<!--remote-codex-color:[^>]+-->/g, '');
}

function remoteMessageSignature(text) {
  const value = stripRemoteCodexColorMarkers(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!value) return '';

  if (/^\*\*Codex 状态\*\*/.test(value)) {
    return `status:${value
      .replace(/\[[█░\s]+\]/g, '[bar]')
      .replace(/[ \t\n]+/g, ' ')
      .trim()}`;
  }

  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function isWorkingStatusLine(line) {
  const value = stripRemoteCodexColorMarkers(line).trim();
  return /^-\s+(?:Working|Codex 正在处理)\s+\(\d+s\)\s*$/.test(value);
}

function progressItemColor(item) {
  if (!item || typeof item === 'string') return '';
  if (item.terminalColor) return item.terminalColor;
  if (item.colorRole && TERMINAL_ROLE_COLORS[item.colorRole]) {
    return TERMINAL_ROLE_COLORS[item.colorRole];
  }
  if (item.type === 'status' || item.type === 'running') {
    return TERMINAL_ROLE_COLORS.running;
  }
  if (item.type === 'warning') return TERMINAL_ROLE_COLORS.warning;
  if (item.type === 'activity') return TERMINAL_ROLE_COLORS.command;
  return '';
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

function formatProgressActivity(value) {
  const text = String(value || '').trim();
  if (/^(?:Ran|Checked)\b/i.test(text)) return '正在验证';
  if (/^(?:Edited|Updated|Added|Removed|Created|Deleted|Applied|Wrote)\b/i.test(text)) {
    return '正在修改';
  }
  if (/^(?:Explored|Read|Opened|Searched|Found|Listed|Viewed)\b/i.test(text)) {
    return '正在检查代码';
  }
  return '正在处理';
}

function addProgressItem(state, type, text, entry = null, options = {}) {
  const value = String(text || '').trim();
  if (!value) return null;
  const colorRole = entry?.colorRole || '';
  const terminalColor = entry?.terminalColor || '';
  const allowDetails = options.allowDetails !== false;
  const previous = state.items[state.items.length - 1];
  if (
    previous &&
    previous.type === type &&
    previous.text === value &&
    previous.colorRole === colorRole &&
    previous.terminalColor === terminalColor &&
    previous.allowDetails === allowDetails
  ) {
    return previous;
  }
  const item = {
    type,
    text: value,
    details: [],
    colorRole,
    terminalColor,
    allowDetails
  };
  state.items.push(item);
  return item;
}

function addProgressDetail(item, detail) {
  if (!item || !detail) return;
  if (item.allowDetails === false) return;
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

function limitProgressItems(items, limit = PROGRESS_ITEM_LIMIT) {
  const safeLimit = Math.max(1, Number(limit) || PROGRESS_ITEM_LIMIT);
  if (items.length <= safeLimit) return items;

  const keepIndexes = new Set();
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].type === 'note') keepIndexes.add(index);
  }

  for (
    let index = items.length - 1;
    keepIndexes.size < safeLimit && index >= 0;
    index -= 1
  ) {
    keepIndexes.add(index);
  }

  return items
    .filter((_item, index) => keepIndexes.has(index))
    .slice(-safeLimit);
}

function progressItemSignature(item) {
  return `${item.type}:${item.colorRole || ''}:${item.terminalColor || ''}:${item.text}:${(item.details || []).join('|')}`;
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
    .map(parseApprovalOptionLine)
    .filter(Boolean);

  return {
    status: statusLine ? normalizeProgressLine(statusLine) : '',
    question,
    reason,
    command: commandLine.replace(/^\$\s+/, '').trim(),
    options
  };
}

function parseApprovalOptionLine(line) {
  const value = String(line || '').trim();
  const match = value.match(/^([>›❯]?\s*)?(\d+)[.)]\s+(.+)$/);
  if (!match) return null;
  return {
    selected: /[>›❯]/.test(match[1] || ''),
    index: Number(match[2]),
    text: match[3].trim()
  };
}

function normalizeApprovalOption(option) {
  if (option && typeof option === 'object') {
    return {
      selected: Boolean(option.selected),
      index: Number(option.index) || 0,
      text: String(option.text || '').trim()
    };
  }

  const parsed = parseApprovalOptionLine(option);
  if (parsed) return parsed;
  return {
    selected: false,
    index: 0,
    text: String(option || '').replace(/^\d+[.)]\s*/, '').trim()
  };
}

function formatApprovalOptionSignature(option) {
  const normalized = normalizeApprovalOption(option);
  return `${normalized.selected ? '>' : '-'}${normalized.index}:${normalized.text}`;
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
      const parsed = normalizeApprovalOption(option);
      const prefix = parsed.selected ? '>' : '-';
      lines.push(`${prefix} ${parsed.index}. ${parsed.text}`);
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
  lines.push(`状态: ${formatRemoteSessionPhase(payload.phase)}`);
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
    if (payload.approval.options?.length > 0) {
      lines.push('', '选项:');
      for (const option of payload.approval.options) {
        const parsed = normalizeApprovalOption(option);
        const prefix = parsed.selected ? '>' : '-';
        const index = parsed.index ? `${parsed.index}. ` : '';
        lines.push(`${prefix} ${index}${parsed.text}`.trimEnd());
      }
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
    '/stop - 中断当前任务，保留 Codex 会话',
    '/remote-status - 查看 Remote Codex 自身状态'
  ].join('\n');
}

function formatRemoteSessionPhase(phase) {
  return {
    detached: '未接入',
    exited: '已退出',
    idle: '等待命令',
    working: '正在处理',
    loading_plugins: '正在加载插件',
    awaiting_authorization: '等待授权',
    native_resume: '历史会话选择',
    native_permissions: '权限模式选择',
    native_status: 'Codex 状态页',
    native_page: 'Codex 特殊页面'
  }[String(phase || '')] || String(phase || '未知');
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
  if (isVisualTurnSettled(state) || isStaleVisualBusyState(state)) return false;
  return true;
}

function detectRemoteSessionPhase(state, approval = null) {
  if (!state?.session) return 'detached';
  if (state.session.status?.().exited) return 'exited';
  if (approval) return 'awaiting_authorization';

  const command = state.nativeCommand?.command
    ? normalizeNativeCodexCommand(state.nativeCommand.command)
    : '';
  if (command === '/resume') return 'native_resume';
  if (command === '/permissions') return 'native_permissions';
  if (command === '/status') return 'native_status';
  if (command) return 'native_page';

  const snapshot = String(
    state.session.visualViewportSnapshot ||
      state.session.visualSnapshot ||
      ''
  );
  if (/(?:Booting MCP server|MCP startup|Starting MCP)/i.test(snapshot)) {
    return 'loading_plugins';
  }
  if (state.turnStartedAt && !state.lastReplyText && !state.pendingReplyText) {
    return 'working';
  }
  return 'idle';
}

function detectVisualSessionPhase(session, approval = null) {
  if (!session) return 'detached';
  if (session.status?.().exited) return 'exited';
  if (approval) return 'awaiting_authorization';

  const snapshot = String(
    session.visualViewportSnapshot ||
      session.visualSnapshot ||
      ''
  );
  if (/(?:Booting MCP server|MCP startup|Starting MCP)/i.test(snapshot)) {
    return 'loading_plugins';
  }
  if (hasActiveVisualIndicators(snapshot)) return 'working';
  if (hasVisibleIdlePrompt(snapshot)) return 'idle';
  return 'idle';
}

function isVisualTurnSettled(state) {
  if (!state?.session) return false;
  const snapshot = state.session.visualSnapshot || state.session.visualViewportSnapshot || '';
  if (hasVisibleIdlePrompt(snapshot) && !hasActiveVisualIndicators(snapshot)) {
    return true;
  }
  return hasIdlePromptAfterSubmittedPrompt(snapshot, state.lastInputText);
}

function isStaleVisualBusyState(state) {
  if (!state?.turnStartedAt || !state?.session) return false;
  const elapsedMs = Date.now() - Number(state.turnStartedAt || 0);
  if (elapsedMs < VISUAL_BUSY_STALE_MS) return false;
  const snapshot = state.session.visualSnapshot || state.session.visualViewportSnapshot || '';
  return hasVisibleIdlePrompt(snapshot) && !hasActiveVisualIndicators(snapshot);
}

function hasVisibleIdlePrompt(snapshot) {
  return getSnapshotTextLines(snapshot)
    .map((line) => line.trim())
    .some((line) => /^›\s*$/.test(line));
}

function hasActiveVisualIndicators(snapshot) {
  return getSnapshotTextLines(snapshot)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) =>
      RUNNING_STATUS_PATTERN.test(line) ||
      /^-\s+(?:Working|Thinking|Running)\b/i.test(line) ||
      SPINNER_PATTERN.test(line) ||
      isApprovalQuestionLine(line) ||
      /^Running shell command\b/i.test(line) ||
      /^Would you like to\b/i.test(line) ||
      /^Do you want to\b/i.test(line)
    );
}

function hasIdlePromptAfterSubmittedPrompt(snapshot, inputText = '') {
  const input = normalizeComparableText(inputText);
  const lines = getSnapshotTextLines(snapshot)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const promptIndex = findLastSubmittedPrompt(lines, input);
  if (input && promptIndex < 0) return false;

  const afterPrompt = promptIndex >= 0 ? lines.slice(promptIndex + 1) : lines;
  return afterPrompt.some((line) => /^›\s*$/.test(line.trim()));
}

function readSessionOutputTail(session, limit = 80) {
  if (!session?.readAfter) return '';
  try {
    const cursor = Math.max(0, Number(session.cursor || 0) - limit);
    return session
      .readAfter(cursor)
      .chunks.map((chunk) => chunk.data)
      .join('');
  } catch {
    return '';
  }
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

function parsePermissionModeCommand(command) {
  const value = String(command || '').replace(/^\//, '').toLowerCase();
  return isPermissionModeControlAction(value) ? value : '';
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

function buildNativeControlInput(state, action) {
  const value = String(action || '').toLowerCase();
  if (isPermissionModeControlAction(value)) {
    return buildPermissionModeControlInput(state, value);
  }
  return buildControlInput(value);
}

function buildPermissionModeControlInput(state, action) {
  if (normalizeNativeCodexCommand(state?.nativeCommand?.command) !== '/permissions') {
    return '';
  }
  const targetIndex = permissionModeActionIndex(action);
  if (!targetIndex) return '';
  const options = extractPermissionsPickerOptions(collectNativeVisualLines(
    state.session?.visualViewportSnapshot || state.session?.visualSnapshot
  ));
  if (options.length !== 3) return '';
  const selectedIndex = options.find((option) => option.selected)?.index || 1;
  const delta = targetIndex - selectedIndex;
  const arrow = delta > 0 ? '\x1b[B' : '\x1b[A';
  return `${arrow.repeat(Math.abs(delta))}\r`;
}

async function writeNativeControlInput(state, action, input) {
  const value = String(action || '').toLowerCase();
  if (
    !isPermissionModeControlAction(value) ||
    normalizeNativeCodexCommand(state?.nativeCommand?.command) !== '/permissions'
  ) {
    state.session.write(input);
    return;
  }

  const targetIndex = permissionModeActionIndex(value);
  const options = extractPermissionsPickerOptions(collectNativeVisualLines(
    state.session?.visualViewportSnapshot || state.session?.visualSnapshot
  ));
  const selectedIndex = options.find((option) => option.selected)?.index || 1;
  const delta = targetIndex - selectedIndex;
  const arrow = delta > 0 ? '\x1b[B' : '\x1b[A';

  for (let i = 0; i < Math.abs(delta); i += 1) {
    state.session.write(arrow);
    await delay(45);
  }
  await delay(80);
  state.session.write('\r');
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
    permission_default: 'Default',
    permission_auto_review: 'Auto-review',
    permission_full_access: 'Full Access'
  }[String(action || '').toLowerCase()] || '';
}

function formatPermissionModeResultHint(mode) {
  return {
    Default: '保留工作区读写能力；联网或越界文件操作仍需要确认。',
    'Auto-review': '符合条件的确认会先走自动审查，适合减少手动审批打断。',
    'Full Access': 'Codex 可越过工作区和联网审批限制，请只在可信任务中使用。'
  }[mode] || '权限模式已应用。';
}

function isPermissionModeControlAction(action) {
  return Boolean(permissionModeActionIndex(action));
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

function isSubmitControlAction(action) {
  const value = String(action || '').toLowerCase();
  if (isPermissionModeControlAction(value)) return true;
  return [
    'approve',
    'yes',
    'approve_persistent',
    'always',
    'persist',
    'deny',
    'escape',
    'cancel',
    'no',
    'enter'
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
    ...(prompt.options || []).map(formatApprovalOptionSignature)
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

function isPersistentNativeSlashPage(command) {
  const normalized = normalizeNativeCodexCommand(command);
  return normalized === '/resume' || normalized === '/permissions';
}

function isNativePageActionConfirmed(state, pending) {
  const command = normalizeNativeCodexCommand(pending?.command);
  const snapshot = String(
    state?.session?.visualViewportSnapshot ||
      state?.session?.visualSnapshot ||
      ''
  );
  if (!snapshot.trim()) return false;
  if (isNativeSlashPageVisible(snapshot, command)) return false;

  const signature = nativePageSnapshotSignature(state, command);
  if (signature && signature !== pending.beforeSignature) return true;
  return hasIdlePromptAfterSubmittedPrompt(snapshot, '');
}

function isNativeSlashPageVisible(snapshot, command) {
  const normalized = normalizeNativeCodexCommand(command);
  const lines = collectNativeVisualLines(snapshot);
  if (lines.length === 0) return false;
  if (normalized === '/resume') {
    if (lines.some((line) => /^Resume a previous session$/i.test(normalizeNativeLine(line)))) {
      return true;
    }
    if (extractResumeRows(lines).items.length > 0) return true;
    if (extractPickerOptions(lines).length > 0 && /resume|session|会话/i.test(lines.join(' '))) {
      return true;
    }
    return false;
  }
  if (normalized === '/permissions') {
    return lines.some((line) =>
      /^Update Model Permissions$/i.test(normalizeNativeLine(line))
    ) || extractPermissionsPickerOptions(lines).length === 3;
  }
  return false;
}

function nativePageSnapshotSignature(state, command) {
  const snapshot = String(
    state?.session?.visualViewportSnapshot ||
      state?.session?.visualSnapshot ||
      ''
  );
  if (!snapshot.trim()) return '';
  const normalized = normalizeNativeCodexCommand(command);
  const lines = collectNativeVisualLines(snapshot)
    .map((line) => normalizeNativeLine(line))
    .filter(Boolean)
    .filter((line) => !isNativeSlashNoiseLine(line, normalized));
  return lines.join('\n').trim();
}

function formatNativePageActionResult(pending, state = null) {
  const command = normalizeNativeCodexCommand(pending?.command);
  const action = String(pending?.action || '').toLowerCase();
  const selected = extractNativePageSelectedSummary(pending);
  const recent = summarizePostNativePageActionSnapshot(state);
  if (command === '/resume' && action === 'enter') {
    const lines = [
      '**会话已恢复**',
      '- Codex 已离开 `/resume` 选择页，并切换到所选历史会话。'
    ];
    if (selected) {
      lines.push(`- 恢复目标: \`${selected}\``);
    }
    lines.push(
      '',
      '**恢复后状态**',
      `- 最近输出: ${recent || '暂未检测到新的可读输出。'}`,
      '- 现在可以继续发送新的任务。'
    );
    return lines.join('\n');
  }
  if (command === '/resume' && action === 'escape') {
    return [
      '**已退出历史会话选择**',
      '- Codex 已返回命令界面，没有恢复新的历史会话。',
      `- 最近输出: ${recent || '当前没有新的可读输出。'}`,
      '- 现在可以继续发送新的任务。'
    ].join('\n');
  }
  if (command === '/permissions' && isPermissionModeControlAction(action)) {
    const mode = permissionModeActionLabel(action);
    return [
      '**权限模式已更新**',
      `- 已切换为 \`${mode}\`。`,
      `- ${formatPermissionModeResultHint(mode)}`
    ].join('\n');
  }
  if (action === 'enter') {
    return [
      '**选择已确认**',
      `- Codex 已离开 \`${command}\` 页面。`
    ].join('\n');
  }
  return [
    '**页面已退出**',
    `- Codex 已离开 \`${command}\` 页面。`
  ].join('\n');
}

function extractNativePageSelectedSummary(pending) {
  const command = normalizeNativeCodexCommand(pending?.command);
  if (command !== '/resume') return '';
  return String(pending?.beforeSignature || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^(?:❯|>|›)\s+/.test(line))
    ?.replace(/^(?:❯|>|›)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim() || '';
}

function summarizePostNativePageActionSnapshot(state) {
  const snapshot = String(
    state?.session?.visualViewportSnapshot ||
      state?.session?.visualSnapshot ||
      ''
  );
  if (!snapshot.trim()) return '';
  const lines = collectNativeVisualLines(snapshot)
    .map((line) => normalizeNativeLine(line))
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^›\s*$/.test(line))
    .filter((line) => !/^>_\s+OpenAI Codex/i.test(line))
    .filter((line) => !/^Tip:/i.test(line))
    .filter((line) => !/^Use \/skills/i.test(line))
    .filter((line) => !/^type \/help/i.test(line));
  const value = lines.slice(-3).join(' / ').replace(/\s+/g, ' ').trim();
  return value ? clipForLog(value, 180) : '';
}

function shouldFinishReplyStream(state, formatted) {
  if (!formatted || isPersistentNativeSlashPage(state?.nativeCommand?.command)) {
    return false;
  }
  if (normalizeNativeCodexCommand(state?.nativeCommand?.command) === '/status') {
    return isCompleteStatusSlashOutput(formatted);
  }
  return true;
}

function isCompleteStatusSlashOutput(text) {
  const value = stripRemoteCodexColorMarkers(text);
  if (
    /\*\*剩余用量\*\*/.test(value) &&
    /^-\s+(?:5 小时额度|每周额度|[^:\n]*limit):/im.test(value)
  ) {
    return true;
  }

  if (!/\*\*运行信息\*\*/.test(value)) return false;
  const fieldCount = [
    /^-\s+模型:/m,
    /^-\s+权限:/m,
    /^-\s+目录:/m,
    /^-\s+账号:/m,
    /^-\s+协作模式:/m,
    /^-\s+Agents\.md:/m,
    /^-\s+Session:/m
  ].filter((pattern) => pattern.test(value)).length;
  return fieldCount >= 4;
}

function buildNativeSlashPanelActions(command) {
  const normalized = normalizeNativeCodexCommand(command);
  if (normalized === '/resume') {
    return ['up', 'down', 'enter', 'escape'];
  }
  if (normalized === '/permissions') {
    return ['permission_default', 'permission_auto_review', 'permission_full_access'];
  }
  if (normalized === '/status') {
    return [];
  }
  return ['up', 'down', 'enter', 'escape'];
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
  classifyVisualTurnOutput,
  formatTerminalProgress,
  formatNativeSlashOutput,
  isCompleteStatusSlashOutput,
  parseCodexProgressState,
  renderCodexProgressState,
  classifyTerminalColorRole,
  buildSubmitInput,
  buildControlInput,
  buildNativeSlashInput,
  writeNativeSlashCommand
};
