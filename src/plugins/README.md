# Integration Plugins

Each integration lives in its own directory under `src/plugins/`. The plugin
manager automatically loads directories that expose an `index.js` module with:

```js
module.exports = {
  id: 'plugin_id',
  name: 'Display Name',
  description: 'Short description.',
  modes: ['mode_a'],
  create: (context) => new Plugin(context)
};
```

The plugin instance may implement:

```js
class Plugin {
  async start() {}
  async stop() {}
  async invoke(action, payload) {}
  getStatus() {}
}
```

The `context` object contains:

- `config`: full app config.
- `pluginConfig`: config for the current plugin.
- `services.sessionManager`: shared Codex session manager.
- `services.remoteController`: shared remote message-to-Codex controller.
- `logger`: runtime logger.

Remote-control plugins should normalize inbound messages and call:

```js
context.services.remoteController.handleMessage({
  pluginId: 'plugin_id',
  conversationId: 'chat-or-thread-id',
  userId: 'sender-id',
  text: 'message text',
  reply: async (text) => {}
});
```

This keeps access control, session creation, command parsing, and output
throttling aligned across Feishu, DingTalk, WeCom, Slack, and future plugins.
