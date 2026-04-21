#!/usr/bin/env bun
/**
 * Skill Validator
 *
 * Validates that a skill follows the skills.sh / Agent Skills format:
 * - A SKILL.md file at the skill root
 * - YAML frontmatter with required fields (name, description)
 * - Recommended metadata fields (license, metadata.author, metadata.version)
 *
 * See: https://skills.sh and https://github.com/vercel-labs/agent-skills
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';

interface ValidationResults {
  valid: boolean;
  errors: string[];
  warnings: string[];
  skillName: string;
}

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  license?: unknown;
  metadata?: {
    author?: unknown;
    version?: unknown;
  };
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Extract the YAML frontmatter block from a SKILL.md file.
 * Returns the raw YAML text (without the `---` fences) or null if missing.
 */
function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  return match ? match[1] : null;
}

/**
 * Minimal YAML parser sufficient for skill frontmatter.
 * Supports top-level scalars, single-line nested objects (one level deep),
 * and quoted/unquoted strings. Not a general YAML parser.
 */
function parseFrontmatter(yaml: string): SkillFrontmatter {
  const result: SkillFrontmatter = {};
  const lines = yaml.split(/\r?\n/);
  let currentNested: Record<string, unknown> | null = null;

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;

    // Nested key/value (indented two or more spaces)
    if (/^\s{2,}\S/.test(rawLine) && currentNested) {
      const m = rawLine.trim().match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (m) {
        currentNested[m[1]] = stripQuotes(m[2].trim());
      }
      continue;
    }

    // Top-level key
    const top = rawLine.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!top) continue;
    const key = top[1];
    const value = top[2].trim();

    if (value === '') {
      // Begin nested block (e.g. metadata:)
      const nested: Record<string, unknown> = {};
      (result as Record<string, unknown>)[key] = nested;
      currentNested = nested;
    } else {
      (result as Record<string, unknown>)[key] = stripQuotes(value);
      currentNested = null;
    }
  }

  return result;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function validateSkill(skillPath: string): ValidationResults {
  const results: ValidationResults = {
    valid: true,
    errors: [],
    warnings: [],
    skillName: basename(skillPath)
  };

  if (!existsSync(skillPath) || !statSync(skillPath).isDirectory()) {
    results.valid = false;
    results.errors.push('Skill directory does not exist');
    return results;
  }

  const skillMdPath = join(skillPath, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    results.valid = false;
    results.errors.push('Missing required file: SKILL.md');
    return results;
  }

  const content = readFileSync(skillMdPath, 'utf8');
  const yaml = extractFrontmatter(content);

  if (yaml === null) {
    results.valid = false;
    results.errors.push('SKILL.md is missing a YAML frontmatter block (---)');
    return results;
  }

  const fm = parseFrontmatter(yaml);

  if (typeof fm.name !== 'string' || fm.name.length === 0) {
    results.valid = false;
    results.errors.push('Frontmatter missing required field: name');
  } else if (!NAME_PATTERN.test(fm.name)) {
    results.valid = false;
    results.errors.push(
      `Frontmatter "name" must be lowercase letters, digits, and hyphens only (got: "${fm.name}")`
    );
  } else if (fm.name !== basename(skillPath)) {
    results.warnings.push(
      `Frontmatter "name" ("${fm.name}") does not match the skill directory name ("${basename(skillPath)}"); they should match so installs and listings stay consistent`
    );
  }

  if (typeof fm.description !== 'string' || fm.description.length === 0) {
    results.valid = false;
    results.errors.push('Frontmatter missing required field: description');
  }

  if (fm.license === undefined) {
    results.warnings.push('Frontmatter should include a license (e.g. license: MIT)');
  }

  if (!fm.metadata || typeof fm.metadata !== 'object') {
    results.warnings.push('Frontmatter should include a metadata block with author and version');
  } else {
    if (!fm.metadata.author) {
      results.warnings.push('Frontmatter metadata should include an author');
    }
    if (!fm.metadata.version) {
      results.warnings.push('Frontmatter metadata should include a version (semver)');
    }
  }

  // Body sanity check: at least one heading after the frontmatter
  const body = content.slice(content.indexOf('---', 3) + 3).trim();
  if (!/^#\s/m.test(body)) {
    results.warnings.push('SKILL.md body should include at least one Markdown heading');
  }

  return results;
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Skill Validator');
    console.log('Usage: bun run scripts/validate-skill.ts <skill-path>');
    console.log('');
    console.log('Example:');
    console.log('  bun run scripts/validate-skill.ts skills/cli-skill-generator');
    return;
  }

  const skillPath = resolve(args[0]);
  console.log(`Validating skill: ${skillPath}\n`);

  const results = validateSkill(skillPath);

  console.log(`Skill: ${results.skillName}`);
  console.log(`Status: ${results.valid ? '✓ VALID' : '✗ INVALID'}\n`);

  if (results.errors.length > 0) {
    console.log('Errors:');
    results.errors.forEach(e => console.log(`  ✗ ${e}`));
    console.log('');
  }

  if (results.warnings.length > 0) {
    console.log('Warnings:');
    results.warnings.forEach(w => console.log(`  ⚠ ${w}`));
    console.log('');
  }

  if (results.valid && results.errors.length === 0 && results.warnings.length === 0) {
    console.log('✓ Skill structure is valid and complete!\n');
  }

  process.exit(results.valid ? 0 : 1);
}

export { validateSkill };

if (import.meta.main) {
  main();
}
