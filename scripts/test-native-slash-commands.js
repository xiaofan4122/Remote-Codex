#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  getNativeSlashActions,
  getNativeSlashCommandMatrix,
  getNativeSlashDefinition,
  isBlockedNativeSlashCommand,
  normalizeNativeSlashCommand,
  normalizeNativeSlashText,
  shouldBindNextRollout,
  shouldRouteAsNativePage
} = require('../src/nativeSlashCommands');
const { buildControlInput } = require('../src/remoteControlInput');

const CODEX_0_146_COMMANDS = [
  '/model', '/fast', '/ide', '/permissions', '/keymap', '/vim', '/experimental',
  '/approve', '/memories', '/skills', '/import', '/hooks', '/review', '/rename',
  '/new', '/archive', '/delete', '/resume', '/fork', '/init', '/compact', '/plan',
  '/goal', '/agent', '/side', '/copy', '/raw', '/diff', '/mention', '/status',
  '/usage', '/title', '/statusline', '/theme', '/pets', '/mcp', '/plugins',
  '/logout', '/exit', '/feedback', '/ps', '/stop', '/clear', '/personality',
  '/subagents'
];

const EXPECTED_KINDS = {
  '/model': 'picker',
  '/fast': 'immediate',
  '/ide': 'immediate',
  '/permissions': 'picker',
  '/keymap': 'picker',
  '/vim': 'immediate',
  '/experimental': 'picker',
  '/approve': 'conflict',
  '/memories': 'picker',
  '/skills': 'picker',
  '/import': 'picker',
  '/hooks': 'picker',
  '/review': 'picker_task',
  '/rename': 'input',
  '/new': 'session',
  '/archive': 'destructive',
  '/delete': 'destructive',
  '/resume': 'picker',
  '/fork': 'session',
  '/init': 'rollout',
  '/compact': 'rollout',
  '/plan': 'mode',
  '/goal': 'report',
  '/agent': 'picker',
  '/side': 'rollout',
  '/copy': 'immediate',
  '/raw': 'immediate',
  '/diff': 'viewer',
  '/mention': 'input',
  '/status': 'report',
  '/usage': 'picker',
  '/title': 'picker',
  '/statusline': 'picker',
  '/theme': 'picker',
  '/pets': 'picker',
  '/mcp': 'report',
  '/plugins': 'picker',
  '/logout': 'destructive',
  '/exit': 'destructive',
  '/feedback': 'picker',
  '/ps': 'report',
  '/stop': 'conflict',
  '/clear': 'session',
  '/personality': 'picker',
  '/subagents': 'picker'
};

const ACTIONS_BY_KIND = {
  picker: ['up', 'down', 'enter', 'escape'],
  picker_task: ['up', 'down', 'enter', 'escape'],
  input: ['escape'],
  viewer: ['up', 'down', 'page_up', 'page_down', 'viewer_exit']
};

function main() {
  const matrix = getNativeSlashCommandMatrix();
  const known = new Set(matrix.flatMap((entry) => [entry.command, ...entry.aliases]));
  for (const command of CODEX_0_146_COMMANDS) {
    assert.ok(known.has(command), `missing native command classification: ${command}`);
    const definition = getNativeSlashDefinition(command);
    const expectedKind = EXPECTED_KINDS[command];
    assert.equal(definition?.kind, expectedKind, `${command} kind`);
    assert.equal(
      shouldRouteAsNativePage(command, command),
      !['conflict', 'destructive', 'rollout'].includes(expectedKind),
      `${command} native-page routing`
    );
    assert.equal(
      shouldBindNextRollout(command),
      expectedKind === 'rollout',
      `${command} rollout binding`
    );
    assert.equal(
      isBlockedNativeSlashCommand(command),
      expectedKind === 'destructive',
      `${command} destructive guard`
    );
    assert.deepEqual(
      getNativeSlashActions(command),
      ACTIONS_BY_KIND[expectedKind] || [],
      `${command} control actions`
    );
  }

  for (const command of ['/archive', '/delete', '/logout', '/exit', '/quit']) {
    assert.equal(isBlockedNativeSlashCommand(command), true, command);
    assert.equal(shouldRouteAsNativePage(command), false, command);
  }

  for (const command of ['/init', '/compact', '/side']) {
    assert.equal(getNativeSlashDefinition(command).kind, 'rollout');
    assert.equal(shouldRouteAsNativePage(command), false, command);
  }

  for (const command of ['/model', '/skills', '/review', '/usage', '/plugins']) {
    assert.equal(shouldRouteAsNativePage(command), true, command);
    assert.deepEqual(getNativeSlashActions(command), ['up', 'down', 'enter', 'escape']);
  }

  assert.equal(shouldRouteAsNativePage('/plan', '/plan'), true);
  assert.equal(shouldRouteAsNativePage('/plan', '/plan inspect this change'), false);
  assert.equal(shouldBindNextRollout('/plan inspect this change'), true);
  assert.equal(shouldBindNextRollout('/plan'), false);
  assert.equal(shouldBindNextRollout('/compact'), true);
  assert.equal(shouldBindNextRollout('/init'), true);
  assert.equal(shouldBindNextRollout('/side inspect this risk'), true);
  assert.equal(shouldBindNextRollout('ordinary prompt'), false);
  assert.equal(shouldRouteAsNativePage('/approve'), false);
  assert.equal(shouldRouteAsNativePage('/codex-approve'), true);
  assert.equal(shouldRouteAsNativePage('/stop'), false);
  assert.equal(shouldRouteAsNativePage('/codex-stop'), true);
  assert.equal(shouldRouteAsNativePage('new', 'new task'), false);
  assert.equal(normalizeNativeSlashText('/codex-stop'), '/stop');
  assert.equal(normalizeNativeSlashCommand('/permission'), '/permissions');
  assert.equal(normalizeNativeSlashCommand('/subagents'), '/agent');

  assert.deepEqual(
    getNativeSlashActions('/diff'),
    ['up', 'down', 'page_up', 'page_down', 'viewer_exit']
  );
  assert.equal(buildControlInput('page_up'), '\x1b[5~');
  assert.equal(buildControlInput('page_down'), '\x1b[6~');
  assert.equal(buildControlInput('viewer_exit'), 'q');

  console.log(`Native slash command matrix passed (${CODEX_0_146_COMMANDS.length} Codex commands).`);
}

main();
