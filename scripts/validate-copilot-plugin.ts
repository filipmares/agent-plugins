#!/usr/bin/env bun
/**
 * GitHub Copilot Plugin Validator
 *
 * Validates the repository's Copilot marketplace catalog and the plugin
 * packages it indexes. This is deliberately scoped to the manifest subset this
 * repository actually uses; it is not a general-purpose implementation of every
 * Copilot plugin field.
 *
 * Checks performed:
 * - `.github/plugin/marketplace.json` parses and declares a marketplace name
 *   and a non-empty, uniquely named plugin list
 * - Every plugin `source` resolves inside the repository and is a directory
 * - Every plugin resolves a manifest (`plugin.json` or `.github/plugin/plugin.json`)
 * - Plugin name and version agree with the marketplace entry
 * - Declared `extensions` paths resolve inside the plugin and contain `extension.mjs`
 * - Canvas ids are unique across a plugin, action names are unique within a
 *   canvas, and no action name uses the reserved `canvas.` prefix
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';

export interface PluginValidationResults {
  valid: boolean;
  errors: string[];
  warnings: string[];
  marketplaceName: string;
  pluginNames: string[];
}

interface MarketplaceEntry {
  name?: unknown;
  source?: unknown;
  version?: unknown;
  description?: unknown;
}

interface CanvasDeclarationSummary {
  id: string;
  actionNames: string[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;
const RESERVED_ACTION_PREFIX = 'canvas.';

/** True when `candidate` is `root` itself or lives underneath it. */
function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * Build a per-character mask marking positions that are inside a string
 * literal, template literal, or comment. Masked positions are excluded from
 * structural scanning so braces and keywords in text cannot confuse it.
 */
function maskNonCode(source: string): boolean[] {
  const masked = new Array<boolean>(source.length).fill(false);
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') masked[i++] = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      masked[i++] = true;
      masked[i++] = true;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) masked[i++] = true;
      if (i < source.length) {
        masked[i++] = true;
        masked[i++] = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      masked[i++] = true;
      while (i < source.length) {
        if (source[i] === '\\') {
          masked[i++] = true;
          if (i < source.length) masked[i++] = true;
          continue;
        }
        const closing = source[i] === quote;
        masked[i++] = true;
        if (closing) break;
      }
      continue;
    }
    i++;
  }
  return masked;
}

/** Find the index of the bracket matching `open` at `start`, skipping masked spans. */
function matchBracket(source: string, masked: boolean[], start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (masked[i]) continue;
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Read a string literal that begins at or after `from`, skipping whitespace. */
function readStringLiteral(source: string, from: number): string | null {
  const match = source.slice(from).match(/^\s*(["'])((?:[^\\]|\\.)*?)\1/);
  return match ? match[2] : null;
}

/**
 * Collect module-level `const NAME = "literal"` bindings so a declaration may
 * reference a named constant instead of repeating a string literal inline.
 */
function collectStringConstants(source: string, masked: boolean[]): Map<string, string> {
  const constants = new Map<string, string>();
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])((?:[^\\]|\\.)*?)\2/g;
  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined || masked[match.index]) continue;
    constants.set(match[1], match[3]);
  }
  return constants;
}

/** Read a string literal, or resolve a reference to a module-level string constant. */
function readStringValue(source: string, from: number, constants: Map<string, string>): string | null {
  const literal = readStringLiteral(source, from);
  if (literal !== null) return literal;
  const identifier = source.slice(from).match(/^\s*([A-Za-z_$][\w$]*)\s*[,}]/);
  if (identifier === null) return null;
  return constants.get(identifier[1]) ?? null;
}

/**
 * Find `key:` occurrences that sit exactly one brace/bracket level inside
 * `[start, end)`. Used so nested schema objects cannot masquerade as
 * declaration fields.
 */
function findKeysAtTopLevel(source: string, masked: boolean[], start: number, end: number, key: string): number[] {
  const hits: number[] = [];
  let depth = 0;
  for (let i = start; i < end; i++) {
    if (masked[i]) continue;
    const ch = source[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (depth === 1 && source.startsWith(key, i) && /^\s*:/.test(source.slice(i + key.length))) {
      const before = i === 0 ? '' : source[i - 1];
      if (!/[A-Za-z0-9_$.]/.test(before)) hits.push(i + key.length);
    }
  }
  return hits;
}

/** Statically extract canvas declarations from an `extension.mjs` source file. */
export function extractCanvasDeclarations(source: string): CanvasDeclarationSummary[] {
  const masked = maskNonCode(source);
  const constants = collectStringConstants(source, masked);
  const declarations: CanvasDeclarationSummary[] = [];

  for (let i = 0; i < source.length; i++) {
    if (masked[i] || !source.startsWith('createCanvas', i)) continue;
    const before = i === 0 ? '' : source[i - 1];
    if (/[A-Za-z0-9_$.]/.test(before)) continue;

    const rest = source.slice(i + 'createCanvas'.length);
    const callMatch = rest.match(/^\s*\(/);
    if (callMatch === null) continue;

    const parenStart = i + 'createCanvas'.length + callMatch[0].length - 1;
    const parenEnd = matchBracket(source, masked, parenStart, '(', ')');
    if (parenEnd === -1) continue;

    const braceStart = source.indexOf('{', parenStart);
    if (braceStart === -1 || braceStart > parenEnd) continue;
    const braceEnd = matchBracket(source, masked, braceStart, '{', '}');
    if (braceEnd === -1) continue;

    const idPositions = findKeysAtTopLevel(source, masked, braceStart, braceEnd + 1, 'id');
    const idValue =
      idPositions.length > 0 ? readStringValue(source, source.indexOf(':', idPositions[0]) + 1, constants) : null;

    const actionNames: string[] = [];
    const actionsPositions = findKeysAtTopLevel(source, masked, braceStart, braceEnd + 1, 'actions');
    if (actionsPositions.length > 0) {
      const arrayStart = source.indexOf('[', actionsPositions[0]);
      if (arrayStart !== -1 && arrayStart < braceEnd) {
        const arrayEnd = matchBracket(source, masked, arrayStart, '[', ']');
        if (arrayEnd !== -1) {
          let cursor = arrayStart + 1;
          while (cursor < arrayEnd) {
            const objectStart = source.indexOf('{', cursor);
            if (objectStart === -1 || objectStart > arrayEnd) break;
            const objectEnd = matchBracket(source, masked, objectStart, '{', '}');
            if (objectEnd === -1) break;
            const namePositions = findKeysAtTopLevel(source, masked, objectStart, objectEnd + 1, 'name');
            if (namePositions.length > 0) {
              const name = readStringValue(source, source.indexOf(':', namePositions[0]) + 1, constants);
              if (name !== null) actionNames.push(name);
            }
            cursor = objectEnd + 1;
          }
        }
      }
    }

    declarations.push({ id: idValue ?? '', actionNames });
  }

  return declarations;
}

function readJson(path: string): { data?: unknown; error?: string } {
  try {
    return { data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function validateExtensions(
  entryName: string,
  pluginDir: string,
  declared: unknown,
  results: PluginValidationResults,
): void {
  const paths = typeof declared === 'string' ? [declared] : declared;
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) {
    results.errors.push(`Plugin "${entryName}" declares "extensions" that is neither a string nor an array of strings`);
    return;
  }

  const seenCanvasIds = new Set<string>();

  for (const declaredPath of paths as string[]) {
    if (declaredPath.trim() === '') {
      results.errors.push(`Plugin "${entryName}" declares an empty extension path`);
      continue;
    }
    const extensionDir = resolve(pluginDir, declaredPath);
    if (!isContained(pluginDir, extensionDir) || extensionDir === pluginDir) {
      results.errors.push(`Plugin "${entryName}" extension path "${declaredPath}" escapes the plugin directory`);
      continue;
    }
    if (!existsSync(extensionDir) || !statSync(extensionDir).isDirectory()) {
      results.errors.push(`Plugin "${entryName}" extension path "${declaredPath}" is not an existing directory`);
      continue;
    }

    const entryFile = join(extensionDir, 'extension.mjs');
    if (!existsSync(entryFile) || !statSync(entryFile).isFile()) {
      results.errors.push(`Plugin "${entryName}" extension "${declaredPath}" is missing extension.mjs`);
      continue;
    }

    const declarations = extractCanvasDeclarations(readFileSync(entryFile, 'utf8'));
    if (declarations.length === 0) {
      results.warnings.push(`Plugin "${entryName}" extension "${declaredPath}" declares no canvases`);
    }

    for (const declaration of declarations) {
      if (declaration.id === '') {
        results.errors.push(`Plugin "${entryName}" extension "${declaredPath}" declares a canvas without a literal id`);
      } else if (seenCanvasIds.has(declaration.id)) {
        results.errors.push(`Plugin "${entryName}" declares duplicate canvas id "${declaration.id}"`);
      } else {
        seenCanvasIds.add(declaration.id);
      }

      const seenActions = new Set<string>();
      for (const actionName of declaration.actionNames) {
        if (actionName.startsWith(RESERVED_ACTION_PREFIX)) {
          results.errors.push(
            `Canvas "${declaration.id}" declares reserved action name "${actionName}"; the "canvas." prefix is reserved`,
          );
        }
        if (seenActions.has(actionName)) {
          results.errors.push(`Canvas "${declaration.id}" declares duplicate action name "${actionName}"`);
        }
        seenActions.add(actionName);
      }
    }
  }
}

/** Validate the Copilot marketplace catalog and the plugin packages it indexes. */
export function validateCopilotPlugin(repoRootInput: string): PluginValidationResults {
  const repoRoot = resolve(repoRootInput);
  const results: PluginValidationResults = {
    valid: false,
    errors: [],
    warnings: [],
    marketplaceName: '',
    pluginNames: [],
  };

  const marketplacePath = join(repoRoot, '.github', 'plugin', 'marketplace.json');
  if (!existsSync(marketplacePath)) {
    results.errors.push('Missing .github/plugin/marketplace.json');
    return results;
  }

  const { data: marketplaceData, error } = readJson(marketplacePath);
  if (error !== undefined) {
    results.errors.push(`.github/plugin/marketplace.json is not valid JSON: ${error}`);
    return results;
  }

  const marketplace = marketplaceData as { name?: unknown; plugins?: unknown };
  if (typeof marketplace.name !== 'string' || !NAME_PATTERN.test(marketplace.name)) {
    results.errors.push('Marketplace "name" must be a lowercase hyphenated string');
  } else {
    results.marketplaceName = marketplace.name;
  }

  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    results.errors.push('Marketplace "plugins" must be a non-empty array');
    return results;
  }

  const seenPluginNames = new Set<string>();

  for (const [index, rawEntry] of (marketplace.plugins as unknown[]).entries()) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      results.errors.push(`Marketplace plugin entry ${index} is not an object`);
      continue;
    }
    const entry = rawEntry as MarketplaceEntry;
    const entryLabel = typeof entry.name === 'string' ? entry.name : `entry ${index}`;

    if (typeof entry.name !== 'string' || !NAME_PATTERN.test(entry.name)) {
      results.errors.push(`Marketplace plugin ${entryLabel} must declare a lowercase hyphenated "name"`);
      continue;
    }
    if (seenPluginNames.has(entry.name)) {
      results.errors.push(`Marketplace declares duplicate plugin name "${entry.name}"`);
      continue;
    }
    seenPluginNames.add(entry.name);
    results.pluginNames.push(entry.name);

    if (typeof entry.description !== 'string' || entry.description.trim() === '') {
      results.errors.push(`Marketplace plugin "${entry.name}" must declare a non-empty "description"`);
    }
    if (typeof entry.version !== 'string' || !SEMVER_PATTERN.test(entry.version)) {
      results.errors.push(`Marketplace plugin "${entry.name}" must declare a semver "version"`);
    }
    if (typeof entry.source !== 'string' || entry.source.trim() === '') {
      results.errors.push(`Marketplace plugin "${entry.name}" must declare a non-empty "source"`);
      continue;
    }

    const pluginDir = resolve(repoRoot, entry.source);
    if (!isContained(repoRoot, pluginDir)) {
      results.errors.push(`Marketplace plugin "${entry.name}" source "${entry.source}" escapes the repository`);
      continue;
    }
    if (!existsSync(pluginDir) || !statSync(pluginDir).isDirectory()) {
      results.errors.push(`Marketplace plugin "${entry.name}" source "${entry.source}" is not an existing directory`);
      continue;
    }

    const rootManifest = join(pluginDir, 'plugin.json');
    const nestedManifest = join(pluginDir, '.github', 'plugin', 'plugin.json');
    const manifestPath = existsSync(rootManifest) ? rootManifest : existsSync(nestedManifest) ? nestedManifest : null;
    if (manifestPath === null) {
      results.errors.push(`Marketplace plugin "${entry.name}" has no plugin.json under "${entry.source}"`);
      continue;
    }

    const { data: manifestData, error: manifestError } = readJson(manifestPath);
    if (manifestError !== undefined) {
      results.errors.push(`Plugin manifest for "${entry.name}" is not valid JSON: ${manifestError}`);
      continue;
    }

    const manifest = manifestData as { name?: unknown; version?: unknown; extensions?: unknown };
    if (manifest.name !== entry.name) {
      results.errors.push(
        `Plugin manifest name "${String(manifest.name)}" does not match marketplace entry name "${entry.name}"`,
      );
    }
    if (manifest.version !== entry.version) {
      results.errors.push(
        `Plugin "${entry.name}" version mismatch: manifest "${String(manifest.version)}" vs marketplace "${String(entry.version)}"`,
      );
    }

    if (manifest.extensions !== undefined) {
      validateExtensions(entry.name, pluginDir, manifest.extensions, results);
    }
  }

  results.valid = results.errors.length === 0;
  return results;
}

function main(): void {
  const args = process.argv.slice(2);
  const repoRoot = args.length > 0 ? resolve(args[0]) : process.cwd();

  console.log(`Validating Copilot plugins in: ${repoRoot}\n`);
  const results = validateCopilotPlugin(repoRoot);

  console.log(`Marketplace: ${results.marketplaceName || '(unresolved)'}`);
  console.log(`Plugins: ${results.pluginNames.join(', ') || '(none)'}`);
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

  if (results.valid && results.warnings.length === 0) {
    console.log('✓ Copilot plugin structure is valid and complete!\n');
  }

  process.exit(results.valid ? 0 : 1);
}

if (import.meta.main) {
  main();
}
