#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PLUGIN_MANIFEST = '.github/plugin/plugin.json';
const MARKETPLACE_MANIFEST = '.github/plugin/marketplace.json';

export function hasShippedPluginChanges(paths: string[]): boolean {
  return paths.some(path => {
    if (path === '.github/plugin' || path.startsWith('.github/plugin/')
      || path.startsWith('.github/agents/') || path.startsWith('skills/')) {
      return true;
    }

    if (!path.startsWith('extensions/')) return false;
    const relativePath = path.slice('extensions/'.length);
    return !relativePath.includes('/docs/') && !relativePath.endsWith('/README.md');
  });
}

export function isVersionIncrease(previous: string, current: string): boolean {
  const parse = (version: string): number[] | null => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
    return match ? match.slice(1).map(Number) : null;
  };
  const before = parse(previous);
  const after = parse(current);
  if (!before || !after) return false;

  for (let index = 0; index < before.length; index += 1) {
    if (after[index] !== before[index]) return after[index] > before[index];
  }
  return false;
}

export function versionsMatch(pluginVersion: string, marketplaceVersion: string): boolean {
  return pluginVersion === marketplaceVersion;
}

function readPluginVersion(json: string, source: string): string {
  const manifest: { version?: unknown } = JSON.parse(json);
  if (typeof manifest.version !== 'string') {
    throw new Error(`${source} does not declare a string version`);
  }
  return manifest.version;
}

function readMarketplaceMetadataVersion(): string {
  const marketplace: { metadata?: { version?: unknown } } =
    JSON.parse(readFileSync(MARKETPLACE_MANIFEST, 'utf8'));
  if (typeof marketplace.metadata?.version !== 'string') {
    throw new Error(`${MARKETPLACE_MANIFEST} does not declare a metadata version`);
  }
  return marketplace.metadata.version;
}

function main(): void {
  const baseRef = process.argv[2];
  if (!baseRef) throw new Error('Usage: bun run scripts/check-plugin-version-bump.ts <base-ref>');

  const changedPaths = execFileSync(
    'git',
    ['diff', '--name-only', `${baseRef}...HEAD`, '--', '.github/plugin', '.github/agents', 'skills', 'extensions'],
    { encoding: 'utf8' },
  ).split(/\r?\n/).filter(Boolean);

  if (!hasShippedPluginChanges(changedPaths)) {
    console.log('No shipped plugin content changed; no version bump required.');
    return;
  }

  const previousJson = execFileSync('git', ['show', `${baseRef}:${PLUGIN_MANIFEST}`], { encoding: 'utf8' });
  const previousVersion = readPluginVersion(previousJson, `${baseRef}:${PLUGIN_MANIFEST}`);
  const currentVersion = readPluginVersion(readFileSync(PLUGIN_MANIFEST, 'utf8'), PLUGIN_MANIFEST);
  const marketplaceVersion = readMarketplaceMetadataVersion();
  if (!versionsMatch(currentVersion, marketplaceVersion)) {
    throw new Error(`Plugin and marketplace metadata versions differ (${currentVersion} vs ${marketplaceVersion}).`);
  }
  if (!isVersionIncrease(previousVersion, currentVersion)) {
    throw new Error(`Plugin content changed, but version did not increase (${previousVersion} -> ${currentVersion}).`);
  }

  console.log(`Plugin version increased: ${previousVersion} -> ${currentVersion}.`);
}

if (import.meta.main) main();
