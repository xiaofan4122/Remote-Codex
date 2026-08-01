#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildDroppedFilePaste,
  dataTransferHasFiles,
  isSafeDroppedPath,
  quoteDroppedPath
} = require('../src/terminalFileDrop');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer.html'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');

assert.equal(dataTransferHasFiles({ types: ['text/plain', 'Files'] }), true);
assert.equal(dataTransferHasFiles({ items: [{ kind: 'string' }, { kind: 'file' }] }), true);
assert.equal(dataTransferHasFiles({ types: ['text/plain'], items: [] }), false);
assert.equal(dataTransferHasFiles(null), false);

assert.equal(isSafeDroppedPath('/tmp/report.txt'), true);
assert.equal(isSafeDroppedPath('relative/report.txt'), false);
assert.equal(isSafeDroppedPath('/tmp/line\nbreak.txt'), false);
assert.equal(isSafeDroppedPath('/tmp/escape\x1b.txt'), false);

assert.equal(quoteDroppedPath('/tmp/report.txt'), '/tmp/report.txt');
assert.equal(quoteDroppedPath('/tmp/my report.txt'), "'/tmp/my report.txt'");
assert.equal(quoteDroppedPath("/tmp/O'Brien.txt"), "'/tmp/O'\\''Brien.txt'");
assert.equal(quoteDroppedPath('/tmp/报告.txt'), "'/tmp/报告.txt'");
assert.equal(quoteDroppedPath('relative.txt'), '');

assert.equal(
  buildDroppedFilePaste([
    '/tmp/report.txt',
    '/tmp/my report.txt',
    '/tmp/report.txt',
    '/tmp/line\nbreak.txt'
  ]),
  "/tmp/report.txt '/tmp/my report.txt' "
);
assert.equal(buildDroppedFilePaste([]), '');
assert.equal(buildDroppedFilePaste(null), '');

assert.ok(
  html.indexOf('src="./terminalFileDrop.js"') < html.indexOf('src="./renderer.js"'),
  'the file-drop helper must load before the renderer'
);
assert.equal((html.match(/id="terminalDropOverlay"/g) || []).length, 1);
assert.match(preload, /webUtils\.getPathForFile\(file\)/);
assert.match(renderer, /addEventListener\('dragenter'/);
assert.match(renderer, /addEventListener\('dragover'/);
assert.match(renderer, /addEventListener\('drop'/);
assert.match(renderer, /term\.paste\(paste\)/);
assert.match(styles, /#terminalShell\.is-file-dragging \.terminal-drop-overlay/);

console.log('Terminal file drop tests passed.');
