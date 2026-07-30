#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeConfig } = require('../src/config');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

for (const id of ['feishuLatexRenderingEnabled', 'feishuLatexMaxFormulas']) {
  assert.equal(count(html, `id="${id}"`), 1, `${id} must appear once in settings HTML`);
  assert.match(renderer, new RegExp(id), `${id} must be wired in renderer.js`);
}

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
assert.equal('rawOutputLogEnabled' in config.remoteControl, false);
assert.equal('rawOutputLogPath' in config.remoteControl, false);
assert.equal(normalizeConfig({
  plugins: { feishu: { latexMaxFormulas: 999 } }
}, '/tmp/remote-codex-settings-test.json').plugins.feishu.latexMaxFormulas, 64);

console.log('Settings UI tests passed.');

function count(text, pattern) {
  return text.split(pattern).length - 1;
}
