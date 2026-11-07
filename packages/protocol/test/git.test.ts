import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCloneUrl, redactCloneUrl } from '../src/git.ts';

test('clone addresses: the usual forms and the folder name git would pick', () => {
  const cases: [string, string][] = [
    ['https://github.com/owner/repo', 'repo'],
    ['https://github.com/owner/repo.git', 'repo'],
    ['https://github.com/owner/repo/', 'repo'],
    [' "https://gitlab.com/group/sub/proj.git" ', 'proj'],
    ['git@github.com:owner/repo.git', 'repo'],
    ['git@github.com:repo', 'repo'],
    ['ssh://git@github.com/owner/repo.git', 'repo'],
    ['ssh://git@host:2222/srv/x.git', 'x'],
    ['git://example.org/a/b', 'b'],
    ['http://intranet:8080/scm/Tools', 'Tools'],
  ];
  for (const [text, name] of cases) assert.equal(parseCloneUrl(text)?.name, name, text);
  assert.equal(parseCloneUrl(' https://github.com/o/r ')?.url, 'https://github.com/o/r');
});

test('clone addresses: paths, other transports, options and secrets are not clone addresses', () => {
  for (const text of [
    '',
    'C:\\Dev\\repo',
    'C:/Dev/repo',
    '\\\\server\\share\\repo',
    '/home/me/repo',
    'file:///C:/repo',
    'ext::sh -c calc',
    'fd::3',
    '-uhttps://x/y',
    '--upload-pack=touch /tmp/x',
    'https://github.com',
    'https://github.com/',
    'https://user:token@github.com/o/r',
    'https://token@github.com/o/r',
    'https://github.com/o/r?x=1',
    'https://github.com/o/r#x',
    'https://github.com/o/r with space',
    'git@github.com:o/..',
    'git@github.com:o/con',
    'x@y:z',
  ]) {
    assert.equal(parseCloneUrl(text), null, text);
  }
});

test('redact: user names are dropped from scheme addresses for logs', () => {
  assert.equal(redactCloneUrl('ssh://git@github.com/o/r'), 'ssh://github.com/o/r');
  assert.equal(redactCloneUrl('https://github.com/o/r'), 'https://github.com/o/r');
  assert.equal(redactCloneUrl('git@github.com:o/r'), 'git@github.com:o/r');
});
