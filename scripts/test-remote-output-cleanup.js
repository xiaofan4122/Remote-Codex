const assert = require('node:assert/strict');
const {
  isLikelyFileStatLine,
  isLikelyStandaloneFileLine,
  isWorkingRepaintGarbageLine,
  stripRemoteCodexColorMarkers,
  stripTerminalRepaintArtifacts
} = require('../src/remoteOutputCleanup');

const repaintSamples = [
  'rking•kinging•ngg1WWo•Wor•WorkWorki•Workin',
  'Working•Working•orking•rking•king•ingng7',
  'codex_r: codex_a•: codex_ap codex_appcodex_apps•odex_appsdex_appsex_appsx_apps_appsappsppspss2Wrk (2s)WWo•Wor',
  'Booting MC•ooting MCP',
  'ooting MCPoting MCP ting MCP s•ing MCP se',
  ': codex_ap codex_appcodex_apps',
  'odex_pps',
  'ingng'
];

for (const sample of repaintSamples) {
  assert.equal(isWorkingRepaintGarbageLine(sample), true, sample);
}

const narrative = '统计结果已经出来了；我再单独取一下文件总数，避免手工从列表里数错。';
assert.equal(
  stripTerminalRepaintArtifacts(`${narrative}Working•Working•orking•rking`),
  narrative
);
assert.equal(
  stripTerminalRepaintArtifacts(`${narrative}Workin`),
  narrative
);
assert.equal(
  stripTerminalRepaintArtifacts(`${narrative}10s • esc to interupt)WWo•Wor•WorkWorki•Workin•Working•Working1`),
  narrative
);
assert.equal(
  stripTerminalRepaintArtifacts(`${narrative}8`),
  narrative
);

assert.equal(isWorkingRepaintGarbageLine('按当前目录递归统计了 rg --files 能看到的文件。'), false);
assert.equal(isLikelyFileStatLine('26150 total'), false);
assert.equal(isLikelyFileStatLine('344 README.md'), true);
assert.equal(isLikelyStandaloneFileLine('src/plugins/feishu/index.js 1382'), true);
assert.equal(
  stripRemoteCodexColorMarkers('<!--remote-codex-color:rgba(247,201,72,1)-->- Working (6s)'),
  '- Working (6s)'
);

console.log('Remote output cleanup tests passed.');
