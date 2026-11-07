// 통합 창 테마 동기화 — 테마 파일·사용자 지정에서 통합 창이 쓰는 색 뽑기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  applyCustomizations,
  buildHubTheme,
  findThemeFile,
  loadThemeColors,
  parseJsonc,
  resolveActiveThemeName,
  themeKindOf,
} from '../src/lib/themeColors.ts';
import { HUB_THEME_DEFAULTS } from '@mark42/protocol';

const EXT = join('C:', 'vsc', 'theme-defaults');
const extensions = [
  { extensionPath: join('C:', 'other'), packageJSON: { contributes: {} } },
  {
    extensionPath: EXT,
    packageJSON: {
      contributes: {
        themes: [
          { id: 'Default Dark Modern', label: '%dark%', uiTheme: 'vs-dark', path: './themes/dark_modern.json' },
          { label: 'Plain Label', uiTheme: 'vs', path: './themes/plain.json' },
          { id: 'Light Pref', uiTheme: 'vs', path: './themes/light.json' },
          { id: 'HC Black', uiTheme: 'hc-black', path: './themes/hc.json' },
        ],
      },
    },
  },
];

const files: Record<string, string> = {
  [join(EXT, 'themes', 'dark_modern.json')]: `{
    // comment
    "include": "./dark_plus.json",
    "colors": { "button.background": "#0078D4", "foreground": "#CCCCCC", },
  }`,
  [join(EXT, 'themes', 'dark_plus.json')]: `{ "include": "./dark_vs.json", "colors": { "editor.background": "#1E1E1E", "foreground": "#aaaaaa" } }`,
  [join(EXT, 'themes', 'dark_vs.json')]: `{ "colors": { "input.background": "#3C3C3C", "statusBar.background": "#007acc" } }`,
  [join(EXT, 'themes', 'hc.json')]: `{ "colors": { "contrastBorder": "#ABCDEF", "panel.border": "#111111" } }`,
};
const readFile = async (p: string) => {
  const t = files[p];
  if (t === undefined) throw new Error(`ENOENT ${p}`);
  return t;
};

test('theme file is found by id, else by label, like VS Code', () => {
  assert.deepEqual(findThemeFile(extensions, 'Default Dark Modern'), { path: join(EXT, 'themes', 'dark_modern.json'), uiTheme: 'vs-dark' });
  assert.equal(findThemeFile(extensions, 'Plain Label')?.path, join(EXT, 'themes', 'plain.json'));
  assert.equal(findThemeFile(extensions, '%dark%'), undefined, 'a theme with an id is not matched by its label');
  assert.equal(findThemeFile(extensions, 'Nope'), undefined);
});

test('colors follow the include chain, child wins; non-JSON and missing files give nothing', async () => {
  const c = await loadThemeColors(join(EXT, 'themes', 'dark_modern.json'), readFile);
  assert.deepEqual(c, { 'input.background': '#3C3C3C', 'statusBar.background': '#007acc', 'editor.background': '#1E1E1E', foreground: '#CCCCCC', 'button.background': '#0078D4' });
  assert.deepEqual(await loadThemeColors(join(EXT, 'x.tmTheme'), readFile), {});
  assert.deepEqual(await loadThemeColors(join(EXT, 'gone.json'), readFile), {});
});

test('user color customizations: global keys, then the [theme] block', () => {
  const out = applyCustomizations({ foreground: '#111111' }, { foreground: '#222222', '[Dark]': { foreground: '#333333' }, '[Other]': { foreground: '#444444' } }, 'Dark');
  assert.equal(out.foreground, '#333333');
  assert.equal(applyCustomizations({ a: '#1' }, 'nonsense', 'Dark').a, '#1');
});

test('customization blocks with wildcards and several themes, like VS Code', () => {
  const pick = (k: string, theme: string) => applyCustomizations({}, { [k]: { foreground: '#123456' } }, theme).foreground;
  assert.equal(pick('[*Dark*]', 'Default Dark Modern'), '#123456');
  assert.equal(pick('[Default*]', 'Default Dark Modern'), '#123456');
  assert.equal(pick('[*Modern]', 'Default Dark Modern'), '#123456');
  assert.equal(pick('[Other][Default Dark Modern]', 'Default Dark Modern'), '#123456');
  assert.equal(pick('[*Light*]', 'Default Dark Modern'), undefined);
});

test('the theme VS Code shows: high contrast and auto-detect preferences checked against the active kind', () => {
  const s = { colorTheme: 'Default Dark Modern', preferredLightColorTheme: 'Light Pref', preferredHighContrastColorTheme: 'HC Black' };
  assert.equal(resolveActiveThemeName(s, 'dark', extensions), 'Default Dark Modern');
  assert.equal(resolveActiveThemeName({ ...s, autoDetectColorScheme: true }, 'light', extensions), 'Light Pref', 'OS light: the preferred light theme');
  assert.equal(resolveActiveThemeName(s, 'light', extensions), 'Default Dark Modern', 'auto-detect off: the setting');
  assert.equal(resolveActiveThemeName(s, 'highContrast', extensions), 'HC Black', 'OS high contrast');
  assert.equal(resolveActiveThemeName({ ...s, autoDetectHighContrast: false }, 'highContrast', extensions), 'Default Dark Modern');
});

test('hub theme keeps only the hub colors, valid hex only, and the kind', async () => {
  const t = await buildHubTheme({
    kind: 2,
    themeName: 'Default Dark Modern',
    extensions,
    customizations: { 'focusBorder': '#ff0000', 'input.border': 'red', 'titleBar.activeBackground': '#7a1018' },
    readFile,
  });
  assert.equal(t.kind, 'dark');
  assert.equal(t.name, 'Default Dark Modern');
  assert.equal(t.colors['button.background'], '#0078d4');
  assert.equal(t.colors['focusBorder'], '#ff0000');
  assert.equal(t.colors['input.border'], undefined, 'named colors are not hex: dropped (they go straight into CSS)');
  assert.equal(t.colors['statusBar.background'], undefined, 'not a hub color');
  assert.equal(t.colors['titleBar.activeBackground'], undefined);
  assert.equal(t.colors['editorWarning.foreground'], '#cca700', 'not in the theme file: VS Code registry default for dark');
  const unknown = await buildHubTheme({ kind: 1, themeName: 'Nope', extensions, customizations: undefined, readFile });
  assert.deepEqual(unknown, { kind: 'light', name: 'Nope', colors: { ...HUB_THEME_DEFAULTS.light } }, 'theme file not found: registry defaults');
});

test('high contrast: the theme contrastBorder drives the borders it does not set itself', async () => {
  const t = await buildHubTheme({ kind: 3, themeName: 'HC Black', extensions, customizations: undefined, readFile });
  assert.equal(t.kind, 'highContrast');
  assert.equal(t.colors['widget.border'], '#abcdef');
  assert.equal(t.colors['input.border'], '#abcdef');
  assert.equal(t.colors['panel.border'], '#111111', 'set by the theme itself');
  assert.equal(t.colors['focusBorder'], '#f38518');
});

test('kinds and JSONC details', () => {
  assert.deepEqual([1, 2, 3, 4].map(themeKindOf), ['light', 'dark', 'highContrast', 'highContrastLight']);
  assert.deepEqual(parseJsonc('{"a":"//not a comment","b":[1,2,],}'), { a: '//not a comment', b: [1, 2] });
});
