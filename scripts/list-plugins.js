#!/usr/bin/env node
/**
 * List All Plugins
 * 
 * Lists all plugins in the Claude Code marketplace with their metadata
 */

const fs = require('fs');
const path = require('path');

/**
 * Read marketplace.json to get plugin list
 * @param {string} dir - Directory to search
 * @returns {Array<object>} Array of plugin metadata
 */
function findPlugins(dir) {
  const plugins = [];
  const marketplacePath = path.join(dir, '.claude-plugin/marketplace.json');
  
  if (!fs.existsSync(marketplacePath)) {
    return plugins;
  }
  
  try {
    const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
    
    if (marketplace.plugins && Array.isArray(marketplace.plugins)) {
      for (const plugin of marketplace.plugins) {
        const pluginPath = path.join(dir, plugin.source);
        const pluginJsonPath = path.join(pluginPath, '.claude-plugin/plugin.json');
        
        if (fs.existsSync(pluginJsonPath)) {
          plugins.push({
            path: pluginPath,
            metadataPath: pluginJsonPath,
            marketplaceEntry: plugin
          });
        }
      }
    }
  } catch (error) {
    console.error('Error reading marketplace.json:', error.message);
  }
  
  return plugins;
}

/**
 * Load plugin metadata
 * @param {string} pluginJsonPath - Path to .claude-plugin/plugin.json
 * @returns {object} Plugin metadata
 */
function loadMetadata(pluginJsonPath) {
  try {
    return JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Format plugin info for display
 * @param {object} plugin - Plugin object
 * @returns {string} Formatted string
 */
function formatPlugin(plugin) {
  const metadata = loadMetadata(plugin.metadataPath);
  
  if (metadata.error) {
    return `  ✗ ${path.basename(plugin.path)} - Error loading metadata`;
  }
  
  const categories = Array.isArray(metadata.categories) ? metadata.categories.join(', ') : metadata.categories;
  const capabilities = metadata.capabilities ? Object.keys(metadata.capabilities).join(', ') : 'None';
  
  return [
    `  ${metadata.name} (v${metadata.version})`,
    `    ${metadata.description}`,
    `    Categories: ${categories}`,
    `    Capabilities: ${capabilities}`,
    `    Author: ${metadata.author}`,
    `    Path: ${path.relative(process.cwd(), plugin.path)}`
  ].join('\n');
}

/**
 * Main function
 */
function main() {
  const rootDir = path.resolve(__dirname, '..');
  
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

// Run if executed directly
if (require.main === module) {
  main();
}

// Export for testing
module.exports = { findPlugins, loadMetadata };
