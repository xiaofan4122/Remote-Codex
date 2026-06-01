#!/usr/bin/env node

const os = require('node:os');
const path = require('node:path');
const { exportCaptureFixture } = require('../src/terminalCaptureExport');

const inputPath =
  process.argv[2] ||
  path.join(os.homedir(), '.local', 'state', 'remote-codex', 'raw-output.jsonl');
const outputPath =
  process.argv[3] ||
  path.join(process.cwd(), 'tmp', 'terminal-capture.fixture.jsonl');

console.log(JSON.stringify(exportCaptureFixture(inputPath, outputPath), null, 2));
