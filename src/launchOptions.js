function parseLaunchOptions(argv = process.argv, env = process.env) {
  const args = getUserArgs(argv);
  const resumeArgs = parseCliResumeArgs(args) ?? parseEnvResumeArgs(env);
  return {
    args,
    resumeArgs
  };
}

function getUserArgs(argv) {
  const values = Array.isArray(argv) ? argv.slice(2) : [];
  return values.filter((arg) => arg !== '--');
}

function parseCliResumeArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return null;

  if (args[0] === '--no-resume') {
    return null;
  }

  if (args[0] === 'resume') {
    return args.slice(1);
  }

  const lastIndex = args.indexOf('--resume-last');
  if (lastIndex >= 0) {
    return ['--last', ...args.slice(lastIndex + 1)];
  }

  const resumeIndex = args.indexOf('--resume');
  if (resumeIndex >= 0) {
    return args.slice(resumeIndex + 1);
  }

  return null;
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
  const resumeArgs = launchOptions.resumeArgs;
  if (!Array.isArray(resumeArgs)) return normalizedBaseArgs;
  return ['resume', ...normalizedBaseArgs, ...resumeArgs];
}

module.exports = {
  parseLaunchOptions,
  buildCodexArgs
};
