const crypto = require('node:crypto');
const path = require('node:path');
const {
  buildControlInput,
  buildSubmitInput,
  formatPermissionModeResultHint,
  isPermissionModeControlAction,
  permissionModeActionIndex,
  permissionModeActionLabel
} = require('./remoteControlInput');
const {
  isWorkingRepaintGarbageLine,
  stripRemoteCodexColorMarkers,
  stripTerminalRepaintArtifacts
} = require('./remoteOutputCleanup');
const {
  FEISHU_FILE_MAX_BYTES,
  extractRemoteFileDirectives,
  validateRemoteFile
} = require('./remoteFileDelivery');
const {
  hasActiveVisualIndicators,
  hasIdlePromptAfterSubmittedPrompt,
  hasVisibleIdlePrompt,
  isVisualTurnSettled
} = require('./visualSessionState');
const {
  getNativeSlashActions,
  getNativeSlashDefinition,
  isBlockedNativeSlashCommand,
  normalizeNativeSlashCommand,
  normalizeNativeSlashText,
  shouldBindNextRollout,
  shouldRouteAsNativePage
} = require('./nativeSlashCommands');
const {
  ROLLOUT_TURN_REPLACED_ERROR_CODE
} = require('./codexRolloutReader');

const ANSI_PATTERN =
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const BOX_ONLY_PATTERN = /^[\s┌┐└┘├┤┬┴┼─│╭╮╰╯═║╔╗╚╝╠╣╦╩╬━┃╋╸╺╹╻╴╶╵╷▪▫·•*+\-=~_.,:;|/\\[\](){}<>]+$/;
const FINAL_PREFIX_PATTERN = /^\s*[•●]\s+/;
const STREAM_FINAL_SETTLE_MS = 1500;
const STREAM_FINAL_DEBOUNCE_MS = 15000;
const STREAM_WORKING_HEARTBEAT_MS = 5000;
const VISUAL_BUSY_STALE_MS = 30 * 60 * 1000;
const APPROVAL_SUBMISSION_GRACE_MS = 15 * 1000;
const REMOTE_CODEX_COLOR_MARKER_PREFIX = '<!--remote-codex-color:';
const REMOTE_CODEX_COLOR_MARKER_SUFFIX = '-->';
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
    appServerRunner = null,
    rolloutReader = null,
    config,
    logger = console,
    sharedSessionProvider = null,
    onRemoteInput = null
  }) {
    this.sessionManager = sessionManager;
    this.execRunner = execRunner;
    this.appServerRunner = appServerRunner;
    this.rolloutReader = rolloutReader;
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
    if (this.appServerRunner !== this.execRunner) {
      this.appServerRunner?.updateConfig?.(config);
    }
  }

  updateSharedSessionProvider(sharedSessionProvider) {
    this.sharedSessionProvider = sharedSessionProvider;
  }

  observeLocalTurn(message, options = {}) {
    const prompt = String(options.prompt || message?.text || '').trim();
    if (!message || !prompt) return false;

    const key = this.getKey(message);
    let state = this.sessions.get(key);
    if (state && options.session && state.session !== options.session) {
      this.disposeState(state, { kill: false });
      this.sessions.delete(key);
      state = null;
    }
    if (!state) {
      const starting = this.startSession(key, message, '', {
        restartShared: false,
        announce: false
      });
      state = this.sessions.get(key);
      starting.catch((error) => {
        this.logger.warn?.('Local rollout observer session failed:', error.message);
      });
    }
    if (!state) return false;

    this.refreshVisualBusyState(state, 'local_terminal_submission');
    const turnOptions = {
      observeOnly: true,
      matchNextPrompt: options.matchNextPrompt !== false,
      startedAt: Number(options.startedAt) || Date.now(),
      inputSource: 'local',
      suppressReplyText: message.suppressReplyText === true
    };
    if (hasActiveRemoteTurn(state)) {
      this.queueRemoteMessage(state, message, prompt, turnOptions).catch((error) => {
        this.logger.warn?.('Local queued rollout observer failed:', error.message);
      });
      return true;
    }

    this.discardPendingReply(state, 'new_local_terminal_turn');
    this.resetPendingOutput(state);
    this.assignTurnMessage(state, message);
    state.inputSource = turnOptions.inputSource;
    state.suppressReplyText = turnOptions.suppressReplyText;
    state.lastInputText = prompt;
    state.turnStartedAt = turnOptions.startedAt;
    state.turnFinishedNotified = false;
    state.phase = 'working';
    const replyStreamReady = this.startReplyStreamBeforeTerminalInput(state, message);
    state.replyStreamReadyPromise = replyStreamReady;
    this.beginRolloutTurn(state, prompt, turnOptions);
    this.logger.event?.('remote.local_turn.observed', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      syncReplyText: !state.suppressReplyText,
      promptChars: prompt.length
    });
    return true;
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

    if (isBlockedNativeSlashCommand(command)) {
      const definition = getNativeSlashDefinition(command);
      await message.reply([
        `Remote Codex 不允许远程执行 \`${definition.command}\`。`,
        '该命令会退出、注销、归档或永久删除当前 Codex 会话，请在本地终端中操作。'
      ].join('\n'));
      return;
    }

    if (isNativeCodexSlashCommand(command, text)) {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await message.reply('Native Codex slash commands require a visible TUI session.');
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
        await message.reply('This control command is only available for visible TUI sessions.');
        return;
      }
      await this.sendControlInput(key, message, keyAction);
      return;
    }

    const permissionModeAction = parsePermissionModeCommand(command);
    if (permissionModeAction) {
      if (this.shouldUseStructuredRunner(message.pluginId)) {
        await message.reply('Permission mode controls require a visible TUI session.');
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

    if (this.submitNativePageTextIfNeeded(state, message, text)) {
      return;
    }

    this.refreshVisualBusyState(state, 'incoming_message');
    if (hasActiveRemoteTurn(state)) {
      const approval = this.getApprovalPrompt(state);
      if (approval) {
        const signature = approvalPromptSignature(approval);
        const recentlySubmitted =
          signature &&
          signature === state.submittedApprovalSignature &&
          Date.now() - Number(state.submittedApprovalAt || 0) <=
            APPROVAL_SUBMISSION_GRACE_MS;
        if (recentlySubmitted) {
          this.logger.event?.('remote.message.queued_after_approval', {
            pluginId: message.pluginId,
            conversationId: message.conversationId,
            sessionId: state.session?.id || '',
            promptChars: text.length
          });
          await this.queueRemoteMessage(state, message, text);
          return;
        }
        if (
          signature &&
          signature !== state.lastApprovalSignature &&
          !state.approvalPanelInFlight
        ) {
          const panel = this.buildPermissionPanelPayload(
            key,
            message,
            state,
            approval
          );
          await this.presentApprovalPanel(state, panel, signature, { force: true });
        } else {
          this.logger.event?.('remote.approval.panel.ignored', {
            pluginId: message.pluginId,
            conversationId: message.conversationId,
            sessionId: state.session?.id || '',
            reason: 'already_presented'
          });
        }
        return;
      }
      if (state.nativeCommand) {
        await message.reply('当前正在操作 Codex 原生页面，请先完成或退出该页面。');
        return;
      }
      await this.queueRemoteMessage(state, message, text);
      return;
    }

    this.assignTurnMessage(state, message);
    this.discardPendingReply(state, 'new_user_message');
    state.lastInputText = text;
    state.turnStartedAt = Date.now();
    state.turnFinishedNotified = false;
    this.emitRemoteInput(message, text, state);
    this.resetPendingOutput(state);
    state.inputSource = 'remote';
    state.suppressReplyText = false;
    const replyStreamReady = this.startReplyStreamBeforeTerminalInput(state, message);
    state.replyStreamReadyPromise = replyStreamReady;
    this.beginRolloutTurn(state, text);
    state.session.write(buildSubmitInput(text));
    await replyStreamReady;
  }

  startReplyStreamBeforeTerminalInput(state, message) {
    return this.startReplyStream(state, message).catch((error) => {
      this.logger.warn?.('Remote reply stream unavailable:', error.message);
      this.logger.event?.('remote.stream.start.failed', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        error: error.message
      });
    }).finally(() => {
      if (state?.outputBuffer && !state.flushTimer) {
        this.queueOutput(state, '');
      }
    });
  }

  submitNativePageTextIfNeeded(state, message, text) {
    if (!state?.nativeCommand || String(text || '').trim().startsWith('/')) return false;
    const definition = getNativeSlashDefinition(state.nativeCommand.command);
    const acceptsText = definition?.kind === 'input' ||
      (definition?.kind === 'picker_task' && state.nativeTaskRolloutPending);
    if (!acceptsText) return false;

    const value = String(text || '').trim();
    if (!value) return false;
    this.emitRemoteInput(message, value, state);
    state.lastInputText = value;
    state.session.write(buildSubmitInput(value));
    this.beginNativePageAction(state, 'enter');
    this.logger.event?.('remote.native_slash.text_submitted', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      command: definition.command,
      chars: value.length
    });
    return true;
  }

  async queueRemoteMessage(state, message, text, options = {}) {
    if (!state || !message || !text) return null;
    if (!Array.isArray(state.queuedMessages)) state.queuedMessages = [];
    const submittedAt = Number(options.startedAt) || Date.now();
    const bindNextRollout = options.matchNextPrompt === undefined
      ? shouldBindNextRollout(text)
      : Boolean(options.matchNextPrompt);
    const skipPromptMatches = bindNextRollout
      ? state.queuedMessages.filter((queued) => queued.bindNextRollout).length
      : state.queuedMessages.filter((queued) => queued.prompt === text).length;
    const queued = {
      message,
      prompt: text,
      bindNextRollout,
      submittedAt,
      reply: message.reply,
      replyPanel: message.replyPanel,
      replySegment: message.replySegment,
      createReplyStream: message.createReplyStream,
      createApprovalPanel: message.createApprovalPanel,
      closeApprovalPanel: message.closeApprovalPanel,
      onTurnFinished: message.onTurnFinished,
      sendFile: message.sendFile,
      inputSource: options.inputSource || 'remote',
      suppressReplyText: options.suppressReplyText === true,
      events: [],
      error: null,
      active: false,
      generation: 0,
      handle: null
    };
    state.queuedMessages.push(queued);

    if (this.shouldUseRolloutOutput(state.pluginId) && this.rolloutReader?.beginTurn) {
      try {
        queued.handle = this.rolloutReader.beginTurn({
          prompt: text,
          matchNextPrompt: bindNextRollout,
          cwd: state.session?.cwd || this.config.codex?.defaultCwd,
          startedAt: submittedAt,
          bindTimeoutMs: this.rolloutReader.turnTimeoutMs || 30 * 60 * 1000,
          skipPromptMatches,
          onEvent: (event) => {
            if (!queued.active) {
              queued.events.push(event);
              return;
            }
            this.enqueueRolloutEvent(state, queued.generation, event);
          },
          onError: (error) => {
            if (!queued.active) {
              queued.error = error;
              return;
            }
            this.enqueueRolloutFailure(state, queued.generation, error);
          }
        });
      } catch (error) {
        queued.error = error;
      }
    } else {
      queued.error = new Error('Codex rollout reader is not configured.');
    }

    if (!options.observeOnly) {
      this.emitRemoteInput(message, text, state);
      state.session.write(buildSubmitInput(text));
    }
    this.logger.event?.('remote.message.queued', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      queueLength: state.queuedMessages.length,
      promptChars: text.length,
      inputSource: queued.inputSource,
      observeOnly: Boolean(options.observeOnly)
    });
    if (!state.rolloutFinished) {
      await this.handoffRolloutForQueuedMessage(state, {
        reason: 'user_message_queued'
      });
    }
    return queued;
  }

  activateNextQueuedMessage(state) {
    if (!state || state.stopped || state.queuedMessageActivating) return false;
    if (!Array.isArray(state.queuedMessages) || state.queuedMessages.length === 0) {
      return false;
    }
    if (state.rolloutTurn && !state.rolloutFinished) return false;

    state.queuedMessageActivating = true;
    try {
      const queued = state.queuedMessages.shift();
      this.resetPendingOutput(state);
      this.assignTurnMessage(state, queued);
      state.inputSource = queued.inputSource || 'remote';
      state.suppressReplyText = queued.suppressReplyText === true;
      state.lastInputText = queued.prompt;
      state.turnStartedAt = queued.submittedAt;
      state.turnFinishedNotified = false;
      state.phase = 'working';
      queued.active = true;
      queued.generation = state.rolloutGeneration;
      state.rolloutTurn = queued.handle;

      const bufferedEventCount = queued.events.length;
      const replyStreamReady = this.startReplyStreamBeforeTerminalInput(
        state,
        queued.message
      );
      state.replyStreamReadyPromise = replyStreamReady;
      for (const event of queued.events.splice(0)) {
        this.enqueueRolloutEvent(state, queued.generation, event);
      }
      if (queued.error) {
        this.enqueueRolloutFailure(state, queued.generation, queued.error);
      }
      this.logger.event?.('remote.message.queue.activated', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        queueLength: state.queuedMessages.length,
        promptChars: queued.prompt.length,
        bufferedEvents: bufferedEventCount
      });
      return true;
    } finally {
      state.queuedMessageActivating = false;
    }
  }

  beginRolloutTurn(state, prompt, options = {}) {
    if (!this.shouldUseRolloutOutput(state?.pluginId)) return null;
    const generation = Number(state.rolloutGeneration || 0);
    if (!this.rolloutReader?.beginTurn) {
      this.enqueueRolloutFailure(
        state,
        generation,
        new Error('Codex rollout reader is not configured.')
      );
      return null;
    }

    const handle = this.rolloutReader.beginTurn({
      prompt,
      matchNextPrompt: options.matchNextPrompt === undefined
        ? shouldBindNextRollout(prompt)
        : Boolean(options.matchNextPrompt),
      cwd: state.session?.cwd || this.config.codex?.defaultCwd,
      startedAt: Number(options.startedAt) || state.turnStartedAt,
      onEvent: (event) => this.enqueueRolloutEvent(state, generation, event),
      onError: (error) => this.enqueueRolloutFailure(state, generation, error)
    });
    state.rolloutTurn = handle;
    this.logger.event?.('remote.rollout.turn.started', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      generation,
      promptChars: String(prompt || '').length,
      inputSource: state.inputSource || 'remote',
      suppressReplyText: state.suppressReplyText === true
    });
    return handle;
  }

  enqueueRolloutEvent(state, generation, event) {
    state.rolloutEventChain = (state.rolloutEventChain || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (
          state.stopped ||
          generation !== state.rolloutGeneration ||
          state.rolloutFinished
        ) {
          return;
        }
        await this.handleRolloutEvent(state, event);
      })
      .catch((error) => {
        this.enqueueRolloutFailure(state, generation, error);
      });
    return state.rolloutEventChain;
  }

  enqueueRolloutFailure(state, generation, error) {
    state.rolloutEventChain = (state.rolloutEventChain || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (
          state.stopped ||
          generation !== state.rolloutGeneration ||
          state.rolloutFinished ||
          state.rolloutFailed
        ) {
          return;
        }
        if (
          error?.code === ROLLOUT_TURN_REPLACED_ERROR_CODE &&
          Array.isArray(state.queuedMessages) &&
          state.queuedMessages.length > 0
        ) {
          await this.handoffRolloutForQueuedMessage(state, {
            reason: 'rollout_turn_replaced',
            turnId: error?.turnId,
            nextTurnId: error?.nextTurnId
          });
          return;
        }
        state.rolloutFailed = true;
        state.rolloutTurn?.stop?.('controller_error');
        state.rolloutTurn = null;
        const detail = String(error?.message || error || 'unknown error');
        this.logger.warn?.('Remote rollout output failed:', detail);
        this.logger.event?.('remote.rollout.turn.failed', {
          pluginId: state.pluginId,
          conversationId: state.conversationId,
          sessionId: state.session?.id || '',
          rolloutSessionId: state.rolloutSessionId || '',
          rolloutTurnId: state.rolloutTurnId || '',
          error: detail
        });
        this.recordParserTrace(state, {
          source: 'rollout_jsonl',
          reason: 'rollout_failure',
          decision: 'fail_without_terminal_fallback',
          formatted: detail
        });
        await this.sendRolloutFailure(
          state,
          `无法绑定当前 Codex 的结构化 JSONL 输出。\n\n错误：${detail}`
        );
        this.finishRolloutTurn(state);
      });
    return state.rolloutEventChain;
  }

  async handoffRolloutForQueuedMessage(state, details = {}) {
    const previousText = String(
      state.rolloutProgressText || state.lastStreamText || ''
    ).trim();
    const handoffText = [
      previousText,
      '',
      '> 已收到后续消息，本轮已转入下一条任务。'
    ].filter(Boolean).join('\n');

    this.logger.event?.('remote.rollout.turn.handed_off', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      rolloutSessionId: state.rolloutSessionId || '',
      rolloutTurnId: details.turnId || state.rolloutTurnId || '',
      nextRolloutTurnId: details.nextTurnId || '',
      reason: details.reason || 'queued_message',
      queueLength: state.queuedMessages.length
    });
    this.recordParserTrace(state, {
      source: 'rollout_jsonl',
      reason: 'queued_rollout_handoff',
      decision: 'close_current_card_and_activate_queued_turn',
      formatted: handoffText
    });

    if (state.replyStreamStarting && state.replyStreamReadyPromise) {
      await state.replyStreamReadyPromise.catch(() => {});
    }
    if (state.replyStream) {
      state.lastStreamText = handoffText;
      this.updateReplyStream(state, handoffText, {
        final: true,
        immediate: true,
        finishDelayMs: 0,
        completionTemplate: 'blue',
        completionSubtitle: '已转入下一条消息'
      });
    }
    this.finishRolloutTurn(state);
  }

  async handleRolloutEvent(state, event = {}) {
    const type = String(event.type || '');
    if (type === 'authorization_requested') {
      await this.handleRolloutAuthorizationRequested(state, event);
      return;
    }

    if (type === 'authorization_completed') {
      await this.handleRolloutAuthorizationCompleted(state, event);
      return;
    }

    if (type === 'bound') {
      this.activateNativePickerTaskRollout(state, event);
      if (state.inputSource === 'local' && event.prompt) {
        state.lastInputText = String(event.prompt).trim() || state.lastInputText;
      }
      state.rolloutSessionId = String(event.sessionId || '');
      state.rolloutTurnId = String(event.turnId || '');
      state.rolloutPath = String(event.rolloutPath || '');
      this.logger.event?.('remote.rollout.turn.bound', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        rolloutSessionId: state.rolloutSessionId,
        rolloutTurnId: state.rolloutTurnId,
        cliVersion: event.cliVersion || '',
        cwd: event.cwd || ''
      });
      this.recordParserTrace(state, {
        reason: 'rollout_bound',
        rolloutEvent: event,
        decision: 'bind_rollout_turn'
      });
      return;
    }

    if (type === 'turn_started') {
      state.rolloutTurnId = String(event.turnId || state.rolloutTurnId || '');
      state.phase = 'working';
      this.recordParserTrace(state, {
        reason: 'rollout_turn_started',
        rolloutEvent: event,
        decision: 'start_rollout_turn'
      });
      return;
    }

    if (type === 'progress') {
      const decision = await this.sendRolloutProgress(state, event.text);
      this.recordParserTrace(state, {
        reason: 'rollout_progress',
        rolloutEvent: event,
        formatted: event.text,
        decision
      });
      return;
    }

    if (type === 'final') {
      const decision = await this.sendRolloutFinal(state, event.text);
      this.recordParserTrace(state, {
        reason: 'rollout_final',
        rolloutEvent: event,
        formatted: state.rolloutFinalText,
        decision
      });
      return;
    }

    if (type !== 'turn_complete') return;
    state.rolloutCompletionSeen = true;
    if (!state.rolloutFinalQueued && event.finalText) {
      await this.sendRolloutFinal(state, event.finalText);
    }
    if (!state.rolloutFinalQueued) {
      await this.sendRolloutFailure(
        state,
        'Codex 已结束任务，但 rollout JSONL 中没有 final_answer 事件。'
      );
    }
    await (state.segmentReplyChain || Promise.resolve()).catch(() => {});
    this.recordParserTrace(state, {
      reason: 'rollout_turn_complete',
      rolloutEvent: event,
      formatted: state.rolloutFinalText,
      decision: state.rolloutFinalQueued ? 'complete_rollout_turn' : 'complete_without_final'
    });
    this.finishRolloutTurn(state);
  }

  async handleRolloutAuthorizationRequested(state, event = {}) {
    const callId = String(event.callId || event.approval?.callId || '').trim();
    if (!callId) return;
    if (!(state.rolloutApprovalCallIds instanceof Set)) {
      state.rolloutApprovalCallIds = new Set();
    }
    if (!Array.isArray(state.rolloutApprovalQueue)) {
      state.rolloutApprovalQueue = [];
    }
    if (state.rolloutApprovalCallIds.has(callId)) {
      this.logger.event?.('remote.approval.rollout.ignored', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        callId,
        reason: 'duplicate_request'
      });
      return;
    }

    state.rolloutApprovalCallIds.add(callId);
    const approval = {
      ...(event.approval || {}),
      id: callId,
      callId,
      source: 'rollout_jsonl',
      turnId: String(event.turnId || event.approval?.turnId || '')
    };
    if (state.pendingRolloutApproval) {
      state.rolloutApprovalQueue.push(approval);
      this.logger.event?.('remote.approval.rollout.queued', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        callId,
        queueLength: state.rolloutApprovalQueue.length
      });
      return;
    }

    await this.activateRolloutApproval(state, approval);
  }

  async handleRolloutAuthorizationCompleted(state, event = {}) {
    const callId = String(event.callId || '').trim();
    if (!callId) return;
    if (!(state.completedRolloutApprovalCallIds instanceof Set)) {
      state.completedRolloutApprovalCallIds = new Set();
    }
    if (!Array.isArray(state.rolloutApprovalQueue)) {
      state.rolloutApprovalQueue = [];
    }
    if (state.completedRolloutApprovalCallIds.has(callId)) return;
    state.completedRolloutApprovalCallIds.add(callId);

    state.rolloutApprovalQueue = state.rolloutApprovalQueue.filter(
      (approval) => approval.callId !== callId
    );
    if (state.pendingRolloutApproval?.callId !== callId) {
      this.logger.event?.('remote.approval.rollout.completed', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        callId,
        active: false
      });
      return;
    }

    state.pendingRolloutApproval = null;
    state.lastApprovalSignature = '';
    state.lastApprovalAttemptSignature = '';
    state.submittedApprovalSignature = '';
    state.submittedApprovalAt = 0;
    state.approvalPanelRetryAt = 0;
    this.refreshSessionPhase(state, 'rollout_authorization_completed');
    this.logger.event?.('remote.approval.rollout.completed', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      callId,
      active: true,
      queueLength: state.rolloutApprovalQueue.length
    });
    this.recordParserTrace(state, {
      source: 'rollout_jsonl',
      reason: 'authorization_completed',
      rolloutEvent: event,
      decision: 'clear_rollout_authorization'
    });

    await this.closeRolloutApprovalPanel(state, callId, {
      completed: true,
      reason: 'authorization_completed'
    });

    const next = state.rolloutApprovalQueue.shift();
    if (next) await this.activateRolloutApproval(state, next);
  }

  async activateRolloutApproval(state, approval) {
    state.pendingRolloutApproval = approval;
    state.lastApprovalSignature = '';
    state.lastApprovalAttemptSignature = '';
    state.submittedApprovalSignature = '';
    state.submittedApprovalAt = 0;
    state.approvalPanelRetryAt = 0;
    this.refreshSessionPhase(state, 'rollout_authorization_requested');

    if (state.suppressReplyText) {
      this.logger.event?.('remote.approval.rollout.local_only', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        callId: approval.callId,
        reason: 'local_text_sync_disabled'
      });
      return;
    }

    const signature = approvalPromptSignature(approval);
    const panel = this.buildPermissionPanelPayload(
      state.key,
      null,
      state,
      approval
    );
    const presented = await this.presentApprovalPanel(
      state,
      panel,
      signature,
      { force: true }
    );
    this.logger.event?.('remote.approval.rollout.presented', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      callId: approval.callId,
      turnId: approval.turnId || '',
      presented
    });
    this.recordParserTrace(state, {
      source: 'rollout_jsonl',
      reason: 'authorization_requested',
      rolloutEvent: {
        type: 'authorization_requested',
        callId: approval.callId,
        turnId: approval.turnId || ''
      },
      formatted: formatApprovalPrompt(approval),
      decision: presented
        ? 'present_rollout_authorization'
        : 'rollout_authorization_presentation_failed'
    });
  }

  async sendRolloutFailure(state, detail) {
    if (state.suppressReplyText) {
      this.logger.event?.('remote.rollout.failure.suppressed', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        inputSource: state.inputSource || 'remote',
        detail: clipForLog(detail)
      });
      return;
    }
    const text = [
      '**Remote Codex 输出失败**',
      String(detail || '无法从 rollout JSONL 读取最终回复。'),
      '',
      '为避免发送终端乱码，本轮不会回退到终端正文解析。'
    ].join('\n');
    if (state.replyStreamStarting && state.replyStreamReadyPromise) {
      await state.replyStreamReadyPromise.catch(() => {});
    }
    if (state.replyStream) {
      state.lastStreamText = text;
      this.updateReplyStream(state, text, {
        final: true,
        finishDelayMs: 0,
        completionTemplate: 'red',
        completionSubtitle: '输出失败'
      });
      return;
    }
    await this.safeReply(state, text);
  }

  async sendRolloutProgress(state, text) {
    const value = normalizeRolloutOutputText(text);
    if (!value) return 'ignore_empty_progress';
    if (state.suppressReplyText) return 'ignore_local_progress_sync_disabled';
    state.phase = 'working';
    state.lastOutputAt = Date.now();
    const outputConfig = this.getOutputConfig(state.pluginId);
    if (
      !outputConfig.sendOutput ||
      outputConfig.outputMode === 'silent' ||
      outputConfig.outputMode === 'status_only'
    ) {
      return 'ignore_output_disabled';
    }

    if (state.replyStreamStarting && state.replyStreamReadyPromise) {
      await state.replyStreamReadyPromise.catch(() => {});
    }

    if (this.shouldUseSegmentedReplies(state, outputConfig)) {
      await this.enqueueSegmentReply(state, value, {
        final: false,
        preserveFormatting: true
      });
      return 'send_segment_progress';
    }

    if (state.replyStream) {
      state.rolloutProgressText = appendRolloutSegment(
        state.rolloutProgressText,
        value
      );
      state.lastStreamText = state.rolloutProgressText;
      this.updateReplyStream(state, state.rolloutProgressText);
      return 'update_stream_progress';
    }

    if (outputConfig.outputMode === 'full') {
      await this.safeReply(state, value);
      return 'send_progress_reply';
    }
    return 'ignore_progress_without_transport';
  }

  async sendRolloutFinal(state, text) {
    const rawValue = normalizeRolloutOutputText(text);
    if (!rawValue) return 'ignore_empty_final';
    if (state.rolloutFinalQueued) return 'ignore_duplicate_final';
    state.rolloutFinalQueued = true;
    const value = this.prepareRemoteFileOutput(state, rawValue);
    state.rolloutFinalText = value;
    state.lastReplyText = value;
    state.lastReplySignature = remoteMessageSignature(value);
    if (state.suppressReplyText) {
      await this.completePendingRemoteFiles(state, value);
      if (state.remoteFileWarnings?.length) {
        this.logger.event?.('remote.local_file.warning.suppressed', {
          pluginId: state.pluginId,
          conversationId: state.conversationId,
          sessionId: state.session?.id || '',
          warnings: state.remoteFileWarnings.length,
          reason: 'local_text_sync_disabled'
        });
        return 'suppress_local_file_warning_text';
      }
      return state.remoteFileDirectiveCount > 0
        ? 'deliver_local_files_without_text_sync'
        : 'ignore_local_final_sync_disabled';
    }
    const outputConfig = this.getOutputConfig(state.pluginId);
    if (
      !outputConfig.sendOutput ||
      outputConfig.outputMode === 'silent' ||
      outputConfig.outputMode === 'status_only'
    ) {
      await this.completePendingRemoteFiles(state, value);
      return 'ignore_output_disabled';
    }

    if (state.replyStreamStarting && state.replyStreamReadyPromise) {
      await state.replyStreamReadyPromise.catch(() => {});
    }

    if (this.shouldUseSegmentedReplies(state, outputConfig)) {
      const completedText = await this.completePendingRemoteFiles(state, value);
      await this.enqueueSegmentReply(state, completedText, {
        final: true,
        preserveFormatting: true
      });
      return 'send_segment_final';
    }

    if (state.replyStream) {
      state.lastStreamText = value;
      this.updateReplyStream(state, value, {
        final: true,
        finishDelayMs: 0,
        completionTemplate: state.remoteFileWarnings?.length ? 'orange' : '',
        completionSubtitle: state.remoteFileWarnings?.length
          ? '已完成，文件未全部发送'
          : ''
      });
      return 'close_stream_final';
    }

    const completedText = await this.completePendingRemoteFiles(state, value);
    await this.safeReply(state, completedText);
    return 'send_final_reply';
  }

  prepareRemoteFileOutput(state, text) {
    const extracted = extractRemoteFileDirectives(text);
    state.pendingRemoteFiles = [];
    state.remoteFilesDelivered = false;
    state.remoteFileWarnings = [];
    state.remoteFileDirectiveCount = extracted.files.length;
    if (!extracted.files.length) return extracted.text;

    const pluginConfig = this.getPluginConfig(state.pluginId);
    const enabled = pluginConfig.fileTransferEnabled !== false;
    const maxFiles = normalizePositiveInteger(pluginConfig.fileTransferMaxFiles, 5, 20);
    const maxBytes = normalizePositiveInteger(
      pluginConfig.fileTransferMaxBytes,
      FEISHU_FILE_MAX_BYTES,
      FEISHU_FILE_MAX_BYTES
    );
    const cwd = state.session?.cwd || state.cwd || this.config.codex?.defaultCwd || '';
    const requestedFiles = extracted.files.slice(0, maxFiles);

    if (!enabled || typeof state.sendFile !== 'function') {
      const reason = enabled
        ? '当前远程通道不支持文件发送。'
        : '文件发送功能已关闭。';
      state.remoteFileWarnings.push(...requestedFiles.map((filePath) => ({
        name: safeRemoteFileName(filePath),
        reason
      })));
    } else {
      const seenTargets = new Set();
      for (const filePath of requestedFiles) {
        try {
          const file = validateRemoteFile(filePath, { cwd, maxBytes });
          if (!seenTargets.has(file.path)) {
            seenTargets.add(file.path);
            state.pendingRemoteFiles.push(file);
          }
        } catch (error) {
          state.remoteFileWarnings.push({
            name: safeRemoteFileName(filePath),
            reason: error.message
          });
        }
      }
    }

    for (const filePath of extracted.files.slice(maxFiles)) {
      state.remoteFileWarnings.push({
        name: safeRemoteFileName(filePath),
        reason: `每轮最多发送 ${maxFiles} 个文件。`
      });
    }

    let output = extracted.text;
    if (!output) {
      output = state.pendingRemoteFiles.length
        ? formatPendingRemoteFiles(state.pendingRemoteFiles)
        : '文件发送请求未完成。';
    }
    return appendRemoteFileWarnings(output, state.remoteFileWarnings);
  }

  async deliverPendingRemoteFiles(state) {
    if (state.remoteFilesDelivered) return [];
    state.remoteFilesDelivered = true;
    const files = Array.isArray(state.pendingRemoteFiles)
      ? state.pendingRemoteFiles.splice(0)
      : [];
    const failures = [];
    const pluginConfig = this.getPluginConfig(state.pluginId);
    const maxBytes = normalizePositiveInteger(
      pluginConfig.fileTransferMaxBytes,
      FEISHU_FILE_MAX_BYTES,
      FEISHU_FILE_MAX_BYTES
    );
    const cwd = state.session?.cwd || state.cwd || this.config.codex?.defaultCwd || '';

    for (const file of files) {
      try {
        const currentFile = validateRemoteFile(file.path, { cwd, maxBytes });
        await state.sendFile(currentFile);
        this.logger.event?.('remote.file.sent', {
          pluginId: state.pluginId,
          conversationId: state.conversationId,
          sessionId: state.session?.id || '',
          name: currentFile.name,
          size: currentFile.size
        });
      } catch (error) {
        failures.push({ name: file.name, reason: error.message || '飞书文件发送失败。' });
        this.logger.warn?.(`Remote file send failed (${file.name}):`, error.message);
        this.logger.event?.('remote.file.send.failed', {
          pluginId: state.pluginId,
          conversationId: state.conversationId,
          sessionId: state.session?.id || '',
          name: file.name,
          size: file.size,
          error: error.message
        });
      }
    }
    return failures;
  }

  async completePendingRemoteFiles(state, text) {
    const failures = await this.deliverPendingRemoteFiles(state);
    if (!failures.length) return text;
    if (!Array.isArray(state.remoteFileWarnings)) {
      state.remoteFileWarnings = [];
    }
    state.remoteFileWarnings.push(...failures);
    const completedText = appendRemoteFileWarnings(text, failures);
    state.rolloutFinalText = completedText;
    state.lastReplyText = completedText;
    state.lastReplySignature = remoteMessageSignature(completedText);
    return completedText;
  }

  finishRolloutTurn(state) {
    if (!state || state.rolloutFinished) return;
    state.rolloutFinished = true;
    state.rolloutTurn?.stop?.('controller_complete');
    state.rolloutTurn = null;
    this.closeOutstandingRolloutApprovalPanels(state, 'turn_complete');
    state.pendingRolloutApproval = null;
    state.rolloutApprovalQueue = [];
    state.outputBuffer = '';
    state.turnStartedAt = 0;
    state.phase = 'idle';
    this.clearStreamHeartbeat(state);
    if (!state.replyStream || state.streamFinishedForTurn) {
      this.notifyTurnFinished(state);
    }
    this.logger.event?.('remote.rollout.turn.completed', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      rolloutSessionId: state.rolloutSessionId || '',
      rolloutTurnId: state.rolloutTurnId || '',
      progressChars: String(state.rolloutProgressText || '').length,
      finalChars: String(state.rolloutFinalText || '').length
    });
  }

  getKey(message) {
    return `${message.pluginId}:${message.conversationId}`;
  }

  getPluginConfig(pluginId) {
    return this.config.plugins?.[pluginId] || {};
  }

  shouldUseStructuredRunner(pluginId) {
    const source = this.getResponseSource(pluginId);
    return source === 'exec_json' || source === 'app_server';
  }

  getResponseSource(pluginId) {
    const pluginConfig = this.getPluginConfig(pluginId);
    return (
      pluginConfig.responseSource ||
      this.config.remoteControl?.responseSource ||
      'rollout_jsonl'
    );
  }

  getStructuredRunner(pluginId) {
    return this.getResponseSource(pluginId) === 'app_server'
      ? this.appServerRunner
      : this.execRunner;
  }

  shouldUseRolloutOutput(pluginId) {
    const source = this.getResponseSource(pluginId);
    return ['rollout_jsonl', 'visual_terminal', 'pty'].includes(source);
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
      ),
      segmentedOutput:
        pluginConfig.singleCardOutput !== false
          ? false
          : pluginConfig.segmentedOutput === undefined
          ? pluginId === 'feishu' && pluginConfig.streaming !== true
          : Boolean(pluginConfig.segmentedOutput)
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
    const structuredRunner = this.getStructuredRunner(message.pluginId);
    if (!structuredRunner?.run) {
      await message.reply(
        `Configured response source ${this.getResponseSource(message.pluginId)} is unavailable.`
      );
      return;
    }
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
        sendFile: message.sendFile,
        pendingRemoteFiles: [],
        remoteFilesDelivered: false,
        remoteFileWarnings: [],
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
    state.sendFile = message.sendFile;
    state.pendingRemoteFiles = [];
    state.remoteFilesDelivered = false;
    state.remoteFileWarnings = [];
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
      const value = extractRemoteFileDirectives(streamText).text.trim();
      if (!value || !replyStream || value === state.lastStreamText) return;
      state.lastStreamText = value;
      replyStream.update(value).catch((error) => {
        this.logger.warn?.('Remote exec stream update failed:', error.message);
      });
    };

    try {
      const result = await structuredRunner.run({
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
      const rawFinalText = state.lastReplyText || state.lastActivityText || 'Codex finished with no output.';
      const preparedText = this.prepareRemoteFileOutput(state, rawFinalText);
      const finalText = await this.completePendingRemoteFiles(state, preparedText);
      if (state.remoteFileWarnings?.length) {
        replyStream?.setCompletionState?.({
          template: 'orange',
          subtitle: '已完成，文件未全部发送'
        });
      }
      if (replyStream) {
        await replyStream.finish(finalText);
      } else {
        await message.reply(finalText);
      }
      await notifyMessageTurnFinished(message);
      this.logger.event?.('remote.exec.reply.sent', {
        pluginId: message.pluginId,
        conversationId: message.conversationId,
        threadId: state.threadId,
        text: clipForLog(finalText)
      });
    } catch (error) {
      const fallback = extractRemoteFileDirectives(
        error.state?.finalText || error.state?.activityText || error.message
      ).text || error.message;
      if (replyStream) {
        await replyStream.finish(fallback).catch((streamError) => {
          this.logger.warn?.('Remote exec stream finish failed:', streamError.message);
        });
      } else {
        await message.reply(fallback);
      }
      await notifyMessageTurnFinished(message);
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
      replySegment: message.replySegment,
      session,
      shared: acquired.shared,
      cursor: 0,
      outputBuffer: '',
      flushTimer: null,
      streamFinishTimer: null,
      visualFinalSettleTimer: null,
      streamHeartbeatTimer: null,
      segmentProgressRetryTimer: null,
      nativePageExitTimer: null,
      nativePageActionTimer: null,
      nativeTaskRolloutPending: false,
      pendingReplyTimer: null,
      createReplyStream: message.createReplyStream,
      createApprovalPanel: message.createApprovalPanel,
      closeApprovalPanel: message.closeApprovalPanel,
      onTurnFinished: message.onTurnFinished,
      sendFile: message.sendFile,
      replyStream: null,
      replyStreamStarting: false,
      replyStreamReadyPromise: null,
      lastReplyText: '',
      lastStreamText: '',
      lastSentReplyText: '',
      lastReplySignature: '',
      lastStreamSignature: '',
      lastSentReplySignature: '',
      lastLocalNativeSlashPanelSignature: '',
      pendingReplyText: '',
      streamedThisTurn: false,
      segmentedThisTurn: false,
      streamFinishedForTurn: false,
      turnFinishedNotified: false,
      streamClosedText: '',
      streamAccumulatedText: '',
      streamRawProgressWindow: '',
      segmentAccumulatedText: '',
      segmentRawProgressWindow: '',
      segmentReplyChain: Promise.resolve(),
      segmentReplyGeneration: 0,
      segmentProgressRetryCount: 0,
      currentTurnVisualAnchorSeen: false,
      rolloutTurn: null,
      rolloutGeneration: 0,
      rolloutEventChain: Promise.resolve(),
      rolloutSessionId: '',
      rolloutTurnId: '',
      rolloutPath: '',
      rolloutProgressText: '',
      rolloutFinalText: '',
      rolloutFinalQueued: false,
      rolloutCompletionSeen: false,
      rolloutFinished: false,
      rolloutFailed: false,
      queuedMessages: [],
      queuedMessageActivating: false,
      pendingRemoteFiles: [],
      remoteFilesDelivered: false,
      remoteFileWarnings: [],
      remoteFileDirectiveCount: 0,
      sentSegmentSignatures: new Set(),
      nativePanelUpdateRequested: false,
      controlActionLocks: new Map(),
      pendingRolloutApproval: null,
      rolloutApprovalQueue: [],
      rolloutApprovalCallIds: new Set(),
      completedRolloutApprovalCallIds: new Set(),
      rolloutApprovalPanels: new Map(),
      lastApprovalSignature: '',
      lastApprovalAttemptSignature: '',
      submittedApprovalSignature: '',
      submittedApprovalAt: 0,
      approvalPanelInFlight: false,
      approvalPanelRetryAt: 0,
      lastInputText: '',
      inputSource: 'remote',
      suppressReplyText: false,
      nativeCommand: null,
      nativePageAction: null,
      phase: 'idle',
      turnStartedAt: 0,
      lastOutputAt: 0,
      stopped: false
    };

    state.dataListener = (chunk) => {
      state.cursor = chunk.cursor;
      this.queueOutput(state, chunk.data);
    };

    state.snapshotListener = () => {
      this.queueOutput(state, '');
    };

    state.exitListener = ({ exitCode, signal }) => {
      this.sessions.delete(key);
      this.clearStreamHeartbeat(state);
      if (state.stopped) return;
      const exitDetail = `Codex exited: code=${exitCode}, signal=${signal || 'none'}`;
      if (state.rolloutTurn && !state.rolloutFinished) {
        this.enqueueRolloutFailure(state, state.rolloutGeneration, new Error(exitDetail));
        return;
      }
      this.safeReply(
        state,
        exitDetail
      );
    };

    session.on('data', state.dataListener);
    session.on('snapshot', state.snapshotListener);
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
        : 'rollout_jsonl',
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
      'rollout_jsonl';

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
        responseSource
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
        responseSource: 'exec_json'
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
    state.createApprovalPanel = message.createApprovalPanel || state.createApprovalPanel;
    state.closeApprovalPanel = message.closeApprovalPanel || state.closeApprovalPanel;
    state.onTurnFinished = message.onTurnFinished;
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
      await message.reply('当前 Codex 正在执行任务；原生页面命令暂不能排队。');
      return;
    }

    state.lastInputText = commandText;
    state.turnStartedAt = Date.now();
    state.turnFinishedNotified = false;
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
    const replyStreamReady = this.startReplyStream(state, message).catch((error) => {
      this.logger.warn?.('Remote reply stream unavailable:', error.message);
      this.logger.event?.('remote.stream.start.failed', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        command,
        error: error.message
      });
    }).finally(() => {
      if (state?.outputBuffer && !state.flushTimer) {
        this.queueOutput(state, '');
      }
    });
    await writeNativeSlashCommand(state.session, commandText);
    await replyStreamReady;
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
    if (
      approvalAction &&
      message.approvalContext &&
      message.approvalContext !== approvalPromptContext(approval)
    ) {
      this.logger.event?.('remote.control.rejected_stale_approval', {
        pluginId: message.pluginId,
        conversationId: message.conversationId,
        action
      });
      if (typeof message.replyPanel === 'function') {
        await message.replyPanel({
          kind: 'permission',
          template: 'grey',
          title: 'Remote Codex 权限确认',
          attached: true,
          active: false,
          completed: false,
          message: '该权限请求已失效。',
          actions: []
        });
      }
      return;
    }
    if (approvalAction) {
      const requestedApprovalAction = canonicalApprovalControlAction(action);
      const availableApprovalActions = this.buildPermissionPanelActions(approval);
      if (
        requestedApprovalAction &&
        !availableApprovalActions.includes(requestedApprovalAction)
      ) {
        this.logger.event?.('remote.control.rejected_unavailable_approval_action', {
          pluginId: message.pluginId,
          conversationId: message.conversationId,
          action: requestedApprovalAction,
          availableActions: availableApprovalActions
        });
        await message.reply('当前授权请求不提供这个选项，请使用授权卡中的可用按钮。');
        return;
      }
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

    const startsNativeTask =
      String(action || '').toLowerCase() === 'enter' &&
      getNativeSlashDefinition(state.nativeCommand?.command)?.kind === 'picker_task';
    if (startsNativeTask && !state.nativeTaskRolloutPending) {
      this.beginNativePickerTaskRollout(state);
    }

    const submitsNativePage =
      state.nativeCommand &&
      (
        ['enter', 'escape', 'viewer_exit'].includes(String(action || '').toLowerCase()) ||
        isPermissionModeControlAction(action)
      );
    if (submitsNativePage) {
      this.beginNativePageAction(state, action);
    }

    await writeNativeControlInput(state, action, input);
    if (
      state.nativeCommand &&
      ['up', 'down', 'page_up', 'page_down', 'home', 'end', 'left', 'right', 'tab'].includes(String(action || '').toLowerCase())
    ) {
      state.nativePanelUpdateRequested = true;
    }
    this.refreshSessionPhase(state, 'control_sent');
    if (approvalAction) {
      state.submittedApprovalSignature = approvalPromptSignature(approval);
      state.submittedApprovalAt = Date.now();
      state.outputBuffer = '';
      this.scheduleStreamHeartbeat(state);
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

    if (String(data || '').length > 0) {
      state.lastOutputAt = Date.now();
      if (state.visualFinalSettleTimer) {
        clearTimeout(state.visualFinalSettleTimer);
        state.visualFinalSettleTimer = null;
      }
    }
    state.outputBuffer += data;
    if (state.flushTimer) return;

    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      const output = state.outputBuffer;
      if (state.replyStreamStarting && outputConfig.outputMode === 'final') {
        this.logger.event?.('remote.output.deferred', {
          pluginId: state.pluginId,
          conversationId: state.conversationId,
          sessionId: state.session?.id || '',
          reason: 'reply_stream_starting',
          chars: String(output || '').length
        });
        return;
      }
      const clearOutputBufferAfterFlush =
        outputConfig.outputMode !== 'final' ||
        (state.shared && !state.nativeCommand);
      if (clearOutputBufferAfterFlush) {
        state.outputBuffer = '';
      }
      if (this.confirmNativePageActionIfReady(state, 'output')) {
        return;
      }
      if (state.nativePageAction) {
        state.outputBuffer = '';
        return;
      }
      this.sendLocalNativeSlashPanelIfPresent(state);
      if (!state.nativeCommand && this.shouldUseRolloutOutput(state.pluginId)) {
        state.outputBuffer = '';
        if (state.rolloutFailed && isVisualTurnSettled(state)) {
          this.finishRolloutTurn(state);
          return;
        }
        this.refreshSessionPhase(state, 'terminal_control_output');
        return;
      }
      if (!state.nativeCommand) {
        state.outputBuffer = '';
        return;
      }

      const formatted = this.formatStateOutput(state, output);
      this.refreshSessionPhase(state, 'native_output_received');
      const nativePageOpen = isNativeCommandPageOpen(state);
      const shouldFinishCurrentStream = shouldFinishReplyStream(state, formatted);
      this.logger.event?.('remote.native_slash.output', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        command: state.nativeCommand.command,
        rawChars: String(output || '').length,
        formattedChars: String(formatted || '').length,
        hasReplyStream: Boolean(state.replyStream),
        snapshotLines: collectNativeVisualLines(
          state.session?.visualViewportSnapshot || state.session?.visualSnapshot
        ).length,
        text: clipForLog(formatted)
      });
      const formattedSignature = remoteMessageSignature(formatted);
      this.recordParserTrace(state, {
        reason: 'native_output_flush',
        output,
        outputConfig,
        formatted,
        formattedSignature,
        shouldFinishCurrentStream,
        decision: formatted ? 'send_native_panel' : 'ignore_empty_native_output'
      });
      if (!formatted || formattedSignature === state.lastReplySignature) {
        return;
      }
      state.lastReplyText = formatted;
      state.lastReplySignature = formattedSignature;
      if (state.replyStream) {
        state.lastStreamText = formatted;
        this.updateReplyStream(state, formatted, {
          final: shouldFinishCurrentStream,
          keepOpen: nativePageOpen,
          finishDelayMs: this.getStreamFinishDelayMs(state, outputConfig)
        });
        if (shouldFinishCurrentStream && !nativePageOpen) {
          this.completeNativeCommandState(state, 'stream_finalized');
        }
        state.nativePanelUpdateRequested = false;
        return;
      }

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
        return;
      }
      if (state.streamedThisTurn && !state.nativePanelUpdateRequested) return;

      state.nativePanelUpdateRequested = false;
      const panel = this.buildNativeSlashPanelPayload(state, formatted);
      if (shouldFinishCurrentStream && !nativePageOpen) {
        panel.active = false;
        panel.completed = true;
        panel.notice = '读取完成。';
        panel.actions = [];
      }
      this.safeReplyPanel(state, panel, formatted).then(() => {
        state.turnStartedAt = 0;
        if (shouldFinishCurrentStream && !nativePageOpen) {
          this.completeNativeCommandState(state, 'panel_finalized');
        }
      });
    }, outputConfig.flushIntervalMs);
  }

  shouldUseSegmentedReplies(state, outputConfig = this.getOutputConfig(state?.pluginId)) {
    return Boolean(
      state?.pluginId === 'feishu' &&
        state.shared &&
        !state.nativeCommand &&
        outputConfig.outputMode === 'final' &&
        outputConfig.segmentedOutput &&
        !state.replyStream
    );
  }

  completeNativeCommandState(state, reason = 'complete') {
    if (!state?.nativeCommand) return false;
    const command = normalizeNativeCodexCommand(state.nativeCommand.command);
    state.nativeCommand = null;
    state.nativePageAction = null;
    state.nativeTaskRolloutPending = false;
    state.outputBuffer = '';
    state.turnStartedAt = 0;
    this.refreshSessionPhase(state, `native_${reason}`);
    this.logger.event?.('remote.native_slash.completed', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      command,
      reason
    });
    return true;
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
    if (state.suppressReplyText) {
      this.logger.event?.('remote.stream.start.skipped', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        reason: 'local_text_sync_disabled',
        controlMode: this.getReplyStreamControlMode(state)
      });
      return;
    }
    const outputConfig = this.getOutputConfig(state.pluginId);
    if (
      !outputConfig.sendOutput ||
      outputConfig.outputMode === 'silent' ||
      outputConfig.outputMode === 'status_only'
    ) {
      this.logger.event?.('remote.stream.start.skipped', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        reason: 'output_disabled',
        controlMode: this.getReplyStreamControlMode(state)
      });
      return;
    }
    if (this.shouldUseSegmentedReplies(state, outputConfig)) {
      this.logger.event?.('remote.stream.start.skipped', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        reason: 'segmented_output',
        controlMode: this.getReplyStreamControlMode(state)
      });
      return;
    }
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
    const initialText = this.formatInitialStreamText(state);
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
      state.lastStreamSignature = remoteMessageSignature(initialText);
      state.streamAccumulatedText =
        state.pluginId === 'feishu' && state.shared && !state.nativeCommand
          ? ''
          : initialText;
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
    if (getNativeSlashDefinition(command)?.kind === 'viewer') return 'viewer';
    return 'slash';
  }

  formatInitialStreamText(state) {
    if (state?.pluginId === 'feishu' && !state.nativeCommand) return '';
    return this.formatRunningFallback(state);
  }

  refreshOpenNativeSlashPage(state, command, message) {
    const normalized = normalizeNativeCodexCommand(command);
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

  sendLocalNativeSlashPanelIfPresent(state) {
    if (!state || state.nativeCommand) return false;
    const snapshot =
      state.session?.visualViewportSnapshot ||
      state.session?.visualSnapshot ||
      '';
    const panel = extractLocalNativeSlashPanel(snapshot);
    if (!panel?.content) return false;

    const signature = `${panel.command}:${remoteMessageSignature(panel.content)}`;
    if (!signature || signature === state.lastLocalNativeSlashPanelSignature) {
      return false;
    }
    state.lastLocalNativeSlashPanelSignature = signature;

    const panelState = {
      ...state,
      nativeCommand: { command: panel.command }
    };
    const payload = {
      ...this.buildNativeSlashPanelPayload(panelState, panel.content),
      notice: '检测到本地终端打开了 Codex 状态页，已单独发送；当前远程任务继续运行。'
    };
    this.safeReplyPanel(state, payload, panel.content).catch((error) => {
      this.logger.warn?.('Remote local native slash panel failed:', error.message);
    });
    this.logger.event?.('remote.local_native_slash.panel.sent', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      command: panel.command,
      prompt: panel.prompt || '',
      chars: panel.content.length
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
    if (
      options.completionTemplate ||
      options.completionSubtitle ||
      options.completionTitle
    ) {
      state.replyStream?.setCompletionState?.({
        template: options.completionTemplate,
        subtitle: options.completionSubtitle,
        title: options.completionTitle
      });
    }
    this.logger.event?.('remote.stream.update', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      method: updateMethod,
      final: Boolean(options.final),
      keepOpen: Boolean(options.keepOpen),
      heartbeat: Boolean(options.heartbeat),
      chars: String(text || '').length,
      text: clipForLog(text, 800)
    });
    const updateStream = state.replyStream?.[updateMethod];
    if (typeof updateStream === 'function') {
      Promise.resolve(updateStream.call(state.replyStream, text)).catch((error) => {
        this.logger.warn?.('Remote reply stream update failed', remoteErrorLogMeta(error, {
          pluginId: state.pluginId,
          conversationId: state.conversationId,
          sessionId: state.session?.id || '',
          method: updateMethod,
          final: Boolean(options.final)
        }));
        if (
          state.pluginId !== 'feishu' &&
          options.final &&
          text &&
          text !== state.lastSentReplyText
        ) {
          this.safeReply(state, text).then(() => {
            state.turnStartedAt = 0;
          });
        }
      });
    }

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
    state.streamFinishTimer = setTimeout(async () => {
      state.streamFinishTimer = null;
      const completedText = await this.completePendingRemoteFiles(state, text);
      const completedSignature = remoteMessageSignature(completedText);
      if (state.remoteFileWarnings?.length) {
        stream?.setCompletionState?.({
          template: 'orange',
          subtitle: '已完成，文件未全部发送'
        });
      }
      stream
        ?.finish(completedText)
        .then(() => {
          if (state.replyStream === stream) {
            state.replyStream = null;
          }
          state.streamFinishedForTurn = true;
          state.streamClosedText = completedText;
          state.lastSentReplyText = completedText;
          state.lastSentReplySignature = completedSignature;
          state.turnStartedAt = 0;
          this.notifyTurnFinished(state);
        })
        .catch((error) => {
          this.logger.warn?.('Remote reply stream finish failed', remoteErrorLogMeta(error, {
            pluginId: state.pluginId,
            conversationId: state.conversationId,
            sessionId: state.session?.id || ''
          }));
          if (state.pluginId === 'feishu') {
            state.streamFinishedForTurn = true;
            state.turnStartedAt = 0;
            this.notifyTurnFinished(state);
            return;
          }
          if (
            error?.finalUpdateFailed &&
            completedText &&
            completedText !== state.lastSentReplyText
          ) {
            this.safeReply(state, completedText).then(() => {
              state.streamFinishedForTurn = true;
              state.streamClosedText = completedText;
              state.lastSentReplySignature = completedSignature;
              state.turnStartedAt = 0;
              this.notifyTurnFinished(state);
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
    if (state.pluginId === 'feishu' && !state.nativeCommand) {
      this.scheduleStreamHeartbeat(state);
      return;
    }

    const streamText = this.formatWorkingHeartbeatText(state);
    if (streamText && streamText !== state.lastStreamText) {
      state.lastStreamText = streamText;
      this.updateReplyStream(state, streamText, { heartbeat: true });
      return;
    }

    this.scheduleStreamHeartbeat(state);
  }

  getVisualFinalSettleDelayMs(outputConfig = {}) {
    const configured = Number(outputConfig.finalReplyDebounceMs);
    if (Number.isFinite(configured)) return Math.max(0, configured);
    return STREAM_FINAL_SETTLE_MS;
  }

  getStreamFinishDelayMs(state, outputConfig = {}, options = {}) {
    if (options.visualFinalAlreadySettled) {
      return 0;
    }
    const configured = Number(outputConfig.finalReplyDebounceMs);
    const settledDelayMs = this.getVisualFinalSettleDelayMs(outputConfig);
    if (
      normalizeNativeCodexCommand(state?.nativeCommand?.command) === '/status' &&
      isCompleteStatusSlashOutput(state.lastReplyText)
    ) {
      return settledDelayMs;
    }
    if (isVisualTurnSettled(state)) {
      return settledDelayMs;
    }
    return Math.max(
      STREAM_FINAL_DEBOUNCE_MS,
      Number.isFinite(configured) ? configured : 0
    );
  }

  notifyTurnFinished(state) {
    if (!state || state.turnFinishedNotified) return;
    state.turnFinishedNotified = true;
    notifyMessageTurnFinished(state)
      .catch((error) => {
        this.logger.warn?.('Remote turn finish callback failed:', error.message);
      })
      .finally(() => {
        this.activateNextQueuedMessage(state);
      });
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

  enqueueSegmentReply(state, text, options = {}) {
    const generation = state.segmentReplyGeneration;
    const task = (state.segmentReplyChain || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (state.stopped || generation !== state.segmentReplyGeneration) return;
        await this.safeReplySegment(state, text, options);
      })
      .catch((error) => {
        this.logger.warn?.('Remote segmented reply failed:', error.message);
      });
    state.segmentReplyChain = task;
    return task;
  }

  async safeReplySegment(state, text, options = {}) {
    const value = normalizeRolloutOutputText(text);
    const signature = remoteMessageSignature(value);
    if (!value || !signature) return;
    const kind = options.final ? 'final' : 'progress';
    const key = `${kind}:${signature}`;
    const sent = state.sentSegmentSignatures || new Set();
    state.sentSegmentSignatures = sent;
    if (sent.has(key)) return;
    sent.add(key);
    state.segmentedThisTurn = true;

    try {
      this.logger.event?.('remote.segment.sent', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session.id,
        final: Boolean(options.final),
        text: clipForLog(value)
      });
      if (typeof state.replySegment === 'function') {
        await state.replySegment({
          text: value,
          final: Boolean(options.final),
          title: options.final ? 'Remote Codex 完成' : 'Remote Codex 进度'
        });
      } else {
        await state.reply(value);
      }
      if (options.final) {
        state.lastSentReplyText = value;
        state.lastSentReplySignature = signature;
      }
    } catch (error) {
      this.logger.warn?.('Remote segment reply failed:', error.message);
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
        return true;
      }

      if (text) {
        await state.reply(text);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.warn?.('Remote panel reply failed:', error.message);
      return false;
    }
  }

  async presentNativePagePanel(state, panel, fallbackText) {
    if (typeof state.replyStream?.showPanel === 'function') {
      try {
        await state.replyStream.showPanel(panel);
        this.logger.event?.('remote.native_slash.panel.replaced', {
          pluginId: state.pluginId,
          conversationId: state.conversationId,
          sessionId: state.session?.id || '',
          command: panel?.command || '',
          kind: panel?.kind || ''
        });
        return true;
      } catch (error) {
        this.logger.warn?.('Remote native page stream panel failed:', error.message);
      }
    }
    return this.safeReplyPanel(state, panel, fallbackText);
  }

  formatStateOutput(state, data) {
    if (!state.nativeCommand) return '';
    return formatNativeSlashOutput({
      snapshot: state.session.visualViewportSnapshot || state.session.visualSnapshot,
      raw: data,
      command: state.nativeCommand.command,
      inputText: state.lastInputText,
      colorMarkers: state.pluginId === 'feishu'
    });
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
    if (!current) {
      return this.formatRunningFallback(state);
    }
    if (/(?:^|\n\n)\*\*回复\*\*/.test(current)) return current;

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

  recordParserTrace(state, payload = {}) {
    const recorder = state?.session?.outputRecorder;
    if (!recorder || typeof recorder.recordParserTrace !== 'function') return;
    try {
      recorder.recordParserTrace(
        state.session,
        buildParserTracePayload(state, payload)
      );
    } catch (error) {
      this.logger.warn?.('Parser trace capture failed:', error.message);
    }
  }

  getApprovalPrompt(state) {
    return state?.pendingRolloutApproval || null;
  }

  async presentApprovalPanel(state, panel, signature, options = {}) {
    if (!signature || signature === state.lastApprovalSignature) return true;
    if (state.approvalPanelInFlight) return false;
    if (
      !options.force &&
      signature === state.lastApprovalAttemptSignature &&
      Date.now() < Number(state.approvalPanelRetryAt || 0)
    ) {
      return false;
    }

    const fallbackText = formatPermissionPanelText(panel);
    this.clearStreamHeartbeat(state);
    state.approvalPanelInFlight = true;
    state.lastApprovalAttemptSignature = signature;
    let presented = false;
    try {
      if (state.replyStreamStarting && state.replyStreamReadyPromise) {
        await state.replyStreamReadyPromise;
      }
      if (typeof state.createApprovalPanel === 'function') {
        try {
          const callId = String(panel?.approval?.callId || panel?.approval?.id || '').trim();
          const handle = await state.createApprovalPanel({
            panel,
            callId
          });
          if (!(state.rolloutApprovalPanels instanceof Map)) {
            state.rolloutApprovalPanels = new Map();
          }
          if (callId) {
            state.rolloutApprovalPanels.set(callId, handle || {});
          }
          presented = true;
          this.logger.event?.('remote.approval.panel.created', {
            pluginId: state.pluginId,
            conversationId: state.conversationId,
            sessionId: state.session?.id || '',
            callId,
            separate: true
          });
        } catch (error) {
          this.logger.warn?.('Remote separate approval panel failed', {
            error: String(error?.message || error || 'Unknown error'),
            signature
          });
        }
      }
      if (!presented && typeof state.replyStream?.showPanel === 'function') {
        try {
          await state.replyStream.showPanel(panel);
          presented = true;
        } catch (error) {
          this.logger.warn?.('Remote approval stream panel failed', {
            error: String(error?.message || error || 'Unknown error'),
            code: error?.code || null,
            httpStatus: error?.httpStatus || null,
            signature
          });
        }
      }
      if (!presented) {
        presented = await this.safeReplyPanel(state, panel, fallbackText);
      }
      if (presented) {
        state.lastApprovalSignature = signature;
        state.approvalPanelRetryAt = 0;
      } else {
        state.approvalPanelRetryAt = Date.now() + 1000;
      }
      return presented;
    } finally {
      state.approvalPanelInFlight = false;
    }
  }

  async closeRolloutApprovalPanel(state, callId, options = {}) {
    if (!callId || !(state?.rolloutApprovalPanels instanceof Map)) return false;
    if (!state.rolloutApprovalPanels.has(callId)) return false;
    const handle = state.rolloutApprovalPanels.get(callId);
    state.rolloutApprovalPanels.delete(callId);
    if (typeof state.closeApprovalPanel !== 'function') return false;
    try {
      await state.closeApprovalPanel({
        handle,
        callId,
        completed: options.completed !== false,
        reason: options.reason || 'authorization_completed'
      });
      this.logger.event?.('remote.approval.panel.closed', {
        pluginId: state.pluginId,
        conversationId: state.conversationId,
        sessionId: state.session?.id || '',
        callId,
        reason: options.reason || 'authorization_completed'
      });
      return true;
    } catch (error) {
      this.logger.warn?.('Remote approval panel close failed', {
        callId,
        error: String(error?.message || error || 'Unknown error')
      });
      return false;
    }
  }

  closeOutstandingRolloutApprovalPanels(state, reason = 'turn_closed') {
    if (!(state?.rolloutApprovalPanels instanceof Map)) return;
    const callIds = [...state.rolloutApprovalPanels.keys()];
    for (const callId of callIds) {
      this.closeRolloutApprovalPanel(state, callId, {
        completed: false,
        reason
      }).catch(() => {});
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
      actionContext: active ? approvalPromptContext(approval) : '',
      actions: active
        ? this.buildPermissionPanelActions(approval)
        : ['tail', 'status']
    };
  }

  buildPermissionPanelActions(approval = {}) {
    const options = Array.isArray(approval?.options) ? approval.options : [];
    if (options.length === 0) return ['approve', 'deny'];
    const actions = [];
    for (let index = 0; index < options.length; index += 1) {
      const action = approvalOptionControlAction(options[index], index, options.length);
      if (action && !actions.includes(action)) actions.push(action);
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

  buildNativeChoicePanelPayload(state, pending, choice) {
    const command = normalizeNativeCodexCommand(pending?.command);
    const fullAccessConfirmation =
      command === '/permissions' &&
      String(pending?.completionAction || pending?.action || '').toLowerCase() ===
        'permission_full_access';
    const content = fullAccessConfirmation
      ? formatFullAccessConfirmationPrompt(choice)
      : formatNativeChoicePrompt(choice);
    return {
      ...this.buildNativeSlashPanelPayload(state, content),
      title: fullAccessConfirmation
        ? 'Remote Codex · 确认 Full Access'
        : `Remote Codex ${command} 确认`,
      notice: fullAccessConfirmation
        ? ''
        : 'Codex 还需要完成下一步选择，当前操作尚未结束。',
      content,
      message: content,
      actions: ['up', 'down', 'enter', 'escape'],
      actionContext: nativeChoicePromptSignature(choice),
      fallbackText: content
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
    if (state.rolloutTurn && !state.rolloutCompletionSeen && !state.rolloutFailed) {
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

  beginNativePageAction(state, action) {
    if (!state?.nativeCommand) return;
    if (state.nativePageActionTimer) {
      clearTimeout(state.nativePageActionTimer);
      state.nativePageActionTimer = null;
    }
    const command = state.nativeCommand.command;
    const normalizedAction = String(action || '').toLowerCase();
    const previous = state.nativePageAction;
    const choice = extractNativeChoicePromptFromState(state);
    const selectedChoice = choice?.options?.find((option) => option.selected)?.text || '';
    const interactiveSignature = nativeInteractivePageSignature(state, command);
    state.nativePageAction = {
      action: normalizedAction,
      completionAction: previous?.completionAction || normalizedAction,
      command,
      requestedAt: Date.now(),
      checks: 0,
      beforeSignature: nativePageSnapshotSignature(state, command),
      selectedChoice: selectedChoice || previous?.selectedChoice || '',
      cancelled: normalizedAction === 'escape' ||
        (normalizedAction === 'enter' && isCancelNativeChoice(selectedChoice)),
      followupSignature: previous?.followupSignature || interactiveSignature
    };
    this.scheduleNativePageActionCheck(state, 80);
  }

  beginNativePickerTaskRollout(state) {
    if (!state?.nativeCommand || !this.shouldUseRolloutOutput(state.pluginId)) return null;
    const definition = getNativeSlashDefinition(state.nativeCommand.command);
    if (definition?.kind !== 'picker_task' || !this.rolloutReader?.beginTurn) return null;

    const generation = Number(state.rolloutGeneration || 0);
    state.nativeTaskRolloutPending = true;
    const handle = this.rolloutReader.beginTurn({
      matchNextPrompt: true,
      cwd: state.session?.cwd || this.config.codex?.defaultCwd,
      startedAt: Date.now(),
      onEvent: (event) => this.enqueueRolloutEvent(state, generation, event),
      onError: (error) => this.enqueueRolloutFailure(state, generation, error)
    });
    state.rolloutTurn = handle;
    this.logger.event?.('remote.native_slash.task.waiting', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      command: definition.command,
      generation
    });
    return handle;
  }

  activateNativePickerTaskRollout(state, event = {}) {
    if (!state?.nativeTaskRolloutPending || !state.nativeCommand) return false;
    const definition = getNativeSlashDefinition(state.nativeCommand.command);
    if (definition?.kind !== 'picker_task') return false;

    const command = definition.command;
    if (state.nativePageActionTimer) {
      clearTimeout(state.nativePageActionTimer);
      state.nativePageActionTimer = null;
    }
    state.nativeTaskRolloutPending = false;
    state.nativePageAction = null;
    state.nativeCommand = null;
    state.outputBuffer = '';
    state.lastInputText = String(event.prompt || command);
    state.turnStartedAt = Date.now();
    state.phase = 'working';
    state.streamFinishedForTurn = false;
    state.streamClosedText = '';

    if (!state.replyStream && typeof state.replyPanel === 'function') {
      state.replyStream = this.createNativeTaskPanelStream(state, command);
    }
    const text = [
      `**${command} 已启动**`,
      '- Codex 已接受所选预设，后续进度和最终结果来自 rollout JSONL。'
    ].join('\n');
    state.lastStreamText = text;
    state.lastStreamSignature = remoteMessageSignature(text);
    state.replyStream?.replace?.(text);
    this.logger.event?.('remote.native_slash.task.bound', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      command,
      rolloutSessionId: event.sessionId || '',
      rolloutTurnId: event.turnId || ''
    });
    return true;
  }

  createNativeTaskPanelStream(state, command) {
    const completion = {
      template: 'green',
      subtitle: '已完成',
      title: `Remote Codex ${command}`
    };
    const patch = async (text, completed = false) => {
      await this.safeReplyPanel(state, {
        kind: 'native_slash',
        template: completion.template,
        title: completion.title,
        command,
        active: !completed,
        completed,
        notice: completed ? '任务已完成。' : 'Codex 正在执行所选任务。',
        content: String(text || '').trim(),
        message: String(text || '').trim(),
        actions: [],
        fallbackText: String(text || '').trim()
      }, text);
    };
    return {
      update: (text) => patch(text, false),
      replace: (text) => patch(text, false),
      finish: (text) => patch(text, true),
      setCompletionState(options = {}) {
        if (options.title) completion.title = String(options.title);
        if (options.template) completion.template = String(options.template);
        if (options.subtitle) completion.subtitle = String(options.subtitle);
      },
      unregister() {}
    };
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

    const choice = extractNativeChoicePromptFromState(state);
    if (!isNativePageActionConfirmed(state, pending, choice)) {
      if (choice) {
        if (this.autoConfirmFullAccessChoice(state, pending, choice, reason)) {
          return false;
        }
        const signature = nativeChoicePromptSignature(choice);
        if (signature && signature !== pending.followupSignature) {
          pending.followupSignature = signature;
          const panel = this.buildNativeChoicePanelPayload(state, pending, choice);
          this.presentNativePagePanel(state, panel, panel.fallbackText);
          this.logger.event?.('remote.native_slash.action.followup', {
            pluginId: state.pluginId,
            conversationId: state.conversationId,
            sessionId: state.session?.id || '',
            command: pending.command,
            action: pending.completionAction || pending.action,
            question: choice.question,
            selected: choice.options.find((option) => option.selected)?.text || '',
            reason
          });
        }
      } else {
        const signature = nativeInteractivePageSignature(state, pending.command);
        if (signature && signature !== pending.followupSignature) {
          pending.followupSignature = signature;
          const formatted = this.formatStateOutput(state, '');
          if (formatted) {
            const panel = this.buildNativeSlashPanelPayload(state, formatted);
            panel.notice = 'Codex 已进入下一步选择，当前操作尚未结束。';
            this.presentNativePagePanel(state, panel, formatted);
            this.logger.event?.('remote.native_slash.action.followup', {
              pluginId: state.pluginId,
              conversationId: state.conversationId,
              sessionId: state.session?.id || '',
              command: pending.command,
              action: pending.completionAction || pending.action,
              selected: extractGenericNativePickerFromState(state, pending.command)
                ?.options?.find((option) => option.selected)?.text || '',
              reason
            });
          }
        }
      }
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
    if (state.nativeTaskRolloutPending && !state.rolloutSessionId) {
      state.rolloutTurn?.stop?.('native_page_closed_without_task');
      state.rolloutTurn = null;
      state.nativeTaskRolloutPending = false;
    }
    const text = formatNativePageActionResult(pending, state);
    const hadStream = Boolean(state.replyStream);
    this.finishNativePageStream(state, text);
    if (!hadStream && typeof state.replyPanel === 'function') {
      const panel = {
        kind: 'native_slash',
        title: `Remote Codex ${normalizeNativeCodexCommand(pending.command)}`,
        command: normalizeNativeCodexCommand(pending.command),
        active: false,
        completed: true,
        completedAction: pending.completionAction || pending.action,
        notice: '操作已完成。',
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
      action: pending.completionAction || pending.action,
      submittedAction: pending.action,
      selectedChoice: pending.selectedChoice || '',
      cancelled: Boolean(pending.cancelled),
      reason
    });
    state.nativePageAction = null;
    state.nativeCommand = null;
    state.turnStartedAt = 0;
    state.outputBuffer = '';
    this.refreshSessionPhase(state, `native_page_${pending.action}_confirmed`);
    return true;
  }

  autoConfirmFullAccessChoice(state, pending, choice, reason = 'check') {
    if (!isFullAccessRiskConfirmation(pending, choice)) return false;
    if (pending.autoConfirmationSubmittedAt) {
      pending.checks = (pending.checks || 0) + 1;
      if (Date.now() - pending.autoConfirmationSubmittedAt < 12000) {
        this.scheduleNativePageActionCheck(
          state,
          pending.checks < 6 ? 160 : 800
        );
      }
      return true;
    }
    const selected = choice.options
      .map(normalizeApprovalOption)
      .find((option) => option.selected);
    if (!selected || !isContinueFullAccessChoice(selected.text)) return false;

    pending.autoConfirmationSubmittedAt = Date.now();
    pending.selectedChoice = selected.text;
    pending.followupSignature = nativeChoicePromptSignature(choice);
    pending.checks = 0;
    state.session.write('\r');
    this.logger.event?.('remote.native_slash.full_access.auto_confirmed', {
      pluginId: state.pluginId,
      conversationId: state.conversationId,
      sessionId: state.session?.id || '',
      command: pending.command,
      action: pending.completionAction || pending.action,
      selected: selected.text,
      reason
    });
    this.scheduleNativePageActionCheck(state, 80);
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
    if (state.visualFinalSettleTimer) {
      clearTimeout(state.visualFinalSettleTimer);
      state.visualFinalSettleTimer = null;
    }
    state.replyStream = null;
    state.replyStreamReadyPromise = null;
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
      .then(() => this.notifyTurnFinished(state))
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

  assignTurnMessage(state, message) {
    state.reply = message.reply;
    state.replyPanel = message.replyPanel;
    state.replySegment = message.replySegment;
    state.createReplyStream = message.createReplyStream;
    state.createApprovalPanel = message.createApprovalPanel;
    state.closeApprovalPanel = message.closeApprovalPanel;
    state.onTurnFinished = message.onTurnFinished;
    state.sendFile = message.sendFile;
  }

  resetPendingOutput(state) {
    state.rolloutTurn?.stop?.('new_turn');
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    if (state.streamFinishTimer) {
      clearTimeout(state.streamFinishTimer);
      state.streamFinishTimer = null;
    }
    if (state.visualFinalSettleTimer) {
      clearTimeout(state.visualFinalSettleTimer);
      state.visualFinalSettleTimer = null;
    }
    if (state.nativePageExitTimer) {
      clearTimeout(state.nativePageExitTimer);
      state.nativePageExitTimer = null;
    }
    if (state.nativePageActionTimer) {
      clearTimeout(state.nativePageActionTimer);
      state.nativePageActionTimer = null;
    }
    if (state.segmentProgressRetryTimer) {
      clearTimeout(state.segmentProgressRetryTimer);
      state.segmentProgressRetryTimer = null;
    }
    this.clearStreamHeartbeat(state);
    if (state.pendingReplyTimer) {
      clearTimeout(state.pendingReplyTimer);
      state.pendingReplyTimer = null;
    }
    if (state.replyStream && typeof state.replyStream.unregister === 'function') {
      state.replyStream.unregister();
    }
    state.outputBuffer = '';
    state.lastReplyText = '';
    state.lastStreamText = '';
    state.lastSentReplyText = '';
    state.lastReplySignature = '';
    state.lastStreamSignature = '';
    state.lastSentReplySignature = '';
    state.lastLocalNativeSlashPanelSignature = '';
    state.pendingReplyText = '';
    state.controlActionLocks = new Map();
    state.streamedThisTurn = false;
    state.segmentedThisTurn = false;
    state.streamFinishedForTurn = false;
    state.streamClosedText = '';
    state.streamAccumulatedText = '';
    state.streamRawProgressWindow = '';
    state.segmentAccumulatedText = '';
    state.segmentRawProgressWindow = '';
    state.segmentReplyChain = Promise.resolve();
    state.segmentReplyGeneration = Number(state.segmentReplyGeneration || 0) + 1;
    state.segmentProgressRetryCount = 0;
    state.currentTurnVisualAnchorSeen = false;
    state.rolloutTurn = null;
    state.rolloutGeneration = Number(state.rolloutGeneration || 0) + 1;
    state.rolloutEventChain = Promise.resolve();
    state.rolloutSessionId = '';
    state.rolloutTurnId = '';
    state.rolloutPath = '';
    state.rolloutProgressText = '';
    state.rolloutFinalText = '';
    state.rolloutFinalQueued = false;
    state.rolloutCompletionSeen = false;
    state.rolloutFinished = false;
    state.rolloutFailed = false;
    state.pendingRemoteFiles = [];
    state.remoteFilesDelivered = false;
    state.remoteFileWarnings = [];
    state.remoteFileDirectiveCount = 0;
    state.sentSegmentSignatures = new Set();
    state.nativePanelUpdateRequested = false;
    this.closeOutstandingRolloutApprovalPanels(state, 'turn_reset');
    state.pendingRolloutApproval = null;
    state.rolloutApprovalQueue = [];
    state.rolloutApprovalCallIds = new Set();
    state.completedRolloutApprovalCallIds = new Set();
    state.rolloutApprovalPanels = new Map();
    state.lastApprovalSignature = '';
    state.lastApprovalAttemptSignature = '';
    state.submittedApprovalSignature = '';
    state.submittedApprovalAt = 0;
    state.approvalPanelInFlight = false;
    state.approvalPanelRetryAt = 0;
    state.inputSource = 'remote';
    state.suppressReplyText = false;
    state.nativeCommand = null;
    state.nativePageAction = null;
    state.nativeTaskRolloutPending = false;
    state.phase = 'idle';
    state.lastOutputAt = 0;
    state.replyStream = null;
    state.replyStreamReadyPromise = null;
  }

  disposeState(state, options = {}) {
    state.stopped = true;
    this.closeOutstandingRolloutApprovalPanels(state, 'state_disposed');
    state.rolloutTurn?.stop?.('state_disposed');
    state.rolloutTurn = null;
    for (const queued of state.queuedMessages || []) {
      queued.handle?.stop?.('state_disposed');
    }
    state.queuedMessages = [];
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    if (state.streamFinishTimer) {
      clearTimeout(state.streamFinishTimer);
      state.streamFinishTimer = null;
    }
    if (state.visualFinalSettleTimer) {
      clearTimeout(state.visualFinalSettleTimer);
      state.visualFinalSettleTimer = null;
    }
    if (state.nativePageExitTimer) {
      clearTimeout(state.nativePageExitTimer);
      state.nativePageExitTimer = null;
    }
    if (state.nativePageActionTimer) {
      clearTimeout(state.nativePageActionTimer);
      state.nativePageActionTimer = null;
    }
    if (state.segmentProgressRetryTimer) {
      clearTimeout(state.segmentProgressRetryTimer);
      state.segmentProgressRetryTimer = null;
    }
    this.clearStreamHeartbeat(state);
    if (state.pendingReplyTimer) {
      clearTimeout(state.pendingReplyTimer);
      state.pendingReplyTimer = null;
    }
    if (state.dataListener) {
      state.session.off?.('data', state.dataListener);
    }
    if (state.snapshotListener) {
      state.session.off?.('snapshot', state.snapshotListener);
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
      '/status, /resume, /permission - native session pages',
      '/model, /skills, /plugins, /usage - native pickers',
      '/mcp, /ps, /diff - native reports and viewers',
      '/review - choose a review preset; results use rollout JSONL',
      '/new, /fork, /plan, /goal, /personality - native session controls',
      '/compact, /init, /side [prompt] - native tasks using the next rollout turn',
      '/codex-stop - run native /stop for background terminals',
      '/codex-approve - run native /approve for an auto-review denial',
      '/tail - show recent output',
      '/approve - approve the current Codex prompt',
      '/deny - deny/cancel the current Codex prompt',
      '/enter, /up, /down, /esc - control an interactive Codex prompt',
      '/help - show this help',
      '',
      'Remote /archive, /delete, /logout, /exit, and /quit are blocked; run them locally.',
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

async function notifyMessageTurnFinished(message) {
  if (typeof message?.onTurnFinished !== 'function') return;
  await message.onTurnFinished();
}

function extractLocalNativeSlashPanel(snapshot) {
  const normalized = String(snapshot || '')
    .split('\n')
    .map((line) => normalizeNativeLine(line));
  const status = findLocalStatusSlashPanel(normalized);
  if (!status) return null;

  const content = formatStatusSlashOutput(status.lines, '/status');
  if (!content || !isCompleteStatusSlashOutput(content)) return null;
  return {
    command: '/status',
    prompt: status.prompt,
    content
  };
}

function findLocalStatusSlashPanel(lines) {
  const normalized = Array.isArray(lines) ? lines : [];
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const prompt = normalized[index];
    if (!isStatusLikeNativeSlashPrompt(prompt)) continue;
    const titleIndex = normalized
      .slice(index + 1)
      .findIndex((line) => /^>_\s+OpenAI Codex\b/i.test(String(line || '').trim()));
    if (titleIndex < 0) continue;
    const startIndex = index + 1 + titleIndex;
    if (!hasNativeSlashPageContext(normalized, startIndex)) continue;
    const endIndex = findExternalNativeSlashPageBlockEndIndex(normalized, startIndex);
    return {
      prompt,
      lines: normalized.slice(startIndex, endIndex)
    };
  }
  return null;
}

function findExternalNativeSlashPageBlockEndIndex(lines, startIndex) {
  const title = String(lines[startIndex] || '').trim();
  const command = /^>_\s+OpenAI Codex\b/i.test(title)
    ? '/status'
    : /^Resume a previous session$/i.test(title)
      ? '/resume'
      : /^Update Model Permissions$/i.test(title)
        ? '/permissions'
        : '';
  let index = startIndex + 1;
  while (index < lines.length && isExternalNativeSlashPageBlockLine(lines[index], command)) {
    index += 1;
  }
  return index;
}

function isExternalNativeSlashPageBlockLine(line, command) {
  const value = String(line || '').trim();
  if (!value) return true;
  if (isSubmittedNativeSlashPrompt(value)) return false;
  if (command === '/status') {
    return isStatusSlashPanelLine(value);
  }
  if (command === '/resume') {
    return isResumeSlashPanelLine(value);
  }
  if (command === '/permissions') {
    return isPermissionsSlashPanelLine(value);
  }
  return false;
}

function isStatusSlashPanelLine(line) {
  const value = String(line || '').trim();
  return (
    /^Visit\s+https?:\/\/chatgpt\.com\/codex\/settings\/usage\b/i.test(value) ||
    /^information on rate limits and credits\b/i.test(value) ||
    /^(?:Model|Permissions|Directory|Session|Account|Agents\.md|Collaboration mode|5h limit|Weekly limit):/i.test(value)
  );
}

function isResumeSlashPanelLine(line) {
  const value = String(line || '').trim();
  return (
    /^Type to search\b/i.test(value) ||
    /^(?:enter resume|esc exit|ctrl\+|tab focus|←|↑|↓)/i.test(value) ||
    /^(?:[>›❯]\s*)?\d+\.\s+/.test(value) ||
    /^(?:(?:❯|>|›)\s*)?(?:just now|\d+\s*[smhdw]\s+ago|\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2}\s+\d{1,2})\s+.+/i.test(value) ||
    /^\d+\s*\/\s*\d+$/.test(value) ||
    /more\b/i.test(value)
  );
}

function isPermissionsSlashPanelLine(line) {
  const value = String(line || '').trim();
  return (
    /^(?:[>›❯]\s*)?\d+\.\s+(?:Default|Auto-review|Full Access)\b/i.test(value) ||
    /^(?:Default|Auto-review|Full Access)\b/i.test(value) ||
    /^(?:Codex can|Same workspace-write|through the auto-reviewer|approval\.|to access the internet|Exercise caution)/i.test(value) ||
    /^(?:Press enter to confirm|esc to go back|tab to focus)/i.test(value)
  );
}

function isSubmittedNativeSlashPrompt(line) {
  if (isStatusLikeNativeSlashPrompt(line)) return true;
  const value = String(line || '').trim().toLowerCase();
  return /^›\s+\/(?:status|resume|permission|permissions|perm)(?:\s|$)/.test(value);
}

function isStatusLikeNativeSlashPrompt(line) {
  const value = String(line || '').trim().toLowerCase();
  return /^›\s+\/statu(?:s)?(?:\s|$)/.test(value);
}

function hasNativeSlashPageContext(lines, index) {
  const windowText = lines
    .slice(index, Math.min(lines.length, index + 10))
    .join('\n');
  if (/^>_\s+OpenAI Codex\b/im.test(windowText)) {
    return /^(?:Model|Permissions|Directory|Session|Account|Agents\.md|Collaboration mode|5h limit|Weekly limit):/im.test(windowText);
  }
  if (/^Resume a previous session$/im.test(windowText)) {
    return /(?:enter resume|esc exit|Type to search|^\s*(?:[>›❯]\s*)?\d+\.|just now|\d+\s*[smhdw]\s+ago)/im.test(windowText);
  }
  if (/^Update Model Permissions$/im.test(windowText)) {
    return /\b(?:Default|Auto-review|Full Access)\b/i.test(windowText);
  }
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
      firstStyle: line.firstStyle || null,
      bulletStyle: line.bulletStyle || null
    };
  }

  return {
    text: String(line || '').trimEnd(),
    firstChar: '',
    firstStyle: null,
    bulletStyle: null
  };
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

const PERMISSION_MODE_DEFINITIONS = [
  { index: 1, canonical: 'Default', labels: ['Default', 'Ask for approval'] },
  { index: 2, canonical: 'Auto-review', labels: ['Auto-review', 'Approve for me'] },
  { index: 3, canonical: 'Full Access', labels: ['Full Access'] }
];
const PERMISSION_MODE_LABELS = PERMISSION_MODE_DEFINITIONS.map((mode) => mode.canonical);
const PERMISSION_MODE_LABEL_PATTERN = '(?:Default|Ask for approval|Auto-review|Approve for me|Full Access)';

function extractPermissionsPickerOptions(lines) {
  const sourceLines = Array.isArray(lines) ? lines : [];
  const titleIndex = sourceLines.findLastIndex((rawLine) =>
    /^Update Model Permissions$/i.test(normalizeNativeLine(rawLine))
  );
  const pickerLines = titleIndex >= 0 ? sourceLines.slice(titleIndex + 1) : sourceLines;

  const options = extractPickerOptions(pickerLines)
    .filter((option) => option.index >= 1 && option.index <= 3)
    .map(normalizePermissionsPickerOption)
    .filter(Boolean);
  if (
    options.length !== PERMISSION_MODE_LABELS.length ||
    options.some((option, index) =>
      option.index !== index + 1 ||
      !isPermissionModeOptionForIndex(option.text, index + 1)
    )
  ) {
    return extractCompactPermissionsPickerOptions(pickerLines);
  }
  return options;
}

function normalizePermissionsPickerOption(option) {
  const match = String(option?.text || '').match(
    /^(Default|Ask for approval|Auto-review|Approve for me|Full Access)(\s+\(current\))?(?=\s|$)\s*(.*)$/i
  );
  if (!match) return null;
  const mode = findPermissionModeDefinitionByLabel(match[1]);
  if (!mode) return null;
  const detail = [match[3], ...(option.details || [])]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  return {
    ...option,
    text: `${mode.label}${match[2] || ''}`,
    details: detail ? [detail] : []
  };
}

function extractCompactPermissionsPickerOptions(lines) {
  const optionsByIndex = new Map();
  for (const rawLine of Array.isArray(lines) ? lines : []) {
    const line = normalizeNativeLine(rawLine);
    if (!line || isNativeSlashNoiseLine(line, '/permissions')) continue;
    const option = parseCompactPermissionOption(line);
    if (!option || optionsByIndex.has(option.index)) continue;
    optionsByIndex.set(option.index, option);
  }

  if (optionsByIndex.size !== PERMISSION_MODE_LABELS.length) return [];
  const options = [...optionsByIndex.values()].sort((a, b) => a.index - b.index);
  if (
    options.some((option, index) =>
      option.index !== index + 1 ||
      !isPermissionModeOptionForIndex(option.text, index + 1)
    )
  ) {
    return [];
  }
  return options;
}

function parseCompactPermissionOption(line) {
  const match = String(line || '').match(
    new RegExp(`^(?<selected>[>›❯])?\\s*(?:[-*]\\s*)?(?<label>${PERMISSION_MODE_LABEL_PATTERN})(?<current>\\s+\\(current\\))?(?:\\s{2,}|\\s+-\\s+|\\s*$)(?<detail>.*)$`, 'i')
  );
  if (!match?.groups?.label) return null;
  const mode = findPermissionModeDefinitionByLabel(match.groups.label);
  if (!mode) return null;
  const detail = String(match.groups.detail || '').trim();
  return {
    selected: Boolean(match.groups.selected || match.groups.current),
    index: mode.index,
    text: `${mode.label}${match.groups.current || ''}`,
    details: detail ? [detail] : []
  };
}

function isPermissionModeOptionForIndex(label, index) {
  const normalized = normalizePermissionModeLabel(label);
  const mode = PERMISSION_MODE_DEFINITIONS.find((candidate) => candidate.index === index);
  return Boolean(mode && mode.labels.some((candidate) => candidate.toLowerCase() === normalized));
}

function findPermissionModeDefinitionByLabel(label) {
  const normalized = normalizePermissionModeLabel(label);
  const mode = PERMISSION_MODE_DEFINITIONS.find((candidate) =>
    candidate.labels.some((value) => value.toLowerCase() === normalized)
  );
  if (!mode) return null;
  const displayLabel = mode.labels.find((value) => value.toLowerCase() === normalized) || mode.canonical;
  return {
    ...mode,
    label: displayLabel
  };
}

function normalizePermissionModeLabel(label) {
  return String(label || '')
    .replace(/\s*\(current\)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function renderPermissionsPickerPage(options) {
  const selected = options.find((option) => option.selected);
  const lines = [
    '**权限模式**',
    `- 当前模式: \`${selected ? selected.text.replace(/\s*\(current\)\s*/i, '') : '未标记'}\``,
    '- 点击下方模式按钮开始切换；选择 Full Access 时，已识别的安全确认会自动继续。',
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
    '- 可直接选择 Ask for approval、Approve for me 或 Full Access。'
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
  const normalizedCommand = normalizeNativeCodexCommand(command);
  const pageLines = selectGenericNativePageLines(lines, normalizedCommand, inputText);
  if (normalizedCommand === '/diff' && isNativeViewerVisible(pageLines, normalizedCommand)) {
    return formatNativeDiffViewer(pageLines);
  }

  const picker = extractGenericNativePicker(pageLines, normalizedCommand);
  if (picker) {
    const intro = [picker.title, ...picker.description].filter(Boolean).join(' ');
    return renderPickerPage({
      title: `**${normalizedCommand}**`,
      intro: intro || '选择一个选项。',
      options: picker.options,
      pageSize: 10,
      footer: '使用卡片中的上移/下移/确认操作，或发送 `/up`、`/down`、`/enter`；发送 `/esc` 退出。'
    });
  }

  const useful = selectUsefulNativeLines(pageLines, normalizedCommand, inputText)
    .filter((line) => !isGenericNativeChromeLine(line));
  if (useful.length === 0) {
    if (hasNativeIdlePrompt(lines.join('\n'), normalizedCommand)) {
      if (hasActiveVisualIndicators(lines.join('\n'))) {
        return [
          `**${normalizedCommand}**`,
          '- Codex 正在完成命令后的初始化，请稍候。'
        ].join('\n');
      }
      return [
        `**${normalizedCommand}**`,
        '- Codex 已执行该命令并返回输入界面。'
      ].join('\n');
    }
    return '';
  }

  const title = options.title || `**${normalizedCommand || 'Codex'}**`;
  return [title, ...useful.slice(0, 80).map((line) => `- ${line}`)].join('\n');
}

function selectGenericNativePageLines(lines, command, inputText = '') {
  const source = Array.isArray(lines) ? lines : [];
  const commandText = normalizeNativeComparableText(command);
  const input = normalizeNativeComparableText(inputText || command);
  let startIndex = -1;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const comparable = normalizeNativeComparableText(source[index]);
    if (comparable === commandText || comparable === input) {
      startIndex = index;
      break;
    }
  }
  if (startIndex >= 0) return source.slice(startIndex + 1);

  const tipIndex = source.findLastIndex((line) => /^\s*Tip:/i.test(normalizeNativeLine(line)));
  return tipIndex >= 0 ? source.slice(tipIndex + 1) : source;
}

function extractGenericNativePicker(lines, command = '') {
  const source = Array.isArray(lines) ? lines : [];
  const options = extractPickerOptions(source);
  if (options.length === 0 || !options.some((option) => option.selected)) return null;

  const firstOptionIndex = source.findIndex((line) =>
    /^(?:[>›❯]\s*)?\d+[.)]\s+/.test(normalizeNativeLine(line))
  );
  if (firstOptionIndex < 0) return null;
  const lastOptionIndex = source.findLastIndex((line) =>
    /^(?:[>›❯]\s*)?\d+[.)]\s+/.test(normalizeNativeLine(line))
  );
  if (hasIdlePromptAfterLine(source, lastOptionIndex)) return null;

  const prelude = source
    .slice(0, firstOptionIndex)
    .map((line) => normalizeNativeLine(line))
    .filter(Boolean)
    .filter((line) => !isGenericNativeChromeLine(line))
    .filter((line) => normalizeNativeComparableText(line) !== normalizeNativeComparableText(command));
  return {
    command: normalizeNativeCodexCommand(command),
    title: prelude[0] || '',
    description: prelude.slice(1),
    options
  };
}

function extractGenericNativePickerFromState(state, command = '') {
  const snapshot = String(
    state?.session?.visualViewportSnapshot ||
      state?.session?.visualSnapshot ||
      ''
  );
  const lines = selectGenericNativePageLines(
    collectNativeVisualLines(snapshot),
    command,
    state?.nativeCommand?.text || command
  );
  return extractGenericNativePicker(lines, command);
}

function nativeInteractivePageSignature(state, command = '') {
  const picker = extractGenericNativePickerFromState(state, command);
  if (picker) {
    return [
      picker.command,
      picker.title,
      ...picker.description,
      ...picker.options.map((option) =>
        `${option.selected ? '>' : '-'}${option.index}:${option.text}:${option.details.join('|')}`
      )
    ].join('|').replace(/\s+/g, ' ').trim();
  }
  const snapshot = String(
    state?.session?.visualViewportSnapshot ||
      state?.session?.visualSnapshot ||
      ''
  );
  if (isNativeViewerVisible(collectNativeVisualLines(snapshot), command)) {
    return nativePageSnapshotSignature(state, command);
  }
  return '';
}

function hasIdlePromptAfterLine(lines, index) {
  return (Array.isArray(lines) ? lines.slice(index + 1) : [])
    .map((line) => normalizeNativeLine(line))
    .some((line) => /^›(?:\s+.*)?$/.test(line) && !/^›\s*\d+[.)]/.test(line));
}

function isGenericNativeChromeLine(line) {
  const value = normalizeNativeLine(line);
  return (
    !value ||
    /^>_\s+OpenAI Codex\b/i.test(value) ||
    /^model:\s+.*\/model to change/i.test(value) ||
    /^directory:/i.test(value) ||
    /^Tip:/i.test(value) ||
    /^https?:\/\/developers\.openai\.com\/mcp\.?$/i.test(value) ||
    /^gpt-[\w.-]+\b.*[·~/]/i.test(value) ||
    /^Press enter to confirm or esc to go back$/i.test(value) ||
    /^›(?:\s+.*)?$/.test(value)
  );
}

function isNativeViewerVisible(lines, command) {
  const normalized = normalizeNativeCodexCommand(command);
  const values = (Array.isArray(lines) ? lines : [])
    .map((line) => normalizeNativeLine(line))
    .filter(Boolean);
  if (normalized === '/diff') {
    return values.some((line) => /\/\s*D\s*I\s*F\s*F\s*\//i.test(line)) ||
      values.some((line) => /^q to quit$/i.test(line));
  }
  return false;
}

function formatNativeDiffViewer(lines) {
  const body = (Array.isArray(lines) ? lines : [])
    .map((line) => String(line || '').trimEnd())
    .filter((line) => !/\/\s*D\s*I\s*F\s*F\s*\//i.test(line))
    .filter((line) => !/^\s*[─━-]+\s*\d+%\s*[─━-]*\s*$/.test(line))
    .filter((line) => !/^\s*(?:↑\/↓ to scroll|pgup\/pgdn to page|home\/end to jump|q to quit)/i.test(line))
    .slice(0, 80);
  return [
    '**/diff**',
    '',
    '```diff',
    body.join('\n').trim() || '当前没有可见差异。',
    '```',
    '',
    '使用上移、下移、上一页或下一页浏览；点击退出返回 Codex。'
  ].join('\n');
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
  const commandText = normalizeNativeComparableText(command || '');
  const input = normalizeNativeComparableText(inputText || command || '');
  const useful = [];

  for (const rawLine of lines) {
    const line = normalizeNativeLine(rawLine);
    if (!line) continue;
    const comparable = normalizeNativeComparableText(line);
    if (!comparable) continue;
    if (commandText && comparable === commandText) continue;
    if (input && comparable === input) continue;
    if (isNativeSlashNoiseLine(line, command)) continue;
    if (useful[useful.length - 1] === line) continue;
    useful.push(line);
  }

  return useful;
}

function normalizeNativeComparableText(text) {
  return normalizeNativeLine(text)
    .replace(/^[>›❯]\s*/, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
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
    .map((line) => stripTerminalRepaintArtifacts(line).trim())
    .map(normalizeStreamSignatureLine)
    .filter(Boolean)
    .join('\n');
}

function normalizeStreamSignatureLine(line) {
  const value = String(line || '').trim();
  if (isWorkingStatusLine(value)) {
    return value.replace(/\(\d+s\)/, '(elapsed)');
  }
  return value;
}

function isWorkingStatusLine(line) {
  const value = stripRemoteCodexColorMarkers(line).trim();
  return /^-\s+(?:Working|Codex 正在处理)\s+\(\d+s\)\s*$/.test(value);
}

function extractApprovalPrompt(lines) {
  const values = lines
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .filter((line) => !BOX_ONLY_PATTERN.test(line));
  const questionIndex = values.findLastIndex((line) => isApprovalQuestionLine(line));
  if (questionIndex < 0) return null;

  const before = values.slice(0, questionIndex).reverse();
  const statusLine = before.find(isApprovalStatusLine);
  const block = values.slice(questionIndex);
  const question = block[0];
  const reason = block.find((line) => /^Reason:/i.test(line)) || '';
  const commandLine = block.find((line) => /^\$\s+/.test(line)) || '';
  const options = block
    .map(parseApprovalOptionLine)
    .filter(Boolean);

  return {
    status: statusLine ? normalizeApprovalStatusLine(statusLine) : '',
    question,
    reason,
    command: commandLine.replace(/^\$\s+/, '').trim(),
    options
  };
}

function extractNativeChoicePrompt(lines) {
  const values = (Array.isArray(lines) ? lines : [])
    .map((line) => normalizeNativeLine(line))
    .filter(Boolean)
    .filter((line) => !BOX_ONLY_PATTERN.test(line));
  const questionIndex = values.findLastIndex((line) => /\?$/.test(line));
  if (questionIndex < 0) return null;

  const optionRows = values
    .map((line, index) => ({ index, option: parseApprovalOptionLine(line) }))
    .filter((row) => row.index > questionIndex && row.option);
  if (optionRows.length < 2 || !optionRows.some((row) => row.option.selected)) {
    return null;
  }

  const lastOptionIndex = optionRows.at(-1).index;
  const idlePromptAfterOptions = values
    .slice(lastOptionIndex + 1)
    .some((line) => /^›(?:\s+.*)?$/.test(line) && !/^›\s*\d+[.)]/.test(line));
  if (idlePromptAfterOptions) return null;

  const firstOptionIndex = optionRows[0].index;
  const question = values[questionIndex];
  const description = values
    .slice(questionIndex + 1, firstOptionIndex)
    .filter((line) => !isNativeSlashNoiseLine(line, ''));
  return {
    question,
    description,
    options: optionRows.map((row) => row.option)
  };
}

function formatNativeChoicePrompt(prompt) {
  if (!prompt) return '';
  const lines = ['**需要继续确认**'];
  if (prompt.question) lines.push(`- ${prompt.question}`);
  if (prompt.description?.length > 0) {
    lines.push('', prompt.description.join(' '));
  }
  if (prompt.options?.length > 0) {
    lines.push('', '**选项**');
    for (const option of prompt.options) {
      const normalized = normalizeApprovalOption(option);
      lines.push(`${normalized.selected ? '>' : '-'} ${normalized.index}. ${normalized.text}`);
    }
  }
  lines.push('', '使用上移/下移切换选择，再点击确认；点击退出会取消当前操作。');
  return lines.join('\n');
}

function formatFullAccessConfirmationPrompt(prompt) {
  if (!prompt) return '';
  const selected = prompt.options
    ?.map(normalizeApprovalOption)
    .find((option) => option.selected);
  const cancelling = isCancelNativeChoice(selected?.text || '');
  return [
    '**确认启用 Full Access**',
    '- Codex 将可以读写工作区之外的文件。',
    '- Codex 将可以执行联网命令，不再逐次请求批准。',
    '',
    '> 此模式会显著增加数据丢失、信息泄露或意外操作的风险，只应在可信任务中启用。',
    '',
    `**当前选择：${cancelling ? '取消' : '继续启用'}**`,
    '- 使用上移/下移切换，再点击确认。'
  ].join('\n');
}

function nativeChoicePromptSignature(prompt) {
  if (!prompt) return '';
  return [
    prompt.question || '',
    ...(prompt.description || []),
    ...(prompt.options || []).map(formatApprovalOptionSignature)
  ].join('|').replace(/\s+/g, ' ').trim();
}

function extractNativeChoicePromptFromState(state) {
  const snapshot = String(
    state?.session?.visualViewportSnapshot ||
      state?.session?.visualSnapshot ||
      ''
  );
  return extractNativeChoicePrompt(collectNativeVisualLines(snapshot));
}

function isCancelNativeChoice(text) {
  return /^(?:(?:cancel|no|go back|exit)\b|取消|返回|退出)/i.test(String(text || '').trim());
}

function isFullAccessRiskConfirmation(pending, prompt) {
  if (
    normalizeNativeCodexCommand(pending?.command) !== '/permissions' ||
    String(pending?.completionAction || pending?.action || '').toLowerCase() !==
      'permission_full_access'
  ) {
    return false;
  }
  if (!/^Enable full access\?$/i.test(String(prompt?.question || '').trim())) {
    return false;
  }
  const options = (prompt?.options || []).map(normalizeApprovalOption);
  return (
    options.some((option) => isContinueFullAccessChoice(option.text)) &&
    options.some((option) => isCancelNativeChoice(option.text))
  );
}

function isContinueFullAccessChoice(text) {
  return /^(?:yes,?\s+continue anyway|continue|继续(?:启用)?)(?:\b|\s|$)/i.test(
    String(text || '').trim()
  );
}

function isApprovalStatusLine(line) {
  const value = normalizeApprovalStatusLine(line);
  return /^(?:Working|Thinking|Running|Ran|Waited|Explored|Read|Edited|Updated|Checked|Applied)\b/i.test(value);
}

function normalizeApprovalStatusLine(line) {
  return stripTerminalRepaintArtifacts(String(line || ''))
    .replace(/^[•●◦○■*-]\s*/, '')
    .trim();
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

function normalizeComparableText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => stripTerminalRepaintArtifacts(line).trim())
    .filter((line) => line && !isWorkingRepaintGarbageLine(line))
    .join('\n')
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
  lines.push(`模式: ${payload.source || 'rollout_jsonl'}`);
  lines.push(`cwd: ${session.cwd || 'unknown'}`);
  if (session.id) lines.push(`id: ${session.id}`);
  if (session.cursor !== undefined) lines.push(`cursor: ${session.cursor}`);
  if (session.createdAt) lines.push(`created: ${session.createdAt}`);
  lines.push(`输出: ${payload.config?.sendOutput ? payload.config.outputMode : 'silent'}`);
  if (payload.lastInputText) lines.push(`最近输入: ${payload.lastInputText}`);
  lines.push('', '快捷命令: /resume /permission /status /tail /stop /remote-status');
  return lines.join('\n').trim();
}

function formatPermissionPanelText(payload) {
  const lines = [];
  if (payload.active && payload.approval) {
    const reason = String(payload.approval.reason || '')
      .replace(/^Reason:\s*/i, '')
      .trim();
    if (reason) lines.push(reason);
    if (payload.approval.command) {
      lines.push('', payload.approval.command);
    }
    if (lines.length === 0) {
      lines.push(payload.approval.question || payload.message || '需要确认本次操作。');
    }
    lines.push('', '发送 /approve、/always 或 /deny。');
    return lines.join('\n').trim();
  }

  if (payload.notice) lines.push(payload.notice, '');
  if (!payload.notice || payload.message !== payload.notice) {
    lines.push(payload.message || '当前没有权限状态。');
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

function isVisualSessionBusy(state) {
  if (!state || !state.turnStartedAt) return false;
  if (state.rolloutTurn && !state.rolloutCompletionSeen && !state.rolloutFailed) {
    return !state.session?.status?.().exited;
  }
  if (state.lastReplyText || state.pendingReplyText) return false;
  if (state.session?.status?.().exited) return false;
  if (isVisualTurnSettled(state) || isStaleVisualBusyState(state)) return false;
  return true;
}

function hasActiveRemoteTurn(state) {
  if (isVisualSessionBusy(state)) return true;
  if (state?.streamFinishTimer) return true;
  return Boolean(state?.replyStream && !state.streamFinishedForTurn);
}

function normalizeRolloutOutputText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^\n+|\n+$/g, '');
}

function appendRolloutSegment(previous, next) {
  const current = normalizeRolloutOutputText(previous);
  const value = normalizeRolloutOutputText(next);
  if (!value) return current;
  if (!current) return value;
  if (remoteMessageSignature(current) === remoteMessageSignature(value)) return current;
  return `${current}\n\n${value}`;
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

function isStaleVisualBusyState(state) {
  if (!state?.turnStartedAt || !state?.session) return false;
  const elapsedMs = Date.now() - Number(state.turnStartedAt || 0);
  if (elapsedMs < VISUAL_BUSY_STALE_MS) return false;
  const snapshot = state.session.visualSnapshot || state.session.visualViewportSnapshot || '';
  return hasVisibleIdlePrompt(snapshot) && !hasActiveVisualIndicators(snapshot);
}

function isApproveCommand(command) {
  return ['/approve', '/allow', '/yes', '/y'].includes(String(command || '').toLowerCase());
}

function isNativeCodexSlashCommand(command, text = '') {
  return shouldRouteAsNativePage(command, text);
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
  const selectedIndex = getCurrentPermissionModeSelectionIndex(state);
  if (!selectedIndex) {
    return buildFallbackPermissionModeInput(targetIndex);
  }
  return buildPermissionModeDeltaInput(selectedIndex, targetIndex);
}

function getCurrentPermissionModeSelectionIndex(state) {
  const options = extractPermissionsPickerOptions(collectNativeVisualLines(
    state?.session?.visualViewportSnapshot || state?.session?.visualSnapshot
  ));
  return options.find((option) => option.selected)?.index || 0;
}

function buildPermissionModeDeltaInput(selectedIndex, targetIndex) {
  const delta = targetIndex - selectedIndex;
  const arrow = delta > 0 ? '\x1b[B' : '\x1b[A';
  return `${arrow.repeat(Math.abs(delta))}\r`;
}

function buildFallbackPermissionModeInput(targetIndex) {
  if (targetIndex === 1) return `${'\x1b[A'.repeat(PERMISSION_MODE_LABELS.length - 1)}\r`;
  if (targetIndex === 2) {
    return `${'\x1b[A'.repeat(PERMISSION_MODE_LABELS.length - 1)}\x1b[B\r`;
  }
  return `${'\x1b[B'.repeat(PERMISSION_MODE_LABELS.length - 1)}\r`;
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

  let wroteNavigation = false;
  for (const token of splitNativeControlInput(input)) {
    if (token === '\r' && wroteNavigation) {
      await delay(80);
    }
    state.session.write(token);
    if (token !== '\r') {
      wroteNavigation = true;
      await delay(45);
    }
  }
}

function splitNativeControlInput(input) {
  const value = String(input || '');
  const tokens = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\x1b' && value[index + 1] === '[' && index + 2 < value.length) {
      tokens.push(value.slice(index, index + 3));
      index += 2;
      continue;
    }
    tokens.push(value[index]);
  }
  return tokens;
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

function canonicalApprovalControlAction(action) {
  const value = String(action || '').toLowerCase();
  if (['approve', 'yes'].includes(value)) return 'approve';
  if (['approve_persistent', 'always', 'persist'].includes(value)) {
    return 'approve_persistent';
  }
  if (['deny', 'escape', 'cancel', 'no'].includes(value)) return 'deny';
  return '';
}

function approvalOptionControlAction(option, index, total) {
  const explicit = canonicalApprovalControlAction(
    option?.action || option?.value || option?.key || ''
  );
  if (explicit) return explicit;

  const text = String(option?.text || option?.label || option || '').toLowerCase();
  if (
    /don't ask again|do not ask again|always approve|persistent|persist|\(p\)|总是允许|始终允许|不再询问/.test(text)
  ) {
    return 'approve_persistent';
  }
  if (/\bno\b|deny|reject|cancel|\besc\b|拒绝|取消/.test(text)) return 'deny';
  if (/\byes\b|allow|approve|proceed|continue|允许|同意|继续/.test(text)) {
    return 'approve';
  }

  if (index === 0) return 'approve';
  if (index === total - 1) return 'deny';
  return total >= 3 ? 'approve_persistent' : '';
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
    'enter',
    'viewer_exit'
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
  const callId = String(prompt.callId || prompt.id || '').trim();
  if (callId) return `rollout:${callId}`;
  return [
    prompt.question || '',
    prompt.reason || '',
    prompt.command || '',
    ...(prompt.options || []).map(formatStableApprovalOptionSignature)
  ]
    .join('|')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatStableApprovalOptionSignature(option) {
  const normalized = normalizeApprovalOption(option);
  return `${normalized.index}:${normalized.text}`;
}

function approvalPromptContext(prompt) {
  const signature = approvalPromptSignature(prompt);
  if (!signature) return '';
  return crypto.createHash('sha256').update(signature).digest('hex').slice(0, 24);
}

function normalizeNativeCodexSlashText(text) {
  return normalizeNativeSlashText(text);
}

function normalizeNativeCodexCommand(command) {
  return normalizeNativeSlashCommand(command);
}

function isNativePageActionConfirmed(state, pending, choice = null) {
  const command = normalizeNativeCodexCommand(pending?.command);
  const snapshot = String(
    state?.session?.visualViewportSnapshot ||
      state?.session?.visualSnapshot ||
      ''
  );
  if (!snapshot.trim()) return false;
  if (isNativeSlashPageVisible(snapshot, command)) return false;
  if (choice || extractNativeChoicePrompt(collectNativeVisualLines(snapshot))) {
    return false;
  }
  return hasNativeIdlePrompt(snapshot, command);
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
  if (isNativeViewerVisible(lines, normalized)) return true;
  const pageLines = selectGenericNativePageLines(lines, normalized, normalized);
  if (extractGenericNativePicker(pageLines, normalized)) return true;
  const definition = getNativeSlashDefinition(normalized);
  if (['picker', 'picker_task'].includes(definition?.kind)) {
    return lines.some((line) =>
      /^Press enter to confirm or esc to go back$/i.test(normalizeNativeLine(line))
    );
  }
  return false;
}

function isNativeCommandPageOpen(state) {
  if (!state?.nativeCommand) return false;
  const snapshot = String(
    state.session?.visualViewportSnapshot ||
      state.session?.visualSnapshot ||
      ''
  );
  return isNativeSlashPageVisible(snapshot, state.nativeCommand.command);
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
  const completionAction = String(pending?.completionAction || action).toLowerCase();
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
  if (
    command === '/permissions' &&
    isPermissionModeControlAction(completionAction) &&
    pending?.cancelled
  ) {
    return [
      '**权限模式未更改**',
      '- 已取消本次权限模式切换。',
      pending.selectedChoice ? `- 最后选择: \`${pending.selectedChoice}\`` : ''
    ].filter(Boolean).join('\n');
  }
  if (command === '/permissions' && isPermissionModeControlAction(completionAction)) {
    const mode = permissionModeActionLabel(completionAction);
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
    .filter((line) => !/^›\s+/.test(line))
    .filter((line) => !/^>_\s+OpenAI Codex/i.test(line))
    .filter((line) => !/^Already viewing\b/i.test(line))
    .filter((line) => !/\.codex\/sessions\/.*\.jsonl/i.test(line))
    .filter((line) => !/^Booting MCP server:/i.test(line))
    .filter((line) => !/^⚠\s*(?:MCP client|MCP startup)/i.test(line))
    .filter((line) => !/^Tip:/i.test(line))
    .filter((line) => !/^Use \/skills/i.test(line))
    .filter((line) => !/^type \/help/i.test(line));
  const value = lines.slice(-3).join(' / ').replace(/\s+/g, ' ').trim();
  return value ? clipForLog(value, 180) : '';
}

function shouldFinishReplyStream(state, formatted) {
  if (!formatted) return false;
  if (normalizeNativeCodexCommand(state?.nativeCommand?.command) === '/status') {
    return isCompleteStatusSlashOutput(formatted);
  }
  if (state?.nativeCommand) {
    if (isNativeCommandPageOpen(state)) return false;
    const snapshot = String(
      state.session?.visualViewportSnapshot ||
        state.session?.visualSnapshot ||
        ''
    );
    return hasNativeIdlePrompt(snapshot, state.nativeCommand.command) &&
      !hasActiveVisualIndicators(snapshot);
  }
  if (state?.shared && !state?.nativeCommand) {
    return isVisualTurnSettled(state);
  }
  return true;
}

function hasNativeIdlePrompt(snapshot, command = '') {
  const expected = normalizeNativeComparableText(command);
  return collectNativeVisualLines(snapshot)
    .map((line) => normalizeNativeLine(line))
    .filter((line) => /^›(?:\s+.*)?$/.test(line) && !/^›\s*\d+[.)]/.test(line))
    .some((line) => {
      const value = normalizeNativeComparableText(line);
      return !expected || value !== expected;
    });
}

function buildParserTracePayload(state, payload = {}) {
  const rolloutEvent = payload.rolloutEvent || null;
  const source = payload.source || (rolloutEvent ? 'rollout_jsonl' : 'native_terminal');
  const raw = String(payload.output || '');
  const formatted = String(payload.formatted || '');
  const eventText = String(rolloutEvent?.text || rolloutEvent?.finalText || '');
  const visualSnapshot = source === 'native_terminal'
    ? String(state?.session?.visualSnapshot || '')
    : '';
  const visualViewportSnapshot = source === 'native_terminal'
    ? String(state?.session?.visualViewportSnapshot || '')
    : '';

  return {
    traceVersion: 2,
    source,
    reason: payload.reason || 'output_flush',
    pluginId: state?.pluginId || '',
    conversationId: state?.conversationId || '',
    remoteKey: state?.key || '',
    phase: state?.phase || '',
    shared: Boolean(state?.shared),
    nativeCommand: state?.nativeCommand?.command || '',
    turnStartedAt: state?.turnStartedAt || 0,
    rollout: {
      sessionId: String(rolloutEvent?.sessionId || state?.rolloutSessionId || ''),
      turnId: String(rolloutEvent?.turnId || state?.rolloutTurnId || ''),
      path: state?.rolloutPath || '',
      eventType: String(rolloutEvent?.type || ''),
      timestamp: String(rolloutEvent?.timestamp || ''),
      durationMs: Number(rolloutEvent?.durationMs) || 0,
      timeToFirstTokenMs: Number(rolloutEvent?.timeToFirstTokenMs) || 0,
      textBase64: encodeUtf8Base64(eventText),
      preview: clipForLog(eventText.replace(/\s+/g, ' ').trim(), 1200)
    },
    input: {
      text: state?.lastInputText || '',
      textBase64: encodeUtf8Base64(state?.lastInputText || '')
    },
    raw: {
      bytes: Buffer.byteLength(raw, 'utf8'),
      dataBase64: encodeUtf8Base64(raw),
      preview: clipForLog(stripTerminalControls(raw).replace(/\s+/g, ' ').trim(), 1200)
    },
    visual: {
      snapshotChars: visualSnapshot.length,
      viewportChars: visualViewportSnapshot.length,
      snapshotBase64: encodeUtf8Base64(visualSnapshot),
      viewportBase64: encodeUtf8Base64(visualViewportSnapshot)
    },
    outputs: {
      formatted,
      formattedBase64: encodeUtf8Base64(formatted)
    },
    signatures: {
      formatted: payload.formattedSignature || remoteMessageSignature(formatted),
      lastReply: state?.lastReplySignature || '',
      lastStream: state?.lastStreamSignature || '',
      lastSent: state?.lastSentReplySignature || ''
    },
    decision: payload.decision || 'unknown'
  };
}

function encodeUtf8Base64(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64');
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
  return getNativeSlashActions(normalized);
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

function normalizePositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), maximum);
}

function safeRemoteFileName(filePath) {
  const name = path.basename(String(filePath || '').trim());
  return name || '未命名文件';
}

function formatPendingRemoteFiles(files) {
  return [
    '文件已经生成，正在发送：',
    '',
    ...files.map((file) => `- ${file.name}`)
  ].join('\n');
}

function appendRemoteFileWarnings(text, warnings) {
  if (!warnings?.length) return String(text || '').trim();
  return [
    String(text || '').trim(),
    '',
    '**文件未发送**',
    ...warnings.map((warning) => `- ${warning.name}: ${warning.reason}`)
  ].filter((line, index) => line || index > 0).join('\n');
}

function remoteErrorLogMeta(error, extra = {}) {
  const meta = {
    ...extra,
    error: String(error?.message || error || 'Unknown error')
  };
  if (error?.code !== undefined && error?.code !== null && error?.code !== '') {
    meta.code = error.code;
  }
  if (error?.httpStatus !== undefined && error?.httpStatus !== null) {
    meta.httpStatus = error.httpStatus;
  }
  return meta;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

module.exports = {
  RemoteSessionController,
  stripTerminalControls,
  formatNativeSlashOutput,
  isCompleteStatusSlashOutput,
  extractApprovalPrompt,
  extractNativeChoicePrompt,
  formatNativeChoicePrompt,
  formatApprovalPrompt,
  buildSubmitInput,
  buildControlInput,
  buildNativeSlashInput,
  writeNativeSlashCommand
};
