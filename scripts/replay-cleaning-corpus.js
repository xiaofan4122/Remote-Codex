#!/usr/bin/env node

const fs = require('node:fs');
const {
  formatVisualSnapshot,
  formatTerminalFinalAnswer
} = require('../src/remoteSessionController');

const corpusPath = process.argv[2] || '/tmp/remote-codex-cleaning-corpus.jsonl';

if (!fs.existsSync(corpusPath)) {
  console.error(`Corpus file not found: ${corpusPath}`);
  process.exit(1);
}

const samples = fs
  .readFileSync(corpusPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

for (const [index, sample] of samples.entries()) {
  const visual = formatVisualSnapshot(sample.visualSnapshot || '', sample.input || '');
  const raw = formatTerminalFinalAnswer(sample.raw || '');
  const next = visual || raw;
  console.log(
    JSON.stringify({
      index,
      input: String(sample.input || '').slice(0, 80),
      previousLength: String(sample.formatted || '').length,
      replayLength: next.length,
      replayPreview: next.slice(0, 500)
    })
  );
}
