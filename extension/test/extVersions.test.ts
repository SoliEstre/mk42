import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, newestVersion } from '../src/lib/extVersions.ts';

test('extVersions: numeric compare per part, longer wins on ties', () => {
  assert.ok(compareVersions('2.1.314', '2.1.312') > 0);
  assert.ok(compareVersions('2.1.9', '2.1.312') < 0);
  assert.ok(compareVersions('26.1101.1', '26.1021.22027') > 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

test('extVersions: newest folder version of that id, platform suffix allowed, obsolete and other ids skipped', () => {
  const names = [
    'anthropic.claude-code-2.1.311-win32-x64',
    'Anthropic.Claude-Code-2.1.314-win32-x64',
    'anthropic.claude-code-2.1.9-win32-x64',
    'anthropic.claude-code-extra-9.9.9',
    'openai.chatgpt-26.1021.22027',
    'openai.codex-audio-26.1101.1-universal',
  ];
  assert.equal(newestVersion(names, new Set(), 'anthropic.claude-code'), '2.1.314');
  assert.equal(newestVersion(names, new Set(['anthropic.claude-code-2.1.314-win32-x64']), 'anthropic.claude-code'), '2.1.311');
  assert.equal(newestVersion(names, new Set(), 'openai.chatgpt'), '26.1021.22027');
  assert.equal(newestVersion([], new Set(), 'openai.chatgpt'), undefined);
});
