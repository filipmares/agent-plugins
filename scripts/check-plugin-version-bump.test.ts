import { expect, test } from 'bun:test';
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
