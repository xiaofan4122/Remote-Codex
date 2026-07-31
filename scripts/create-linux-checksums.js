#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const architecture = String(process.argv[2] || '').trim();
if (!['x64', 'arm64'].includes(architecture)) {
  console.error('Usage: node scripts/create-linux-checksums.js <x64|arm64> [dist-directory]');
  process.exit(1);
}

const directory = path.resolve(process.argv[3] || 'dist');
const debianArchitecture = architecture === 'x64' ? 'amd64' : 'arm64';
const assets = [
  `remote-codex-linux-${architecture}.tar.gz`,
  `remote-codex-linux-${debianArchitecture}.deb`
];

for (const asset of assets) {
  const assetPath = path.join(directory, asset);
  if (!fs.statSync(assetPath).isFile()) {
    throw new Error(`Release asset is not a regular file: ${assetPath}`);
  }
  const checksum = crypto
    .createHash('sha256')
    .update(fs.readFileSync(assetPath))
    .digest('hex');
  fs.writeFileSync(`${assetPath}.sha256`, `${checksum}  ${asset}\n`);
  console.log(`${asset}.sha256`);
}
