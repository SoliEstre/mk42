// C2: argv.json에 locale ko를 글자 그대로 넣기(주석 유지, 사용자가 고른 locale 유지)
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureArgvLocale, mk42ArgvJsonPath, scanJsoncTopLevel } from '../src/argvJson.ts';
import { tempDir } from './helpers.ts';

/** VS Code가 처음 만드는 argv.json 모양(주석 + 키 둘) */
const DEFAULT_ARGV = [
  '// This configuration file allows you to pass permanent command line arguments to VS Code.',
  '// Only a subset of arguments is currently supported to reduce the likelihood of breaking',
  '// the installation.',
  '//',
  '// PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING THE IMPACT',
  '//',
  '// NOTE: Changing this file requires a restart of VS Code.',
  '{',
  '\t// Use software rendering instead of hardware accelerated rendering.',
  '\t// This can help in cases where you see rendering issues in VS Code.',
  '\t// "disable-hardware-acceleration": true,',
  '\t// "locale": "en",',
  '',
  '\t// Allows to disable crash reporting.',
  '\t// Should restart the app if the value is changed.',
  '\t"enable-crash-reporter": true,',
  '',
  '\t/* Unique id used for correlating crash reports sent from this instance. { "x": 1 } */',
  '\t"crash-reporter-id": "a{b}// c\\"d"',
  '}',
  '',
].join('\r\n');

function stripComments(text: string): string {
  // 시험용: 문자열 밖의 // 줄 주석과 /* */ 블록 주석 지우기
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      for (; text[j] !== '"'; j++) if (text[j] === '\\') j++;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return out;
}

test('argv.json: path is <user home>\\.mk42\\argv.json', () => {
  assert.equal(mk42ArgvJsonPath('C:\\Users\\u'), join('C:\\Users\\u', '.mk42', 'argv.json'));
});

test('argv.json: top-level keys skip comments and strings; non-objects are refused', () => {
  assert.deepEqual(scanJsoncTopLevel(DEFAULT_ARGV)?.keys, ['enable-crash-reporter', 'crash-reporter-id']);
  assert.deepEqual(scanJsoncTopLevel('{"a": {"locale": 1}, "b": [1, {"c": 2}]}')?.keys, ['a', 'b'], 'nested keys are not top-level');
  assert.deepEqual(scanJsoncTopLevel('\uFEFF{}')?.keys, []);
  assert.equal(scanJsoncTopLevel(''), undefined);
  assert.equal(scanJsoncTopLevel('[1]'), undefined);
  assert.equal(scanJsoncTopLevel('{"a": 1'), undefined);
  assert.equal(scanJsoncTopLevel('{} {}'), undefined);
  assert.equal(scanJsoncTopLevel('{"a": "unterminated}'), undefined);
  assert.equal(scanJsoncTopLevel('{ /* open'), undefined);
});

test('argv.json: missing file is created with only the locale', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = join(dir, '.mk42', 'argv.json');
    assert.equal(await ensureArgvLocale(file, 'ko'), 'created');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { locale: 'ko' });
    assert.equal(await ensureArgvLocale(file, 'ko'), 'kept');
  } finally {
    cleanup();
  }
});

test('argv.json: locale goes in as the first key, comments and CRLF stay; a commented-out locale does not count', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = join(dir, 'argv.json');
    writeFileSync(file, DEFAULT_ARGV);
    assert.equal(await ensureArgvLocale(file, 'ko'), 'set');
    const out = readFileSync(file, 'utf8');
    assert.ok(out.includes('{\r\n\t"locale": "ko",\r\n\t// Use software rendering'), out);
    assert.equal(out.replace('\r\n\t"locale": "ko",', ''), DEFAULT_ARGV, 'nothing else changed');
    assert.deepEqual(JSON.parse(stripComments(out)), { locale: 'ko', 'enable-crash-reporter': true, 'crash-reporter-id': 'a{b}// c"d' });
    assert.equal(await ensureArgvLocale(file, 'ko'), 'kept');
    assert.equal(readFileSync(file, 'utf8'), out);
  } finally {
    cleanup();
  }
});

test('argv.json: a locale the user chose is kept; empty objects and odd files', async () => {
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(join(dir, 'x'));
    const chosen = join(dir, 'chosen.json');
    writeFileSync(chosen, '{\n\t"enable-crash-reporter": false,\n\t"locale": "en"\n}\n');
    assert.equal(await ensureArgvLocale(chosen, 'ko'), 'kept');
    assert.equal(readFileSync(chosen, 'utf8'), '{\n\t"enable-crash-reporter": false,\n\t"locale": "en"\n}\n');

    const empty = join(dir, 'empty.json');
    writeFileSync(empty, '{}');
    assert.equal(await ensureArgvLocale(empty, 'ko'), 'set');
    assert.equal(readFileSync(empty, 'utf8'), '{\n\t"locale": "ko"\n}');

    const onlyComments = join(dir, 'comments.json');
    writeFileSync(onlyComments, '{\n\t// nothing yet\n}\n');
    assert.equal(await ensureArgvLocale(onlyComments, 'ko'), 'set');
    assert.deepEqual(JSON.parse(stripComments(readFileSync(onlyComments, 'utf8'))), { locale: 'ko' });

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, 'not json at all');
    assert.equal(await ensureArgvLocale(broken, 'ko'), 'unreadable');
    assert.equal(readFileSync(broken, 'utf8'), 'not json at all', 'never overwritten');
  } finally {
    cleanup();
  }
});
