const { buildStreamingActionFeedback } = require('./cardActions');
const { buildPanelMarkdown } = require('./cardBuilders');
const { summarizeForCard } = require('./cardMarkdown');

const FEISHU_STREAM_MIN_UPDATE_INTERVAL_MS = 110;
const FEISHU_STREAM_CLOSE_RETRY_MS = 250;
const FEISHU_STREAM_LEASE_MS = 10 * 60 * 1000;
const FEISHU_STREAM_RENEW_AFTER_MS = 8 * 60 * 1000;
const FEISHU_STREAM_RENEW_RETRY_MS = 5 * 1000;
const FEISHU_INTERACTION_RETRY_MS = 300;
const FEISHU_INTERACTION_RETRY_ATTEMPTS = 3;

class FeishuReplyStream {
  constructor({
    plugin,
    cardId,
    messageId = '',
    elementId,
    title = 'Remote Codex',
    completedTemplate = 'green',
    completedSubtitle = '已完成',
    renderLatex = false,
    logger = console,
    now = Date.now,
    wait = delay,
    minUpdateIntervalMs = FEISHU_STREAM_MIN_UPDATE_INTERVAL_MS,
    streamRenewAfterMs = FEISHU_STREAM_RENEW_AFTER_MS,
    streamRenewRetryMs = FEISHU_STREAM_RENEW_RETRY_MS
  }) {
    this.plugin = plugin;
    this.cardId = cardId;
    this.messageId = messageId;
    this.elementId = elementId;
    this.title = title || 'Remote Codex';
    this.completedTemplate = completedTemplate || 'green';
    this.completedSubtitle = completedSubtitle || '已完成';
    this.renderLatex = Boolean(renderLatex);
    this.logger = logger;
    this.now = typeof now === 'function' ? now : Date.now;
    this.wait = typeof wait === 'function' ? wait : delay;
    this.minUpdateIntervalMs = Math.max(0, Number(minUpdateIntervalMs) || 0);
    this.streamRenewAfterMs = Math.max(0, Number(streamRenewAfterMs) || 0);
    this.streamRenewRetryMs = Math.max(0, Number(streamRenewRetryMs) || 0);
    this.sequence = 1;
    this.currentText = '';
    this.targetText = '';
    this.flushPromise = null;
    this.lastUpdateAt = 0;
    this.streamingModeOpenedAt = this.now();
    this.lastRenewalAttemptAt = Number.NEGATIVE_INFINITY;
    this.closed = false;
    this.actionFeedbackText = '';
    this.panelActive = false;
    this.panelRestoreText = '';
    this.panelRevision = 0;
  }

  async update(text) {
    this.actionFeedbackText = '';
    if (this.panelActive) {
      return this.replacePanelWithText(text);
    }
    return this.setTargetText(text);
  }

  async replace(text) {
    this.actionFeedbackText = '';
    if (this.panelActive) {
      return this.replacePanelWithText(text);
    }
    return this.setTargetText(text);
  }

  async showPanel(panel) {
    if (this.closed) return;
    const panelRevision = this.panelRevision + 1;
    this.panelRevision = panelRevision;
    if (this.flushPromise) {
      await this.flushPromise;
    }
    this.panelRestoreText = String(buildPanelMarkdown(panel) || '').trim();
    const nextSequence = this.sequence + 1;
    let result;
    try {
      result = await this.plugin.replaceStreamingPanel({
        cardId: this.cardId,
        panel,
        sequence: nextSequence
      });
    } catch (error) {
      if (Number(error?.cardSequence) >= nextSequence) {
        this.sequence = Number(error.cardSequence);
      }
      throw error;
    }
    this.sequence = Number(result?.sequence) || nextSequence;
    const text = String(panel?.fallbackText || panel?.progressText || panel?.message || '').trim();
    this.currentText = text;
    this.targetText = text;
    this.lastUpdateAt = this.now();
    this.actionFeedbackText = '';
    this.panelActive = true;
  }

  async showActionFeedback(action, page = '', options = {}) {
    if (!this.matchesPanelRevision(options.expectedPanelRevision)) {
      this.logger.event?.('feishu.stream.action_feedback.ignored', {
        cardId: this.cardId,
        action,
        reason: 'panel_changed',
        expectedPanelRevision: options.expectedPanelRevision,
        panelRevision: this.panelRevision
      });
      return false;
    }
    const text = buildStreamingActionFeedback({
      action,
      page,
      currentText: this.panelActive
        ? this.panelRestoreText
        : this.targetText || this.currentText
    });
    this.actionFeedbackText = text;
    if (this.panelActive) {
      return this.replacePanelWithText(text, options);
    }
    return this.setTargetText(text);
  }

  async replacePanelWithText(text, options = {}) {
    const nextText = String(text || '').trim();
    if (!nextText || this.closed) return;
    if (!this.matchesPanelRevision(options.expectedPanelRevision)) return false;
    if (this.flushPromise) {
      await this.flushPromise;
    }
    if (!this.matchesPanelRevision(options.expectedPanelRevision)) return false;
    for (let attempt = 1; attempt <= FEISHU_INTERACTION_RETRY_ATTEMPTS; attempt += 1) {
      if (!this.matchesPanelRevision(options.expectedPanelRevision)) return false;
      const sequence = this.sequence + 1;
      try {
        await this.plugin.replaceStreamingText({
          cardId: this.cardId,
          title: this.title,
          text: nextText,
          sequence
        });
        this.sequence = sequence;
        break;
      } catch (error) {
        if (!isOngoingInteractionError(error) || attempt >= FEISHU_INTERACTION_RETRY_ATTEMPTS) {
          throw error;
        }
        this.logger.event?.('feishu.stream.interaction.retry', {
          cardId: this.cardId,
          sequence,
          attempt,
          error: String(error?.message || error || 'Unknown error'),
          code: error?.code || null,
          httpStatus: error?.httpStatus || null
        });
        await this.wait(FEISHU_INTERACTION_RETRY_MS * attempt);
      }
    }
    this.currentText = nextText;
    this.targetText = nextText;
    this.lastUpdateAt = this.now();
    this.panelActive = false;
    this.panelRestoreText = '';
    return true;
  }

  matchesPanelRevision(expectedPanelRevision) {
    return expectedPanelRevision === undefined ||
      expectedPanelRevision === null ||
      expectedPanelRevision === this.panelRevision;
  }

  setCompletionState({ title, template, subtitle } = {}) {
    if (title) this.title = String(title);
    if (template) this.completedTemplate = String(template);
    if (subtitle) this.completedSubtitle = String(subtitle);
  }

  async setTargetText(text) {
    const nextText = String(text || '').trim();
    if (!nextText || this.closed) return;
    if (nextText === this.currentText && this.targetText === this.currentText) return;

    this.targetText = nextText;
    if (!this.flushPromise) {
      this.flushPromise = this.flushTargetText().finally(() => {
        this.flushPromise = null;
      });
    }
    return this.flushPromise;
  }

  async flushTargetText() {
    while (!this.closed && this.targetText && this.targetText !== this.currentText) {
      const waitMs = Math.max(
        0,
        this.minUpdateIntervalMs - (this.now() - this.lastUpdateAt)
      );
      if (waitMs) {
        await this.wait(waitMs);
      }
      if (this.closed || !this.targetText || this.targetText === this.currentText) {
        break;
      }

      const nextText = this.targetText;
      await this.renewStreamingModeIfNeeded();
      this.sequence += 1;
      await this.updateStreamingContentWithRecovery(nextText, this.sequence);
      this.lastUpdateAt = this.now();
      if (this.targetText === nextText) {
        this.currentText = nextText;
      }
    }
  }

  async updateStreamingContentWithRecovery(text, sequence) {
    try {
      await this.plugin.updateStreamingContent({
        cardId: this.cardId,
        elementId: this.elementId,
        text,
        sequence
      });
      return;
    } catch (error) {
      if (!isRecoverableStreamingModeError(error)) {
        throw error;
      }

      const modeClosed = isStreamingModeClosedError(error);
      const eventPrefix = modeClosed
        ? 'feishu.stream.mode_closed'
        : 'feishu.stream.timeout';
      this.logger.event?.(`${eventPrefix}.detected`, errorLogMeta(error, {
        cardId: this.cardId,
        sequence,
        leaseAgeMs: this.now() - this.streamingModeOpenedAt
      }));
      const renewed = await this.renewStreamingModeIfNeeded({
        force: true,
        reason: modeClosed ? 'card_streaming_mode_closed' : 'card_streaming_timeout'
      });
      if (!renewed) {
        throw error;
      }

      this.sequence += 1;
      await this.plugin.updateStreamingContent({
        cardId: this.cardId,
        elementId: this.elementId,
        text,
        sequence: this.sequence
      });
      this.logger.event?.(`${eventPrefix}.recovered`, {
        cardId: this.cardId,
        sequence: this.sequence
      });
    }
  }

  async renewStreamingModeIfNeeded({ force = false, reason = 'lease_expiring' } = {}) {
    if (typeof this.plugin.renewStreamingMode !== 'function') {
      return false;
    }

    const now = this.now();
    const leaseAgeMs = now - this.streamingModeOpenedAt;
    if (!force && leaseAgeMs < this.streamRenewAfterMs) {
      return false;
    }
    if (!force && now - this.lastRenewalAttemptAt < this.streamRenewRetryMs) {
      return false;
    }

    this.lastRenewalAttemptAt = now;
    this.sequence += 1;
    const sequence = this.sequence;
    try {
      await this.plugin.renewStreamingMode({
        cardId: this.cardId,
        sequence
      });
      this.streamingModeOpenedAt = this.now();
      this.logger.event?.('feishu.stream.lease.renewed', {
        cardId: this.cardId,
        sequence,
        reason,
        leaseAgeMs
      });
      return true;
    } catch (error) {
      this.logger.warn?.('Feishu stream lease renewal failed', errorLogMeta(error, {
        cardId: this.cardId,
        sequence,
        reason,
        leaseAgeMs
      }));
      this.logger.event?.('feishu.stream.lease.renewal_failed', errorLogMeta(error, {
        cardId: this.cardId,
        sequence,
        reason,
        leaseAgeMs
      }));
      return false;
    }
  }

  async finish(text) {
    if (this.closed) return;
    const explicitText = String(text || '').trim();
    const usingActionFeedback = !explicitText && Boolean(this.actionFeedbackText);
    const sourceText = String(
      explicitText || this.actionFeedbackText || this.currentText || ''
    ).trim();
    let preparedContent = null;
    if (this.renderLatex && !usingActionFeedback) {
      preparedContent = await this.plugin.prepareFinalCardContent(sourceText).catch((error) => {
        this.logger.warn?.('Feishu final LaTeX preparation failed', errorLogMeta(error, {
          cardId: this.cardId
        }));
        return null;
      });
    }
    const finalText = String(preparedContent?.text || sourceText).trim();
    let finalUpdateError = null;
    if (!preparedContent?.elements) {
      await this.update(finalText).catch((error) => {
        finalUpdateError = error;
        this.logger.warn?.('Feishu stream final update failed', errorLogMeta(error, {
          cardId: this.cardId
        }));
      });
    }
    this.closed = true;
    this.sequence += 1;
    try {
      await this.closeCardWithRetry({
        cardId: this.cardId,
        sequence: this.sequence,
        summary: preparedContent?.summary || summarizeForCard(finalText),
        text: finalText,
        title: this.title,
        template: this.completedTemplate,
        subtitle: this.completedSubtitle,
        contentElements: preparedContent?.elements || null
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
      this.logger.event?.('feishu.stream.final_update_recovered', {
        cardId: this.cardId,
        error: finalUpdateError.message
      });
    }
    this.logger.event?.('feishu.stream.finished', {
      cardId: this.cardId,
      chars: finalText.length,
      text: clipForLog(finalText, 800)
    });
  }

  async closeCardWithRetry(payload) {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.plugin.closeStreamingCard({
          ...payload,
          sequence: this.sequence
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= 2) break;
        this.logger.warn?.('Feishu stream close retry', errorLogMeta(error, {
          cardId: this.cardId,
          attempt
        }));
        this.logger.event?.('feishu.stream.close.retry', {
          cardId: this.cardId,
          attempt,
          error: error.message
        });
        await delay(FEISHU_STREAM_CLOSE_RETRY_MS);
        this.sequence += 1;
      }
    }
    throw lastError;
  }

  unregister() {
    if (this.messageId && this.plugin.replyStreamsByMessageId.get(this.messageId) === this) {
      this.plugin.replyStreamsByMessageId.delete(this.messageId);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function clipForLog(text, max = 1200) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated]`;
}

function isStreamingTimeoutError(error) {
  if (Number(error?.code) === 200510) return true;
  return /(?:\b200510\b|card streaming timeout|streaming timeout)/i.test(
    String(error?.message || '')
  );
}

function isStreamingModeClosedError(error) {
  if (Number(error?.code) === 300309) return true;
  return /(?:\b300309\b|streaming mode is closed)/i.test(
    String(error?.message || '')
  );
}

function isRecoverableStreamingModeError(error) {
  return isStreamingTimeoutError(error) || isStreamingModeClosedError(error);
}

function isOngoingInteractionError(error) {
  return Number(error?.code) === 200810 || /\b200810\b/.test(String(error?.message || ''));
}

function errorLogMeta(error, extra = {}) {
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

module.exports = {
  FEISHU_STREAM_LEASE_MS,
  FEISHU_STREAM_RENEW_AFTER_MS,
  FeishuReplyStream,
  errorLogMeta,
  isRecoverableStreamingModeError,
  isStreamingModeClosedError,
  isStreamingTimeoutError
};
