import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error — plain .mjs build script without types
import { buildManifest, listL10nFiles, packageVsix, stampVersion } from '../package-vsix.mjs';

function fakeExtension(): string {
  const root = mkdtempSync(join(tmpdir(), 'mk42-vsix-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'mark42', publisher: 'mark42', version: '0.1.0', displayName: 'Mark42', description: 'a <b> & c', engines: { vscode: '^1.100.0' } }),
  );
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'extension.cjs'), 'module.exports = { activate() {} };\n'.repeat(50));
  writeFileSync(join(root, 'dist', 'extension.cjs.map'), '{}');
  writeFileSync(join(root, 'dist', 'hub-ui.js'), '// 통합 창\n');
  writeFileSync(join(root, 'package.nls.json'), '{"x":"X"}');
  writeFileSync(join(root, 'package.nls.ko.json'), '{"x":"엑스"}');
  mkdirSync(join(root, 'l10n'));
  writeFileSync(join(root, 'l10n', 'bundle.l10n.ko.json'), '{"Hub window":"통합 창"}');
  writeFileSync(join(root, 'l10n', 'notes.txt'), 'not a bundle');
  return root;
}

function list(dir: string, base = ''): string[] {
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? list(dir, join(base, e.name)) : [join(base, e.name).replace(/\\/g, '/')],
  );
}

test('build version: <major>.<minor>.<days × 43200 + UTC seconds ÷ 2>, growing with time', () => {
  assert.equal(stampVersion('0.1.0', new Date(Date.UTC(2026, 0, 1, 0, 0, 0))), '0.1.0');
  assert.equal(stampVersion('0.1.0', new Date(Date.UTC(2026, 9, 22, 4, 30, 10))), `0.1.${294 * 43200 + (4 * 3600 + 30 * 60 + 10) / 2}`);
  assert.equal(stampVersion('2.7.9', new Date(Date.UTC(2026, 0, 2, 0, 0, 1))), '2.7.43200');
  assert.ok(Number(stampVersion('0.1.0').split('.')[2]) > 294 * 43200);
});

test('vsix manifest escapes text and carries identity and engine', () => {
  const xml = buildManifest({ name: 'mark42', publisher: 'mark42', version: '1.2.3', description: 'a <b> & c', engines: { vscode: '^1.100.0' } });
  assert.match(xml, /<Identity Language="en-US" Id="mark42" Version="1.2.3" Publisher="mark42" \/>/);
  assert.match(xml, /a &lt;b&gt; &amp; c/);
  assert.match(xml, /Microsoft.VisualStudio.Code.Engine" Value="\^1.100.0"/);
  assert.match(xml, /Path="extension\/package.json"/);
  // %키% 설명은 package.nls.json(영어 기본) 글로
  const nlsXml = buildManifest({ name: 'mark42', publisher: 'mark42', version: '1.2.3', description: '%description%' }, { description: 'Built-in & co' });
  assert.match(nlsXml, /<Description xml:space="preserve">Built-in &amp; co<\/Description>/);
  assert.match(buildManifest({ name: 'm', publisher: 'p', version: '1', description: '%missing%' }, {}), />%missing%</);
});

test('the real extension ships its language files: package.nls(.ko).json keys match, every %key% in package.json resolves', async () => {
  const here = join(import.meta.dirname, '..');
  const pkgText = readFileSync(join(here, 'package.json'), 'utf8');
  const en = JSON.parse(readFileSync(join(here, 'package.nls.json'), 'utf8')) as Record<string, string>;
  const ko = JSON.parse(readFileSync(join(here, 'package.nls.ko.json'), 'utf8')) as Record<string, string>;
  const used = [...pkgText.matchAll(/"%([\w.-]+)%"/g)].map((m) => m[1]!);
  assert.ok(used.length > 0);
  for (const k of used) {
    assert.equal(typeof en[k], 'string', `package.nls.json has ${k}`);
    assert.equal(typeof ko[k], 'string', `package.nls.ko.json has ${k}`);
  }
  assert.deepEqual(Object.keys(ko).sort(), Object.keys(en).sort(), 'same keys in en and ko');
  assert.equal(JSON.parse(pkgText).l10n, './l10n');
  assert.ok((await listL10nFiles(here)).some((f: { from: string }) => f.from === 'l10n/bundle.l10n.ko.json'));
});

test('vsix is a zip with the manifest, content types, package.json and the bundles only (no source maps), byte-stable', { skip: process.platform !== 'win32' }, async () => {
  const root = fakeExtension();
  try {
    const file = await packageVsix(root, join(root, 'out'), { version: '9.8.7' });
    assert.match(file, /mark42-9\.8\.7\.vsix$/);
    const first = readFileSync(file);
    const x = join(root, 'x');
    mkdirSync(x);
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', file, '-C', x]);
    assert.deepEqual(list(x).sort(), [
      '[Content_Types].xml',
      'extension.vsixmanifest',
      'extension/dist/extension.cjs',
      'extension/dist/hub-ui.js',
      'extension/l10n/bundle.l10n.ko.json',
      'extension/package.json',
      'extension/package.nls.json',
      'extension/package.nls.ko.json',
    ]);
    assert.equal(readFileSync(join(x, 'extension', 'l10n', 'bundle.l10n.ko.json'), 'utf8'), '{"Hub window":"통합 창"}');
    assert.equal(readFileSync(join(x, 'extension', 'dist', 'extension.cjs'), 'utf8'), readFileSync(join(root, 'dist', 'extension.cjs'), 'utf8'));
    assert.equal(readFileSync(join(x, 'extension', 'dist', 'hub-ui.js'), 'utf8'), '// 통합 창\n');
    assert.equal(JSON.parse(readFileSync(join(x, 'extension', 'package.json'), 'utf8')).version, '9.8.7');
    assert.match(readFileSync(join(x, 'extension.vsixmanifest'), 'utf8'), /Version="9\.8\.7"/);
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.1.0', 'source package.json untouched');
    await packageVsix(root, join(root, 'out'), { version: '9.8.7' });
    assert.deepEqual(readFileSync(file), first, 'same input → same bytes');

    assert.match(await packageVsix(root, join(root, 'out2')), /mark42-0\.1\.\d+\.vsix$/); // build-stamped by default

    rmSync(join(root, 'dist', 'extension.cjs'));
    await assert.rejects(packageVsix(root, join(root, 'out')), /npm run build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
