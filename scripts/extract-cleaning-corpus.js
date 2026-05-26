#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const defaultLog = path.join(os.homedir(), '.local', 'state', 'remote-codex', 'remote-codex.log');
const defaultOut = path.join(os.homedir(), '.local', 'state', 'remote-codex', 'cleaning-history-corpus.jsonl');
const logFile = process.argv[2] || defaultLog;
const outFile = process.argv[3] || defaultOut;

if (!fs.existsSync(logFile)) {
  console.error(`Log file not found: ${logFile}`);
  process.exit(1);
}

const lines = fs.readFileSync(logFile, 'utf8').split('\n');
const samples = [];
const pendingBySession = new Map();

for (const line of lines) {
  if (!line.trim()) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }

  if (entry.level !== 'event') continue;
  const meta = entry.meta || {};
  const sessionId = meta.sessionId || '';
  if (!sessionId) continue;

  if (entry.message === 'remote.reply.ignored') {
    const list = pendingBySession.get(sessionId) || [];
    list.push({
      at: entry.at,
      pluginId: meta.pluginId || '',
      conversationId: meta.conversationId || '',
      sessionId,
      raw: meta.raw || ''
    });
    pendingBySession.set(sessionId, list.slice(-12));
    continue;
  }

  if (entry.message === 'remote.reply.sent') {
    const pending = pendingBySession.get(sessionId) || [];
    samples.push({
      at: entry.at,
      source: 'remote-codex-log',
      pluginId: meta.pluginId || '',
      conversationId: meta.conversationId || '',
      sessionId,
      rawFragments: pending.map((item) => item.raw).filter(Boolean),
      formatted: meta.text || ''
    });
    pendingBySession.set(sessionId, []);
  }
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, samples.map((sample) => JSON.stringify(sample)).join('\n') + (samples.length ? '\n' : ''));

const withRaw = samples.filter((sample) => sample.rawFragments.length > 0).length;
console.log(
  JSON.stringify(
    {
      logFile,
      outFile,
      samples: samples.length,
      samplesWithRawFragments: withRaw
    },
    null,
    2
  )
);
