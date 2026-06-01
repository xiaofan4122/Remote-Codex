#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadCaptureEvents,
  replayCaptureEvents
} = require('../src/terminalCaptureReplay');
const {
  classifyVisualTurnOutput,
  formatTerminalFinalAnswer,
  formatVisualProgressSnapshot,
  formatVisualSnapshot
} = require('../src/remoteSessionController');

const args = parseArgs(process.argv.slice(2));
const inputPath = args.inputPath ||
  path.join(os.homedir(), '.local', 'state', 'remote-codex', 'raw-output.jsonl');

async function main() {
  const loaded = loadCaptureEvents(inputPath);
  const replay = await replayCaptureEvents(loaded.events, {
    collectFrames: Boolean(args.framesPath || args.parserReportPath),
    frameMode: args.frameMode,
    verifySnapshots: !args.noVerify
  });
  if (args.framesPath) {
    writeJsonl(args.framesPath, replay.frames);
  }
  if (args.parserReportPath) {
    writeJson(args.parserReportPath, buildParserReport(replay.frames));
  }
  const { frames, ...summary } = replay;
  console.log(JSON.stringify({
    inputPath,
    events: loaded.events.length,
    readErrors: loaded.errors,
    framesPath: args.framesPath || '',
    parserReportPath: args.parserReportPath || '',
    frames: frames.length,
    ...summary
  }, null, 2));
  if (loaded.errors.length || replay.errors.length) process.exitCode = 2;
}

function parseArgs(argv) {
  const args = {
    inputPath: '',
    framesPath: '',
    parserReportPath: '',
    frameMode: 'snapshots',
    noVerify: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--frames') {
      args.framesPath = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--parser-report') {
      args.parserReportPath = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--frame-mode') {
      args.frameMode = argv[index + 1] === 'all' ? 'all' : 'snapshots';
      index += 1;
    } else if (arg === '--no-verify') {
      args.noVerify = true;
    } else if (!args.inputPath) {
      args.inputPath = arg;
    }
  }
  return args;
}

function buildParserReport(frames) {
  return {
    generatedAt: new Date().toISOString(),
    frames: frames.map((frame) => {
      const inputText = frame.lastInputText || '';
      const classified = classifyVisualTurnOutput(frame.viewport, inputText, {
        colorMarkers: true
      });
      return {
        sessionId: frame.sessionId,
        sequence: frame.sequence,
        at: frame.at,
        eventType: frame.eventType,
        terminal: frame.terminal,
        lastInputText: inputText,
        classified,
        visualProgress: formatVisualProgressSnapshot(frame.viewport, inputText, {
          colorMarkers: true
        }),
        visualFinal: formatVisualSnapshot(frame.viewport, inputText),
        terminalFinal: formatTerminalFinalAnswer(frame.scrollback)
      };
    })
  };
}

function writeJsonl(outputPath, records) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '')
  );
}

function writeJson(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
