#!/usr/bin/env node
// Single source of truth for bumping every embedded version in this package.
//
//   npm run bump <version>      e.g. npm run bump 1.2.3
//
// Updates, in lock-step, every place this package hard-codes its own version:
//   - package.json + package-lock.json   (via `npm version`)
//   - src/core/version.ts ADAPTER_VERSION (the one version literal we ship)
//
// GUARD_UA, PLUGIN_VERSION and the generated gemini-extension.json manifest
// used to be separate targets here. They are now derived from ADAPTER_VERSION,
// so this script has one place left to touch and
// `tests/adapter-version.test.ts` fails the build if a release bypasses it --
// which is how two sibling adaptors shipped reporting the previous version.
//
// Fails loudly if the target is missing so a drifting file can't slip a release.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`usage: npm run bump <version>   (got: ${version ?? '<none>'})`);
  process.exit(1);
}

// package.json + package-lock.json — let npm keep the two in sync.
execSync(`npm version ${version} --no-git-tag-version --allow-same-version`, { stdio: 'inherit' });

const targets = [
  // export const ADAPTER_VERSION = "<version>"
  { file: 'src/core/version.ts', re: /(export const ADAPTER_VERSION = ")[^"]+(")/, to: `$1${version}$2` },
];

for (const { file, re, to } of targets) {
  const src = readFileSync(file, 'utf8');
  if (!re.test(src)) {
    console.error(`bump: no version match in ${file} (pattern ${re}) — aborting before a partial bump`);
    process.exit(1);
  }
  writeFileSync(file, src.replace(re, to));
  console.log(`  bumped ${file}`);
}

console.log(`\nAll version locations set to ${version}.`);
