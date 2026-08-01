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

for (const id of [
  'feishuSyncLocalTurns',
  'feishuLatexRenderingEnabled',
  'feishuLatexMaxFormulas'
]) {
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
assert.match(preload, /setUiLanguage:.*ui:set-language/);
assert.match(preload, /resetFeishuConnection:.*feishu:connection-reset/);
assert.match(main, /ipcMain\.handle\('updates:check'/);
assert.match(main, /ipcMain\.handle\('updates:download'/);
assert.match(main, /ipcMain\.handle\('updates:install'/);
const languageHandler = main.slice(
  main.indexOf("ipcMain.handle('ui:set-language'"),
  main.indexOf("ipcMain.handle('ui:onboarding-complete'")
);
assert.match(languageHandler, /saveConfigPatch/);
assert.doesNotMatch(
  languageHandler,
  /restartPlugins/,
  'changing the UI language must not restart Codex plugins'
);
assert.match(renderer, /queueLanguageSave\(language\)/);
assert.match(renderer, /await waitForPendingLanguageSave\(\)/);
assert.match(renderer, /resetFeishu: '重置飞书链接'/);
assert.match(renderer, /hasConfiguredFeishuConnection\(currentConfig\)/);
assert.match(renderer, /window\.codexShell\.resetFeishuConnection\(\)/);
assert.match(styles, /button\.danger-text-button\s*\{[^}]*color:\s*#f87171;/s);

const feishuResetHandler = main.slice(
  main.indexOf("ipcMain.handle('feishu:connection-reset'"),
  main.indexOf("ipcMain.handle('feishu:connect-cancel'")
);
assert.match(feishuResetHandler, /dialog\.showMessageBox/);
assert.match(feishuResetHandler, /type:\s*'warning'/);
assert.match(feishuResetHandler, /resetFeishuConnection\(/);
assert.match(main, /是否删除原本链接并重新配置？/);
assert.match(main, /飞书应用需要在应用管理后台自行删除。/);

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
assert.doesNotMatch(html, /codexDefaultCwd|defaultWorkingDirectory|默认工作目录/);
assert.doesNotMatch(renderer, /codexDefaultCwd|defaultWorkingDirectory/);
assert.doesNotMatch(
  renderer,
  /next\.codex\.(?:defaultCwd|configuredDefaultCwd)\s*=/,
  'saving common settings must preserve the command-line working directory configuration'
);
assert.match(
  styles,
  /\.settings-dialog\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
  'the settings grid must constrain its scrollable middle row'
);
assert.match(
  styles,
  /\.settings-content\s*\{[^}]*overflow-y:\s*scroll;[^}]*scrollbar-gutter:\s*stable;/s,
  'the settings body must keep a visible vertical scrollbar gutter'
);
assert.match(styles, /\.settings-content::\-webkit-scrollbar-thumb/);
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
      latexMaxFormulas: 55,
      syncLocalTurns: true
    }
  }
}, '/tmp/remote-codex-settings-test.json');

assert.equal(config.plugins.feishu.latexRenderingEnabled, false);
assert.equal(config.plugins.feishu.latexMaxFormulas, 55);
assert.equal(config.plugins.feishu.syncLocalTurns, true);
assert.equal(normalizeConfig({}).plugins.feishu.syncLocalTurns, false);
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

testLanguagePersistence();

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

function testLanguagePersistence() {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'remote-codex-settings-language-')
  );
  const configPath = path.join(fixtureRoot, 'config.json');
  try {
    const saved = saveConfigPatch({
      ui: { language: 'en' }
    }, { configPath });
    assert.equal(saved.ui.language, 'en');
    assert.equal(loadConfig({ configPath }).ui.language, 'en');
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).ui.language, 'en');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
