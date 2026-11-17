import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCopilotPlugin } from './validate-copilot-plugin';

let root: string;

function write(path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function declareExtensions(paths: string[]): void {
  write(join('.github', 'plugin', 'plugin.json'), JSON.stringify({
    name: 'agent-plugins',
    version: '1.0.0',
    extensions: paths,
  }));
}

function addCanvas(directory: string, id: string): void {
  write(join('extensions', directory, 'extension.mjs'),
    `createCanvas({ id: ${JSON.stringify(id)}, actions: [] });`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copilot-plugin-discovery-'));
  write(join('.github', 'plugin', 'marketplace.json'), JSON.stringify({
    name: 'agent-plugins',
    plugins: [{
      name: 'agent-plugins',
      description: 'Bundled canvases',
      version: '1.0.0',
      source: '.',
    }],
  }));
  declareExtensions(['extensions']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('discovers both canvases under the declared parent directory', () => {
  addCanvas('notes', 'notes');
  addCanvas('rpi-artifact-navigator', 'rpi-artifact-navigator');

  const result = validateCopilotPlugin(root);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(result.valid).toBe(true);
});

test('rejects individual extension folders as discovery roots', () => {
  addCanvas('notes', 'notes');
  addCanvas('rpi-artifact-navigator', 'rpi-artifact-navigator');
  declareExtensions(['extensions/notes', 'extensions/rpi-artifact-navigator']);

  const result = validateCopilotPlugin(root);
  expect(result.valid).toBe(false);
  expect(result.errors).toHaveLength(2);
  expect(result.errors.every(error => error.includes('contains no extension subdirectories'))).toBe(true);
});

test('checks canvas id uniqueness across discovered subdirectories', () => {
  addCanvas('notes', 'notes');
  addCanvas('other-notes', 'notes');

  expect(validateCopilotPlugin(root).errors).toContain(
    'Plugin "agent-plugins" declares duplicate canvas id "notes"',
  );
});

test('rejects a discovered extension without its entry point', () => {
  addCanvas('notes', 'notes');
  mkdirSync(join(root, 'extensions', 'broken'));

  expect(validateCopilotPlugin(root).errors).toContain(
    `Plugin "agent-plugins" extension "${join('extensions', 'broken')}" is missing extension.mjs`,
  );
});

test('repository packages Notes separately from the developer plugin', () => {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const marketplace: { plugins: { name: string; source: string }[] } =
    JSON.parse(readFileSync(join(repoRoot, '.github', 'plugin', 'marketplace.json'), 'utf8'));
  const discovered = Object.fromEntries(marketplace.plugins.map(entry => {
    const pluginRoot = join(repoRoot, entry.source);
    const manifest: { extensions: string[] } =
      JSON.parse(readFileSync(join(pluginRoot, '.github', 'plugin', 'plugin.json'), 'utf8'));
    return [entry.name, manifest.extensions.flatMap(path =>
      readdirSync(join(pluginRoot, path), { withFileTypes: true })
        .filter(child => child.isDirectory())
        .map(child => child.name),
    )];
  }));

  expect(discovered).toEqual({
    'agent-plugins': ['rpi-artifact-navigator'],
    notes: ['notes'],
  });
  expect(validateCopilotPlugin(repoRoot).errors).toEqual([]);
});
