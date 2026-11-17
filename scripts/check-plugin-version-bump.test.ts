import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasShippedPluginChanges, isVersionIncrease, versionsMatch } from './check-plugin-version-bump';

test('requires a bump for shipped plugin and extension files', () => {
  expect(hasShippedPluginChanges([
    '.github/plugin/plugin.json',
    '.github/agents/reviewer.agent.md',
    'skills/example/SKILL.md',
    'extensions/notes/client/app.ts',
  ])).toBe(true);
});

test('does not require a bump for extension documentation-only changes', () => {
  expect(hasShippedPluginChanges([
    'extensions/notes/README.md',
    'extensions/notes/docs/notes-light.png',
    'CHANGELOG.md',
  ])).toBe(false);
});

test('scopes shipped changes to the owning plugin, not the marketplace catalog', () => {
  const notesChanges = ['plugins/notes/extensions/notes/client/app.ts'];
  expect(hasShippedPluginChanges(notesChanges)).toBe(false);
  expect(hasShippedPluginChanges(notesChanges, './plugins/notes')).toBe(true);
  expect(hasShippedPluginChanges(['extensions/rpi-artifact-navigator/server.mjs'], './plugins/notes')).toBe(false);
  expect(hasShippedPluginChanges(['.github/plugin/marketplace.json'])).toBe(false);
  expect(hasShippedPluginChanges(['plugins/notes/.github/plugin/plugin.json'], './plugins/notes')).toBe(true);
  expect(hasShippedPluginChanges([
    'plugins/notes/extensions/notes/README.md',
    'plugins/notes/extensions/notes/docs/notes-light.png',
  ], './plugins/notes')).toBe(false);
});

test('accepts only a strictly increasing stable SemVer version', () => {
  expect(isVersionIncrease('2.2.2', '2.2.3')).toBe(true);
  expect(isVersionIncrease('2.2.9', '2.2.10')).toBe(true);
  expect(isVersionIncrease('2.2.2', '2.2.2')).toBe(false);
  expect(isVersionIncrease('2.2.3', '2.2.2')).toBe(false);
});

test('requires plugin and marketplace metadata versions to match', () => {
  expect(versionsMatch('2.2.3', '2.2.3')).toBe(true);
  expect(versionsMatch('2.2.3', '2.2.2')).toBe(false);
});

let fixture: string | undefined;

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

function versionFixture(includeNotes = true) {
  const root = mkdtempSync(join(tmpdir(), 'copilot-plugin-versions-'));
  fixture = root;
  const write = (path: string, value: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=Plugin tests', '-c', 'user.email=tests@example.com',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.git/hooks', 'commit', '--quiet', '-m', 'Fixture');
  };
  const writeNotes = (version: string) => {
    write('plugins/notes/.github/plugin/plugin.json', JSON.stringify({ name: 'notes', version }));
  };
  const writeMarketplace = (notesVersion?: string, mainVersion = '1.0.0') => {
    write('.github/plugin/marketplace.json', JSON.stringify({
      name: 'agent-plugins',
      metadata: { version: mainVersion },
      plugins: [
        { name: 'agent-plugins', source: '.', version: mainVersion },
        ...(notesVersion ? [{ name: 'notes', source: './plugins/notes', version: notesVersion }] : []),
      ],
    }));
  };

  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  write('.github/plugin/plugin.json', JSON.stringify({ name: 'agent-plugins', version: '1.0.0' }));
  writeMarketplace(includeNotes ? '1.0.0' : undefined);
  if (includeNotes) writeNotes('1.0.0');
  commit();
  const base = git('rev-parse', 'HEAD');
  const check = () => spawnSync(process.execPath, [
    fileURLToPath(new URL('./check-plugin-version-bump.ts', import.meta.url)), base,
  ], { cwd: root, encoding: 'utf8' });
  return { write, writeNotes, writeMarketplace, commit, check };
}

test('requires a Notes release without forcing a developer-plugin release', () => {
  const repo = versionFixture();
  repo.write('plugins/notes/extensions/notes/extension.mjs', 'export {};\n');
  repo.commit();

  const unchanged = repo.check();
  expect(unchanged.status).not.toBe(0);
  expect(unchanged.stderr).toContain('notes');
  expect(unchanged.stderr).toContain('version did not increase');

  repo.writeNotes('1.0.1');
  repo.writeMarketplace('1.0.1');
  const released = repo.check();
  expect(released.status).toBe(0);
  expect(released.stdout).toContain('notes');
  expect(released.stdout).toContain('1.0.0 -> 1.0.1');

  repo.writeMarketplace('1.0.2');
  const mismatched = repo.check();
  expect(mismatched.status).not.toBe(0);
  expect(mismatched.stderr).toContain('versions differ');
});

test('allows an initial release of a newly added plugin', () => {
  const repo = versionFixture(false);
  repo.writeNotes('1.0.0');
  repo.writeMarketplace('1.0.0');
  repo.write('plugins/notes/extensions/notes/extension.mjs', 'export {};\n');
  repo.commit();

  expect(repo.check().status).toBe(0);

  repo.writeNotes('1.0.0-beta');
  repo.writeMarketplace('1.0.0-beta');
  expect(repo.check().stderr).toContain('stable SemVer');
});

test('still requires a developer-plugin release for RPI changes', () => {
  const repo = versionFixture();
  repo.write('extensions/rpi-artifact-navigator/extension.mjs', 'export {};\n');
  repo.commit();

  const unchanged = repo.check();
  expect(unchanged.status).not.toBe(0);
  expect(unchanged.stderr).toContain('agent-plugins');
  expect(unchanged.stderr).toContain('version did not increase');

  repo.write('.github/plugin/plugin.json', JSON.stringify({ name: 'agent-plugins', version: '1.0.1' }));
  repo.writeMarketplace('1.0.0', '1.0.1');
  expect(repo.check().status).toBe(0);
});

test('does not require a release for Notes documentation alone', () => {
  const repo = versionFixture();
  repo.write('plugins/notes/extensions/notes/README.md', '# Notes\n');
  repo.commit();

  expect(repo.check().status).toBe(0);
});
