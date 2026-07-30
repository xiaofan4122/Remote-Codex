const assert = require('node:assert/strict');
const {
  buildControlInput,
  buildSubmitInput,
  formatPermissionModeResultHint,
  isPassthroughSlashCommand,
  isPermissionModeControlAction,
  permissionModeActionIndex,
  permissionModeActionLabel
} = require('../src/remoteControlInput');

assert.equal(buildSubmitInput('/status'), '/status\r');
assert.equal(buildSubmitInput('hello'), '\x1b[200~hello\x1b[201~\r');
assert.equal(buildSubmitInput('a\r\nb'), '\x1b[200~a\nb\x1b[201~\r');
assert.equal(isPassthroughSlashCommand('/status extra'), true);
assert.equal(isPassthroughSlashCommand('/status\nextra'), false);

assert.equal(buildControlInput('approve'), 'y');
assert.equal(buildControlInput('approve_persistent'), 'p');
assert.equal(buildControlInput('deny'), '\x1b');
assert.equal(buildControlInput('enter'), '\r');
assert.equal(buildControlInput('up'), '\x1b[A');
assert.equal(buildControlInput('down'), '\x1b[B');
assert.equal(buildControlInput('tab'), '\t');
assert.equal(buildControlInput('unknown'), '');

assert.equal(isPermissionModeControlAction('permission_auto_review'), true);
assert.equal(isPermissionModeControlAction('permission_custom'), false);
assert.equal(permissionModeActionIndex('permission_full_access'), 3);
assert.equal(permissionModeActionLabel('permission_default'), 'Ask for approval');
assert.match(formatPermissionModeResultHint('Full Access'), /审批限制/);

console.log('Remote control input tests passed.');
