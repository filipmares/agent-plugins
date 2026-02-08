#!/usr/bin/env bun
/**
 * List All Plugins
 *
 * Lists all plugins in the Claude Code marketplace with their metadata
 */

import { existsSync, readFileSync } from 'fs';
import { basename, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MarketplaceEntry {
  name: string;
  source: string;
  description?: string;
  category?: string;
  author?: string | { name: string };
}

interface Marketplace {
  name: string;
  owner?: {
    name: string;
    url?: string;
  };
  description?: string;
  homepage?: string;
  plugins: MarketplaceEntry[];
}

interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

interface PluginMetadata {
  name?: string;
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  skills?: string;
  commands?: string;
  agents?: string;
  hooks?: string;
  mcpServers?: string;
  error?: string;
}

interface PluginInfo {
  path: string;
  metadataPath: string;
  marketplaceEntry: MarketplaceEntry;
}

/**
 * Read marketplace.json to get plugin list
 */
function findPlugins(dir: string): PluginInfo[] {
  const plugins: PluginInfo[] = [];
  const marketplacePath = join(dir, '.claude-plugin/marketplace.json');

  if (!existsSync(marketplacePath)) {
    return plugins;
  }

  try {
    const marketplace: Marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));

    if (marketplace.plugins && Array.isArray(marketplace.plugins)) {
      for (const plugin of marketplace.plugins) {
        const pluginPath = join(dir, plugin.source);
        const pluginJsonPath = join(pluginPath, '.claude-plugin/plugin.json');

        if (existsSync(pluginJsonPath)) {
          plugins.push({
            path: pluginPath,
            metadataPath: pluginJsonPath,
            marketplaceEntry: plugin
          });
        }
      }
    }
  } catch (error) {
    console.error('Error reading marketplace.json:', error instanceof Error ? error.message : String(error));
  }

  return plugins;
}

/**
 * Load plugin metadata
 */
function loadMetadata(pluginJsonPath: string): PluginMetadata {
  try {
    return JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Get component paths from metadata
 */
function getComponents(metadata: PluginMetadata): string[] {
  const components: string[] = [];
  if (metadata.skills) components.push('skills');
  if (metadata.commands) components.push('commands');
  if (metadata.agents) components.push('agents');
  if (metadata.hooks) components.push('hooks');
  if (metadata.mcpServers) components.push('mcpServers');
  return components;
}

/**
 * Format plugin info for display
 */
function formatPlugin(plugin: PluginInfo): string {
  const metadata = loadMetadata(plugin.metadataPath);

  if (metadata.error) {
    return `  ✗ ${basename(plugin.path)} - Error loading metadata`;
  }

  const authorName = metadata.author?.name ?? 'Unknown';
  const components = getComponents(metadata);
  const componentsStr = components.length > 0 ? components.join(', ') : 'None';

  return [
    `  ${metadata.name} (v${metadata.version})`,
    `    ${metadata.description}`,
    `    Components: ${componentsStr}`,
    `    Author: ${authorName}`,
    `    Path: ${relative(process.cwd(), plugin.path)}`
  ].join('\n');
}

/**
 * Main function
 */
function main(): void {
  const rootDir = resolve(__dirname, '..');

  console.log('Claude Code Plugin Marketplace - Available Plugins\n');
  console.log('='.repeat(60));
  console.log('');

  const plugins = findPlugins(rootDir);

  if (plugins.length === 0) {
    console.log('No plugins found in the marketplace.\n');
    console.log('Add plugins by following the guidelines in CONTRIBUTING.md\n');
    return;
  }

  // Display all plugins
  for (const plugin of plugins) {
    console.log(formatPlugin(plugin));
    console.log('');
  }

  console.log('='.repeat(60));
  console.log(`Total: ${plugins.length} plugin(s)\n`);
}

// Export for testing
export { findPlugins, loadMetadata };

// Run if executed directly
if (import.meta.main) {
  main();
}
