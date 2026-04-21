#!/usr/bin/env bun
/**
 * List All Skills
 *
 * Lists every skill under the top-level `skills/` directory.
 * Reads the YAML frontmatter from each SKILL.md to display name, description,
 * version, author, and license.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

import { validateSkill } from './validate-skill.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SkillSummary {
  path: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  license?: string;
  references: number;
  scripts: number;
  valid: boolean;
}

function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  return match ? match[1] : null;
}

function readField(yaml: string, key: string): string | undefined {
  // Match a top-level (un-indented) key
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm');
  const m = yaml.match(re);
  if (!m) return undefined;
  let value = m[1].trim();
  if (value.length >= 2) {
    const f = value[0];
    const l = value[value.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) {
      value = value.slice(1, -1);
    }
  }
  return value || undefined;
}

function readNestedField(yaml: string, parent: string, key: string): string | undefined {
  const lines = yaml.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      if (new RegExp(`^${parent}\\s*:\\s*$`).test(line)) inBlock = true;
      continue;
    }
    if (/^\S/.test(line)) break; // left the nested block
    const m = line.trim().match(new RegExp(`^${key}\\s*:\\s*(.*)$`));
    if (m) {
      let value = m[1].trim();
      if (value.length >= 2) {
        const f = value[0];
        const l = value[value.length - 1];
        if ((f === '"' && l === '"') || (f === "'" && l === "'")) {
          value = value.slice(1, -1);
        }
      }
      return value || undefined;
    }
  }
  return undefined;
}

function countDirEntries(dir: string): number {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return 0;
  return readdirSync(dir).length;
}

function loadSkill(skillDir: string): SkillSummary | null {
  const skillMd = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) return null;
  const content = readFileSync(skillMd, 'utf8');
  const yaml = extractFrontmatter(content) ?? '';

  const name = readField(yaml, 'name') ?? '(missing name)';
  const description = readField(yaml, 'description') ?? '(missing description)';
  const license = readField(yaml, 'license');
  const version = readNestedField(yaml, 'metadata', 'version');
  const author = readNestedField(yaml, 'metadata', 'author');

  const validation = validateSkill(skillDir);

  return {
    path: skillDir,
    name,
    description,
    version,
    author,
    license,
    references: countDirEntries(join(skillDir, 'references')),
    scripts: countDirEntries(join(skillDir, 'scripts')),
    valid: validation.valid
  };
}

function findSkills(rootDir: string): SkillSummary[] {
  const skillsDir = join(rootDir, 'skills');
  if (!existsSync(skillsDir)) return [];

  const entries = readdirSync(skillsDir).sort();
  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    const dir = join(skillsDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const skill = loadSkill(dir);
    if (skill) skills.push(skill);
  }
  return skills;
}

function format(skill: SkillSummary): string {
  const versionStr = skill.version ? `v${skill.version}` : '(no version)';
  const authorStr = skill.author ?? 'Unknown';
  const licenseStr = skill.license ?? 'unspecified';
  const supporting: string[] = [];
  if (skill.references > 0) supporting.push(`${skill.references} reference(s)`);
  if (skill.scripts > 0) supporting.push(`${skill.scripts} script(s)`);
  const supportingStr = supporting.length > 0 ? supporting.join(', ') : 'none';
  const status = skill.valid ? '✓' : '✗';

  return [
    `  ${status} ${skill.name} (${versionStr})`,
    `      ${skill.description}`,
    `      Author: ${authorStr}    License: ${licenseStr}`,
    `      Supporting files: ${supportingStr}`,
    `      Path: ${relative(process.cwd(), skill.path)}`
  ].join('\n');
}

function main(): void {
  const rootDir = resolve(__dirname, '..');

  console.log('Agent Skills — Available Skills\n');
  console.log('='.repeat(60));
  console.log('');

  const skills = findSkills(rootDir);

  if (skills.length === 0) {
    console.log('No skills found under ./skills/.\n');
    console.log('Add skills following the guidelines in CONTRIBUTING.md\n');
    return;
  }

  for (const skill of skills) {
    console.log(format(skill));
    console.log('');
  }

  console.log('='.repeat(60));
  console.log(`Total: ${skills.length} skill(s)\n`);
}

export { findSkills, loadSkill };

if (import.meta.main) {
  main();
}
