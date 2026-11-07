import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureLanguagePacksJson, languagePackHash } from '../src/languagePacks.ts';

function fakePack(root: string): string {
  const exts = join(root, 'extensions');
  const dir = join(exts, 'ms-ceintl.vscode-language-pack-ko-1.131.0-universal');
  mkdirSync(join(dir, 'translations'), { recursive: true });
  writeFileSync(join(dir, 'translations', 'main.i18n.json'), '{}');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'vscode-language-pack-ko',
      publisher: 'MS-CEINTL',
      version: '1.131.0',
      contributes: { localizations: [{ languageId: 'ko', languageName: 'Korean', localizedLanguageName: '한국어', translations: [{ id: 'vscode', path: './translations/main.i18n.json' }] }] },
    }),
  );
  return exts;
}

test('languagepacks.json: written like LanguagePacksCache, other languages kept, second run kept (drive case ignored)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mk42-lp-'));
  try {
    const exts = fakePack(root);
    const ud = join(root, 'user-data');
    mkdirSync(ud);
    writeFileSync(join(ud, 'languagepacks.json'), JSON.stringify({ de: { hash: 'x', extensions: [], translations: {}, label: 'Deutsch' } }));
    assert.equal(await ensureLanguagePacksJson(ud, exts, 'ms-ceintl.vscode-language-pack-ko'), 'written');
    const doc = JSON.parse(readFileSync(join(ud, 'languagepacks.json'), 'utf8'));
    assert.ok(doc.de, 'other language kept');
    assert.equal(doc.ko.label, '한국어');
    assert.equal(doc.ko.hash, languagePackHash(doc.ko.extensions));
    assert.match(doc.ko.translations.vscode, /translations[\\/]main\.i18n\.json$/);
    // the shared process writes a lower-case drive letter — same path, not rewritten
    doc.ko.translations.vscode = doc.ko.translations.vscode.replace(/^[A-Z]:/, (d: string) => d.toLowerCase());
    writeFileSync(join(ud, 'languagepacks.json'), JSON.stringify(doc));
    assert.equal(await ensureLanguagePacksJson(ud, exts, 'ms-ceintl.vscode-language-pack-ko'), 'kept');
    assert.equal(await ensureLanguagePacksJson(ud, join(root, 'nothing'), 'ms-ceintl.vscode-language-pack-ko'), 'no-pack');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
