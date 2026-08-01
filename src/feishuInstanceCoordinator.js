const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_POLL_INTERVAL_MS = 500;
const LEASE_STALE_MS = 10000;

class FeishuInstanceCoordinator {
  constructor({
    directory,
    instanceId = crypto.randomUUID(),
    pid = process.pid,
    startedAt = Date.now(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    isProcessAlive = defaultIsProcessAlive,
    onState = () => {},
    logger = console
  }) {
    if (!directory) throw new Error('Feishu instance coordination directory is required.');

    this.directory = path.resolve(directory);
    this.instanceId = normalizeInstanceId(instanceId);
    this.pid = Number(pid);
    this.startedAt = Number(startedAt) || Date.now();
    this.pollIntervalMs = Math.max(0, Number(pollIntervalMs) || 0);
    this.isProcessAlive = isProcessAlive;
    this.onState = onState;
    this.logger = logger;
    this.instancePath = path.join(this.directory, `instance-${this.instanceId}.json`);
    this.selectionPath = path.join(this.directory, 'feishu-selection.json');
    this.leaseDirectory = path.join(this.directory, 'feishu-connection.lock');
    this.leasePath = path.join(this.leaseDirectory, 'owner.json');
    this.timer = null;
    this.started = false;
    this.state = {
      instanceId: this.instanceId,
      instanceCount: 1,
      multiple: false,
      selected: true,
      ownerId: this.instanceId
    };
  }

  start() {
    if (this.started) return this.getState();
    this.started = true;
    this.ensureDirectory();
    this.writeHeartbeat();
    this.writeSelection(this.instanceId, 'latest_instance');
    this.refresh();

    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => {
        try {
          this.writeHeartbeat();
          this.refresh();
        } catch (error) {
          this.logger.warn?.('Failed to refresh Remote Codex instance state', {
            instanceId: this.instanceId,
            error: error.message
          });
        }
      }, this.pollIntervalMs);
      this.timer.unref?.();
    }

    return this.getState();
  }

  stop({ releaseLease = false } = {}) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (releaseLease) this.releaseConnectionLease();
    safeUnlink(this.instancePath);

    const selection = readJson(this.selectionPath);
    if (selection?.ownerId === this.instanceId) {
      const remaining = this.readLiveInstances();
      const replacement = newestInstance(remaining);
      this.writeSelection(replacement?.instanceId || null, 'owner_exited');
    }
    this.started = false;
  }

  refresh() {
    this.ensureDirectory();
    let instances = this.readLiveInstances();
    if (this.started && !instances.some((entry) => entry.instanceId === this.instanceId)) {
      this.writeHeartbeat();
      instances = this.readLiveInstances();
    }

    let selection = readJson(this.selectionPath);
    const ownerIsLive = selection?.ownerId && instances.some(
      (entry) => entry.instanceId === selection.ownerId
    );

    if (instances.length === 1) {
      const onlyInstanceId = instances[0].instanceId;
      if (selection?.ownerId !== onlyInstanceId) {
        this.writeSelection(onlyInstanceId, 'single_instance');
        selection = readJson(this.selectionPath);
      }
    } else if (!selection || (selection.ownerId && !ownerIsLive)) {
      const replacement = newestInstance(instances);
      this.writeSelection(replacement?.instanceId || null, 'owner_unavailable');
      selection = readJson(this.selectionPath);
    }

    const ownerId = typeof selection?.ownerId === 'string'
      ? selection.ownerId
      : null;
    this.state = {
      instanceId: this.instanceId,
      instanceCount: instances.length,
      multiple: instances.length > 1,
      selected: ownerId === this.instanceId,
      ownerId
    };
    this.emitState();
    return this.getState();
  }

  setSelected(selected) {
    if (selected) {
      this.writeSelection(this.instanceId, 'user_selected');
    } else {
      const selection = readJson(this.selectionPath);
      if (selection?.ownerId === this.instanceId) {
        this.writeSelection(null, 'user_cleared');
      }
    }
    return this.refresh();
  }

  isSelected() {
    return this.state.selected === true;
  }

  getState() {
    return { ...this.state };
  }

  tryAcquireConnectionLease() {
    this.ensureDirectory();
    if (!this.isSelected()) return false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.mkdirSync(this.leaseDirectory, { mode: 0o700 });
        this.writeLease();
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }

      const lease = readJson(this.leasePath);
      if (lease?.instanceId === this.instanceId) {
        this.writeLease();
        return true;
      }
      if (this.isLeaseLive(lease)) return false;
      if (!this.removeStaleLease()) return false;
    }

    return false;
  }

  holdsConnectionLease() {
    return readJson(this.leasePath)?.instanceId === this.instanceId;
  }

  releaseConnectionLease() {
    const lease = readJson(this.leasePath);
    if (lease?.instanceId !== this.instanceId) return false;
    safeUnlink(this.leasePath);
    try {
      fs.rmdirSync(this.leaseDirectory);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
    }
    return true;
  }

  ensureDirectory() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
  }

  writeHeartbeat() {
    writeJsonAtomic(this.instancePath, {
      instanceId: this.instanceId,
      pid: this.pid,
      startedAt: this.startedAt,
      heartbeatAt: Date.now()
    });
  }

  writeSelection(ownerId, reason) {
    this.ensureDirectory();
    writeJsonAtomic(this.selectionPath, {
      ownerId: ownerId || null,
      updatedAt: Date.now(),
      updatedBy: this.instanceId,
      reason
    });
  }

  writeLease() {
    writeJsonAtomic(this.leasePath, {
      instanceId: this.instanceId,
      pid: this.pid,
      heartbeatAt: Date.now()
    });
  }

  readLiveInstances() {
    this.ensureDirectory();
    const instances = [];
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^instance-[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
      const filePath = path.join(this.directory, name);
      const entry = readJson(filePath);
      if (this.isInstanceLive(entry)) {
        instances.push(entry);
      } else {
        safeUnlink(filePath);
      }
    }
    return instances;
  }

  isInstanceLive(entry) {
    if (!entry || typeof entry.instanceId !== 'string') return false;
    if (!Number.isInteger(Number(entry.pid)) || Number(entry.pid) <= 0) return false;
    return entry.instanceId === this.instanceId || this.isProcessAlive(Number(entry.pid));
  }

  isLeaseLive(lease) {
    if (!lease || !Number.isInteger(Number(lease.pid)) || Number(lease.pid) <= 0) {
      try {
        return Date.now() - fs.statSync(this.leaseDirectory).mtimeMs < LEASE_STALE_MS;
      } catch (_error) {
        return false;
      }
    }
    if (!this.isProcessAlive(Number(lease.pid))) return false;

    const matchingInstance = readJson(
      path.join(this.directory, `instance-${normalizeInstanceId(lease.instanceId)}.json`)
    );
    if (matchingInstance?.instanceId === lease.instanceId) return true;
    return Date.now() - Number(lease.heartbeatAt || 0) < LEASE_STALE_MS;
  }

  removeStaleLease() {
    safeUnlink(this.leasePath);
    try {
      fs.rmdirSync(this.leaseDirectory);
      return true;
    } catch (error) {
      return error.code === 'ENOENT';
    }
  }

  emitState() {
    try {
      const result = this.onState(this.getState());
      result?.catch?.((error) => {
        this.logger.warn?.('Failed to apply Remote Codex instance state', {
          instanceId: this.instanceId,
          error: error.message
        });
      });
    } catch (error) {
      this.logger.warn?.('Failed to publish Remote Codex instance state', {
        instanceId: this.instanceId,
        error: error.message
      });
    }
  }
}

function newestInstance(instances) {
  return [...instances].sort((left, right) => {
    const timeDifference = Number(right.startedAt || 0) - Number(left.startedAt || 0);
    if (timeDifference) return timeDifference;
    return String(right.instanceId).localeCompare(String(left.instanceId));
  })[0] || null;
}

function normalizeInstanceId(value) {
  const text = String(value || '');
  if (/^[a-zA-Z0-9_-]+$/.test(text)) return text;
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

module.exports = {
  FeishuInstanceCoordinator,
  newestInstance
};
