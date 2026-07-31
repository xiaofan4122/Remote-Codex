const fs = require('node:fs');
const path = require('node:path');

function discoverPlugins() {
  return fs
    .readdirSync(__dirname, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const pluginPath = path.join(__dirname, entry.name);
      return require(pluginPath);
    })
    .filter((plugin) => plugin?.id && typeof plugin.create === 'function');
}

class PluginManager {
  constructor({ config, services, logger = console }) {
    this.config = config;
    this.services = services;
    this.logger = logger;
    this.registry = new Map();
    this.instances = new Map();

    for (const plugin of discoverPlugins()) {
      this.registry.set(plugin.id, plugin);
    }
  }

  listDescriptors() {
    return [...this.registry.values()].map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      modes: plugin.modes || []
    }));
  }

  getPluginConfig(pluginId) {
    return this.config.plugins?.[pluginId] || {};
  }

  async startEnabled() {
    for (const plugin of this.registry.values()) {
      const pluginConfig = this.getPluginConfig(plugin.id);
      if (!pluginConfig.enabled) continue;
      await this.start(plugin.id);
    }
  }

  async start(pluginId) {
    if (this.instances.has(pluginId)) {
      return this.instances.get(pluginId);
    }

    const instance = this.createInstance(pluginId);
    await instance.start?.();
    this.instances.set(pluginId, instance);
    return instance;
  }

  createInstance(pluginId) {
    const plugin = this.registry.get(pluginId);
    if (!plugin) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }

    return plugin.create({
      config: this.config,
      pluginConfig: this.getPluginConfig(pluginId),
      services: this.services,
      logger: this.logger
    });
  }

  async stopAll() {
    const instances = [...this.instances.values()].reverse();
    this.instances.clear();

    for (const instance of instances) {
      await instance.stop?.();
    }
  }

  async restart(config) {
    await this.stopAll();
    this.config = config;
    await this.startEnabled();
  }

  async invoke(pluginId, action, payload = {}) {
    const instance = this.instances.get(pluginId) || this.createInstance(pluginId);

    if (!instance.invoke) {
      throw new Error(`Plugin does not support actions: ${pluginId}`);
    }

    return instance.invoke(action, payload);
  }

  getInstance(pluginId) {
    return this.instances.get(pluginId) || null;
  }

  getStatuses() {
    return this.listDescriptors().map((plugin) => {
      const instance = this.instances.get(plugin.id);
      return {
        ...plugin,
        enabled: Boolean(this.getPluginConfig(plugin.id).enabled),
        running: Boolean(instance),
        status: instance?.getStatus?.() || null
      };
    });
  }
}

module.exports = {
  PluginManager
};
