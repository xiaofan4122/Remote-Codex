const DEFINITIONS = [
  ['model', 'picker'],
  ['fast', 'immediate'],
  ['ide', 'immediate'],
  ['permissions', 'picker', ['permission', 'perm']],
  ['keymap', 'picker'],
  ['vim', 'immediate'],
  ['experimental', 'picker'],
  ['approve', 'conflict'],
  ['memories', 'picker'],
  ['skills', 'picker'],
  ['import', 'picker'],
  ['hooks', 'picker'],
  ['review', 'picker_task'],
  ['rename', 'input'],
  ['new', 'session'],
  ['archive', 'destructive'],
  ['delete', 'destructive'],
  ['resume', 'picker'],
  ['fork', 'session'],
  ['init', 'rollout'],
  ['compact', 'rollout'],
  ['plan', 'mode'],
  ['goal', 'report'],
  ['agent', 'picker', ['subagents']],
  ['side', 'rollout', ['btw']],
  ['copy', 'immediate'],
  ['raw', 'immediate'],
  ['diff', 'viewer'],
  ['mention', 'input'],
  ['status', 'report'],
  ['usage', 'picker'],
  ['title', 'picker'],
  ['statusline', 'picker'],
  ['theme', 'picker'],
  ['pets', 'picker', ['pet']],
  ['mcp', 'report'],
  ['plugins', 'picker'],
  ['logout', 'destructive'],
  ['exit', 'destructive', ['quit']],
  ['feedback', 'picker'],
  ['ps', 'report'],
  ['stop', 'conflict', ['clean']],
  ['clear', 'session'],
  ['personality', 'picker'],
  ['apps', 'picker'],
  ['debug-config', 'report']
];

const COMMANDS = new Map();
for (const [name, kind, aliases = []] of DEFINITIONS) {
  const command = `/${name}`;
  const definition = { command, kind, aliases: aliases.map((alias) => `/${alias}`) };
  COMMANDS.set(command, definition);
  for (const alias of definition.aliases) COMMANDS.set(alias, definition);
}

const REMOTE_ALIASES = new Map([
  ['/codex-approve', '/approve'],
  ['/native-approve', '/approve'],
  ['/codex-stop', '/stop'],
  ['/native-stop', '/stop']
]);

function getNativeSlashDefinition(command) {
  const value = normalizeSlashToken(command);
  const aliased = REMOTE_ALIASES.get(value) || value;
  const definition = COMMANDS.get(aliased);
  if (!definition) return null;
  return {
    ...definition,
    requestedCommand: value,
    command: definition.command,
    remoteAlias: REMOTE_ALIASES.has(value)
  };
}

function normalizeNativeSlashCommand(command) {
  return getNativeSlashDefinition(command)?.command || normalizeSlashToken(command) || '/status';
}

function normalizeNativeSlashText(text) {
  const value = String(text || '').trim();
  const [command, ...args] = value.split(/\s+/);
  const normalized = normalizeNativeSlashCommand(command);
  return [normalized, ...args].join(' ').trim();
}

function shouldRouteAsNativePage(command, text = '') {
  const definition = getNativeSlashDefinition(command);
  if (!definition) return false;
  if (definition.kind === 'conflict') return definition.remoteAlias;
  if (definition.kind === 'destructive' || definition.kind === 'rollout') return false;
  if (definition.kind === 'mode' && String(text || '').trim().split(/\s+/).length > 1) {
    return false;
  }
  return true;
}

function shouldBindNextRollout(text) {
  const value = String(text || '').trim();
  const [command, ...args] = value.split(/\s+/);
  const definition = getNativeSlashDefinition(command);
  if (!definition) return false;
  if (definition.kind === 'rollout') return true;
  return definition.kind === 'mode' && args.length > 0;
}

function isBlockedNativeSlashCommand(command) {
  return getNativeSlashDefinition(command)?.kind === 'destructive';
}

function isNativeSlashInteractive(command) {
  return ['picker', 'picker_task', 'input', 'viewer'].includes(
    getNativeSlashDefinition(command)?.kind
  );
}

function getNativeSlashActions(command) {
  const kind = getNativeSlashDefinition(command)?.kind;
  if (kind === 'viewer') {
    return ['up', 'down', 'page_up', 'page_down', 'viewer_exit'];
  }
  if (kind === 'picker' || kind === 'picker_task') {
    return ['up', 'down', 'enter', 'escape'];
  }
  if (kind === 'input') return ['escape'];
  return [];
}

function getNativeSlashCommandMatrix() {
  return DEFINITIONS.map(([name, kind, aliases = []]) => ({
    command: `/${name}`,
    kind,
    aliases: aliases.map((alias) => `/${alias}`)
  }));
}

function normalizeSlashToken(command) {
  const value = String(command || '').trim().toLowerCase();
  if (!value || !value.startsWith('/')) return '';
  return value;
}

module.exports = {
  getNativeSlashActions,
  getNativeSlashCommandMatrix,
  getNativeSlashDefinition,
  isBlockedNativeSlashCommand,
  isNativeSlashInteractive,
  normalizeNativeSlashCommand,
  normalizeNativeSlashText,
  shouldBindNextRollout,
  shouldRouteAsNativePage
};
