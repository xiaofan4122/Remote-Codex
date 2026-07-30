const { buildStreamingActionFeedback } = require('./cardActions');
const { summarizeForCard } = require('./cardMarkdown');

const FEISHU_STREAM_MIN_UPDATE_INTERVAL_MS = 110;
const FEISHU_STREAM_CLOSE_RETRY_MS = 250;

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
    logger = console
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
    this.sequence = 1;
    this.currentText = '';
    this.targetText = '';
    this.flushPromise = null;
    this.lastUpdateAt = 0;
    this.closed = false;
    this.actionFeedbackText = '';
  }

  async update(text) {
    this.actionFeedbackText = '';
    return this.setTargetText(text);
  }

  async replace(text) {
    this.actionFeedbackText = '';
    return this.setTargetText(text);
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
        FEISHU_STREAM_MIN_UPDATE_INTERVAL_MS - (Date.now() - this.lastUpdateAt)
      );
      if (waitMs) {
        await delay(waitMs);
      }
      if (this.closed || !this.targetText || this.targetText === this.currentText) {
        break;
      }

      const nextText = this.targetText;
      this.sequence += 1;
      const sequence = this.sequence;
      await this.plugin.updateStreamingContent({
        cardId: this.cardId,
        elementId: this.elementId,
        text: nextText,
        sequence
      });
      this.lastUpdateAt = Date.now();
      if (this.targetText === nextText) {
        this.currentText = nextText;
      }
    }
  }

  async finish(text) {
    if (this.closed) return;
    const sourceText = String(this.actionFeedbackText || text || this.currentText || '').trim();
    let preparedContent = null;
    if (this.renderLatex && !this.actionFeedbackText) {
      preparedContent = await this.plugin.prepareFinalCardContent(sourceText).catch((error) => {
        this.logger.warn?.('Feishu final LaTeX preparation failed:', error.message);
        return null;
      });
    }
    const finalText = String(preparedContent?.text || sourceText).trim();
    let finalUpdateError = null;
    if (!preparedContent?.elements) {
      await this.update(finalText).catch((error) => {
        finalUpdateError = error;
        this.logger.warn?.('Feishu stream final update failed:', error.message);
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
        this.logger.warn?.('Feishu stream close retry:', error.message);
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

module.exports = {
  FeishuReplyStream
};
