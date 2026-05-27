const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const pty = require('node-pty');
const { loadConfig } = require('./config');

const moduleConfig = loadConfig();
const defaultCommand = moduleConfig.codex.command || 'codex';
const defaultCwd = moduleConfig.codex.defaultCwd || os.homedir();

class CodexSession extends EventEmitter {
  constructor({
    id,
    command,
    args,
    cwd,
    cols,
    rows,
    env,
    maxBufferedChunks,
    outputRecorder
  }) {
    super();
    this.id = id;
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.cols = cols;
    this.rows = rows;
    this.createdAt = new Date().toISOString();
    this.exitedAt = null;
    this.exit = null;
    this.cursor = 0;
    this.output = [];
    this.maxBufferedChunks = Number(maxBufferedChunks) || 5000;
    this.outputRecorder = outputRecorder || null;

    this.shell = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        ...env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      }
    });

    this.shell.onData((data) => {
      const chunk = {
        cursor: ++this.cursor,
        data,
        at: new Date().toISOString()
      };
      this.output.push(chunk);
      if (this.output.length > this.maxBufferedChunks) {
        this.output.splice(0, this.output.length - this.maxBufferedChunks);
      }
      this.outputRecorder?.recordOutput(this, chunk);
      this.emit('data', chunk);
    });

    this.shell.onExit(({ exitCode, signal }) => {
      this.exitedAt = new Date().toISOString();
      this.exit = { exitCode, signal: signal || null };
      this.outputRecorder?.recordExit(this, this.exit);
      this.emit('exit', this.exit);
    });
  }

  write(data) {
    if (!this.shell || this.exit) {
      throw new Error('Session has exited');
    }
    this.outputRecorder?.recordInput(this, data);
    this.shell.write(data);
  }

  resize(cols, rows) {
    if (!this.shell || this.exit) {
      throw new Error('Session has exited');
    }
    const nextCols = Math.max(2, Number(cols) || this.cols);
    const nextRows = Math.max(2, Number(rows) || this.rows);
    if (nextCols === this.cols && nextRows === this.rows) return;
    this.cols = nextCols;
    this.rows = nextRows;
    this.shell.resize(nextCols, nextRows);
  }

  readAfter(cursor = 0) {
    const after = Number(cursor) || 0;
    return {
      cursor: this.cursor,
      chunks: this.output.filter((chunk) => chunk.cursor > after),
      exited: Boolean(this.exit),
      exit: this.exit
    };
  }

  status() {
    return {
      id: this.id,
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      exitedAt: this.exitedAt,
      exited: Boolean(this.exit),
      exit: this.exit,
      cursor: this.cursor
    };
  }

  kill() {
    if (this.shell && !this.exit) {
      this.shell.kill();
    }
  }
}

class CodexSessionManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.outputRecorder = options.outputRecorder || null;
    this.updateConfig(options.config || loadConfig());
  }

  updateConfig(config) {
    this.config = config || loadConfig();
    this.outputRecorder?.updateConfig?.(this.config);
    this.defaultCommand = this.config.codex.command || defaultCommand;
    this.defaultArgs = Array.isArray(this.config.codex.args)
      ? this.config.codex.args
      : [];
    this.defaultCwd = this.config.codex.defaultCwd || defaultCwd;
    this.maxBufferedChunks =
      Number(this.config.codex.outputBufferChunks) || 5000;
  }

  create(options = {}) {
    const id = options.id || crypto.randomUUID();
    if (this.sessions.has(id)) {
      throw new Error(`Session already exists: ${id}`);
    }

    const session = new CodexSession({
      id,
      command: options.command || this.defaultCommand,
      args: Array.isArray(options.args) ? options.args : this.defaultArgs,
      cwd: options.cwd || this.defaultCwd,
      cols: Number(options.cols) || 120,
      rows: Number(options.rows) || 34,
      env: options.env && typeof options.env === 'object' ? options.env : {},
      maxBufferedChunks: this.maxBufferedChunks,
      outputRecorder: this.outputRecorder
    });

    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }
    return session;
  }

  list() {
    return [...this.sessions.values()].map((session) => session.status());
  }

  delete(id) {
    const session = this.get(id);
    session.kill();
    this.sessions.delete(id);
    return session.status();
  }

  killAll() {
    for (const session of this.sessions.values()) {
      session.kill();
    }
    this.sessions.clear();
  }
}

module.exports = {
  CodexSessionManager,
  defaultCommand,
  defaultCwd
};
