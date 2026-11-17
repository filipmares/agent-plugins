#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const MARKETPLACE_MANIFEST = '.github/plugin/marketplace.json';
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

interface MarketplacePlugin {
  name: string;
  source: string;
  version: string;
}

export function hasShippedPluginChanges(paths: string[], source = '.'): boolean {
  const directory = relative('.', source).split(sep).join('/');
  const prefix = directory ? `${directory}/` : '';
  return paths.some(repoPath => {
    if (!repoPath.startsWith(prefix)) return false;
    const path = repoPath.slice(prefix.length);
    if (path === MARKETPLACE_MANIFEST) return false;
    if (path === 'plugin.json') return true;
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
    const match = STABLE_SEMVER.exec(version);
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
  if (typeof manifest.version !== 'string' || !STABLE_SEMVER.test(manifest.version)) {
    throw new Error(`${source} does not declare a stable SemVer version`);
  }
  return manifest.version;
}

function readMarketplace(json: string, source: string): { metadataVersion: string; plugins: MarketplacePlugin[] } {
  const marketplace: {
    metadata?: { version?: unknown };
    plugins?: { name?: unknown; source?: unknown; version?: unknown }[];
  } = JSON.parse(json);
  if (typeof marketplace.metadata?.version !== 'string') {
    throw new Error(`${source} does not declare a metadata version`);
  }
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error(`${source} does not declare a plugin list`);
  }
  return {
    metadataVersion: marketplace.metadata.version,
    plugins: marketplace.plugins.map(entry => {
      if (typeof entry?.name !== 'string' || typeof entry.source !== 'string' || typeof entry.version !== 'string') {
        throw new Error(`${source} has a plugin without a name, source, or version`);
      }
      return { name: entry.name, source: entry.source, version: entry.version };
    }),
  };
}

function main(): void {
  const baseRef = process.argv[2];
  if (!baseRef) throw new Error('Usage: bun run scripts/check-plugin-version-bump.ts <base-ref>');

  const changedPaths = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', `${baseRef}...HEAD`],
    { encoding: 'utf8' },
  ).split(/\r?\n/).filter(Boolean);

  const previousJson = execFileSync('git', ['show', `${baseRef}:${MARKETPLACE_MANIFEST}`], { encoding: 'utf8' });
  const previous = readMarketplace(previousJson, `${baseRef}:${MARKETPLACE_MANIFEST}`);
  const current = readMarketplace(readFileSync(MARKETPLACE_MANIFEST, 'utf8'), MARKETPLACE_MANIFEST);

  for (const plugin of current.plugins) {
    const pluginRoot = resolve(plugin.source);
    const rootManifest = join(pluginRoot, 'plugin.json');
    const manifestPath = existsSync(rootManifest) ? rootManifest : join(pluginRoot, '.github', 'plugin', 'plugin.json');
    const version = readPluginVersion(readFileSync(manifestPath, 'utf8'), manifestPath);
    if (!versionsMatch(version, plugin.version)) {
      throw new Error(`Plugin "${plugin.name}" manifest and marketplace versions differ (${version} vs ${plugin.version}).`);
    }
    if (pluginRoot === process.cwd() && !versionsMatch(version, current.metadataVersion)) {
      throw new Error(`Plugin and marketplace metadata versions differ (${version} vs ${current.metadataVersion}).`);
    }

    const before = previous.plugins.find(entry => entry.name === plugin.name);
    if (!before) {
      console.log(`New plugin "${plugin.name}": ${version}.`);
    } else if (hasShippedPluginChanges(changedPaths, plugin.source)
      || before.source !== plugin.source || before.version !== version) {
      if (!isVersionIncrease(before.version, version)) {
        throw new Error(`Plugin "${plugin.name}" content changed, but version did not increase (${before.version} -> ${version}).`);
      }
      console.log(`Plugin "${plugin.name}" version increased: ${before.version} -> ${version}.`);
    } else {
      console.log(`No shipped content changed for "${plugin.name}"; no version bump required.`);
    }
  }

  const removed = previous.plugins.filter(before => !current.plugins.some(plugin => plugin.name === before.name));
  if (removed.length && !isVersionIncrease(previous.metadataVersion, current.metadataVersion)) {
    const names = removed.map(plugin => `"${plugin.name}"`).join(', ');
    throw new Error(`Removed plugin ${names}, but marketplace version did not increase (${previous.metadataVersion} -> ${current.metadataVersion}).`);
  }
}

if (import.meta.main) main();
