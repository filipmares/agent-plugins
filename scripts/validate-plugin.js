#!/usr/bin/env node
/**
 * Plugin Validator
 * 
 * Validates that a plugin follows the marketplace structure and standards
 */

const fs = require('fs');
const path = require('path');

/**
 * Validate a plugin directory
 * @param {string} pluginPath - Path to the plugin directory
 * @returns {object} Validation results
 */
function validatePlugin(pluginPath) {
  const results = {
    valid: true,
    errors: [],
    warnings: [],
    pluginName: path.basename(pluginPath)
  };

  // Check if directory exists
  if (!fs.existsSync(pluginPath)) {
    results.valid = false;
    results.errors.push('Plugin directory does not exist');
    return results;
  }

  // Check required files
  const requiredFiles = ['README.md', 'plugin.json', 'src/index.js'];
  for (const file of requiredFiles) {
    const filePath = path.join(pluginPath, file);
    if (!fs.existsSync(filePath)) {
      results.valid = false;
      results.errors.push(`Missing required file: ${file}`);
    }
  }

  // Validate plugin.json
  const pluginJsonPath = path.join(pluginPath, 'plugin.json');
  if (fs.existsSync(pluginJsonPath)) {
    try {
      const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
      
      // Check required fields
      const requiredFields = ['name', 'version', 'description', 'author', 'license', 'category'];
      for (const field of requiredFields) {
        if (!pluginJson[field]) {
          results.valid = false;
          results.errors.push(`Missing required field in plugin.json: ${field}`);
        }
      }

      // Check category is valid
      const validCategories = ['web-tools', 'development-tools', 'data-tools', 'utilities'];
      if (pluginJson.category && !validCategories.includes(pluginJson.category)) {
        results.warnings.push(`Category "${pluginJson.category}" is not a standard category`);
      }

    } catch (error) {
      results.valid = false;
      results.errors.push(`Invalid plugin.json: ${error.message}`);
    }
  }

  // Validate README.md
  const readmePath = path.join(pluginPath, 'README.md');
  if (fs.existsSync(readmePath)) {
    const readme = fs.readFileSync(readmePath, 'utf8');
    
    // Check for key sections
    const requiredSections = ['#', 'Features', 'Installation', 'Usage'];
    for (const section of requiredSections) {
      if (!readme.includes(section)) {
        results.warnings.push(`README.md should include "${section}" section`);
      }
    }
  }

  // Check if index.js is valid JavaScript
  const indexPath = path.join(pluginPath, 'src/index.js');
  if (fs.existsSync(indexPath)) {
    try {
      const code = fs.readFileSync(indexPath, 'utf8');
      // Basic syntax check - try to load as module
      if (!code.includes('module.exports')) {
        results.warnings.push('src/index.js should export functions via module.exports');
      }
    } catch (error) {
      results.errors.push(`Error reading src/index.js: ${error.message}`);
    }
  }

  return results;
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Plugin Validator');
    console.log('Usage: node validate-plugin.js <plugin-path>');
    console.log('');
    console.log('Example:');
    console.log('  node scripts/validate-plugin.js plugins/web-tools/web-fetcher');
    return;
  }

  const pluginPath = path.resolve(args[0]);
  console.log(`Validating plugin: ${pluginPath}\n`);

  const results = validatePlugin(pluginPath);

  console.log(`Plugin: ${results.pluginName}`);
  console.log(`Status: ${results.valid ? '✓ VALID' : '✗ INVALID'}\n`);

  if (results.errors.length > 0) {
    console.log('Errors:');
    results.errors.forEach(error => console.log(`  ✗ ${error}`));
    console.log('');
  }

  if (results.warnings.length > 0) {
    console.log('Warnings:');
    results.warnings.forEach(warning => console.log(`  ⚠ ${warning}`));
    console.log('');
  }

  if (results.valid && results.errors.length === 0 && results.warnings.length === 0) {
    console.log('✓ Plugin structure is valid and complete!\n');
  }

  process.exit(results.valid ? 0 : 1);
}

// Export for testing
module.exports = { validatePlugin };

// Run if executed directly
if (require.main === module) {
  main();
}
