import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { AppLauncher, type DiscoveredInstall } from '../src/launcher.ts';
import { emptyRegistry, type DaemonSettings } from '../src/registry.ts';
import {
  applyManagedUserSettings,
  editSettingsText,
  MANAGED_USER_SETTINGS,
  parseSettingsText,
} from '../src/userData.ts';
import { tempDir } from './helpers.ts';

/** 시각을 정해서 파일을 써요 (초 단위, 2026-10-21 기준) */
function put(path: string, text: string, sec: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  const t = new Date(Date.UTC(2026, 9, 21, 0, 0, sec));
  utimesSync(path, t, t);
}

const ud = (home: string, v: string) => join(home, 'data', v, 'user-data');
const vscdb = (dir: string) => join(dir, 'User', 'globalStorage', 'state.vscdb');

test('userData: managed user settings are merged in, kept other keys, never rewritten when equal, never in the user’s own data', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const env = { APPDATA: join(dir, 'Roaming') };
    const ud1 = join(dir, 'ud1');
    await applyManagedUserSettings(ud1, undefined, env); // no settings.json yet → created
    assert.deepEqual(JSON.parse(readFileSync(join(ud1, 'User', 'settings.json'), 'utf8')), MANAGED_USER_SETTINGS);

    const file = join(dir, 'ud2', 'User', 'settings.json');
    put(file, '{\n  // mine\n  "editor.fontSize": 15,\n  "update.mode": "default",\n}', 10);
    await applyManagedUserSettings(join(dir, 'ud2'), undefined, env);
    const kept = readFileSync(file, 'utf8');
    assert.ok(kept.includes('// mine'), 'comments survive (the sync would spread a stripped file to every version)');
    assert.deepEqual(parseSettingsText(kept), { 'editor.fontSize': 15, ...MANAGED_USER_SETTINGS });

    for (const blank of ['', '  \n', '// only a comment\n']) {
      const f = join(dir, 'blank', 'User', 'settings.json');
      put(f, blank, 10);
      await applyManagedUserSettings(join(dir, 'blank'), undefined, env);
      assert.deepEqual(parseSettingsText(readFileSync(f, 'utf8')), MANAGED_USER_SETTINGS, `blank: ${JSON.stringify(blank)}`);
    }
    const t = new Date(Date.UTC(2026, 9, 21, 0, 0, 20));
    utimesSync(file, t, t);
    await applyManagedUserSettings(join(dir, 'ud2'), undefined, env);
    assert.equal(statSync(file).mtimeMs, t.getTime(), 'already right: not rewritten (settings sync would see it as newest)');

    const bad = join(dir, 'ud3', 'User', 'settings.json');
    put(bad, '{ not json', 10);
    await applyManagedUserSettings(join(dir, 'ud3'), undefined, env);
    assert.equal(readFileSync(bad, 'utf8'), '{ not json');

    const own = join(env.APPDATA, 'Code');
    await applyManagedUserSettings(own, undefined, env);
    assert.ok(!existsSync(join(own, 'User')), 'the user’s own VS Code data is never written');
  } finally {
    cleanup();
  }
});

test('userData: settings text edits keep comments and layout; anything they cannot do safely comes back undefined', () => {
  const v = { 'update.mode': 'none', 'window.restoreWindows': 'none' };
  assert.equal(
    editSettingsText('{\n\t"a": 1 // note\n}\n', v),
    '{\n\t"a": 1, // note\n\t"update.mode": "none",\n\t"window.restoreWindows": "none"\n}\n',
  );
  assert.equal(editSettingsText('{}', v), '{\n\t"update.mode": "none",\n\t"window.restoreWindows": "none"\n}');
  assert.equal(editSettingsText('{"a":1,}', { 'update.mode': 'none' }), '{"a":1,\n\t"update.mode": "none"\n}');
  assert.equal(
    editSettingsText('{\n  /* x */ "update.mode": "default", "window.restoreWindows": "all"\n}', v),
    '{\n  /* x */ "update.mode": "none", "window.restoreWindows": "none"\n}',
  );
  assert.equal(editSettingsText('', { 'update.mode': 'none' }), '{\n\t"update.mode": "none"\n}\n');
  // a commented-out copy of the key would be «changed» inside the comment: refused, the caller backs up and rewrites
  assert.equal(editSettingsText('{\n  // "update.mode": "default"\n  "a": 1\n}', { 'update.mode': 'none' }), undefined);
});

test('userData: a file that cannot be edited in place is backed up before the plain rewrite', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = join(dir, 'ud', 'User', 'settings.json');
    put(file, '{\n  // "update.mode": "default"\n  "a": 1\n}', 10);
    await applyManagedUserSettings(join(dir, 'ud'), undefined, { APPDATA: join(dir, 'Roaming') });
    assert.deepEqual(parseSettingsText(readFileSync(file, 'utf8')), { a: 1, ...MANAGED_USER_SETTINGS });
    const backups = readdirSync(dirname(file)).filter((n) => n.startsWith('settings.json.mk42-bak-'));
    assert.equal(backups.length, 1);
    assert.ok(readFileSync(join(dirname(file), backups[0]!), 'utf8').includes('// "update.mode"'));
  } finally {
    cleanup();
  }
});

