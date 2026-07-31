const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildStreamingActionFeedback,
  formatActionSubmittedNotice,
  isBlockingNativePageSubmitAction,
  isControlAckText,
  isNavigationCardAction,
  isSubmitCardAction
} = require('./cardActions');
const {
  STREAM_CONTENT_ELEMENT_ID,
  buildActionStateCard,
  buildCompletedStreamingCard,
  buildControlButtons,
  buildPanelCard,
  buildPanelFallbackText,
  buildPanelMarkdown,
  buildReplyCard,
  buildStreamingCard,
  buildStreamingPanelCard,
  buildStreamingModeConfig,
  getCompletedStreamingCardTemplate
} = require('./cardBuilders');
const {
  formatCardMarkdown
} = require('./cardMarkdown');
const { parseTextContent } = require('./messageContent');
const { FeishuReplyStream } = require('./replyStream');
const defaultLatexRenderer = require('../../latexRenderer');

const FEISHU_TEXT_CHUNK_CHARS = 3500;
const FEISHU_CARD_CHUNK_CHARS = 7000;
const FEISHU_EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000;
const FEISHU_EVENT_DEDUPE_MAX_ENTRIES = 1000;
const FEISHU_ACTION_DEBOUNCE_MS = 700;
const FEISHU_ACTION_SUBMIT_LOCK_MS = 10 * 60 * 1000;
const FEISHU_INTERACTION_SETTLE_MS = 300;
const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const FEISHU_BOT_MENU_COMMANDS = [
  { label: '状态', command: '/status' },
  { label: '历史会话', command: '/resume' },
  { label: '权限模式', command: '/permission' }
];

module.exports = {
  id: 'feishu',
  name: 'Feishu',
  description: 'Receive remote Codex commands and send notifications through Feishu.',
  modes: ['long_connection', 'custom_webhook'],
  create: (context) => new FeishuPlugin(context)
};

class FeishuPlugin {
  constructor({ config, pluginConfig, services, logger = console }) {
    this.config = config;
    this.pluginConfig = pluginConfig;
    this.services = services;
    this.logger = logger;
    this.client = null;
    this.wsClient = null;
    this.startedAt = null;
    this.startedAtMs = 0;
    this.tenantAccessToken = '';
    this.tenantAccessTokenExpiresAt = 0;
    this.scopeApplyInFlight = null;
    this.seenEventIds = new Map();
    this.cardActionLocks = new Map();
    this.replyStreamsByMessageId = new Map();
    this.latexRenderer = services?.latexRenderer || defaultLatexRenderer;
    this.latexImageKeys = new Map();
    this.connectionWaiters = new Set();
    this.lastConnectionError = '';
  }

  async start() {
    this.startedAtMs = Date.now();
    this.startedAt = new Date(this.startedAtMs).toISOString();
    if (this.pluginConfig.mode !== 'long_connection') {
      return;
    }

    if (!this.pluginConfig.appId || !this.pluginConfig.appSecret) {
      throw new Error('Feishu appId and appSecret are required for long connection mode.');
    }

    const Lark = this.services?.larkSdk || requireLarkSdk();
    const baseConfig = {
      appId: this.pluginConfig.appId,
      appSecret: this.pluginConfig.appSecret
    };

    this.client = new Lark.Client(baseConfig);
    this.wsClient = new Lark.WSClient({
      ...baseConfig,
      loggerLevel: Lark.LoggerLevel?.info,
      autoReconnect: true,
      handshakeTimeoutMs: 15000,
      onReady: () => this.handleConnectionReady('ready'),
      onError: (error) => this.handleConnectionError(error),
      onReconnecting: () => {
        this.logger.event?.('feishu.connection.reconnecting', {
          appId: maskForLog(this.pluginConfig.appId)
        });
      },
      onReconnected: () => this.handleConnectionReady('reconnected')
    });

    const dispatcherOptions = {};
    if (this.pluginConfig.encryptKey) {
      dispatcherOptions.encryptKey = this.pluginConfig.encryptKey;
    }
    if (this.pluginConfig.verificationToken) {
      dispatcherOptions.verificationToken = this.pluginConfig.verificationToken;
    }

    const eventDispatcher = new Lark.EventDispatcher(dispatcherOptions).register({
      'im.message.receive_v1': async (data) => this.handleReceiveMessage(data),
      'card.action.trigger': async (data) => this.handleCardAction(data)
    });

    this.wsClient.start({ eventDispatcher });
    await this.sendStartupNotice();
  }

  async stop() {
    if (this.wsClient) {
      await this.wsClient.close?.();
      this.wsClient = null;
    }
    this.resolveConnectionWaiters(false);
  }

  getStatus() {
    return {
      mode: this.pluginConfig.mode,
      startedAt: this.startedAt,
      startedAtMs: this.startedAtMs,
      hasClient: Boolean(this.client),
      hasWebsocket: Boolean(this.wsClient),
      connection: this.wsClient?.getConnectionStatus?.() || { state: 'idle' },
      lastConnectionError: this.lastConnectionError
    };
  }

  waitUntilConnected(timeoutMs = 15000) {
    const state = this.wsClient?.getConnectionStatus?.().state || 'idle';
    if (state === 'connected') return Promise.resolve(true);
    if (state === 'failed' || !this.wsClient) return Promise.resolve(false);

    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.connectionWaiters.delete(waiter);
        resolve(false);
      }, Math.max(1, Number(timeoutMs) || 15000));
      this.connectionWaiters.add(waiter);
    });
  }

  handleConnectionReady(kind) {
    this.lastConnectionError = '';
    this.logger.event?.(`feishu.connection.${kind}`, {
      appId: maskForLog(this.pluginConfig.appId)
    });
    this.resolveConnectionWaiters(true);
  }

  handleConnectionError(error) {
    this.lastConnectionError = String(error?.message || error || 'Unknown connection error');
    this.logger.warn?.('Feishu long connection failed', {
      appId: maskForLog(this.pluginConfig.appId),
      error: this.lastConnectionError
    });
    this.logger.event?.('feishu.connection.failed', {
      appId: maskForLog(this.pluginConfig.appId),
      error: this.lastConnectionError
    });
    this.resolveConnectionWaiters(false);
  }

  resolveConnectionWaiters(connected) {
    const waiters = [...this.connectionWaiters];
    this.connectionWaiters.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(Boolean(connected));
    }
  }

  async invoke(action, payload = {}) {
    if (action === 'test') {
      const text = payload.text || 'Remote Codex Feishu test message.';
      await this.sendText({
        receiveId: payload.receiveId || this.pluginConfig.defaultChatId,
        receiveIdType: payload.receiveIdType || 'chat_id',
        text
      });
      return { ok: true };
    }

    throw new Error(`Unknown Feishu action: ${action}`);
  }

  async handleReceiveMessage(data) {
    const message = normalizeMessage(data);
    if (!message.text) return;
    this.logger.event?.('feishu.message.received', {
      chatId: message.chatId,
      messageId: message.messageId,
      senderOpenId: message.senderOpenId,
      text: clipForLog(message.text)
    });
    if (this.isHistoricalMessage(message)) {
      this.logger.event?.('feishu.message.ignored_historical', {
        chatId: message.chatId,
        messageId: message.messageId,
        senderOpenId: message.senderOpenId,
        createTimeMs: message.createTimeMs,
        startedAtMs: this.startedAtMs
      });
      return;
    }
    if (this.isDuplicateEvent(message.messageId)) {
      this.logger.event?.('feishu.message.duplicate', {
        chatId: message.chatId,
        messageId: message.messageId,
        senderOpenId: message.senderOpenId
      });
      return;
    }

    const rejected = this.getAuthorizationError(message);
    if (rejected) {
      this.logger.warn?.('Feishu message rejected', {
        chatId: message.chatId,
        senderOpenId: message.senderOpenId,
        reason: rejected
      });
      await this.sendText({
        receiveId: message.chatId,
        receiveIdType: 'chat_id',
        text: rejected
      });
      return;
    }

    const text = this.normalizeCommandText(message);
    if (!text) return;
    this.logger.event?.('feishu.message.accepted', {
      chatId: message.chatId,
      messageId: message.messageId,
      senderOpenId: message.senderOpenId,
      text: clipForLog(text)
    });
    this.addAckReaction(message).catch((error) => {
      this.logger.warn?.('Feishu ack reaction failed', {
        messageId: message.messageId,
        emojiType: normalizeReactionEmoji(this.pluginConfig.ackReactionEmoji || '了解'),
        error: error.message
      });
    });

    this.dispatchRemoteMessage(message, text).catch((error) =>
      this.handleRemoteDispatchError(message, error)
    );
  }

  async addAckReaction(message) {
    if (!this.pluginConfig.ackReactionEnabled) return;
    if (this.pluginConfig.mode === 'custom_webhook') return;
    if (!message?.messageId) return;

    const emojiType = normalizeReactionEmoji(this.pluginConfig.ackReactionEmoji || '了解');
    if (!emojiType) return;
    try {
      await this.addMessageReaction({
        messageId: message.messageId,
        emojiType
      });
    } catch (error) {
      const fallbackEmojiType = 'OK';
      if (emojiType === fallbackEmojiType) {
        throw error;
      }
      this.logger.warn?.('Feishu ack reaction failed, retrying fallback', {
        messageId: message.messageId,
        emojiType,
        fallbackEmojiType,
        error: error.message
      });
      await this.addMessageReaction({
        messageId: message.messageId,
        emojiType: fallbackEmojiType
      });
    }
  }

  async addDoneReaction(message) {
    if (!this.pluginConfig.doneReactionEnabled) return;
    if (this.pluginConfig.mode === 'custom_webhook') return;
    if (!message?.messageId) return;

    const emojiType = normalizeReactionEmoji(this.pluginConfig.doneReactionEmoji || 'DONE');
    if (!emojiType) return;
    try {
      await this.addMessageReaction({
        messageId: message.messageId,
        emojiType
      });
    } catch (error) {
      this.logger.warn?.('Feishu done reaction failed:', error.message);
    }
  }

  async addMessageReaction({ messageId, emojiType }) {
    const response = await fetch(
      `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.getTenantAccessToken()}`,
          'content-type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({
          reaction_type: {
            emoji_type: emojiType
          }
        })
      }
    );

    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.code) {
      throw new Error(
        `Feishu reaction failed: ${response.status} ${result.code || ''} ${result.msg || ''}`.trim()
      );
    }
    this.logger.event?.('feishu.message.ack_reaction', {
      messageId,
      emojiType
    });
    return result;
  }

  async dispatchRemoteMessage(message, text) {
    await this.services.remoteController.handleMessage({
      pluginId: 'feishu',
      conversationId: message.chatId || message.senderOpenId,
      userId: message.senderOpenId,
      text,
      reply: async (replyText) => {
        await this.sendReply({
          receiveId: message.chatId,
          receiveIdType: 'chat_id',
          text: replyText
        });
      },
      replyPanel: async (panel) => {
        await this.sendPanel({
          receiveId: message.chatId,
          receiveIdType: 'chat_id',
          panel
        });
      },
      replySegment: async ({ text: segmentText, final = false, title = '' } = {}) => {
        await this.sendReply({
          receiveId: message.chatId,
          receiveIdType: 'chat_id',
          text: segmentText,
          template: final ? 'green' : 'blue',
          title: title || (final ? 'Remote Codex 完成' : 'Remote Codex 进度')
        });
      },
      sendFile: this.pluginConfig.mode === 'long_connection'
        ? async ({ path: filePath, name, size }) => {
          await this.sendFile({
            receiveId: message.chatId,
            receiveIdType: 'chat_id',
            filePath,
            fileName: name,
            size
          });
        }
        : undefined,
      onTurnFinished: async () => {
        await this.addDoneReaction(message);
      },
      createReplyStream: async ({ title, initialText, controlMode } = {}) => {
        if (!this.pluginConfig.streaming) {
          this.logger.event?.('feishu.stream.skipped', {
            chatId: message.chatId,
            reason: 'streaming_disabled',
            controlMode
          });
          return null;
        }
        if (this.pluginConfig.mode !== 'long_connection') {
          this.logger.event?.('feishu.stream.skipped', {
            chatId: message.chatId,
            reason: 'not_long_connection',
            mode: this.pluginConfig.mode,
            controlMode
          });
          return null;
        }
        return this.createReplyStream({
          receiveId: message.chatId,
          receiveIdType: 'chat_id',
          title: title || 'Remote Codex',
          initialText: initialText === undefined ? 'Generating...' : initialText,
          controlMode
        });
      }
    });
  }

  async handleRemoteDispatchError(message, error) {
    this.logger.warn?.('Feishu message handling failed:', error.message);
    try {
      await this.sendText({
        receiveId: message.chatId,
        receiveIdType: 'chat_id',
        text: error.message
      });
    } catch (sendError) {
      this.logger.warn?.('Feishu error reply failed:', sendError.message);
    }
  }

  isDuplicateEvent(eventId) {
    if (!eventId) return false;

    const now = Date.now();
    for (const [id, seenAt] of this.seenEventIds) {
      if (
        now - seenAt > FEISHU_EVENT_DEDUPE_TTL_MS ||
        this.seenEventIds.size > FEISHU_EVENT_DEDUPE_MAX_ENTRIES
      ) {
        this.seenEventIds.delete(id);
      }
    }

    const seenAt = this.seenEventIds.get(eventId);
    this.seenEventIds.set(eventId, now);
    return Boolean(seenAt && now - seenAt <= FEISHU_EVENT_DEDUPE_TTL_MS);
  }

  isHistoricalMessage(message) {
    return Boolean(
      this.startedAtMs &&
      (
        !message?.createTimeMs ||
        message.createTimeMs <= this.startedAtMs
      )
    );
  }

  async sendStartupNotice() {
    const receiveIds = [
      this.pluginConfig.defaultChatId,
      ...(this.pluginConfig.allowedChatIds || [])
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index);
    const text = [
      'Remote Codex 已启动。',
      '仅处理此消息之后发送的新指令；启动前的历史消息不会执行。',
      `常用命令：${formatBotMenuCommandSummary()}。`,
      '机器人单聊可在飞书开发者后台配置悬浮菜单，点击后直接发送以上命令。'
    ].join('\n');

    for (const receiveId of receiveIds) {
      try {
        await this.sendText({
          receiveId,
          receiveIdType: 'chat_id',
          text
        });
      } catch (error) {
        this.logger.warn?.('Feishu startup notice failed:', {
          receiveId,
          error: error.message
        });
      }
    }
  }

  async handleCardAction(data) {
    const action = normalizeCardAction(data);
    if (!action.remoteAction) return;

    this.logger.event?.('feishu.card.action', {
      chatId: action.chatId,
      messageId: action.messageId,
      operatorOpenId: action.operatorOpenId,
      action: action.remoteAction,
      page: action.page
    });
    const actionEventId = shouldDedupeCardAction(action.remoteAction) && action.messageId
      ? `card:${action.messageId}:${action.operatorOpenId}:${action.remoteAction}`
      : '';
    if (this.isDuplicateEvent(actionEventId)) {
      this.logger.event?.('feishu.card.duplicate', {
        chatId: action.chatId,
        messageId: action.messageId,
        operatorOpenId: action.operatorOpenId,
        action: action.remoteAction
      });
      return;
    }
    if (!this.acquireCardActionLock(action)) {
      this.logger.event?.('feishu.card.action.buffered', {
        chatId: action.chatId,
        messageId: action.messageId,
        operatorOpenId: action.operatorOpenId,
        action: action.remoteAction
      });
      return;
    }

    const rejected = this.getAuthorizationError({
      chatId: action.chatId,
      senderOpenId: action.operatorOpenId
    });
    if (rejected) {
      this.logger.warn?.('Feishu card action rejected', {
        chatId: action.chatId,
        operatorOpenId: action.operatorOpenId,
        reason: rejected
      });
      if (action.chatId) {
        await this.sendText({
          receiveId: action.chatId,
          receiveIdType: 'chat_id',
          text: rejected
        });
      }
      return;
    }

    const command = `/${action.remoteAction}`;
    await this.updateActionCardFeedback(action);
    try {
      await this.services.remoteController.handleMessage({
        pluginId: 'feishu',
        conversationId: action.chatId || action.operatorOpenId,
        userId: action.operatorOpenId,
        pageContext: action.page,
        text: command,
        reply: async (replyText) => {
          if (!action.chatId) return;
          if (action.messageId && isControlAckText(replyText)) {
            if (this.replyStreamsByMessageId.has(action.messageId)) {
              return;
            }
            await this.updateActionCardState(action, {
              status: 'submitted',
              text: replyText
            });
            return;
          }
          await this.sendReply({
            receiveId: action.chatId,
            receiveIdType: 'chat_id',
            text: replyText
          });
        },
        replyPanel: async (panel) => {
          if (!action.chatId) return;
          if (action.messageId && isPatchablePanel(panel)) {
            await this.updateActionCardState(action, {
              status: 'panel',
              panel
            });
            if (panel.active && Array.isArray(panel.actions) && panel.actions.length > 0) {
              this.releaseCardSubmitLock(action);
            }
            return;
          }
          await this.sendPanel({
            receiveId: action.chatId,
            receiveIdType: 'chat_id',
            panel
          });
        },
        onTurnFinished: async () => {
          if (action.messageId) {
            await this.addDoneReaction({ messageId: action.messageId });
          }
        },
        createReplyStream: async ({ title, initialText, controlMode } = {}) => {
          if (!action.chatId) return null;
          if (!this.pluginConfig.streaming) {
            this.logger.event?.('feishu.stream.skipped', {
              chatId: action.chatId,
              messageId: action.messageId,
              reason: 'streaming_disabled',
              controlMode
            });
            return null;
          }
          if (this.pluginConfig.mode !== 'long_connection') {
            this.logger.event?.('feishu.stream.skipped', {
              chatId: action.chatId,
              messageId: action.messageId,
              reason: 'not_long_connection',
              mode: this.pluginConfig.mode,
              controlMode
            });
            return null;
          }
          return this.createReplyStream({
            receiveId: action.chatId,
            receiveIdType: 'chat_id',
            title: title || 'Remote Codex',
            initialText: initialText === undefined ? 'Generating...' : initialText,
            controlMode
          });
        }
      });
    } catch (error) {
      this.logger.warn?.('Feishu card action handling failed:', error.message);
      if (action.chatId) {
        await this.sendText({
          receiveId: action.chatId,
          receiveIdType: 'chat_id',
          text: error.message
        });
      }
    }
  }

  acquireCardActionLock(action) {
    const now = Date.now();
    for (const [key, lock] of this.cardActionLocks) {
      if (now - lock.at > lock.ttlMs) {
        this.cardActionLocks.delete(key);
      }
    }

    const scopeKey = action.messageId
      ? `message:${action.messageId}`
      : `chat:${action.chatId}:${action.operatorOpenId}`;
    const submit = isSubmitCardAction(action.remoteAction);
    const submitKey = `${scopeKey}:submit`;
    const actionKey = `${scopeKey}:action:${action.remoteAction}`;

    if (submit && this.cardActionLocks.has(submitKey)) {
      return false;
    }

    const actionLock = this.cardActionLocks.get(actionKey);
    if (actionLock && now - actionLock.at <= actionLock.ttlMs) {
      return false;
    }

    this.cardActionLocks.set(actionKey, {
      at: now,
      ttlMs: FEISHU_ACTION_DEBOUNCE_MS
    });
    if (submit) {
      this.cardActionLocks.set(submitKey, {
        at: now,
        ttlMs: FEISHU_ACTION_SUBMIT_LOCK_MS
      });
    }
    return true;
  }

  releaseCardSubmitLock(action) {
    const scopeKey = action.messageId
      ? `message:${action.messageId}`
      : `chat:${action.chatId}:${action.operatorOpenId}`;
    this.cardActionLocks.delete(`${scopeKey}:submit`);
  }

  async updateActionCardState(action, options = {}) {
    if (!action.messageId || this.pluginConfig.mode === 'custom_webhook') return;

    const card = options.panel
      ? buildPanelCard({
          ...options.panel,
          notice:
            options.panel.notice ||
            (
              isNavigationCardAction(action.remoteAction)
                ? ''
                : formatActionSubmittedNotice(action.remoteAction)
            )
        })
      : buildActionStateCard({
          action: action.remoteAction,
          page: action.page,
          text: options.text,
          status: options.status
        });

    try {
      await this.patchMessageCard({
        messageId: action.messageId,
        card
      });
    } catch (error) {
      this.logger.warn?.('Feishu card action update failed:', error.message);
    }
  }

  async updateActionCardFeedback(action) {
    if (isNavigationCardAction(action.remoteAction)) {
      return;
    }
    const stream = this.replyStreamsByMessageId.get(action.messageId);
    if (stream) {
      const showFeedback = () => {
        return stream.showActionFeedback(action.remoteAction, action.page).catch((error) => {
          this.logger.warn?.('Feishu stream action feedback failed', {
            error: String(error?.message || error || 'Unknown error'),
            code: error?.code || null,
            httpStatus: error?.httpStatus || null,
            action: action.remoteAction,
            messageId: action.messageId
          });
        });
      };
      if (stream.panelActive) {
        setTimeout(showFeedback, FEISHU_INTERACTION_SETTLE_MS).unref?.();
      } else {
        await showFeedback();
      }
      return;
    }
    if (isBlockingNativePageSubmitAction(action.remoteAction)) {
      await this.updateActionCardState(action, {
        status: 'submitted'
      });
      return;
    }
    await this.updateActionCardState(action, {
      status: 'submitted'
    });
  }

  async patchMessageCard({ messageId, card }) {
    if (!messageId) return;
    const client = this.client || new (requireLarkSdk().Client)({
      appId: this.pluginConfig.appId,
      appSecret: this.pluginConfig.appSecret
    });
    const api = client.im?.v1?.message || client.im?.message;
    if (!api?.patch) {
      throw new Error('The installed Feishu SDK does not expose im message patch API.');
    }
    await api.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) }
    });
  }

  getAuthorizationError(message) {
    const allowedOpenIds = this.pluginConfig.allowedOpenIds || [];
    const allowedChatIds = this.pluginConfig.allowedChatIds || [];

    if (allowedOpenIds.length > 0 && !allowedOpenIds.includes(message.senderOpenId)) {
      return 'This Feishu user is not allowed to control Codex.';
    }

    if (allowedChatIds.length > 0 && !allowedChatIds.includes(message.chatId)) {
      return 'This Feishu chat is not allowed to control Codex.';
    }

    return '';
  }

  normalizeCommandText(message) {
    let text = String(message.text || '').trim();
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];

    if (this.pluginConfig.requireMention && mentions.length === 0) {
      return '';
    }

    if (this.pluginConfig.requireMention) {
      const hasMentionText = mentions.some((mention) =>
        getMentionMatchTokens(mention).some((token) => token && text.includes(token))
      );
      if (!hasMentionText) return '';
    }

    for (const mention of mentions) {
      for (const token of getMentionStripTokens(mention)) {
        if (token) {
          text = removeMentionToken(text, token).trim();
        }
      }
    }

    return text;
  }

  async sendText({ receiveId, receiveIdType = 'chat_id', text }) {
    const chunks = splitMessage(text, FEISHU_TEXT_CHUNK_CHARS);
    this.logger.event?.('feishu.message.send', {
      receiveId,
      receiveIdType,
      chunks: chunks.length,
      text: clipForLog(text)
    });

    if (this.pluginConfig.mode === 'custom_webhook') {
      for (const chunk of chunks) {
        await sendCustomWebhookText({
          webhookUrl: this.pluginConfig.customWebhookUrl,
          secret: this.pluginConfig.customWebhookSecret,
          text: chunk
        });
      }
      return;
    }

    if (!receiveId) {
      throw new Error('Feishu receive id is required.');
    }

    const client = this.client || new (requireLarkSdk().Client)({
      appId: this.pluginConfig.appId,
      appSecret: this.pluginConfig.appSecret
    });

    for (const chunk of chunks) {
      await sendAppMessage(client, {
        receiveId,
        receiveIdType,
        text: chunk
      });
    }
  }

  async sendFile({
    receiveId,
    receiveIdType = 'chat_id',
    filePath,
    fileName,
    size = 0
  }) {
    if (this.pluginConfig.mode !== 'long_connection') {
      throw new Error('飞书自定义 Webhook 模式不支持文件上传。');
    }
    if (!receiveId) {
      throw new Error('Feishu receive id is required.');
    }

    const name = String(fileName || path.basename(String(filePath || ''))).trim();
    if (!filePath || !name) {
      throw new Error('Feishu file path and name are required.');
    }
    const client = this.client || new (requireLarkSdk().Client)({
      appId: this.pluginConfig.appId,
      appSecret: this.pluginConfig.appSecret
    });
    this.logger.event?.('feishu.file.upload.started', {
      receiveId,
      receiveIdType,
      name,
      size: Number(size) || 0,
      fileType: inferFeishuFileType(name)
    });

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const file = fs.createReadStream(filePath);
      try {
        const uploaded = await uploadAppFile(client, {
          file,
          fileName: name,
          fileType: inferFeishuFileType(name)
        });
        const fileKey = String(
          uploaded?.data?.file_key || uploaded?.file_key || ''
        ).trim();
        if (!fileKey) {
          throw new Error('Feishu file upload did not return file_key.');
        }
        const sent = await sendAppFileMessage(client, {
          receiveId,
          receiveIdType,
          fileKey
        });
        if (sent?.code) {
          throw new Error(`Feishu send file failed: ${sent.code} ${sent.msg || ''}`.trim());
        }
        this.logger.event?.('feishu.file.sent', {
          receiveId,
          receiveIdType,
          name,
          size: Number(size) || 0,
          messageId: extractCreatedMessageId(sent)
        });
        return sent;
      } catch (error) {
        if (attempt === 1 && isLikelyPermissionError(error)) {
          await this.applyMissingScopesIfNeeded(error);
          continue;
        }
        throw error;
      } finally {
        file.destroy();
      }
    }
    throw new Error('Feishu file upload failed.');
  }

  async sendReply({
    receiveId,
    receiveIdType = 'chat_id',
    text,
    template = 'blue',
    title = 'Remote Codex'
  }) {
    if (this.pluginConfig.mode === 'custom_webhook') {
      await this.sendCardOrText({ receiveId, receiveIdType, text, template, title });
      return;
    }

    await this.sendCardOrText({ receiveId, receiveIdType, text, template, title });
  }

  async prepareFinalCardContent(text) {
    const value = String(text || '').trim();
    if (!value || this.pluginConfig.latexRenderingEnabled === false) {
      return { text: value, elements: null, formulaCount: 0 };
    }

    const nodes = this.latexRenderer.parseLatexContent(value);
    const formulaNodes = nodes.filter((node) => node.type !== 'markdown');
    if (formulaNodes.length === 0) {
      return { text: value, elements: null, formulaCount: 0 };
    }

    const maxFormulas = Math.max(1, Number(this.pluginConfig.latexMaxFormulas) || 64);
    const elements = [];
    let renderedCount = 0;
    let cappedCount = 0;
    let failedCount = 0;
    for (const node of nodes) {
      if (node.type === 'markdown') {
        appendMarkdownElement(elements, node.text);
        continue;
      }

      if (this.pluginConfig.mode === 'custom_webhook' || renderedCount >= maxFormulas) {
        if (renderedCount >= maxFormulas) cappedCount += 1;
        appendMarkdownElement(elements, buildLatexFallback(node));
        continue;
      }

      try {
        const rendered = node.type === 'inline_formula_line'
          ? await this.latexRenderer.renderInlineFormulaLineToPng(node.segments)
          : await this.latexRenderer.renderLatexToPng(node.latex, {
            display: node.display !== false
          });
        const imageKey = await this.uploadLatexImage(rendered);
        elements.push(buildLatexImageElement(imageKey, node));
        renderedCount += 1;
      } catch (error) {
        failedCount += 1;
        this.logger.warn?.('Feishu LaTeX rendering failed:', error.message);
        this.logger.event?.('feishu.latex.fallback', {
          type: node.type,
          error: error.message,
          source: clipForLog(node.source || node.latex, 300)
        });
        appendMarkdownElement(elements, buildLatexFallback(node));
      }
    }

    this.logger.event?.('feishu.latex.prepared', {
      formulas: formulaNodes.length,
      rendered: renderedCount,
      limit: maxFormulas,
      capped: cappedCount,
      failed: failedCount,
      elements: elements.length
    });
    return {
      text: value,
      elements,
      formulaCount: formulaNodes.length,
      renderedCount,
      cappedCount,
      failedCount,
      summary: renderedCount > 0
        ? `Remote Codex 已完成，包含 ${renderedCount} 个公式`
        : 'Remote Codex 已完成'
    };
  }

  async uploadLatexImage(rendered) {
    const cacheKey = String(rendered?.cacheKey || '').trim();
    if (cacheKey && this.latexImageKeys.has(cacheKey)) {
      return this.latexImageKeys.get(cacheKey);
    }
    const png = Buffer.from(rendered?.png || []);
    if (png.length === 0) throw new Error('Rendered LaTeX image is empty.');
    if (png.length > 10 * 1024 * 1024) {
      throw new Error('Rendered LaTeX image exceeds the Feishu 10 MB image limit.');
    }

    const client = this.client || new (requireLarkSdk().Client)({
      appId: this.pluginConfig.appId,
      appSecret: this.pluginConfig.appSecret
    });
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const uploaded = await uploadAppImage(client, png);
        const imageKey = String(
          uploaded?.data?.image_key || uploaded?.image_key || ''
        ).trim();
        if (!imageKey) throw new Error('Feishu image upload did not return image_key.');
        if (cacheKey) rememberImageKey(this.latexImageKeys, cacheKey, imageKey);
        return imageKey;
      } catch (error) {
        lastError = error;
        if (attempt === 1 && isLikelyPermissionError(error)) {
          await this.applyMissingScopesIfNeeded(error);
          continue;
        }
        break;
      }
    }
    throw lastError || new Error('Feishu LaTeX image upload failed.');
  }

  async sendCardOrText({
    receiveId,
    receiveIdType = 'chat_id',
    text,
    template = 'blue',
    title = 'Remote Codex'
  }) {
    try {
      await this.sendCard({ receiveId, receiveIdType, text, template, title });
    } catch (error) {
      await this.applyMissingScopesIfNeeded(error);
      this.logger.warn?.('Feishu card send failed, falling back to text:', error.message);
      await this.sendText({ receiveId, receiveIdType, text });
    }
  }

  async sendPanel({ receiveId, receiveIdType = 'chat_id', panel }) {
    const enrichedPanel = {
      ...panel,
      transport: {
        plugin: 'feishu',
        mode: this.pluginConfig.mode,
        startedAt: this.startedAt,
        websocket: Boolean(this.wsClient)
      }
    };
    const fallbackText = panel?.fallbackText || buildPanelFallbackText(enrichedPanel);

    try {
      await this.sendPanelCard({ receiveId, receiveIdType, panel: enrichedPanel });
    } catch (error) {
      await this.applyMissingScopesIfNeeded(error);
      this.logger.warn?.('Feishu panel card send failed, falling back to text:', error.message);
      await this.sendText({ receiveId, receiveIdType, text: fallbackText });
    }
  }

  async sendPanelCard({ receiveId, receiveIdType = 'chat_id', panel }) {
    const card = buildPanelCard(panel);
    this.logger.event?.('feishu.panel.send', {
      receiveId,
      receiveIdType,
      kind: panel?.kind || '',
      text: clipForLog(panel?.fallbackText || buildPanelFallbackText(panel))
    });

    if (this.pluginConfig.mode === 'custom_webhook') {
      await sendCustomWebhookCard({
        webhookUrl: this.pluginConfig.customWebhookUrl,
        secret: this.pluginConfig.customWebhookSecret,
        card
      });
      return;
    }

    if (!receiveId) {
      throw new Error('Feishu receive id is required.');
    }

    const client = this.client || new (requireLarkSdk().Client)({
      appId: this.pluginConfig.appId,
      appSecret: this.pluginConfig.appSecret
    });

    await sendAppCard(client, {
      receiveId,
      receiveIdType,
      card
    });
  }

  async sendCard({
    receiveId,
    receiveIdType = 'chat_id',
    text,
    template = 'blue',
    title = 'Remote Codex'
  }) {
    const chunks = splitMessage(text, FEISHU_CARD_CHUNK_CHARS);
    this.logger.event?.('feishu.card.send', {
      receiveId,
      receiveIdType,
      chunks: chunks.length,
      text: clipForLog(text)
    });

    if (this.pluginConfig.mode === 'custom_webhook') {
      for (let index = 0; index < chunks.length; index += 1) {
        await sendCustomWebhookCard({
          webhookUrl: this.pluginConfig.customWebhookUrl,
          secret: this.pluginConfig.customWebhookSecret,
          card: buildReplyCard(chunks[index], index, chunks.length, {
            template,
            title
          })
        });
      }
      return;
    }

    if (!receiveId) {
      throw new Error('Feishu receive id is required.');
    }

    const client = this.client || new (requireLarkSdk().Client)({
      appId: this.pluginConfig.appId,
      appSecret: this.pluginConfig.appSecret
    });

    for (let index = 0; index < chunks.length; index += 1) {
      await sendAppCard(client, {
        receiveId,
        receiveIdType,
        card: buildReplyCard(chunks[index], index, chunks.length, {
          template,
          title
        })
      });
    }
  }

  async createReplyStream({
    receiveId,
    receiveIdType = 'chat_id',
    title = 'Remote Codex',
    initialText = '',
    controlMode = 'default'
  }) {
    if (!receiveId) {
      throw new Error('Feishu receive id is required.');
    }

    let created;
    try {
      const card = buildStreamingCard({ title, initialText, controlMode });
      created = await this.cardkitRequest('/cardkit/v1/cards', {
        method: 'POST',
        body: {
          type: 'card_json',
          data: JSON.stringify(card)
        }
      });
    } catch (error) {
      await this.applyMissingScopesIfNeeded(error);
      throw error;
    }
    const cardId = created.data?.card_id;
    if (!cardId) {
      throw new Error('Feishu streaming card did not return card_id.');
    }

    const client = this.client || new (requireLarkSdk().Client)({
      appId: this.pluginConfig.appId,
      appSecret: this.pluginConfig.appSecret
    });
    const sent = await sendAppCardEntity(client, {
      receiveId,
      receiveIdType,
      cardId
    });
    if (sent?.code) {
      throw new Error(`Feishu send streaming card failed: ${sent.code} ${sent.msg || ''}`.trim());
    }
    const messageId = extractCreatedMessageId(sent);

    this.logger.event?.('feishu.stream.started', {
      receiveId,
      receiveIdType,
      cardId,
      initialChars: String(initialText || '').length,
      initialText: clipForLog(initialText, 800)
    });

    const stream = new FeishuReplyStream({
      plugin: this,
      cardId,
      messageId,
      elementId: STREAM_CONTENT_ELEMENT_ID,
      title,
      completedTemplate: getCompletedStreamingCardTemplate(controlMode),
      renderLatex: controlMode === 'default',
      logger: this.logger
    });
    if (messageId) {
      this.replyStreamsByMessageId.set(messageId, stream);
    }
    return stream;
  }

  async updateStreamingContent({ cardId, elementId, text, sequence }) {
    await this.cardkitRequest(
      `/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`,
      {
        method: 'PUT',
        body: {
          content: formatCardMarkdown(text),
          sequence,
          uuid: `remote_codex_stream_${cardId}_${sequence}`
        }
      }
    );
    this.logger.event?.('feishu.stream.updated', {
      cardId,
      elementId,
      sequence,
      chars: String(text || '').length,
      text: clipForLog(text, 800)
    });
  }

  async replaceStreamingPanel({ cardId, panel, sequence }) {
    const card = buildStreamingPanelCard(panel);
    let lastSuccessfulSequence = sequence - 1;
    try {
      await this.setStreamingMode({
        cardId,
        enabled: false,
        sequence
      });
      lastSuccessfulSequence = sequence;
      await this.replaceStreamingCardEntity({
        cardId,
        card,
        sequence: sequence + 1,
        operation: 'panel'
      });
      return { sequence: sequence + 1 };
    } catch (error) {
      error.cardSequence = lastSuccessfulSequence;
      throw error;
    }
  }

  async replaceStreamingText({ cardId, title, text, sequence }) {
    const card = buildStreamingCard({
      title,
      initialText: text,
      controlMode: 'default'
    });
    await this.replaceStreamingCardEntity({
      cardId,
      card,
      sequence,
      operation: 'resume'
    });
  }

  async replaceStreamingCardEntity({ cardId, card, sequence, operation }) {
    await this.cardkitRequest(
      `/cardkit/v1/cards/${encodeURIComponent(cardId)}`,
      {
        method: 'PUT',
        body: {
          card: {
            type: 'card_json',
            data: JSON.stringify(card)
          },
          sequence,
          uuid: `remote_codex_${operation}_${cardId}_${sequence}`
        }
      }
    );
    this.logger.event?.('feishu.stream.card_replaced', {
      cardId,
      sequence,
      operation
    });
  }

  async setStreamingMode({ cardId, enabled, sequence }) {
    await this.cardkitRequest(
      `/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`,
      {
        method: 'PATCH',
        body: {
          settings: JSON.stringify({
            config: {
              streaming_mode: Boolean(enabled)
            }
          }),
          sequence,
          uuid: `remote_codex_stream_mode_${cardId}_${sequence}`
        }
      }
    );
    this.logger.event?.('feishu.stream.mode.updated', {
      cardId,
      enabled: Boolean(enabled),
      sequence
    });
  }

  async renewStreamingMode({ cardId, sequence }) {
    await this.cardkitRequest(
      `/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`,
      {
        method: 'PATCH',
        body: {
          settings: JSON.stringify({
            config: buildStreamingModeConfig()
          }),
          sequence,
          uuid: `remote_codex_stream_renew_${cardId}_${sequence}`
        }
      }
    );
    this.logger.event?.('feishu.stream.renewed', {
      cardId,
      sequence
    });
  }

  async closeStreamingCard({
    cardId,
    sequence,
    summary,
    text,
    title,
    template,
    subtitle,
    contentElements
  }) {
    const card = buildCompletedStreamingCard({
      title,
      text,
      summary,
      template,
      subtitle,
      contentElements
    });
    await this.cardkitRequest(
      `/cardkit/v1/cards/${encodeURIComponent(cardId)}`,
      {
        method: 'PUT',
        body: {
          card: {
            type: 'card_json',
            data: JSON.stringify(card)
          },
          sequence,
          uuid: `remote_codex_close_${cardId}_${sequence}`
        }
      }
    );
  }

  async cardkitRequest(path, { method, body }) {
    const response = await fetch(`${FEISHU_API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.getTenantAccessToken()}`,
        'content-type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(body)
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.code) {
      const error = new Error(
        `Feishu CardKit failed: ${response.status} ${result.code || ''} ${result.msg || ''}`.trim()
      );
      error.name = 'FeishuCardKitError';
      error.httpStatus = response.status;
      error.code = result.code || null;
      error.feishuMessage = String(result.msg || '');
      throw error;
    }
    return result;
  }

  async getTenantAccessToken() {
    const now = Date.now();
    if (this.tenantAccessToken && now < this.tenantAccessTokenExpiresAt) {
      return this.tenantAccessToken;
    }

    const response = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        app_id: this.pluginConfig.appId,
        app_secret: this.pluginConfig.appSecret
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.code) {
      throw new Error(
        `Feishu tenant token failed: ${response.status} ${result.code || ''} ${result.msg || ''}`.trim()
      );
    }

    this.tenantAccessToken = result.tenant_access_token;
    this.tenantAccessTokenExpiresAt =
      now + Math.max(60, Number(result.expire) - 120) * 1000;
    return this.tenantAccessToken;
  }

  async applyMissingScopesIfNeeded(error) {
    if (!isLikelyPermissionError(error)) return;
    if (this.scopeApplyInFlight) return this.scopeApplyInFlight;

    this.scopeApplyInFlight = this.applyMissingScopes()
      .catch((applyError) => {
        this.logger.warn?.('Feishu permission apply failed:', applyError.message);
      })
      .finally(() => {
        this.scopeApplyInFlight = null;
      });
    return this.scopeApplyInFlight;
  }

  async applyMissingScopes() {
    if (!this.pluginConfig.appId || !this.pluginConfig.appSecret) return;
    const client = this.client || new (requireLarkSdk().Client)({
      appId: this.pluginConfig.appId,
      appSecret: this.pluginConfig.appSecret
    });
    const result = await client.application.scope.apply({});
    this.logger.event?.('feishu.permission.apply', {
      code: result?.code || 0,
      msg: result?.msg || ''
    });
    if (result?.code) {
      throw new Error(`${result.code} ${result.msg || ''}`.trim());
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireLarkSdk() {
  try {
    return require('@larksuiteoapi/node-sdk');
  } catch (error) {
    throw new Error(
      'Feishu long connection requires @larksuiteoapi/node-sdk. Run `npm install` after updating dependencies.'
    );
  }
}

function normalizeMessage(data) {
  const message = data.message || {};
  const sender = data.sender || {};
  const senderId = sender.sender_id || {};

  return {
    chatId: message.chat_id || '',
    messageId: message.message_id || '',
    senderOpenId: senderId.open_id || sender.open_id || '',
    text: parseTextContent(message.content),
    mentions: Array.isArray(message.mentions) ? message.mentions : [],
    createTimeMs: normalizeFeishuTimestampMs(
      message.create_time ||
        message.createTime ||
        data.create_time ||
        data.header?.create_time
    )
  };
}

function normalizeCardAction(data) {
  const rawAction = data.action || {};
  const rawContext = data.context || {};
  const operator = data.operator || {};
  const operatorId = operator.operator_id || operator.id || {};
  const value = rawAction.value || rawAction.option || {};
  const normalizedValue = typeof value === 'string' ? parseJsonObject(value) : value;
  const remoteAction = normalizeRemoteAction(
    normalizedValue.remote_codex_action ||
      normalizedValue.action ||
      rawAction.name ||
      rawAction.tag ||
      rawAction.option
  );

  return {
    chatId:
      rawContext.open_chat_id ||
      rawContext.chat_id ||
      data.open_chat_id ||
      data.chat_id ||
      '',
    messageId:
      rawContext.open_message_id ||
      rawContext.message_id ||
      data.open_message_id ||
      data.message_id ||
      '',
    operatorOpenId:
      operatorId.open_id ||
      operator.open_id ||
      operator.openId ||
      data.open_id ||
      '',
    remoteAction,
    page: String(
      normalizedValue.remote_codex_page ||
        normalizedValue.page ||
        ''
    ).toLowerCase()
  };
}

function normalizeRemoteAction(action) {
  const value = String(action || '').toLowerCase();
  if (['approve', 'allow', 'yes', 'y'].includes(value)) return 'approve';
  if (
    [
      'approve_persistent',
      'approve-always',
      'always',
      'persist',
      'persistent',
      'p'
    ].includes(value)
  ) {
    return 'approve_persistent';
  }
  if (['deny', 'reject', 'no', 'n', 'cancel'].includes(value)) {
    return 'deny';
  }
  if (
    [
      'enter',
      'escape',
      'esc',
      'up',
      'down',
      'page_up',
      'page_down',
      'home',
      'end',
      'left',
      'right',
      'tab',
      'viewer_exit'
    ].includes(value)
  ) {
    return value === 'esc' ? 'escape' : value;
  }
  if (['permission_default', 'permission_auto_review', 'permission_full_access'].includes(value)) {
    return value;
  }
  if (['resume', 'status', 'permission', 'permissions', 'tail', 'stop', 'help', 'commands', 'menu'].includes(value)) {
    return value === 'permissions' ? 'permission' : value;
  }
  return '';
}

function normalizeReactionEmoji(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/^[\[\]【】]+|[\[\]【】]+$/g, '')
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, '');
  if (!cleaned) return '';

  const alias = REACTION_EMOJI_ALIASES.get(cleaned) || REACTION_EMOJI_ALIASES.get(cleaned.toLowerCase());
  if (alias) return alias;
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(cleaned)) {
    return cleaned.toUpperCase();
  }
  return '';
}

const REACTION_EMOJI_ALIASES = new Map([
  ['了解', 'Get'],
  ['收到', 'Get'],
  ['get', 'Get'],
  ['Get', 'Get'],
  ['GET', 'Get'],
  ['处理中', 'OnIt'],
  ['处理', 'OnIt'],
  ['onit', 'OnIt'],
  ['OnIt', 'OnIt'],
  ['yes', 'Yes'],
  ['Yes', 'Yes'],
  ['YES', 'Yes'],
  ['checkmark', 'CheckMark'],
  ['CheckMark', 'CheckMark'],
  ['CHECKMARK', 'CheckMark'],
  ['done', 'DONE'],
  ['Done', 'DONE'],
  ['DONE', 'DONE'],
  ['ok', 'OK'],
  ['Ok', 'OK'],
  ['OK', 'OK']
]);

function shouldDedupeCardAction(action) {
  return ['approve', 'approve_persistent', 'deny', 'enter', 'escape'].includes(
    String(action || '').toLowerCase()
  );
}

function isPatchablePanel(panel) {
  return ['permission', 'native_slash', 'status', 'commands'].includes(
    String(panel?.kind || '').toLowerCase()
  );
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeFeishuTimestampMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 100000000000 ? number * 1000 : number;
}

function getMentionMatchTokens(mention) {
  return [
    mention?.key,
    mention?.name,
    mention?.id?.open_id,
    mention?.id?.union_id,
    mention?.id?.user_id,
    mention?.open_id
  ]
    .flatMap((token) => {
      const value = String(token || '').trim();
      if (!value) return [];
      return value.startsWith('@') ? [value, value.slice(1)] : [value, `@${value}`];
    })
    .filter(Boolean);
}

function getMentionStripTokens(mention) {
  return [
    mention?.key,
    mention?.name ? `@${mention.name}` : '',
    mention?.id?.open_id ? `@${mention.id.open_id}` : '',
    mention?.open_id ? `@${mention.open_id}` : ''
  ]
    .map((token) => String(token || '').trim())
    .filter(Boolean);
}

function removeMentionToken(text, token) {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(token)}[ \\t]*`, 'g');
  return String(text || '').replace(pattern, '$1');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function sendAppMessage(client, { receiveId, receiveIdType, text }) {
  const payload = {
    params: {
      receive_id_type: receiveIdType
    },
    data: {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text })
    }
  };

  const api = client.im?.v1?.message || client.im?.message;
  if (!api?.create) {
    throw new Error('The installed Feishu SDK does not expose im message create API.');
  }

  return api.create(payload);
}

async function uploadAppFile(client, { file, fileName, fileType }) {
  const api = client.im?.v1?.file || client.im?.file;
  if (!api?.create) {
    throw new Error('The installed Feishu SDK does not expose im file create API.');
  }
  const result = await api.create({
    data: {
      file_type: fileType,
      file_name: fileName,
      file
    }
  });
  if (result?.code) {
    throw new Error(`Feishu file upload failed: ${result.code} ${result.msg || ''}`.trim());
  }
  return result;
}

async function uploadAppImage(client, image) {
  const api = client.im?.v1?.image || client.im?.image;
  if (!api?.create) {
    throw new Error('The installed Feishu SDK does not expose im image create API.');
  }
  const result = await api.create({
    data: {
      image_type: 'message',
      image
    }
  });
  if (result?.code) {
    throw new Error(`Feishu image upload failed: ${result.code} ${result.msg || ''}`.trim());
  }
  return result;
}

async function sendAppFileMessage(client, { receiveId, receiveIdType, fileKey }) {
  const payload = {
    params: {
      receive_id_type: receiveIdType
    },
    data: {
      receive_id: receiveId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey })
    }
  };
  const api = client.im?.v1?.message || client.im?.message;
  if (!api?.create) {
    throw new Error('The installed Feishu SDK does not expose im message create API.');
  }
  return api.create(payload);
}

function inferFeishuFileType(fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (extension === '.opus') return 'opus';
  if (extension === '.mp4') return 'mp4';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.doc' || extension === '.docx') return 'doc';
  if (extension === '.xls' || extension === '.xlsx') return 'xls';
  if (extension === '.ppt' || extension === '.pptx') return 'ppt';
  return 'stream';
}

async function sendAppCard(client, { receiveId, receiveIdType, card }) {
  const payload = {
    params: {
      receive_id_type: receiveIdType
    },
    data: {
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    }
  };

  const api = client.im?.v1?.message || client.im?.message;
  if (!api?.create) {
    throw new Error('The installed Feishu SDK does not expose im message create API.');
  }

  return api.create(payload);
}

async function sendAppCardEntity(client, { receiveId, receiveIdType, cardId }) {
  const payload = {
    params: {
      receive_id_type: receiveIdType
    },
    data: {
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify({
        type: 'card',
        data: {
          card_id: cardId
        }
      })
    }
  };

  const api = client.im?.v1?.message || client.im?.message;
  if (!api?.create) {
    throw new Error('The installed Feishu SDK does not expose im message create API.');
  }

  return api.create(payload);
}

function extractCreatedMessageId(result) {
  return String(
    result?.data?.message_id ||
    result?.data?.data?.message_id ||
    result?.message_id ||
    ''
  ).trim();
}

async function sendCustomWebhookText({ webhookUrl, secret, text }) {
  if (!webhookUrl) {
    throw new Error('Feishu custom webhook URL is required.');
  }

  const payload = {
    msg_type: 'text',
    content: { text }
  };

  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = createWebhookSign(timestamp, secret);
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Feishu webhook failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json().catch(() => ({}));
  if (body.code && body.code !== 0) {
    throw new Error(`Feishu webhook failed: ${body.code} ${body.msg || ''}`.trim());
  }
}

async function sendCustomWebhookCard({ webhookUrl, secret, card }) {
  if (!webhookUrl) {
    throw new Error('Feishu custom webhook URL is required.');
  }

  const payload = {
    msg_type: 'interactive',
    card
  };

  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = createWebhookSign(timestamp, secret);
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Feishu webhook failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json().catch(() => ({}));
  if (body.code && body.code !== 0) {
    throw new Error(`Feishu webhook failed: ${body.code} ${body.msg || ''}`.trim());
  }
}

function createWebhookSign(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto
    .createHmac('sha256', stringToSign)
    .update('')
    .digest('base64');
}

function isLikelyPermissionError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return (
    text.includes('permission') ||
    text.includes('scope') ||
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    /\b(99991663|99991664|99991672|230028|230027|200830|212001)\b/.test(text)
  );
}

function splitMessage(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return [value];

  const chunks = [];
  for (let index = 0; index < value.length; index += maxChars) {
    chunks.push(value.slice(index, index + maxChars));
  }
  return chunks;
}

function appendMarkdownElement(elements, text) {
  const value = String(text || '').trim();
  if (!value) return;
  const previous = elements.at(-1);
  if (previous?.tag === 'markdown') {
    previous.content = formatCardMarkdown(`${previous.content}\n\n${value}`);
    return;
  }
  elements.push({
    tag: 'markdown',
    content: formatCardMarkdown(value)
  });
}

function buildLatexImageElement(imageKey, node) {
  return {
    tag: 'img',
    img_key: imageKey,
    alt: {
      tag: 'plain_text',
      content: node?.type === 'inline_formula_line'
        ? '包含行内公式的文本'
        : 'LaTeX 公式'
    },
    preview: false
  };
}

function buildLatexFallback(node) {
  if (node?.type === 'inline_formula_line') {
    return `\`\`\`text\n${String(node.source || '').trim()}\n\`\`\``;
  }
  return `\`\`\`latex\n${String(node?.latex || '').trim()}\n\`\`\``;
}

function rememberImageKey(cache, key, imageKey) {
  cache.set(key, imageKey);
  while (cache.size > 128) {
    cache.delete(cache.keys().next().value);
  }
}

function clipForLog(text, max = 1200) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated]`;
}

function maskForLog(value) {
  const text = String(value || '');
  if (text.length <= 10) return text;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function formatBotMenuCommandSummary() {
  return FEISHU_BOT_MENU_COMMANDS
    .map(({ label, command }) => `${label} \`${command}\``)
    .join('、');
}

module.exports.__private = {
  FEISHU_BOT_MENU_COMMANDS,
  FeishuReplyStream,
  buildActionStateCard,
  buildControlButtons,
  buildCompletedStreamingCard,
  buildPanelCard,
  buildPanelMarkdown,
  buildStreamingActionFeedback,
  buildStreamingCard,
  buildStreamingPanelCard,
  buildStreamingModeConfig,
  formatBotMenuCommandSummary,
  formatCardMarkdown,
  parseTextContent
};
