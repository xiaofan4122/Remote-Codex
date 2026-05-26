const crypto = require('node:crypto');

const FEISHU_TEXT_CHUNK_CHARS = 3500;
const FEISHU_CARD_CHUNK_CHARS = 7000;
const FEISHU_EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000;
const FEISHU_EVENT_DEDUPE_MAX_ENTRIES = 1000;
const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const STREAM_CONTENT_ELEMENT_ID = 'content';

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
    this.tenantAccessToken = '';
    this.tenantAccessTokenExpiresAt = 0;
    this.scopeApplyInFlight = null;
    this.seenEventIds = new Map();
  }

  async start() {
    if (this.pluginConfig.mode !== 'long_connection') {
      this.startedAt = new Date().toISOString();
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
    this.startedAt = new Date().toISOString();
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
      senderOpenId: message.senderOpenId,
      text: clipForLog(text)
    });

    this.dispatchRemoteMessage(message, text).catch((error) =>
      this.handleRemoteDispatchError(message, error)
    );
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
      createReplyStream: async ({ title, initialText } = {}) => {
        if (!this.pluginConfig.streaming) return null;
        if (this.pluginConfig.mode !== 'long_connection') return null;
        return this.createReplyStream({
          receiveId: message.chatId,
          receiveIdType: 'chat_id',
          title: title || 'Remote Codex',
          initialText: initialText || 'Generating...'
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

  async handleCardAction(data) {
    const action = normalizeCardAction(data);
    if (!action.remoteAction) return;

    this.logger.event?.('feishu.card.action', {
      chatId: action.chatId,
      messageId: action.messageId,
      operatorOpenId: action.operatorOpenId,
      action: action.remoteAction
    });
    const actionEventId = action.messageId
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
    try {
      await this.services.remoteController.handleMessage({
        pluginId: 'feishu',
        conversationId: action.chatId || action.operatorOpenId,
        userId: action.operatorOpenId,
        text: command,
        reply: async (replyText) => {
          if (!action.chatId) return;
          await this.sendReply({
            receiveId: action.chatId,
            receiveIdType: 'chat_id',
            text: replyText
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
    let text = message.text.trim();

    if (this.pluginConfig.requireMention && message.mentions.length === 0) {
      return '';
    }

    if (this.pluginConfig.requireMention) {
      const hasMentionText = message.mentions.some((mention) => {
        const key = mention.key || mention.name || mention.id?.open_id;
        return key && text.includes(key);
      });
      if (!hasMentionText) return '';
    }

    for (const mention of message.mentions) {
      if (mention.key) {
        text = text.replaceAll(mention.key, '').trim();
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
    initialText = ''
  }) {
    if (!receiveId) {
      throw new Error('Feishu receive id is required.');
    }

    let created;
    try {
      const card = buildStreamingCard({ title, initialText });
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

    this.logger.event?.('feishu.stream.started', {
      receiveId,
      receiveIdType,
      cardId
    });

    return new FeishuReplyStream({
      plugin: this,
      cardId,
      elementId: STREAM_CONTENT_ELEMENT_ID,
      logger: this.logger
    });
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
  constructor({ plugin, cardId, elementId, logger = console }) {
    this.plugin = plugin;
    this.cardId = cardId;
    this.elementId = elementId;
    this.logger = logger;
    this.sequence = 1;
    this.currentText = '';
    this.closed = false;
    this.queue = Promise.resolve();
  }

  async update(text) {
    const nextText = String(text || '').trim();
    if (!nextText || nextText === this.currentText || this.closed) return;
    this.queue = this.queue.then(async () => {
      if (this.closed || nextText === this.currentText) return;
      this.currentText = nextText;
      this.sequence += 1;
      await this.plugin.updateStreamingContent({
        cardId: this.cardId,
        elementId: this.elementId,
        text: nextText,
        sequence: this.sequence
      });
    });
    return this.queue;
  }

  async finish(text) {
    if (this.closed) return;
    const finalText = String(text || this.currentText || '').trim();
    await this.update(finalText);
    this.closed = true;
    this.sequence += 1;
    await this.plugin.closeStreamingCard({
      cardId: this.cardId,
      sequence: this.sequence,
      summary: summarizeForCard(finalText)
    });
    this.logger.event?.('feishu.stream.finished', {
      cardId: this.cardId,
      chars: finalText.length
    });
  }
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
    mentions: Array.isArray(message.mentions) ? message.mentions : []
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
    remoteAction
  };
}

function normalizeRemoteAction(action) {
  const value = String(action || '').toLowerCase();
  if (['approve', 'allow', 'yes', 'y'].includes(value)) return 'approve';
  if (['deny', 'reject', 'no', 'n', 'cancel', 'escape', 'esc'].includes(value)) {
    return 'deny';
  }
  if (['enter', 'up', 'down', 'left', 'right', 'tab'].includes(value)) return value;
  return '';
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseTextContent(content) {
  if (!content) return '';

  try {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    return parsed.text || parsed.content || '';
  } catch {
    return String(content);
  }
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
    config: {
      wide_screen_mode: true,
      enable_forward: true
    },
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

function buildStreamingCard({ title, initialText }) {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: true,
      summary: {
        content: '[Generating...]'
      },
      streaming_config: {
        print_frequency_ms: {
          default: 45,
          pc: 45,
          ios: 45,
          android: 45
        },
        print_step: {
          default: 2,
          pc: 2,
          ios: 2,
          android: 2
        },
        print_strategy: 'fast'
      }
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: title || 'Remote Codex'
      }
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: STREAM_CONTENT_ELEMENT_ID,
          content: formatCardMarkdown(initialText, { allowEmpty: true })
        },
        {
          tag: 'action',
          actions: buildControlButtons()
        }
      ]
    }
  };
}

function buildControlButtons() {
  return [
    buildControlButton('Approve', 'approve', 'primary'),
    buildControlButton('Deny', 'deny', 'default'),
    buildControlButton('Up', 'up', 'default'),
    buildControlButton('Down', 'down', 'default')
  ];
}

function buildControlButton(label, action, type) {
  const value = { remote_codex_action: action };
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
  return String(text || '')
    .split('\n')
    .map((line) => {
      const value = line.trimEnd();
      const compact = value.trim();
      if (/^⚠/.test(compact)) return `> ${escapeMarkdownLine(compact)}`;
      if (/^Ran\b/.test(compact)) return `**${escapeMarkdownLine(compact)}**`;
      if (/^Explored\b/.test(compact)) return `**${escapeMarkdownLine(compact)}**`;
      if (/^(?:Read|Edited|Updated|Created|Deleted|Checked|Applied)\b/.test(compact)) {
        return `- ${escapeMarkdownLine(compact)}`;
      }
      if (/^└\s+/.test(compact)) return `> ${escapeMarkdownLine(compact)}`;
      return value;
    })
    .join('\n');
}

function escapeMarkdownLine(text) {
  return String(text || '').replace(/\*/g, '\\*');
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
