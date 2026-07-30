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
    responseSource: 'rollout_jsonl',
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
      flushIntervalMs: 100,
      finalReplyDebounceMs: 1500,
      singleCardOutput: true,
      streaming: true,
      segmentedOutput: false,
      fileTransferEnabled: true,
      fileTransferMaxBytes: 31457280,
      fileTransferMaxFiles: 5,
      latexRenderingEnabled: true,
      latexMaxFormulas: 64,
      ackReactionEnabled: true,
      ackReactionEmoji: '了解',
      doneReactionEnabled: true,
      doneReactionEmoji: 'DONE',
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
      responseSource: process.env.REMOTE_CODEX_RESPONSE_SOURCE,
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
        requireMention: parseBoolean(process.env.FEISHU_REQUIRE_MENTION),
        flushIntervalMs: parseNumber(process.env.FEISHU_FLUSH_INTERVAL_MS),
        finalReplyDebounceMs: parseNumber(process.env.FEISHU_FINAL_REPLY_DEBOUNCE_MS),
        singleCardOutput: parseBoolean(process.env.FEISHU_SINGLE_CARD_OUTPUT),
        streaming: parseBoolean(process.env.FEISHU_STREAMING),
        segmentedOutput: parseBoolean(process.env.FEISHU_SEGMENTED_OUTPUT),
        fileTransferEnabled: parseBoolean(process.env.FEISHU_FILE_TRANSFER_ENABLED),
        fileTransferMaxBytes: parseNumber(process.env.FEISHU_FILE_TRANSFER_MAX_BYTES),
        fileTransferMaxFiles: parseNumber(process.env.FEISHU_FILE_TRANSFER_MAX_FILES),
        latexRenderingEnabled: parseBoolean(process.env.FEISHU_LATEX_RENDERING_ENABLED),
        latexMaxFormulas: parseNumber(process.env.FEISHU_LATEX_MAX_FORMULAS),
        ackReactionEnabled: parseBoolean(process.env.FEISHU_ACK_REACTION_ENABLED),
        ackReactionEmoji: process.env.FEISHU_ACK_REACTION_EMOJI,
        doneReactionEnabled: parseBoolean(process.env.FEISHU_DONE_REACTION_ENABLED),
        doneReactionEmoji: process.env.FEISHU_DONE_REACTION_EMOJI
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

  for (const key of [
    'rawOutputLogEnabled',
    'rawOutputLogPath',
    'rawOutputLogMaxBytes',
    'rawOutputLogRecordTerminalControls',
    'rawOutputLogRecordParserTrace'
  ]) {
    delete next.remoteControl[key];
  }

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
  next.plugins.feishu.singleCardOutput =
    next.plugins.feishu.singleCardOutput !== false;
  if (next.plugins.feishu.singleCardOutput) {
    next.plugins.feishu.streaming = true;
    next.plugins.feishu.segmentedOutput = false;
  }
  next.plugins.feishu.fileTransferEnabled =
    next.plugins.feishu.fileTransferEnabled !== false;
  next.plugins.feishu.fileTransferMaxBytes = normalizePositiveInteger(
    next.plugins.feishu.fileTransferMaxBytes,
    defaultConfig.plugins.feishu.fileTransferMaxBytes,
    defaultConfig.plugins.feishu.fileTransferMaxBytes
  );
  next.plugins.feishu.fileTransferMaxFiles = normalizePositiveInteger(
    next.plugins.feishu.fileTransferMaxFiles,
    defaultConfig.plugins.feishu.fileTransferMaxFiles,
    20
  );
  next.plugins.feishu.latexRenderingEnabled =
    next.plugins.feishu.latexRenderingEnabled !== false;
  next.plugins.feishu.latexMaxFormulas = normalizePositiveInteger(
    next.plugins.feishu.latexMaxFormulas,
    defaultConfig.plugins.feishu.latexMaxFormulas,
    defaultConfig.plugins.feishu.latexMaxFormulas
  );
  if (
    next.plugins.feishu.streaming &&
    next.remoteControl.outputMode === 'final' &&
    Number(next.remoteControl.flushIntervalMs) > 900
  ) {
    next.remoteControl.flushIntervalMs = defaultConfig.remoteControl.flushIntervalMs;
  }

  const configuredDefaultCwd = next.codex.defaultCwd || '';
  const launchCwd =
    process.env.REMOTE_CODEX_LAUNCH_CWD || process.cwd() || os.homedir();
  const useConfiguredDefaultCwd = parseBoolean(
    process.env.REMOTE_CODEX_USE_CONFIG_DEFAULT_CWD
  );

  next.codex.configuredDefaultCwd = configuredDefaultCwd;
  next.codex.launchCwd = launchCwd;
  next.codex.defaultCwd = useConfiguredDefaultCwd
    ? configuredDefaultCwd || launchCwd
    : process.env.CODEX_WORKDIR || launchCwd;

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
  if (source === 'visual_terminal' || source === 'pty') return 'rollout_jsonl';
  if (['app_server', 'exec_json', 'rollout_jsonl'].includes(source)) return source;
  return defaultConfig.remoteControl.responseSource;
}

function normalizePositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), maximum);
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
  if (next.codex) {
    if (Object.prototype.hasOwnProperty.call(next.codex, 'configuredDefaultCwd')) {
      next.codex.defaultCwd = next.codex.configuredDefaultCwd || '';
    }
    delete next.codex.configuredDefaultCwd;
    delete next.codex.launchCwd;
  }
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
  normalizeConfig,
  saveConfig
};
