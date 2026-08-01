function parseLaunchOptions(argv = process.argv, env = process.env, options = {}) {
  const args = getUserArgs(argv, options);
  const cliOptions = parseCliOptions(args);
  const resumeArgs = cliOptions.resumeDisabled
    ? null
    : cliOptions.resumeArgs ?? parseEnvResumeArgs(env);
  return {
    args,
    codexArgs: cliOptions.codexArgs,
    resumeArgs
  };
}

function getUserArgs(argv, options = {}) {
  if (!Array.isArray(argv)) return [];
  return argv.slice(options.packaged ? 1 : 2);
}

function parseCliOptions(args) {
  const values = Array.isArray(args) ? args : [];

  if (values[0] === '--no-resume') {
    return {
      codexArgs: values.slice(1),
      resumeArgs: null,
      resumeDisabled: true
    };
  }

  if (values[0] === 'resume') {
    return {
      codexArgs: [],
      resumeArgs: values.slice(1),
      resumeDisabled: false
    };
  }

  const lastIndex = values.indexOf('--resume-last');
  if (lastIndex >= 0) {
    return {
      codexArgs: values.slice(0, lastIndex),
      resumeArgs: ['--last', ...values.slice(lastIndex + 1)],
      resumeDisabled: false
    };
  }

  const resumeIndex = values.indexOf('--resume');
  if (resumeIndex >= 0) {
    return {
      codexArgs: values.slice(0, resumeIndex),
      resumeArgs: values.slice(resumeIndex + 1),
      resumeDisabled: false
    };
  }

  return {
    codexArgs: [...values],
    resumeArgs: null,
    resumeDisabled: false
  };
}

function parseEnvResumeArgs(env = process.env) {
  const rawResume = env.REMOTE_CODEX_RESUME ?? env.CODEX_RESUME;
  if (rawResume === undefined || rawResume === '') return null;

  const value = String(rawResume).trim();
  if (!value) return null;
  if (['0', 'false', 'off', 'no'].includes(value.toLowerCase())) return null;

  const args = ['1', 'true', 'yes', 'on', 'last'].includes(value.toLowerCase())
    ? ['--last']
    : [value];
  const prompt = String(env.REMOTE_CODEX_RESUME_PROMPT || '').trim();
  if (prompt) args.push(prompt);
  return args;
}

function buildCodexArgs(baseArgs, launchOptions = {}) {
  const normalizedBaseArgs = Array.isArray(baseArgs) ? [...baseArgs] : [];
  const codexArgs = Array.isArray(launchOptions.codexArgs)
    ? [...launchOptions.codexArgs]
    : [];
  const resumeArgs = launchOptions.resumeArgs;
  if (!Array.isArray(resumeArgs)) return [...normalizedBaseArgs, ...codexArgs];
  return ['resume', ...normalizedBaseArgs, ...codexArgs, ...resumeArgs];
}

module.exports = {
  parseLaunchOptions,
  buildCodexArgs
};
