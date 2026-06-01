#!/usr/bin/env node

const os = require('node:os');
const path = require('node:path');
const {
  loadCaptureEvents,
  replayCaptureEvents
} = require('../src/terminalCaptureReplay');

const inputPath =
  process.argv[2] ||
  path.join(os.homedir(), '.local', 'state', 'remote-codex', 'raw-output.jsonl');

async function main() {
  const loaded = loadCaptureEvents(inputPath);
  const replay = await replayCaptureEvents(loaded.events);
  console.log(JSON.stringify({
    inputPath,
    events: loaded.events.length,
    readErrors: loaded.errors,
    ...replay
  }, null, 2));
  if (loaded.errors.length || replay.errors.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
