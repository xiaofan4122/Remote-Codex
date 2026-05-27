const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const defaultConfig = {
  ui: {
    language: 'zh-CN'
  },
  codex: {
    command: 'codex',
    args: ['--no-alt-screen'],
    execArgs: ['--json', '--color', 'never', '--skip-git-repo-check'],
    appServerTurnTimeoutMs: 600000,
    defaultCwd: '',
    allowedWorkdirs: [],
    outputBufferChunks: 5000
  },
  api: {
    host: '127.0.0.1',
    port: 4317,
    token: '',
    corsOrigin: 'http://localhost',
    allowCommandOverride: false
  },
  remoteControl: {
    autoCreateSession: true,
    sendOutput: true,
    outputMode: 'final',
    responseSource: 'visual_terminal',
    captureCleaningCorpus: false,
    cleaningCorpusPath: '',
    rawOutputLogEnabled: false,
    rawOutputLogPath: '',
    rawOutputLogMaxBytes: 52428800,
    flushIntervalMs: 250,
    finalReplyDebounceMs: 6000
  },
  plugins: {
    feishu: {
      enabled: false,
      mode: 'long_connection',
      appId: '',
      appSecret: '',
      encryptKey: '',
      verificationToken: '',
      defaultChatId: '',
      customWebhookUrl: '',
      customWebhookSecret: '',
      allowedOpenIds: [],
      allowedChatIds: [],
      requireMention: false,
      sendOutput: true,
      outputMode: 'final',
      streaming: true,
      connectSource: '',
      connectedAt: '',
      authorizedOpenId: '',
      tenantBrand: ''
    }
  }
};

function getConfigPath() {
  if (process.env.REMOTE_CODEX_CONFIG) {
    return process.env.REMOTE_CODEX_CONFIG;
  }

  if (process.env.CODEX_SHELL_CONFIG) {
    return process.env.CODEX_SHELL_CONFIG;
  }

  const nextPath = path.join(os.homedir(), '.remote-codex.json');
  const legacyPath = path.join(os.homedir(), '.codex-electron-shell.json');
  if (!fs.existsSync(nextPath) && fs.existsSync(legacyPath)) {
    return legacyPath;
  }

  return nextPath;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(...objects) {
  const result = {};

  for (const object of objects) {
    if (!isPlainObject(object)) continue;

    for (const [key, value] of Object.entries(object)) {
      if (Array.isArray(value)) {
        result[key] = [...value];
      } else if (isPlainObject(value)) {
        result[key] = deepMerge(result[key], value);
      } else if (value !== undefined) {
        result[key] = value;
      }
    }
  }

  return result;
}

function parseBoolean(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseNumber(value) {
  if (value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseList(value) {
  if (!value) return undefined;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getEnvConfig() {
  return {
    ui: {
      language: process.env.REMOTE_CODEX_LANGUAGE || process.env.CODEX_UI_LANGUAGE
    },
    codex: {
      command: process.env.CODEX_COMMAND,
      args: parseList(process.env.CODEX_ARGS),
      execArgs: parseList(process.env.CODEX_EXEC_ARGS),
      appServerTurnTimeoutMs: parseNumber(process.env.CODEX_APP_SERVER_TURN_TIMEOUT_MS),
      defaultCwd: process.env.CODEX_WORKDIR,
      allowedWorkdirs: parseList(process.env.CODEX_ALLOWED_WORKDIRS),
      outputBufferChunks: parseNumber(process.env.CODEX_OUTPUT_BUFFER_CHUNKS)
    },
    api: {
      host: process.env.CODEX_API_HOST,
      port: parseNumber(process.env.CODEX_API_PORT),
      token: process.env.CODEX_API_TOKEN,
      corsOrigin: process.env.CODEX_API_CORS_ORIGIN,
      allowCommandOverride: parseBoolean(process.env.CODEX_API_ALLOW_COMMAND)
    },
    remoteControl: {
      captureCleaningCorpus: parseBoolean(process.env.REMOTE_CODEX_CAPTURE_CLEANING),
      cleaningCorpusPath: process.env.REMOTE_CODEX_CLEANING_CORPUS,
      rawOutputLogEnabled: parseBoolean(process.env.REMOTE_CODEX_RAW_OUTPUT_LOG),
      rawOutputLogPath: process.env.REMOTE_CODEX_RAW_OUTPUT_LOG_PATH,
      rawOutputLogMaxBytes: parseNumber(process.env.REMOTE_CODEX_RAW_OUTPUT_LOG_MAX_BYTES),
      finalReplyDebounceMs: parseNumber(process.env.REMOTE_CODEX_FINAL_REPLY_DEBOUNCE_MS)
    },
    plugins: {
      feishu: {
        enabled: parseBoolean(process.env.FEISHU_ENABLED),
        mode: process.env.FEISHU_MODE,
        appId: process.env.FEISHU_APP_ID,
        appSecret: process.env.FEISHU_APP_SECRET,
        encryptKey: process.env.FEISHU_ENCRYPT_KEY,
        verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
        defaultChatId: process.env.FEISHU_DEFAULT_CHAT_ID,
        customWebhookUrl: process.env.FEISHU_WEBHOOK_URL,
        customWebhookSecret: process.env.FEISHU_WEBHOOK_SECRET,
        allowedOpenIds: parseList(process.env.FEISHU_ALLOWED_OPEN_IDS),
        allowedChatIds: parseList(process.env.FEISHU_ALLOWED_CHAT_IDS),
        requireMention: parseBoolean(process.env.FEISHU_REQUIRE_MENTION)
      }
    }
  };
}

function readConfigFile(configPath = getConfigPath()) {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

function normalizeConfig(config, configPath = getConfigPath()) {
  const next = deepMerge(defaultConfig, config);
  next.configPath = configPath;

  if (!isPlainObject(next.ui)) {
    next.ui = {};
  }
  next.remoteControl.outputMode = normalizeOutputMode(
    next.remoteControl.outputMode
  );
  next.ui.language = normalizeLanguage(next.ui.language);
  next.remoteControl.responseSource = normalizeResponseSource(
    next.remoteControl.responseSource
  );
  next.plugins.feishu.outputMode = normalizeOutputMode(
    next.plugins.feishu.outputMode || next.remoteControl.outputMode
  );
  if (
    next.plugins.feishu.streaming &&
    next.remoteControl.outputMode === 'final' &&
    Number(next.remoteControl.flushIntervalMs) > 900
  ) {
    next.remoteControl.flushIntervalMs = defaultConfig.remoteControl.flushIntervalMs;
  }

  if (!next.codex.defaultCwd) {
    next.codex.defaultCwd =
      process.env.REMOTE_CODEX_LAUNCH_CWD || process.cwd() || os.homedir();
  }

  return next;
}

function normalizeLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  if (['en', 'en-us', 'en_us', 'english'].includes(language)) return 'en';
  if (['zh', 'zh-cn', 'zh_cn', 'cn', 'chinese', '中文'].includes(language)) {
    return 'zh-CN';
  }
  return defaultConfig.ui.language;
}

function normalizeOutputMode(value) {
  const mode = String(value || '').trim();
  if (!mode || mode === 'summary') return 'final';
  if (['final', 'full', 'silent', 'status_only'].includes(mode)) return mode;
  return 'final';
}

function normalizeResponseSource(value) {
  const source = String(value || '').trim();
  if (['app_server', 'exec_json', 'visual_terminal', 'pty'].includes(source)) return source;
  return defaultConfig.remoteControl.responseSource;
}

function loadConfig(options = {}) {
  const configPath = options.configPath || getConfigPath();
  const fileConfig = readConfigFile(configPath);
  return normalizeConfig(
    deepMerge(defaultConfig, fileConfig, getEnvConfig(), options.overrides),
    configPath
  );
}

function stripRuntimeFields(config) {
  const next = deepMerge(config);
  delete next.configPath;
  return next;
}

function saveConfig(config, options = {}) {
  const configPath = options.configPath || config.configPath || getConfigPath();
  const payload = stripRuntimeFields(config);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(`${configPath}.tmp`, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(`${configPath}.tmp`, configPath);
  return loadConfig({ configPath });
}

module.exports = {
  defaultConfig,
  deepMerge,
  getConfigPath,
  loadConfig,
  saveConfig
};
