#!/usr/bin/env bun
/**
 * Plugin Validator
 * 
 * Validates that a plugin follows the Claude Code marketplace structure
 * Based on official Anthropic guidelines: https://code.claude.com/docs/en/plugin-marketplaces
 */

import { existsSync, readFileSync } from 'fs';
import { basename, join, resolve } from 'path';

interface ValidationResults {
  valid: boolean;
  errors: string[];
  warnings: string[];
  pluginName: string;
}

interface PluginManifest {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  categories?: string[];
  capabilities?: {
    skills?: string[];
    commands?: string[];
    agents?: string[];
    hooks?: string[];
    mcpServers?: string[];
  };
}

/**
 * Validate a plugin directory
 */
function validatePlugin(pluginPath: string): ValidationResults {
  const results: ValidationResults = {
    valid: true,
    errors: [],
    warnings: [],
    pluginName: basename(pluginPath)
  };

  // Check if directory exists
  if (!existsSync(pluginPath)) {
    results.valid = false;
    results.errors.push('Plugin directory does not exist');
    return results;
  }

  // Check required files
  const requiredFiles = ['README.md', '.claude-plugin/plugin.json'];
  for (const file of requiredFiles) {
    const filePath = join(pluginPath, file);
    if (!existsSync(filePath)) {
      results.valid = false;
      results.errors.push(`Missing required file: ${file}`);
    }
  }

  // Validate plugin.json
  const pluginJsonPath = join(pluginPath, '.claude-plugin/plugin.json');
  if (existsSync(pluginJsonPath)) {
    try {
      const pluginJson: PluginManifest = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
      
      // Check required fields
      const requiredFields: (keyof PluginManifest)[] = ['name', 'version', 'description', 'author', 'categories', 'capabilities'];
      for (const field of requiredFields) {
        if (!pluginJson[field]) {
          results.valid = false;
          results.errors.push(`Missing required field in plugin.json: ${field}`);
        }
      }

      // Check categories array
      const validCategories = ['development-tools', 'productivity', 'web-tools', 'data-tools', 'testing', 'security', 'documentation', 'deployment'];
      if (pluginJson.categories) {
        if (!Array.isArray(pluginJson.categories)) {
          results.errors.push('categories must be an array');
        } else {
          for (const cat of pluginJson.categories) {
            if (!validCategories.includes(cat)) {
              results.warnings.push(`Category "${cat}" is not a standard category`);
            }
          }
        }
      }

      // Check capabilities object
      if (pluginJson.capabilities && typeof pluginJson.capabilities === 'object') {
        const validCapabilities = ['skills', 'commands', 'agents', 'hooks', 'mcpServers'];
        for (const cap of Object.keys(pluginJson.capabilities)) {
          if (!validCapabilities.includes(cap)) {
            results.warnings.push(`Unknown capability type: ${cap}`);
          }
        }
      }

    } catch (error) {
      results.valid = false;
      results.errors.push(`Invalid plugin.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Validate README.md
  const readmePath = join(pluginPath, 'README.md');
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8');
    
    // Check for key sections
    const requiredSections = ['## Overview', '## Installation', '## Usage'];
    for (const section of requiredSections) {
      if (!readme.includes(section)) {
        results.warnings.push(`README.md should include "${section}" section`);
      }
    }
    
    // Check if README starts with a heading
    if (!readme.trim().startsWith('# ')) {
      results.warnings.push('README.md should start with a main heading (# Title)');
    }
  }

  // Check for capability implementations
  if (existsSync(pluginJsonPath)) {
    try {
      const pluginJson: PluginManifest = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
      
      if (pluginJson.capabilities) {
        // Check for skills
        if (pluginJson.capabilities.skills && pluginJson.capabilities.skills.length > 0) {
          for (const skill of pluginJson.capabilities.skills) {
            const skillPath = join(pluginPath, 'skills', skill, 'SKILL.md');
            if (!existsSync(skillPath)) {
              results.warnings.push(`Skill "${skill}" declared but SKILL.md not found at skills/${skill}/SKILL.md`);
            }
          }
        }
        
        // Check for commands
        if (pluginJson.capabilities.commands && pluginJson.capabilities.commands.length > 0) {
          for (const command of pluginJson.capabilities.commands) {
            const commandPath = join(pluginPath, 'commands', command, 'COMMAND.md');
            if (!existsSync(commandPath)) {
              results.warnings.push(`Command "${command}" declared but COMMAND.md not found at commands/${command}/COMMAND.md`);
            }
          }
        }
      }
    } catch (error) {
      // Already handled above
    }
  }

  return results;
}

/**
 * Main function
 */
function main(): void {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Plugin Validator');
    console.log('Usage: bun run scripts/validate-plugin.ts <plugin-path>');
    console.log('');
    console.log('Example:');
    console.log('  bun run scripts/validate-plugin.ts .templates/plugin-template');
    return;
  }

  const pluginPath = resolve(args[0]);
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
export { validatePlugin };

// Run if executed directly
if (import.meta.main) {
  main();
}
