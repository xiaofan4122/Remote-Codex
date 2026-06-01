const QRCode = require('qrcode');

class FeishuRegistrationManager {
  constructor({ onUpdate, onComplete, logger = console }) {
    this.onUpdate = onUpdate;
    this.onComplete = onComplete;
    this.logger = logger;
    this.controller = null;
    this.promise = null;
    this.state = {
      status: 'idle'
    };
  }

  start(options = {}) {
    if (this.controller) {
      return this.getStatus();
    }

    const Lark = requireLarkSdk();
    this.controller = new AbortController();
    this.update({
      status: 'starting',
      message: 'Preparing Feishu authorization...',
      startedAt: new Date().toISOString(),
      url: '',
      qrDataUrl: '',
      appId: '',
      userOpenId: '',
      tenantBrand: '',
      errorCode: ''
    });

    this.promise = Lark.registerApp({
      source: options.source || 'remote-codex',
      signal: this.controller.signal,
      onQRCodeReady: (info) => this.handleQRCodeReady(info),
      onStatusChange: (info) => this.handleStatusChange(info)
    })
      .then(async (result) => {
        const completion = await this.onComplete?.(result);
        const pluginError = completion?.pluginError || '';
        this.update({
          status: 'complete',
          message: pluginError
            ? `Feishu credentials saved. Plugin start error: ${pluginError}`
            : 'Feishu connected. Configure and publish the floating bot menu in the Feishu Developer Console.',
          appId: result.client_id,
          userOpenId: result.user_info?.open_id || '',
          tenantBrand: result.user_info?.tenant_brand || '',
          configPath: completion?.configPath || '',
          pluginError
        });
      })
      .catch((error) => {
        const isAbort = error.code === 'abort' || error.name === 'AbortError';
        this.update({
          status: isAbort ? 'aborted' : 'error',
          message: error.description || error.message || String(error),
          errorCode: error.code || ''
        });
      })
      .finally(() => {
        this.controller = null;
        this.promise = null;
      });

    return this.getStatus();
  }

  cancel() {
    if (!this.controller) {
      return this.getStatus();
    }

    this.update({
      status: 'aborting',
      message: 'Cancelling Feishu authorization...'
    });
    this.controller.abort();
    return this.getStatus();
  }

  getStatus() {
    return { ...this.state };
  }

  handleQRCodeReady(info) {
    const expireAt = new Date(Date.now() + Number(info.expireIn || 600) * 1000);
    this.update({
      status: 'waiting',
      message: 'Open the Feishu authorization link to continue.',
      url: info.url,
      expireIn: Number(info.expireIn || 600),
      expireAt: expireAt.toISOString()
    });

    QRCode.toDataURL(info.url, {
      width: 240,
      margin: 1,
      color: {
        dark: '#111418',
        light: '#ffffff'
      }
    })
      .then((qrDataUrl) => {
        this.update({ qrDataUrl });
      })
      .catch((error) => {
        this.logger.warn?.('Failed to render Feishu QR code:', error.message);
      });
  }

  handleStatusChange(info) {
    const messages = {
      polling: 'Waiting for Feishu authorization...',
      slow_down: 'Feishu asked to slow down polling.',
      domain_switched: 'Switched to Lark authorization domain.'
    };

    this.update({
      status: info.status,
      message: messages[info.status] || info.status,
      pollInterval: info.interval
    });
  }

  update(patch) {
    this.state = {
      ...this.state,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    try {
      this.onUpdate?.(this.getStatus());
    } catch (error) {
      this.logger.warn?.('Feishu registration update failed:', error.message);
    }
  }
}

function requireLarkSdk() {
  try {
    return require('@larksuiteoapi/node-sdk');
  } catch (error) {
    throw new Error(
      'Feishu registration requires @larksuiteoapi/node-sdk. Run `npm install` after updating dependencies.'
    );
  }
}

module.exports = {
  FeishuRegistrationManager
};
