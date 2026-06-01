const crypto = require('node:crypto');

const FEISHU_TEXT_CHUNK_CHARS = 3500;
const FEISHU_CARD_CHUNK_CHARS = 7000;
const FEISHU_EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000;
const FEISHU_EVENT_DEDUPE_MAX_ENTRIES = 1000;
const FEISHU_ACTION_DEBOUNCE_MS = 700;
const FEISHU_ACTION_SUBMIT_LOCK_MS = 10 * 60 * 1000;
const FEISHU_STREAM_FRAME_CHARS = 36;
const FEISHU_STREAM_FRAME_DELAY_MS = 70;
const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const STREAM_CONTENT_ELEMENT_ID = 'content';
const FEISHU_BOT_MENU_COMMANDS = [
  { label: '状态', command: '/status' },
  { label: '历史会话', command: '/resume' },
  { label: '权限模式', command: '/permission' }
];
const CARD_COLORS = {
  approval: 'rgba(247,201,72,1)',
  command: 'rgba(96,165,250,1)',
  error: 'rgba(255,107,107,1)',
  info: 'rgba(103,232,249,1)',
  muted: 'rgba(100,116,139,1)',
  progress: 'rgba(96,165,250,1)',
  reply: 'rgba(110,231,183,1)',
  running: 'rgba(247,201,72,1)',
  success: 'rgba(110,231,183,1)',
  warning: 'rgba(247,201,72,1)'
};
const LIGHT_CARD_COLORS = {
  approval: 'rgba(146,64,14,1)',
  command: 'rgba(29,78,216,1)',
  error: 'rgba(220,38,38,1)',
  info: 'rgba(14,116,144,1)',
  muted: 'rgba(71,85,105,1)',
  progress: 'rgba(29,78,216,1)',
  reply: 'rgba(4,120,87,1)',
  running: 'rgba(146,64,14,1)',
  success: 'rgba(4,120,87,1)',
  warning: 'rgba(180,83,9,1)'
};
const FEISHU_CARD_CUSTOM_COLORS = {
  'cus-remote-approval': {
    light_mode: LIGHT_CARD_COLORS.approval,
    dark_mode: CARD_COLORS.approval
  },
  'cus-remote-command': {
    light_mode: LIGHT_CARD_COLORS.command,
    dark_mode: CARD_COLORS.command
  },
  'cus-remote-error': {
    light_mode: LIGHT_CARD_COLORS.error,
    dark_mode: CARD_COLORS.error
  },
  'cus-remote-info': {
    light_mode: LIGHT_CARD_COLORS.info,
    dark_mode: CARD_COLORS.info
  },
  'cus-remote-muted': {
    light_mode: LIGHT_CARD_COLORS.muted,
    dark_mode: CARD_COLORS.muted
  },
  'cus-remote-progress': {
    light_mode: LIGHT_CARD_COLORS.progress,
    dark_mode: CARD_COLORS.progress
  },
  'cus-remote-reply': {
    light_mode: LIGHT_CARD_COLORS.reply,
    dark_mode: CARD_COLORS.reply
  },
  'cus-remote-running': {
    light_mode: LIGHT_CARD_COLORS.running,
    dark_mode: CARD_COLORS.running
  },
  'cus-remote-success': {
    light_mode: LIGHT_CARD_COLORS.success,
    dark_mode: CARD_COLORS.success
  },
  'cus-remote-warning': {
    light_mode: LIGHT_CARD_COLORS.warning,
    dark_mode: CARD_COLORS.warning
  }
};
const FEISHU_CARD_COLOR_TOKENS = Object.fromEntries(
  Object.entries(FEISHU_CARD_CUSTOM_COLORS)
    .flatMap(([token, modes]) => [
      [normalizeRgbaColor(modes.light_mode), token],
      [normalizeRgbaColor(modes.dark_mode), token]
    ])
);

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

    const Lark = requireLarkSdk();
    const baseConfig = {
      appId: this.pluginConfig.appId,
      appSecret: this.pluginConfig.appSecret
    };

    this.client = new Lark.Client(baseConfig);
    this.wsClient = new Lark.WSClient({
      ...baseConfig,
      loggerLevel: Lark.LoggerLevel?.info,
      autoReconnect: true
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
  }

  getStatus() {
    return {
      mode: this.pluginConfig.mode,
      startedAt: this.startedAt,
      startedAtMs: this.startedAtMs,
      hasClient: Boolean(this.client),
      hasWebsocket: Boolean(this.wsClient)
    };
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
      this.logger.warn?.('Feishu ack reaction failed:', error.message);
    });

    this.dispatchRemoteMessage(message, text).catch((error) =>
      this.handleRemoteDispatchError(message, error)
    );
  }

  async addAckReaction(message) {
    if (!this.pluginConfig.ackReactionEnabled) return;
    if (this.pluginConfig.mode === 'custom_webhook') return;
    if (!message?.messageId) return;

    const emojiType = normalizeReactionEmoji(this.pluginConfig.ackReactionEmoji || 'OK');
    if (!emojiType) return;
    await this.addMessageReaction({
      messageId: message.messageId,
      emojiType
    });
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
          initialText: initialText || 'Generating...',
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
            initialText: initialText || 'Generating...',
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
    if (isBlockingNativePageSubmitAction(action.remoteAction)) {
      await this.updateActionCardState(action, {
        status: 'submitted'
      });
      return;
    }
    const stream = this.replyStreamsByMessageId.get(action.messageId);
    if (stream) {
      stream.showActionFeedback(action.remoteAction, action.page).catch((error) => {
        this.logger.warn?.('Feishu stream action feedback failed:', error.message);
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

  async sendReply({ receiveId, receiveIdType = 'chat_id', text }) {
    if (this.pluginConfig.mode === 'custom_webhook') {
      await this.sendCardOrText({ receiveId, receiveIdType, text });
      return;
    }

    await this.sendCardOrText({ receiveId, receiveIdType, text });
  }

  async sendCardOrText({ receiveId, receiveIdType = 'chat_id', text }) {
    try {
      await this.sendCard({ receiveId, receiveIdType, text });
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

  async sendCard({ receiveId, receiveIdType = 'chat_id', text }) {
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
          card: buildReplyCard(chunks[index], index, chunks.length)
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
        card: buildReplyCard(chunks[index], index, chunks.length)
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
      cardId
    });

    const stream = new FeishuReplyStream({
      plugin: this,
      cardId,
      messageId,
      elementId: STREAM_CONTENT_ELEMENT_ID,
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
      chars: String(text || '').length
    });
  }

  async closeStreamingCard({ cardId, sequence, summary }) {
    await this.cardkitRequest(
      `/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`,
      {
        method: 'PATCH',
        body: {
          settings: JSON.stringify({
            config: {
              streaming_mode: false,
              summary: {
                content: summary || 'Remote Codex'
              }
            }
          }),
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
      throw new Error(
        `Feishu CardKit failed: ${response.status} ${result.code || ''} ${result.msg || ''}`.trim()
      );
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

class FeishuReplyStream {
  constructor({ plugin, cardId, messageId = '', elementId, logger = console }) {
    this.plugin = plugin;
    this.cardId = cardId;
    this.messageId = messageId;
    this.elementId = elementId;
    this.logger = logger;
    this.sequence = 1;
    this.currentText = '';
    this.targetText = '';
    this.closed = false;
    this.pumpPromise = null;
    this.actionFeedbackText = '';
  }

  async update(text) {
    this.actionFeedbackText = '';
    return this.setTargetText(text);
  }

  async replace(text) {
    this.actionFeedbackText = '';
    const nextText = String(text || '').trim();
    if (!nextText || this.closed) return;
    this.targetText = nextText;
    this.currentText = nextText;
    this.sequence += 1;
    await this.plugin.updateStreamingContent({
      cardId: this.cardId,
      elementId: this.elementId,
      text: nextText,
      sequence: this.sequence
    });
  }

  async showActionFeedback(action, page = '') {
    const text = buildStreamingActionFeedback({
      action,
      page,
      currentText: this.targetText || this.currentText
    });
    this.actionFeedbackText = text;
    return this.setTargetText(text);
  }

  async setTargetText(text) {
    const nextText = String(text || '').trim();
    if (!nextText || this.closed) return;
    if (nextText === this.targetText && nextText === this.currentText) return;

    this.targetText = nextText;
    if (!this.pumpPromise) {
      this.pumpPromise = this.pumpToTarget().finally(() => {
        this.pumpPromise = null;
      });
    }
    return this.pumpPromise;
  }

  async pumpToTarget() {
    while (!this.closed && this.currentText !== this.targetText) {
      const nextText = nextStreamingTextFrame(this.currentText, this.targetText);
      if (!nextText || nextText === this.currentText) break;
      this.sequence += 1;
      await this.plugin.updateStreamingContent({
        cardId: this.cardId,
        elementId: this.elementId,
        text: nextText,
        sequence: this.sequence
      });
      this.currentText = nextText;
      if (!this.closed && this.currentText !== this.targetText) {
        await delay(FEISHU_STREAM_FRAME_DELAY_MS);
      }
    }
  }

  async finish(text) {
    if (this.closed) return;
    const finalText = String(this.actionFeedbackText || text || this.currentText || '').trim();
    let finalUpdateError = null;
    await this.update(finalText).catch((error) => {
      finalUpdateError = error;
      this.logger.warn?.('Feishu stream final update failed:', error.message);
    });
    this.closed = true;
    this.sequence += 1;
    try {
      await this.plugin.closeStreamingCard({
        cardId: this.cardId,
        sequence: this.sequence,
        summary: summarizeForCard(finalText)
      });
    } catch (error) {
      if (finalUpdateError) {
        error.finalUpdateFailed = true;
      }
      throw error;
    } finally {
      this.unregister();
    }
    if (finalUpdateError) {
      finalUpdateError.finalUpdateFailed = true;
      throw finalUpdateError;
    }
    this.logger.event?.('feishu.stream.finished', {
      cardId: this.cardId,
      chars: finalText.length
    });
  }

  unregister() {
    if (this.messageId && this.plugin.replyStreamsByMessageId.get(this.messageId) === this) {
      this.plugin.replyStreamsByMessageId.delete(this.messageId);
    }
  }
}

function nextStreamingTextFrame(current, target) {
  const currentText = String(current || '');
  const targetText = String(target || '');
  if (!targetText || currentText === targetText) return targetText;

  const prefixLength = targetText.startsWith(currentText)
    ? currentText.length
    : commonPrefixLength(currentText, targetText);
  const nextLength = Math.min(
    targetText.length,
    findStreamingFrameEnd(targetText, prefixLength + FEISHU_STREAM_FRAME_CHARS)
  );
  return targetText.slice(0, nextLength);
}

function commonPrefixLength(left, right) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function findStreamingFrameEnd(text, preferredEnd) {
  const value = String(text || '');
  const minEnd = Math.min(value.length, Math.max(1, preferredEnd));
  if (minEnd >= value.length) return value.length;

  const newlineIndex = value.indexOf('\n', minEnd);
  if (newlineIndex >= 0 && newlineIndex - minEnd <= FEISHU_STREAM_FRAME_CHARS) {
    return newlineIndex + 1;
  }

  for (
    let index = Math.min(value.length - 1, minEnd + 12);
    index > minEnd - 12 && index > 0;
    index -= 1
  ) {
    if (/\s/.test(value[index])) return index + 1;
  }

  return minEnd;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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
  if (['enter', 'escape', 'esc', 'up', 'down', 'left', 'right', 'tab'].includes(value)) {
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
  return String(value || '')
    .trim()
    .replace(/[^\w-]/g, '')
    .toUpperCase();
}

function shouldDedupeCardAction(action) {
  return ['approve', 'approve_persistent', 'deny', 'enter', 'escape'].includes(
    String(action || '').toLowerCase()
  );
}

function isSubmitCardAction(action) {
  const value = String(action || '').toLowerCase();
  return ['approve', 'approve_persistent', 'deny', 'enter', 'escape'].includes(value) ||
    isPermissionModeAction(value);
}

function isNavigationCardAction(action) {
  return ['up', 'down', 'left', 'right', 'tab'].includes(
    String(action || '').toLowerCase()
  );
}

function isBlockingNativePageSubmitAction(action) {
  const value = String(action || '').toLowerCase();
  return ['enter', 'escape'].includes(value) || isPermissionModeAction(value);
}

function isPermissionModeAction(action) {
  return ['permission_default', 'permission_auto_review', 'permission_full_access'].includes(
    String(action || '').toLowerCase()
  );
}

function isPatchablePanel(panel) {
  return ['permission', 'native_slash', 'status', 'commands'].includes(
    String(panel?.kind || '').toLowerCase()
  );
}

function formatRemoteActionLabel(action) {
  const value = String(action || '').toLowerCase();
  return {
    approve: '允许一次',
    approve_persistent: '总是允许',
    deny: '拒绝/退出',
    escape: '退出',
    enter: '确认',
    up: '上移',
    down: '下移',
    status: '状态',
    resume: '历史会话',
    permission: '权限',
    tail: '最近输出',
    stop: '中断任务'
  }[value] || value || '操作';
}

function formatActionSubmittedNotice(action) {
  return `已提交「${formatRemoteActionLabel(action)}」，等待 Codex 更新。`;
}

function formatActionStateText(status, action, page = '') {
  if (status === 'submitted') return formatActionFeedback(action, page).status;
  return '正在处理。';
}

function formatActionFeedback(action, page = '') {
  const value = String(action || '').toLowerCase();
  if (value === 'enter' && page === '/resume') {
    return {
      title: '正在恢复会话',
      status: '已提交恢复请求，正在等待 Codex 切换到所选会话。按钮已锁定，避免重复恢复。',
      detail: '确认本地 Codex 已离开历史会话列表后，这张卡片会自动更新。'
    };
  }
  if (isPermissionModeAction(value)) {
    const mode = formatPermissionModeActionLabel(value);
    return {
      title: '正在更新权限模式',
      status: `正在将 Codex 权限模式切换为 ${mode}。按钮已锁定，避免重复提交。`,
      detail: '确认本地 Codex 已应用该模式后，这张卡片会自动更新。'
    };
  }
  if (value === 'enter') {
    return {
      title: '正在确认选择',
      status: '已提交当前选择，正在等待 Codex 更新。',
      detail: '请等待当前页面刷新。'
    };
  }
  if (value === 'escape') {
    return {
      title: '正在退出页面',
      status: '已提交退出请求，正在返回 Codex 命令界面。按钮已锁定，避免重复退出。',
      detail: '确认本地 Codex 已离开当前页面后，这张卡片会自动更新。'
    };
  }
  if (['up', 'down', 'left', 'right', 'tab'].includes(value)) {
    return {
      title: '正在刷新选择',
      status: `已提交「${formatRemoteActionLabel(value)}」，正在更新当前选项。`,
      detail: '选中项刷新后会继续显示在当前卡片中。'
    };
  }
  if (value === 'stop') {
    return {
      title: '正在中断任务',
      status: '已请求中断当前任务，Codex 会话会继续保留。',
      detail: '稍后可以继续发送新的任务。'
    };
  }
  if (['resume', 'permission', 'status', 'tail'].includes(value)) {
    return {
      title: '正在打开页面',
      status: `已提交「${formatRemoteActionLabel(value)}」请求。`,
      detail: '新页面加载后会显示对应内容。'
    };
  }
  if (isSubmitCardAction(value)) {
    return {
      title: '操作已提交',
      status: `已提交「${formatRemoteActionLabel(value)}」。`,
      detail: '这张卡片已锁定，避免重复确认。'
    };
  }
  return {
    title: '操作处理中',
    status: `已提交「${formatRemoteActionLabel(value)}」。`,
    detail: '正在等待 Codex 更新。'
  };
}

function formatPermissionModeActionLabel(action) {
  return {
    permission_default: 'Default',
    permission_auto_review: 'Auto-review',
    permission_full_access: 'Full Access'
  }[String(action || '').toLowerCase()] || formatRemoteActionLabel(action);
}

function buildStreamingActionFeedback({ action, page = '', currentText = '' } = {}) {
  const feedback = formatActionFeedback(action, page);
  if (['up', 'down', 'left', 'right', 'tab'].includes(String(action || '').toLowerCase())) {
    const content = String(currentText || '').trim();
    return [
      content,
      '',
      '**操作状态**',
      `- ${feedback.status}`
    ].filter(Boolean).join('\n');
  }
  return [
    `**${feedback.title}**`,
    `- ${feedback.status}`,
    `- ${feedback.detail}`
  ].join('\n');
}

function isControlAckText(text) {
  return /^已发送/.test(String(text || '').trim()) ||
    /请勿重复点击/.test(String(text || ''));
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

function parseTextContent(content) {
  if (!content) return '';

  try {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    return extractFeishuContentText(parsed);
  } catch {
    return String(content);
  }
}

function extractFeishuContentText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return extractRichTextBlocks(value);
  if (typeof value !== 'object') return String(value);

  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return extractPostDocumentText(value);
  if (value.post) return extractLocalizedPostText(value.post);

  const localized = extractLocalizedPostText(value);
  if (localized) return localized;

  if (value.content && typeof value.content === 'object') {
    return extractFeishuContentText(value.content);
  }

  return '';
}

function extractLocalizedPostText(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';

  const preferred = value.zh_cn || value.en_us || value.zh_hk || value.ja_jp;
  if (preferred) return extractPostDocumentText(preferred);

  for (const item of Object.values(value)) {
    const text = extractPostDocumentText(item);
    if (text) return text;
  }

  return '';
}

function extractPostDocumentText(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return '';

  const parts = [];
  if (typeof document.title === 'string' && document.title.trim()) {
    parts.push(document.title.trim());
  }

  if (Array.isArray(document.content)) {
    const body = extractRichTextBlocks(document.content);
    if (body) parts.push(body);
  } else if (document.content) {
    const body = extractFeishuContentText(document.content);
    if (body) parts.push(body);
  }

  return parts.join('\n').trim();
}

function extractRichTextBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';

  return blocks
    .map((block) => {
      if (Array.isArray(block)) {
        return block.map((element) => extractRichTextElement(element)).join('');
      }
      return extractRichTextElement(block);
    })
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractRichTextElement(element) {
  if (element === undefined || element === null) return '';
  if (typeof element === 'string') return element;
  if (Array.isArray(element)) {
    return element.map((item) => extractRichTextElement(item)).join('');
  }
  if (typeof element !== 'object') return String(element);

  const tag = String(element.tag || element.type || '').toLowerCase();
  if (tag === 'text' || tag === 'plain_text' || tag === 'md' || tag === 'markdown') {
    return String(element.text || element.content || '');
  }
  if (tag === 'a' || tag === 'link') {
    const text = String(element.text || element.content || '').trim();
    const href = String(element.href || element.url || '').trim();
    if (text && href && text !== href) return `${text} (${href})`;
    return text || href;
  }
  if (tag === 'at' || tag === 'mention') {
    const mention = String(
      element.text ||
        element.user_name ||
        element.name ||
        element.key ||
        element.user_id ||
        element.open_id ||
        ''
    ).trim();
    if (!mention) return '';
    return mention.startsWith('@') ? mention : `@${mention}`;
  }
  if (tag === 'img' || tag === 'image') {
    return '[图片]';
  }
  if (tag === 'file') {
    const name = element.file_name || element.name || element.text || '';
    return name ? `[文件: ${name}]` : '[文件]';
  }
  if (tag === 'media' || tag === 'video') {
    return '[视频]';
  }
  if (tag === 'emotion' || tag === 'emoji') {
    const name = element.emoji_type || element.name || element.text || '';
    return name ? `[${name}]` : '';
  }
  if (tag === 'hr') return '\n---\n';
  if (tag === 'code_block') {
    const text = String(element.text || element.content || '').trim();
    return text ? `\n\`\`\`\n${text}\n\`\`\`\n` : '';
  }

  if (typeof element.text === 'string') return element.text;
  if (typeof element.content === 'string') return element.content;
  if (Array.isArray(element.content)) return extractRichTextBlocks(element.content);
  return '';
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

function buildReplyCard(text, index = 0, total = 1) {
  const suffix = total > 1 ? ` ${index + 1}/${total}` : '';
  return {
    config: buildCardConfig({
      update_multi: true,
      wide_screen_mode: true,
      enable_forward: true
    }),
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: `Remote Codex${suffix}`
      }
    },
    elements: [
      {
        tag: 'markdown',
        content: formatCardMarkdown(text)
      }
    ]
  };
}

function buildPanelCard(panel = {}) {
  const actions = buildPanelActions(panel);
  const elements = [
    {
      tag: 'markdown',
      content: formatCardMarkdown(buildPanelMarkdown(panel))
    }
  ];

  if (actions.length > 0) {
    elements.push({
      tag: 'action',
      actions
    });
  }

  return {
    config: buildCardConfig({
      update_multi: true,
      wide_screen_mode: true,
      enable_forward: true
    }),
    header: {
      template: getPanelTemplate(panel),
      title: {
        tag: 'plain_text',
        content: panel.title || 'Remote Codex'
      }
    },
    elements
  };
}

function buildActionStateCard({ action, page = '', text, status } = {}) {
  const label = formatRemoteActionLabel(action);
  const feedback = formatActionFeedback(action, page);
  const lines = [
    `**${feedback.title}**`,
    `- 操作: ${colorCardText(label, CARD_COLORS.approval)}`,
    `- 状态: ${text || formatActionStateText(status, action, page)}`
  ];
  lines.push(`- ${feedback.detail}`);

  return {
    config: buildCardConfig({
      update_multi: true,
      wide_screen_mode: true,
      enable_forward: true
    }),
    header: {
      template: isSubmitCardAction(action) ? 'green' : 'blue',
      title: {
        tag: 'plain_text',
        content: 'Remote Codex'
      }
    },
    elements: [
      {
        tag: 'markdown',
        content: formatCardMarkdown(lines.join('\n'))
      }
    ]
  };
}

function getPanelTemplate(panel = {}) {
  if (panel.kind === 'permission' && panel.active) return 'orange';
  if (panel.kind === 'permission') return 'grey';
  if (panel.kind === 'native_slash' && panel.command === '/permissions') return 'orange';
  if (panel.kind === 'native_slash' && panel.command === '/status') return 'green';
  if (panel.kind === 'native_slash') return 'blue';
  if (panel.kind === 'status' && panel.running) return 'green';
  if (panel.kind === 'status') return 'grey';
  return 'blue';
}

function buildPanelMarkdown(panel = {}) {
  if (panel.kind === 'status') return buildStatusPanelMarkdown(panel);
  if (panel.kind === 'permission') return buildPermissionPanelMarkdown(panel);
  if (panel.kind === 'native_slash') return buildNativeSlashPanelMarkdown(panel);
  if (panel.kind === 'commands') return buildCommandPanelMarkdown(panel);
  return panel.fallbackText || 'Remote Codex';
}

function buildStatusPanelMarkdown(panel = {}) {
  const lines = ['**状态**'];
  if (panel.notice) lines.push(`- ${panel.notice}`);

  if (!panel.attached || !panel.session) {
    lines.push(`- ${colorCardText('未接入会话', CARD_COLORS.warning)}`);
    lines.push('- 发送 `/start` 可启动会话；`/resume` 会打开 Codex 原生历史会话列表。');
    lines.push('', '**快捷命令**', '- `/start` 启动会话', '- `/resume` 历史会话列表', '- `/permission` 权限面板', '- `/status` Codex 状态');
    return lines.join('\n');
  }

  const session = panel.session || {};
  const outputMode = panel.config?.sendOutput ? panel.config?.outputMode : 'silent';
  lines.push(
    `- 运行: ${panel.running ? colorCardText('运行中', CARD_COLORS.success) : colorCardText('未运行', CARD_COLORS.muted)}`,
    `- 状态: ${formatPanelPhase(panel.phase)}`,
    `- 模式: ${inlineCode(panel.source || 'visual_terminal')}`,
    `- 工作目录: ${inlineCode(session.cwd || 'unknown')}`,
    `- 输出: ${inlineCode(outputMode || 'final')}`,
    `- 原始日志: ${panel.config?.rawOutputLogEnabled ? colorCardText('开启', CARD_COLORS.success) : colorCardText('关闭', CARD_COLORS.muted)}`,
    `- 飞书长连接: ${panel.transport?.websocket ? colorCardText('已启动', CARD_COLORS.success) : colorCardText('未启动', CARD_COLORS.warning)}`
  );
  if (session.id) lines.push(`- 会话: ${inlineCode(session.id)}`);
  if (session.cursor !== undefined) lines.push(`- 游标: ${inlineCode(session.cursor)}`);
  if (session.createdAt) lines.push(`- 创建: ${inlineCode(session.createdAt)}`);
  if (panel.lastInputText) {
    lines.push(`- 最近输入: ${inlineCode(clipForCard(panel.lastInputText, 120))}`);
  }

  lines.push('', '**快捷命令**', '- `/resume` 历史会话列表', '- `/permission` 权限面板', '- `/status` Codex 状态', '- `/tail` 最近输出', '- `/stop` 中断当前任务，保留 Codex 会话');
  return lines.join('\n');
}

function formatPanelPhase(phase) {
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

function buildPermissionPanelMarkdown(panel = {}) {
  const lines = ['**权限**'];
  if (panel.notice) {
    lines.push(`- ${panel.notice}`);
  }
  if (!panel.attached) {
    lines.push(`- ${panel.message || '当前没有接入会话。'}`);
    lines.push('- 发送 `/resume` 可接入当前可视化 Codex 会话。');
    return lines.join('\n');
  }

  if (panel.active) {
    if (panel.progressText) {
      lines.push('', panel.progressText);
    } else {
      lines.push(`- ${panel.message || 'Codex 正在等待权限确认。'}`);
      const options = formatPanelApprovalOptions(panel.approval);
      if (options.length > 0) {
        lines.push('', '**选项**', ...options);
      }
    }
    if (panel.approval?.options?.length > 0) {
      lines.push('', '上移/下移会切换 `>` 标记的选项，确认会选择当前项。');
    }
    lines.push('', '可以点击下方按钮，或发送 `/approve`、`/always`、`/deny`。');
    return lines.join('\n');
  }

  lines.push(`- ${panel.message || '当前没有待处理的权限请求。'}`);
  if (panel.progressText) lines.push('', panel.progressText);
  lines.push('', '- `/status` 查看当前会话状态');
  return lines.join('\n');
}

function formatPanelApprovalOptions(approval) {
  return (approval?.options || [])
    .map((option) => {
      if (option && typeof option === 'object') {
        const prefix = option.selected ? '>' : '-';
        const index = Number(option.index) ? `${Number(option.index)}. ` : '';
        const text = String(option.text || '').trim();
        return text ? `${prefix} ${index}${text}` : '';
      }
      const value = String(option || '').trim();
      if (!value) return '';
      return /^[->]\s/.test(value) ? value : `- ${value}`;
    })
    .filter(Boolean);
}

function buildNativeSlashPanelMarkdown(panel = {}) {
  if (panel.command === '/resume') {
    return buildResumeNativeSlashPanelMarkdown(panel);
  }
  const lines = [];
  if (panel.notice) {
    lines.push(`- ${panel.notice}`, '');
  }
  const content = String(panel.content || panel.message || panel.fallbackText || '').trim();
  if (content) {
    lines.push(content);
  } else {
    lines.push('Codex 没有返回可解析的页面内容。');
  }
  return lines.join('\n');
}

function buildResumeNativeSlashPanelMarkdown(panel = {}) {
  const content = String(panel.content || panel.message || panel.fallbackText || '').trim();
  if (!content) return 'Codex 没有返回可解析的历史会话列表。';

  const sourceLines = content.split('\n');
  const selected = sourceLines
    .map((line) => line.trim())
    .find((line) => /^>\s+/.test(line));
  const lines = [];
  if (panel.notice) {
    lines.push(`- ${panel.notice}`, '');
  }

  for (const line of sourceLines) {
    const compact = line.trim();
    if (/^\*\*\/resume 会话列表\*\*$/.test(compact)) {
      lines.push('**历史会话**');
      if (selected) {
        lines.push(`- 当前选择: ${colorCardText(selected.replace(/^>\s+/, ''), CARD_COLORS.command)}`);
      }
      continue;
    }
    if (/^点击 Enter 或发送/.test(compact)) {
      lines.push('', colorCardText('点击“恢复”会切换到当前选中的历史会话；点击“退出”返回命令界面。', CARD_COLORS.muted));
      continue;
    }
    if (/^点击卡片里的/.test(compact)) {
      lines.push('', colorCardText('使用上移/下移切换选择，恢复前请确认当前选择。', CARD_COLORS.muted));
      continue;
    }
    if (/^>\s+/.test(compact)) {
      lines.push(colorCardText(compact, CARD_COLORS.command));
      continue;
    }
    if (/^-\s+/.test(compact) && !/^-\s+(?:第|卡片显示|选择要恢复|Codex 已|现在可以|当前)/.test(compact)) {
      lines.push(colorCardText(compact, CARD_COLORS.muted));
      continue;
    }
    lines.push(line);
  }
  return lines.join('\n').trim();
}

function buildCommandPanelMarkdown(panel = {}) {
  return [
    '**快捷命令**',
    panel.attached
      ? '- 已接入 Remote Codex 会话。'
      : '- 当前还没有接入会话，先使用 `/start`。',
    '',
    '- `/resume` 打开 Codex 原生历史会话列表',
    '- `/permission` 打开 Codex 原生权限面板',
    '- `/status` 打开 Codex 原生状态面板',
    '- `/tail` 查看最近输出',
    '- `/stop` 中断当前任务，保留 Codex 会话',
    '- `/remote-status` 查看 Remote Codex 自身状态'
  ].join('\n');
}

function buildPanelActions(panel = {}) {
  const actions = Array.isArray(panel.actions) ? panel.actions : [];
  return actions
    .map((action) => buildPanelActionButton(action, panel))
    .filter(Boolean)
    .slice(0, 6);
}

function buildPanelActionButton(action, panel = {}) {
  const value = String(action || '').toLowerCase();
  const nativeSlashLabels = panel.kind === 'native_slash'
    ? {
        enter: panel.command === '/resume' ? '恢复' : '确认',
        deny: '退出'
      }
    : {};
  const option = {
    approve: ['允许一次', 'approve', 'primary'],
    approve_persistent: ['总是允许', 'approve_persistent', 'default'],
    deny: [
      nativeSlashLabels.deny || '拒绝',
      'deny',
      nativeSlashLabels.deny ? 'default' : 'danger'
    ],
    escape: ['退出', 'escape', 'default'],
    resume: ['历史会话', 'resume', 'primary'],
    permission: ['权限', 'permission', 'default'],
    status: ['状态', 'status', 'default'],
    tail: ['最近输出', 'tail', 'default'],
    stop: ['中断任务', 'stop', 'danger'],
    up: ['上移', 'up', 'default'],
    down: ['下移', 'down', 'default'],
    enter: [nativeSlashLabels.enter || '确认', 'enter', 'primary'],
    permission_default: ['Default', 'permission_default', 'default'],
    permission_auto_review: ['Auto-review', 'permission_auto_review', 'primary'],
    permission_full_access: ['Full Access', 'permission_full_access', 'danger'],
    help: ['帮助', 'help', 'default'],
    commands: ['快捷命令', 'commands', 'default']
  }[value];
  if (!option) return null;
  return buildControlButton(option[0], option[1], option[2], {
    page: panel.kind === 'native_slash' ? panel.command : ''
  });
}

function buildPanelFallbackText(panel = {}) {
  return stripCardMarkup(buildPanelMarkdown(panel));
}

function stripCardMarkup(text) {
  return String(text || '')
    .replace(/<font\s+color='[^']+'>/g, '')
    .replace(/<\/font>/g, '')
    .replace(/\*\*/g, '')
    .trim();
}

function inlineCode(value) {
  const text = String(value || '').replace(/`/g, "'");
  return `\`${text}\``;
}

function clipForCard(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function buildStreamingCard({ title, initialText, controlMode = 'default' }) {
  const actions = buildControlButtons(controlMode);
  const elements = [
    {
      tag: 'markdown',
      element_id: STREAM_CONTENT_ELEMENT_ID,
      content: formatCardMarkdown(initialText, { allowEmpty: true })
    }
  ];
  if (actions.length > 0) {
    elements.push({
      tag: 'action',
      actions
    });
  }

  return {
    schema: '2.0',
    config: buildCardConfig({
      update_multi: true,
      streaming_mode: true,
      summary: {
        content: '[Generating...]'
      },
      streaming_config: {
        print_frequency_ms: {
          default: 30,
          pc: 30,
          ios: 35,
          android: 35
        },
        print_step: {
          default: 4,
          pc: 4,
          ios: 3,
          android: 3
        },
        print_strategy: 'fast'
      }
    }),
    header: {
      template: getStreamingCardTemplate(controlMode),
      title: {
        tag: 'plain_text',
        content: title || 'Remote Codex'
      }
    },
    body: {
      elements
    }
  };
}

function getStreamingCardTemplate(controlMode = 'default') {
  if (controlMode === 'resume') return 'blue';
  if (controlMode === 'permissions') return 'orange';
  if (controlMode === 'status') return 'green';
  if (controlMode === 'slash') return 'blue';
  return 'blue';
}

function buildControlButtons(controlMode = 'default') {
  if (controlMode === 'resume') {
    return [
      buildControlButton('上移', 'up', 'default', { page: '/resume' }),
      buildControlButton('下移', 'down', 'default', { page: '/resume' }),
      buildControlButton('恢复', 'enter', 'primary', { page: '/resume' }),
      buildControlButton('退出', 'escape', 'default', { page: '/resume' })
    ];
  }

  if (controlMode === 'permissions') {
    return [
      buildControlButton('Default', 'permission_default', 'default', { page: '/permissions' }),
      buildControlButton('Auto-review', 'permission_auto_review', 'primary', { page: '/permissions' }),
      buildControlButton('Full Access', 'permission_full_access', 'danger', { page: '/permissions' })
    ];
  }

  if (controlMode === 'status') {
    return [];
  }

  if (controlMode === 'navigation' || controlMode === 'slash') {
    return [
      buildControlButton('上移', 'up', 'default'),
      buildControlButton('下移', 'down', 'default'),
      buildControlButton('确认', 'enter', 'primary'),
      buildControlButton('退出', 'escape', 'default')
    ];
  }

  return [
    buildControlButton('允许一次', 'approve', 'primary'),
    buildControlButton('总是允许', 'approve_persistent', 'default'),
    buildControlButton('拒绝', 'deny', 'default'),
    buildControlButton('上移', 'up', 'default'),
    buildControlButton('下移', 'down', 'default')
  ];
}

function buildControlButton(label, action, type, options = {}) {
  const value = { remote_codex_action: action };
  if (options.page) value.remote_codex_page = options.page;
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: label
    },
    type,
    value,
    behaviors: [
      {
        type: 'callback',
        value
      }
    ]
  };
}

function formatCardMarkdown(text, options = {}) {
  const value = String(text || '');
  if (!value.trim()) return options.allowEmpty ? '' : '_No output._';
  return normalizeMarkdownLineBreaks(enhanceCodexMarkdown(value))
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function enhanceCodexMarkdown(text) {
  let inCodeBlock = false;

  return String(text || '')
    .split('\n')
    .map((line) => {
      let value = line.trimEnd();
      const markedColor = extractRemoteCodexColor(value);
      if (markedColor) {
        value = stripRemoteCodexColorMarkers(value);
      }
      const compact = value.trim();
      if (/^\s*```/.test(compact)) {
        inCodeBlock = !inCodeBlock;
        return value;
      }
      if (inCodeBlock || !compact) return value;
      if (markedColor) {
        return colorCardText(formatCodexCardLine(value), markedColor);
      }
      if (/^\*\*等待确认\*\*$/.test(compact)) {
        return colorCardText('**等待确认**', CARD_COLORS.approval);
      }
      if (/^\*\*进度\*\*$/.test(compact)) {
        return colorCardText('**进度**', CARD_COLORS.progress);
      }
      if (/^\*\*回复\*\*$/.test(compact)) {
        return colorCardText('**回复**', CARD_COLORS.reply);
      }
      if (/^\*\*选项\*\*$/.test(compact)) {
        return colorCardText('**选项**', CARD_COLORS.info);
      }
      if (/^\*\*(?:Codex 状态|剩余用量|用量提示|运行信息)\*\*$/.test(compact)) {
        return colorCardText(compact, CARD_COLORS.info);
      }
      if (/^⚠/.test(compact)) return `> ${colorCardText(compact, CARD_COLORS.warning)}`;
      if (/^-\s+(?:5 小时额度|每周额度):/.test(compact)) {
        const color = compact.includes('余量紧张') || compact.includes('低余量')
          ? CARD_COLORS.error
          : compact.includes('余量适中')
            ? CARD_COLORS.warning
            : CARD_COLORS.success;
        return colorCardText(compact, color);
      }
      if (/^(?:Error|Failed|Failure|Denied|Rejected)\b/i.test(compact)) {
        return colorCardText(compact, CARD_COLORS.error);
      }
      if (/^-\s+(?:Error|Failed|Failure|Denied|Rejected)\b/i.test(compact)) {
        return colorCardText(compact, CARD_COLORS.error);
      }
      if (/^-\s+(?:Working|Thinking|Running|Reading|Writing|Finding|Searching|Checking|Applying|Planning)\b/i.test(compact)) {
        return colorCardText(compact, CARD_COLORS.running);
      }
      if (/^-\s+(?:Ran|Explored|Opened|Searched|Found|Listed|Viewed)\b/i.test(compact)) {
        return colorCardText(formatCodexCardLine(compact), CARD_COLORS.command);
      }
      if (/^-\s+(?:Read|Edited|Updated|Created|Deleted|Checked|Applied|Wrote)\b/i.test(compact)) {
        return colorCardText(formatCodexCardLine(compact), CARD_COLORS.success);
      }
      if (/^-\s+(?:Would you like|Reason:|[123]\.)/i.test(compact)) {
        return colorCardText(compact, CARD_COLORS.approval);
      }
      if (/^-\s+Codex 正在处理/.test(compact)) {
        return colorCardText(compact, CARD_COLORS.running);
      }
      if (/^可在卡片按钮中选择/.test(compact)) {
        return colorCardText(compact, CARD_COLORS.muted);
      }
      if (/^Ran\b/.test(compact)) return colorCardText(formatCodexCardLine(compact), CARD_COLORS.command);
      if (/^Explored\b/.test(compact)) return colorCardText(formatCodexCardLine(compact), CARD_COLORS.command);
      if (/^(?:Read|Edited|Updated|Created|Deleted|Checked|Applied|Wrote)\b/.test(compact)) {
        return colorCardText(formatCodexCardLine(`- ${compact}`), CARD_COLORS.success);
      }
      if (/^└\s+/.test(compact)) {
        return `> ${colorCardText(formatCodexCardLine(compact), CARD_COLORS.muted)}`;
      }
      return formatCodexCardLine(value);
    })
    .join('\n');
}

function formatCodexCardLine(line) {
  return highlightCodexInlineTokens(preserveCodexIndentation(line));
}

function preserveCodexIndentation(line) {
  return String(line || '').replace(/^ +/, (spaces) => {
    const pairs = Math.floor(spaces.length / 2);
    const rest = spaces.length % 2;
    return `${'　'.repeat(pairs)}${rest ? ' ' : ''}`;
  });
}

function highlightCodexInlineTokens(line) {
  const value = String(line || '');
  if (value.includes('`')) return value;
  const action = value.match(/^(\s*(?:[-•]\s+)?)(Ran|Read|Edited|Updated|Created|Deleted|Checked|Applied|Wrote|Explored|Opened|Searched|Found|Listed|Viewed)\s+(.+)$/i);
  if (action) {
    const [, prefix, verb, detail] = action;
    if (/^(?:Ran|Explored|Opened|Searched|Found|Listed|Viewed)$/i.test(verb)) {
      return `${prefix}${verb} ${inlineCode(detail)}`;
    }
    return `${prefix}${verb} ${highlightFileLikeTokens(detail)}`;
  }
  return highlightFileLikeTokens(value);
}

function highlightFileLikeTokens(text) {
  return String(text || '').replace(
    /(^|[\s([{"'，。；：、])((?:\.{1,2}\/|\/)?[\w@./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|md|css|html|py|sh|yml|yaml|toml|lock|txt)(?::\d+)?)(?=$|[\s)\]}"'，。；：、])/g,
    (match, prefix, filePath) => `${prefix}${inlineCode(filePath)}`
  );
}

function colorCardText(text, color) {
  return `<font color='${normalizeCardColor(color)}'>${escapeCardFontText(text)}</font>`;
}

function extractRemoteCodexColor(line) {
  const match = String(line || '').match(/<!--remote-codex-color:([^>]+)-->/);
  return match ? normalizeCardColor(match[1]) : '';
}

function stripRemoteCodexColorMarkers(line) {
  return String(line || '').replace(/<!--remote-codex-color:[^>]+-->/g, '');
}

function normalizeCardColor(color) {
  const value = String(color || '').trim();
  const rgba = normalizeRgbaColor(value);
  if (rgba) {
    return FEISHU_CARD_COLOR_TOKENS[rgba] || 'cus-remote-muted';
  }
  if (Object.prototype.hasOwnProperty.call(FEISHU_CARD_CUSTOM_COLORS, value)) {
    return value;
  }
  if (/^(?:red|green|grey|gray|blue|orange|yellow|purple)$/i.test(value)) {
    return value.toLowerCase() === 'gray' ? 'grey' : value.toLowerCase();
  }
  return 'cus-remote-muted';
}

function normalizeRgbaColor(color) {
  const value = String(color || '').trim();
  if (!/^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)$/i.test(value)) {
    return '';
  }
  return value.replace(/\s+/g, '').toLowerCase();
}

function buildCardConfig(config = {}) {
  return {
    ...config,
    style: {
      ...(config.style || {}),
      color: {
        ...(config.style?.color || {}),
        ...FEISHU_CARD_CUSTOM_COLORS
      }
    }
  };
}

function escapeCardFontText(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeMarkdownLineBreaks(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const next = [];
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmedEnd = line.trimEnd();
    if (/^\s*```/.test(trimmedEnd)) {
      inCodeBlock = !inCodeBlock;
      next.push(trimmedEnd);
      continue;
    }

    if (inCodeBlock || trimmedEnd === '') {
      next.push(trimmedEnd);
      continue;
    }

    next.push(`${trimmedEnd}  `);
  }

  return next.join('\n');
}

function summarizeForCard(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return 'Remote Codex';
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
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

function clipForLog(text, max = 1200) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated]`;
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
  buildPanelCard,
  buildPanelMarkdown,
  buildStreamingActionFeedback,
  buildStreamingCard,
  formatBotMenuCommandSummary,
  formatCardMarkdown,
  nextStreamingTextFrame,
  parseTextContent
};
