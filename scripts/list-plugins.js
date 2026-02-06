#!/usr/bin/env node
/**
 * List All Plugins
 * 
 * Lists all plugins in the marketplace with their metadata
 */

const fs = require('fs');
const path = require('path');

/**
 * Recursively find all plugin.json files
 * @param {string} dir - Directory to search
 * @returns {Array<string>} Array of plugin.json paths
 */
function findPlugins(dir) {
  const plugins = [];
  const categories = ['web-tools', 'development-tools', 'data-tools', 'utilities'];
  
  for (const category of categories) {
    const categoryPath = path.join(dir, 'plugins', category);
    if (!fs.existsSync(categoryPath)) continue;
    
    const items = fs.readdirSync(categoryPath);
    for (const item of items) {
      const itemPath = path.join(categoryPath, item);
      const stat = fs.statSync(itemPath);
      
      if (stat.isDirectory()) {
        const pluginJsonPath = path.join(itemPath, 'plugin.json');
        if (fs.existsSync(pluginJsonPath)) {
          plugins.push({
            path: itemPath,
            category: category,
            metadataPath: pluginJsonPath
          });
        }
      }
    }
  }
  
  return plugins;
}

/**
 * Load plugin metadata
 * @param {string} pluginJsonPath - Path to plugin.json
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
  
  return [
    `  ${metadata.name} (v${metadata.version})`,
    `    ${metadata.description}`,
    `    Category: ${metadata.category}`,
    `    Compatibility: ${metadata.compatibility?.join(', ') || 'Not specified'}`,
    `    Path: ${path.relative(process.cwd(), plugin.path)}`
  ].join('\n');
}

/**
 * Main function
 */
function main() {
  const rootDir = path.resolve(__dirname, '..');
  
  console.log('Plugin Marketplace - All Available Plugins\n');
  console.log('='.repeat(60));
  console.log('');
  
  const plugins = findPlugins(rootDir);
  
  if (plugins.length === 0) {
    console.log('No plugins found in the marketplace.\n');
    return;
  }
  
  // Group by category
  const byCategory = {};
  for (const plugin of plugins) {
    if (!byCategory[plugin.category]) {
      byCategory[plugin.category] = [];
    }
    byCategory[plugin.category].push(plugin);
  }
  
  // Display by category
  for (const [category, categoryPlugins] of Object.entries(byCategory)) {
    const categoryName = category.split('-').map(w => 
      w.charAt(0).toUpperCase() + w.slice(1)
    ).join(' ');
    
    console.log(`${categoryName} (${categoryPlugins.length}):`);
    console.log('-'.repeat(60));
    
    for (const plugin of categoryPlugins) {
      console.log(formatPlugin(plugin));
      console.log('');
    }
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
