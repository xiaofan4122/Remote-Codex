#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const packageJson = require('../package.json');

const tag = String(process.argv[2] || '').trim();
const outputDirectory = path.resolve(process.argv[3] || 'dist');
const version = tag.replace(/^v/, '');

if (!/^v[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`Release tag must look like v1.2.3: ${tag}`);
}
if (version !== packageJson.version) {
  throw new Error(`Release tag ${tag} does not match package version ${packageJson.version}`);
}

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, 'remote-codex-version.txt'), `${version}\n`);
console.log(version);
