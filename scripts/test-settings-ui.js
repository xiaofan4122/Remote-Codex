#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadConfig,
  normalizeConfig,
  saveConfigPatch
} = require('../src/config');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');

for (const id of ['feishuLatexRenderingEnabled', 'feishuLatexMaxFormulas']) {
  assert.equal(count(html, `id="${id}"`), 1, `${id} must appear once in settings HTML`);
  assert.match(renderer, new RegExp(id), `${id} must be wired in renderer.js`);
}

for (const id of ['automaticUpdatesEnabled', 'updateStatus', 'updateAction']) {
  assert.equal(count(html, `id="${id}"`), 1, `${id} must appear once in settings HTML`);
  assert.match(renderer, new RegExp(id), `${id} must be wired in renderer.js`);
}
assert.match(preload, /checkForUpdates:.*updates:check/);
assert.match(preload, /downloadUpdate:.*updates:download/);
assert.match(preload, /installUpdate:.*updates:install/);
assert.match(main, /ipcMain\.handle\('updates:check'/);
assert.match(main, /ipcMain\.handle\('updates:download'/);
assert.match(main, /ipcMain\.handle\('updates:install'/);

for (const id of [
  'onboardingWelcome',
  'openSettingsFromOnboarding',
  'dismissOnboardingWelcome',
  'feishuOnboardingGuide',
  'tryFeishuFromOnboarding',
  'dismissOnboardingConnect',
  'feishuConnectBox'
]) {
  assert.equal(count(html, `id="${id}"`), 1, `${id} must appear once in settings HTML`);
  assert.match(renderer, new RegExp(id), `${id} must be wired in renderer.js`);
}

assert.ok(
  html.indexOf('id="feishuLatexMaxFormulas"') < html.indexOf('id="feishuConnectBox"'),
  'the Feishu connection box must appear below the formula rendering controls'
);
assert.match(styles, /\.onboarding-welcome/);
assert.match(styles, /\.onboarding-inline\[hidden\]/);
assert.match(renderer, /config\?\.ui\?\.firstRun === true/);
assert.match(preload, /completeOnboarding:.*ui:onboarding-complete/);
assert.match(main, /ipcMain\.handle\('ui:onboarding-complete'/);
assert.doesNotMatch(html, /feishuBotMenuHint|机器人菜单/);
assert.doesNotMatch(renderer, /feishuBotMenuHint|悬浮菜单|floating bot menu/);
const onboardingHandler = main.slice(
  main.indexOf("ipcMain.handle('ui:onboarding-complete'"),
  main.indexOf("ipcMain.handle('feishu:connect-start'")
);
assert.doesNotMatch(
  onboardingHandler,
  /restartPlugins/,
  'completing the UI guide must not restart Codex plugins'
);

for (const removed of [
  'rawOutputLogEnabled',
  'openCaptureLogs',
  'captureLogPanel'
]) {
  assert.doesNotMatch(html, new RegExp(removed));
  assert.doesNotMatch(renderer, new RegExp(removed));
}
assert.doesNotMatch(preload, /logs:open-raw-output|logs:capture-view/);
assert.doesNotMatch(main, /logs:open-raw-output|logs:capture-view/);

const config = normalizeConfig({
  remoteControl: {
    rawOutputLogEnabled: true,
    rawOutputLogPath: '/tmp/legacy-capture.jsonl'
  },
  plugins: {
    feishu: {
      latexRenderingEnabled: false,
      latexMaxFormulas: 55
    }
  }
}, '/tmp/remote-codex-settings-test.json');

assert.equal(config.plugins.feishu.latexRenderingEnabled, false);
assert.equal(config.plugins.feishu.latexMaxFormulas, 55);
assert.equal(config.ui.onboardingCompleted, false);
assert.equal(config.updates.automaticEnabled, true);
assert.equal('rawOutputLogEnabled' in config.remoteControl, false);
assert.equal('rawOutputLogPath' in config.remoteControl, false);
assert.equal(normalizeConfig({
  plugins: { feishu: { latexMaxFormulas: 999 } }
}, '/tmp/remote-codex-settings-test.json').plugins.feishu.latexMaxFormulas, 64);
assert.equal(normalizeConfig({
  updates: { automaticEnabled: false }
}, '/tmp/remote-codex-settings-test.json').updates.automaticEnabled, false);

testFirstRunOnboardingPersistence();

console.log('Settings UI tests passed.');

function count(text, pattern) {
  return text.split(pattern).length - 1;
}

function testFirstRunOnboardingPersistence() {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'remote-codex-settings-onboarding-')
  );
  const configPath = path.join(fixtureRoot, 'config.json');
  try {
    const firstRun = loadConfig({ configPath });
    assert.equal(firstRun.ui.firstRun, true);
    assert.equal(firstRun.ui.onboardingCompleted, false);

    const saved = saveConfigPatch({
      ui: { onboardingCompleted: true }
    }, { configPath });
    assert.equal(saved.ui.firstRun, false);
    assert.equal(saved.ui.onboardingCompleted, true);

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(persisted.ui.onboardingCompleted, true);
    assert.equal('firstRun' in persisted.ui, false);

    fs.writeFileSync(configPath, JSON.stringify({ ui: { language: 'zh-CN' } }));
    const existingUser = loadConfig({ configPath });
    assert.equal(existingUser.ui.firstRun, false);
    assert.equal(existingUser.ui.onboardingCompleted, false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
