#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  extractRemoteFileDirectives,
  validateRemoteFile
} = require('../src/remoteFileDelivery');

function main() {
  testDirectiveExtractionPreservesAnswerFormatting();
  testWorkspaceFileValidation();
  console.log('Remote file delivery tests passed.');
}

function testDirectiveExtractionPreservesAnswerFormatting() {
  const first = path.resolve('output/report.pdf');
  const second = path.resolve('output/result data.csv');
  const parsed = extractRemoteFileDirectives([
    '文件已经生成：',
    '',
    `[[remote-codex-file:${first}]]`,
    `[[remote-codex-file:${second}]]`,
    `[[remote-codex-file:${first}]]`
  ].join('\n'));

  assert.equal(parsed.text, '文件已经生成：');
  assert.deepEqual(parsed.files, [first, second]);
  assert.doesNotMatch(parsed.text, /remote-codex-file/);
}

function testWorkspaceFileValidation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-files-'));
  const output = path.join(root, 'report.txt');
  const empty = path.join(root, 'empty.txt');
  const outside = path.join(os.tmpdir(), `remote-codex-outside-${process.pid}.txt`);
  const symlink = path.join(root, 'outside-link.txt');

  try {
    fs.writeFileSync(output, 'result\n');
    fs.writeFileSync(empty, '');
    fs.writeFileSync(outside, 'secret\n');
    fs.symlinkSync(outside, symlink);

    const valid = validateRemoteFile(output, { cwd: root });
    assert.equal(valid.path, fs.realpathSync(output));
    assert.equal(valid.name, 'report.txt');
    assert.equal(valid.size, 7);

    assert.throws(
      () => validateRemoteFile('report.txt', { cwd: root }),
      (error) => error.code === 'path_not_absolute'
    );
    assert.throws(
      () => validateRemoteFile(empty, { cwd: root }),
      (error) => error.code === 'empty_file'
    );
    assert.throws(
      () => validateRemoteFile(outside, { cwd: root }),
      (error) => error.code === 'outside_workspace'
    );
    assert.throws(
      () => validateRemoteFile(symlink, { cwd: root }),
      (error) => error.code === 'outside_workspace'
    );
    assert.throws(
      () => validateRemoteFile(output, { cwd: root, maxBytes: 3 }),
      (error) => error.code === 'file_too_large'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
}

main();
