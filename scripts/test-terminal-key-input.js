#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isImeCompositionKeyEvent,
  isImeSwitchKeyEvent,
  shouldBypassTerminalKeyEvent
} = require('../src/terminalKeyInput');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');

assert.ok(
  html.indexOf('src="./terminalKeyInput.js"') < html.indexOf('src="./renderer.js"'),
  'the IME key guard must load before the renderer'
);
assert.match(renderer, /addEventListener\('compositionstart'/);
assert.match(renderer, /addEventListener\('compositionend'/);
assert.match(
  renderer,
  /shouldBypassTerminalKeyEvent\(event, terminalCompositionActive\)/,
  'xterm must consult both KeyboardEvent metadata and tracked composition state'
);

assert.equal(
  shouldBypassTerminalKeyEvent({ type: 'keydown', key: '1', code: 'Digit1', keyCode: 49 }),
  false,
  'ordinary digits must still reach xterm'
);
assert.equal(
  shouldBypassTerminalKeyEvent({
    type: 'keydown',
    key: '1',
    code: 'Digit1',
    keyCode: 49,
    isComposing: true
  }),
  true,
  'Sogou candidate digits marked as composing must stay with the IME'
);
assert.equal(
  shouldBypassTerminalKeyEvent(
    { type: 'keydown', key: '2', code: 'Digit2', keyCode: 50 },
    true
  ),
  true,
  'compositionstart state must protect candidate digits when Chromium omits isComposing'
);
assert.equal(
  isImeCompositionKeyEvent({ type: 'keydown', key: 'Process', keyCode: 0 }),
  true
);
assert.equal(
  isImeCompositionKeyEvent({ type: 'keydown', key: 'Unidentified', keyCode: 229 }),
  true
);
assert.equal(
  shouldBypassTerminalKeyEvent({
    type: 'keydown',
    key: 'Unidentified',
    keyCode: 229,
    isComposing: false
  }),
  false,
  'bare keyCode 229 must stay on xterm CompositionHelper fallback path'
);
assert.equal(
  isImeSwitchKeyEvent({ type: 'keydown', key: ' ', code: 'Space', ctrlKey: true }),
  true
);
assert.equal(
  isImeSwitchKeyEvent({ type: 'keydown', key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true }),
  true
);
assert.equal(
  shouldBypassTerminalKeyEvent(
    { type: 'keydown', key: '3', code: 'Digit3', keyCode: 51 },
    false
  ),
  false,
  'digits must return to normal terminal input after compositionend'
);

console.log('Terminal IME key input tests passed.');
