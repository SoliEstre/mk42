import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DaemonSettings } from '../src/registry.ts';
import {
  compareVersions,
  listFiles,
  packageVersionAt,
  summarizeTree,
  treeHash,
  validateManifest,
  type PackageManifest,
} from '../src/setup/manifest.ts';
import {
  applyInstallToSettings,
  decideTask,
  installPaths,
  isDaemonCommandLine,
  isInside,
  removeInstallFromSettings,
  targetFor,
  upstreamVersionOf,
} from '../src/setup/plan.ts';
import { defaultPipeName } from '@mark42/protocol/paths';
import { tempDir } from './helpers.ts';

const H = 'a'.repeat(64);
function manifest(over: Partial<PackageManifest> = {}): PackageManifest {
  return {
    schema: 1,
    product: 'mark42',
    version: '2026.1103.104512',
    createdAt: '2026-11-03T10:45:12.000Z',
    source: { mark42Commit: 'abc1234', dirty: false, upstreamTag: '1.143.1' },
    appExe: 'Mk42.exe',
    components: [
      { name: 'runtime', version: '24.20.0', dir: 'runtime', treeHash: H, fileCount: 1, size: 1 },
      { name: 'daemon', version: '2026.1103.104512', dir: 'daemon', treeHash: H, fileCount: 4, size: 1 },
      { name: 'app', version: '1.143.1-2aca49f', dir: 'app', treeHash: H, fileCount: 9, size: 1 },
      { name: 'hub', version: '2026.1103.104512', dir: 'hub', treeHash: H, fileCount: 1, size: 1 },
      { name: 'extension', version: '0.1.13178646', dir: 'extension', treeHash: H, fileCount: 1, size: 1 },
    ],
    ...over,
  };
}

test('tree hash: same files → same hash regardless of listing order; any change in path, size or content changes it', async () => {
  const t = tempDir('mk42-setup-');
  try {
    mkdirSync(join(t.dir, 'a', 'sub'), { recursive: true });
    writeFileSync(join(t.dir, 'a', 'x.txt'), 'hello');
    writeFileSync(join(t.dir, 'a', 'sub', 'y.bin'), Buffer.from([1, 2, 3]));
    const files = await listFiles(join(t.dir, 'a'));
    assert.deepEqual(files.map((f) => f.path), ['sub/y.bin', 'x.txt']);
    assert.equal(treeHash(files), treeHash([...files].reverse()));
    const before = (await summarizeTree(join(t.dir, 'a'))).treeHash;
    writeFileSync(join(t.dir, 'a', 'x.txt'), 'hellO');
    assert.notEqual((await summarizeTree(join(t.dir, 'a'))).treeHash, before);
    assert.notEqual(treeHash([{ ...files[0]!, path: 'sub/z.bin' }, files[1]!]), treeHash(files));
  } finally {
    t.cleanup();
  }
});

test('package versions: UTC stamp sorts numerically; compareVersions handles mixed parts', () => {
  assert.equal(packageVersionAt(new Date('2026-11-03T01:02:03Z')), '2026.1103.10203');
  assert.equal(packageVersionAt(new Date('2026-01-09T00:00:00Z')), '2026.109.0');
  assert.ok(compareVersions('2026.1103.10203', '2026.1103.104512') < 0);
  assert.ok(compareVersions('2026.1231.0', '2026.109.235959') > 0);
  assert.ok(compareVersions('2027.101.0', '2026.1231.235959') > 0);
  assert.equal(compareVersions('0.1.13178646', '0.1.13178646'), 0);
  assert.ok(compareVersions('0.1.9', '0.1.10') < 0);
});

test('manifest validation: refuses unsafe folder names and missing or unknown components', () => {
  assert.equal(validateManifest(manifest()).version, '2026.1103.104512');
  const bad = (m: unknown, re: RegExp) => assert.throws(() => validateManifest(m), re);
  bad(manifest({ schema: 2 as never }), /schema/);
  bad(manifest({ appExe: '..\\evil.exe' }), /appExe/);
  bad({ ...manifest(), components: manifest().components.slice(1) }, /missing component runtime/);
  bad({ ...manifest(), components: [...manifest().components, manifest().components[0]] }, /duplicate/);
  const withVersion = (v: string) => ({ ...manifest(), components: manifest().components.map((c) => (c.name === 'app' ? { ...c, version: v } : c)) });
  bad(withVersion('..\\..\\Windows'), /bad version for app/);
  bad(withVersion('1.0/../x'), /bad version for app/);
  bad({ ...manifest(), components: manifest().components.map((c) => (c.name === 'hub' ? { ...c, dir: '../hub' } : c)) }, /bad dir/);
  bad({ ...manifest(), components: manifest().components.map((c) => (c.name === 'hub' ? { ...c, treeHash: 'x' } : c)) }, /treeHash/);
});

test('install targets: versioned folders under home, hub exe and extension in one place', () => {
  const home = 'C:\\Users\\u\\AppData\\Local\\Mark42';
  const m = manifest();
  assert.equal(targetFor(home, m.components[2]!).path, `${home}\\app\\Mk42-1.143.1-2aca49f`);
  const p = installPaths(home, m);
  assert.equal(p.node, `${home}\\runtime\\node-24.20.0\\node.exe`);
  assert.equal(p.daemonEntry, `${home}\\daemon\\2026.1103.104512\\daemon\\dist\\mk42d.mjs`);
  assert.equal(p.appExe, `${home}\\app\\Mk42-1.143.1-2aca49f\\Mk42.exe`);
  assert.equal(p.hubExe, `${home}\\hub\\mk42-hub.exe`);
  assert.equal(p.extensionDir, `${home}\\extension`);
  assert.equal(upstreamVersionOf('1.143.1-2aca49f'), '1.143.1');
  assert.equal(upstreamVersionOf('1.143.1-2aca49f-dirty-202611031040'), '1.143.1');
});

test('settings: replaces the Mark42 app of the same version, keeps its data folders and every other setting', () => {
  const current = {
    resumeMode: 'firstRemoteApp',
    defaultAppProduct: 'mark42',
    // 코어가 모르는 키(판 덧층 설정)도 그대로 남아요
    appProductByFolder: { 'C:\\p': 'mark42' },
    extensionDevelopmentPath: 'C:\\dev\\extension',
    extensionVsix: 'C:\\dev\\extension\\out',
    apps: [
      { version: '1.143.1', exe: 'C:\\poc\\Code.exe', userDataDir: 'C:\\t\\ud' },
      { version: '1.143.1', product: 'mark42', exe: 'C:\\old\\Mk42.exe', userDataDir: 'C:\\Users\\u\\.mk42\\user-data', extensionsDir: 'C:\\Users\\u\\.mk42\\extensions' },
      { version: '1.142.0', product: 'mark42', exe: 'C:\\older\\Mk42.exe' },
    ],
  } as DaemonSettings;
  const r = applyInstallToSettings(current, {
    appVersion: '1.143.1',
    appExe: 'C:\\new\\Mk42.exe',
    extensionDir: 'C:\\home\\extension',
    mk42Data: 'C:\\elsewhere\\.mk42',
    fresh: false,
  });
  assert.deepEqual(r.settings.apps.map((a) => a.exe), ['C:\\poc\\Code.exe', 'C:\\new\\Mk42.exe', 'C:\\older\\Mk42.exe'], 'replaced in place — the VS Code entry stays first');
  assert.equal(r.settings.apps[1]!.userDataDir, 'C:\\Users\\u\\.mk42\\user-data', 'data folders come from the existing entry');
  assert.equal(r.settings.apps[1]!.product, 'mark42');
  const added = applyInstallToSettings(current, { appVersion: '1.144.0', appExe: 'C:\\n2\\Mk42.exe', extensionDir: 'e', mk42Data: 'd', fresh: false });
  assert.deepEqual(added.settings.apps.map((a) => a.exe), ['C:\\poc\\Code.exe', 'C:\\n2\\Mk42.exe', 'C:\\old\\Mk42.exe', 'C:\\older\\Mk42.exe'], 'a new version goes first among the Mk42 entries');
  assert.equal(r.settings.extensionVsix, 'C:\\home\\extension');
  assert.equal(r.settings.extensionDevelopmentPath, 'C:\\dev\\extension');
  assert.deepEqual((r.settings as unknown as Record<string, unknown>).appProductByFolder, { 'C:\\p': 'mark42' });
  assert.equal(current.apps.length, 3, 'input not mutated');
  assert.ok(r.notes.some((n) => n.includes('C:\\old\\Mk42.exe -> C:\\new\\Mk42.exe')));
});

test('settings: a first install gets default data folders and Mk42 as the default app; an existing choice is kept', () => {
  const fresh = applyInstallToSettings({ resumeMode: 'firstRemoteApp', apps: [] }, {
    appVersion: '1.143.1',
    appExe: 'C:\\h\\app\\Mk42-1.143.1-x\\Mk42.exe',
    extensionDir: 'C:\\h\\extension',
    mk42Data: 'C:\\Users\\v\\.mk42',
    fresh: true,
  });
  assert.equal(fresh.settings.defaultAppProduct, 'mark42');
  assert.equal(fresh.settings.apps[0]!.userDataDir, 'C:\\Users\\v\\.mk42\\user-data');
  assert.equal(fresh.settings.apps[0]!.extensionsDir, 'C:\\Users\\v\\.mk42\\extensions');
  const kept = applyInstallToSettings({ resumeMode: 'firstRemoteApp', apps: [], defaultAppProduct: 'vscode' }, {
    appVersion: '1.143.1',
    appExe: 'x',
    extensionDir: 'y',
    mk42Data: 'z',
    fresh: true,
  });
  assert.equal(kept.settings.defaultAppProduct, 'vscode');
  const existing = applyInstallToSettings({ resumeMode: 'firstRemoteApp', apps: [] }, { appVersion: '1', appExe: 'x', extensionDir: 'y', mk42Data: 'z', fresh: false });
  assert.equal(existing.settings.defaultAppProduct, undefined, 'only a first install picks the default app');
});

test('old daemon processes are matched by bundle name and this pipe only', () => {
  const pipe = '\\\\.\\pipe\\mark42-m42d-8e7882229610';
  assert.ok(isDaemonCommandLine(`"C:\\Program Files\\nodejs\\node.exe" "C:\\Dev\\work area\\Mark42\\mark42\\daemon\\dist\\mk42d.mjs" --home C:\\Users\\u\\AppData\\Local\\Mark42 --pipe ${pipe}`, pipe));
  assert.ok(isDaemonCommandLine(`node C:\\x\\m42d.mjs --boot --pipe ${pipe.toUpperCase()}`, pipe));
  assert.ok(!isDaemonCommandLine(`node C:\\x\\mk42d.mjs --pipe \\\\.\\pipe\\mark42-m42d-other`, pipe), 'another home/pipe (tests, a second profile)');
  assert.ok(!isDaemonCommandLine(`node C:\\x\\server.mjs --pipe ${pipe}`, pipe));
  assert.ok(!isDaemonCommandLine(`node C:\\x\\notmk42d.mjs --pipe ${pipe}`, pipe));
  assert.ok(!isDaemonCommandLine(`node C:\\x\\mk42d.mjs --pipe ${pipe}-2`, pipe), 'a pipe name that only starts like ours');
  assert.ok(!isDaemonCommandLine(`node C:\\x\\mk42d.mjs --unknown-flag --pipe ${pipe}`, pipe), 'arguments it cannot parse — leave it alone');
  // --pipe 없이 뜬 데몬: --home(없으면 기본값)에서 만든 파이프로 비교
  const home = 'C:\\Users\\u\\AppData\\Local\\Mark42';
  const derived = defaultPipeName({ USERNAME: 'u', MARK42_HOME: home });
  assert.ok(isDaemonCommandLine(`"C:\\n\\node.exe" "C:\\x y\\mk42d.mjs" --home ${home}`, derived, { USERNAME: 'u' }));
  assert.ok(!isDaemonCommandLine(`node C:\\x\\mk42d.mjs --home C:\\other`, derived, { USERNAME: 'u' }));
});

test('logon task: only the task of this home and pipe is rewritten; a test or second home never takes the user task', () => {
  const home = 'C:\\Users\\u\\AppData\\Local\\Mark42';
  const pipe = '\\\\.\\pipe\\mark42-m42d-8e7882229610';
  const mine = { args: ['C:\\repo\\daemon\\dist\\mk42d.mjs', '--boot', '--home', home, '--pipe', pipe] };
  const other = { args: ['C:\\repo\\daemon\\dist\\mk42d.mjs', '--boot', '--home', 'C:\\b\\test-home', '--pipe', '\\\\.\\pipe\\mark42-setup-test'] };
  const d = (o: Partial<Parameters<typeof decideTask>[0]>) =>
    decideTask({ noAutostart: false, fresh: false, defaultHome: true, current: undefined, home, pipe, env: {}, ...o } as Parameters<typeof decideTask>[0]);
  assert.equal(d({ current: mine }), 'update');
  assert.equal(d({ current: { args: [mine.args[0]!, '--boot', '--home', `${home.toLowerCase()}\\`, '--pipe', pipe.toUpperCase()] } }), 'update');
  assert.equal(d({ current: other }), 'leave-other');
  assert.equal(d({ current: other, fresh: true }), 'leave-other');
  assert.equal(d({ current: { args: [mine.args[0]!, '--future-flag'] } }), 'leave-other');
  assert.equal(d({ fresh: true }), 'create');
  assert.equal(d({}), 'leave-off', 'the user turned it off — keep it off');
  assert.equal(d({ fresh: true, defaultHome: false }), 'leave-off', 'a test or second home never creates the user task');
  assert.equal(d({ noAutostart: true, current: mine }), 'update', '--no-autostart still moves our own task off the old daemon');
  assert.equal(d({ noAutostart: true, fresh: true }), 'skip');
  assert.equal(d({ noAutostart: true, current: other }), 'leave-other');
});

test('isInside: below the folder only, case-insensitive on Windows, not a sibling with the same prefix', { skip: process.platform !== 'win32' }, () => {
  assert.equal(isInside('C:\\h\\Mark42\\app\\Mk42-1\\Mk42.exe', 'C:\\h\\Mark42\\app'), true);
  assert.equal(isInside('c:\\H\\mark42\\APP\\x', 'C:\\h\\Mark42\\app\\'), true);
  assert.equal(isInside('C:\\h\\Mark42\\app', 'C:\\h\\Mark42\\app'), false, 'the folder itself is not inside');
  assert.equal(isInside('C:\\h\\Mark42\\apps\\x', 'C:\\h\\Mark42\\app'), false);
  assert.equal(isInside('C:\\h\\Mark42-test\\runtime\\node.exe', 'C:\\h\\Mark42'), false);
});

test('removeInstallFromSettings: drops only apps installed under this home and its extension folder', { skip: process.platform !== 'win32' }, () => {
  const home = 'C:\\Users\\u\\AppData\\Local\\Mark42';
  const current = {
    resumeMode: 'firstRemoteApp',
    defaultAppProduct: 'mark42',
    // 코어가 모르는 키(판 덧층 설정)도 그대로 남아요
    appProductByFolder: { 'C:\\p': 'mark42' },
    extensionVsix: `${home}\\extension`,
    apps: [
      { version: '1.143.1', exe: 'C:\\Program Files\\Microsoft VS Code\\Code.exe' },
      { version: '1.143.1', product: 'mark42', exe: `${home}\\app\\Mk42-1.143.1-2aca49f\\Mk42.exe` },
      { version: '1.142.0', product: 'mark42', exe: `${home.toLowerCase()}\\APP\\Mk42-1.142.0-x\\Mk42.exe` },
    ],
  } as DaemonSettings;
  const r = removeInstallFromSettings(current, home);
  assert.deepEqual(r.settings.apps.map((a) => a.exe), ['C:\\Program Files\\Microsoft VS Code\\Code.exe']);
  assert.equal(r.settings.extensionVsix, undefined);
  assert.equal(r.settings.defaultAppProduct, undefined, 'no Mark42 app is left');
  assert.deepEqual((r.settings as unknown as Record<string, unknown>).appProductByFolder, { 'C:\\p': 'mark42' }, 'folder settings are kept');
  assert.equal(r.notes.length, 4);

  const keep = removeInstallFromSettings({ ...current, extensionVsix: 'C:\\dev\\extension\\out', apps: [...current.apps, { version: '1.143.1', product: 'mark42', exe: 'C:\\b\\VSCode-win32-x64\\Mk42.exe' }] }, home);
  assert.equal(keep.settings.extensionVsix, 'C:\\dev\\extension\\out', 'a dev extension folder is not ours');
  assert.equal(keep.settings.defaultAppProduct, 'mark42', 'a Mark42 app outside the home is left');
  assert.equal(current.apps.length, 3, 'input is not changed');
});
