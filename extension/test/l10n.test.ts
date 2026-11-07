// 언어 번들 점검 — 코드의 번역 원문(영어)이 한국어 번들에 다 있는지, 번들에 쓰이지 않는 원문이 없는지, {0}… 자리가 맞는지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceText } from '../src/lib/l10n.ts';
import { KO_BUNDLE } from './helpers/l10n.ts';

const src = join(import.meta.dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

const unescape = (s: string): string => s.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n');

/** 번역 함수 호출(vscode.l10n.t·t·tr·l10nT)의 첫 인자 문자열 리터럴 */
function translatedLiterals(): Map<string, string> {
  const found = new Map<string, string>();
  const re = /(?:\bl10n\.t|\bl10nT|\btr|(?<![\w.$])t)\(\s*'((?:[^'\\]|\\.)*)'/g;
  for (const f of tsFiles(src)) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(re)) found.set(unescape(m[1]!), f);
  }
  return found;
}

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]!).sort();

test('every translated source string in src/ has a Korean entry', () => {
  const lits = translatedLiterals();
  assert.ok(lits.size > 100, `found ${lits.size} translated strings`);
  const missing = [...lits].filter(([k]) => !Object.hasOwn(KO_BUNDLE, k)).map(([k, f]) => `${k}  (${f})`);
  assert.deepEqual(missing, [], 'missing in l10n/bundle.l10n.ko.json');
});

test('every Korean entry is used in src/ and keeps the same {n} placeholders', () => {
  const all = tsFiles(src).map((f) => unescape(readFileSync(f, 'utf8'))).join('\n');
  const unused = Object.keys(KO_BUNDLE).filter((k) => !all.includes(`'${k}'`));
  assert.deepEqual(unused, [], 'unused entries in l10n/bundle.l10n.ko.json');
  for (const [k, v] of Object.entries(KO_BUNDLE)) {
    assert.deepEqual(placeholders(v), placeholders(k), `placeholders differ: ${k}`);
    assert.ok(v.trim().length > 0, `empty translation: ${k}`);
  }
});

test('source text fallback fills {n} and leaves unknown slots', () => {
  assert.equal(sourceText('{0} of {1}', 1, 'two'), '1 of two');
  assert.equal(sourceText('a {1} b', 'x'), 'a {1} b');
});
