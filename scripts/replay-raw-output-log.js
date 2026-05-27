#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  formatTerminalFinalAnswer,
  formatTerminalProgress
} = require('../src/remoteSessionController');

const inputPath =
  process.argv[2] ||
  path.join(os.homedir(), '.local', 'state', 'remote-codex', 'raw-output.jsonl');

if (!fs.existsSync(inputPath)) {
  console.error(`Raw output log not found: ${inputPath}`);
  process.exit(1);
}

const sessions = new Map();
const lines = fs.readFileSync(inputPath, 'utf8').split('\n').filter(Boolean);

for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }

  if (!event.sessionId) continue;
  const state =
    sessions.get(event.sessionId) ||
    {
      sessionId: event.sessionId,
      cwd: event.cwd || '',
      output: '',
      inputs: 0,
      outputs: 0,
      exits: 0
    };

  if (event.type === 'pty.output') {
    state.output += Buffer.from(event.dataBase64 || '', 'base64').toString('utf8');
    state.outputs += 1;
  } else if (event.type === 'pty.input') {
    state.inputs += 1;
  } else if (event.type === 'pty.exit') {
    state.exits += 1;
  }

  sessions.set(event.sessionId, state);
}

for (const state of sessions.values()) {
  const progress = formatTerminalProgress(state.output);
  const finalText = formatTerminalFinalAnswer(state.output);
  console.log(`## ${state.sessionId}`);
  console.log(`cwd: ${state.cwd || '(unknown)'}`);
  console.log(`events: outputs=${state.outputs}, inputs=${state.inputs}, exits=${state.exits}`);
  console.log('');
  console.log('### Progress');
  console.log(progress || '(empty)');
  console.log('');
  console.log('### Final');
  console.log(finalText || '(empty)');
  console.log('');
}
