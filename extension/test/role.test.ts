import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentOfRole,
  buildWindowInfo,
  canonicalLocalPath,
  canonicalTrustedHomes,
  daemonSpawnSpec,
  parseRole,
  preferRenamedDaemonEntry,
  readRoleConfig,
  readRoleConfigScoped,
  roleOfWorkspaceFile,
  type HostEnv,
  type TrustOptions,
} from '../src/lib/role.ts';

function cfg(values: Record<string, unknown>) {
  return readRoleConfig((k) => values[k]);
}

const HOME = 'C:\\Users\\u\\AppData\\Local\\Mark42';
const FID = '0123456789abcdef';
/** 순수 문자열 검사(파일 시스템 없음) */
const W: TrustOptions = { platform: 'win32', realpath: null };

const env: HostEnv = {
  workspaceFile: `${HOME}\\roles\\${FID}\\agent-claude.s1.code-workspace`,
  workspaceFolders: ['C:\\Dev\\proj'],
  pid: 4242,
  appVersion: '1.142.0',
  extensions: [{ id: 'anthropic.claude-code', version: '2.1.301' }],
};

test('parseRole accepts only known roles', () => {
  assert.equal(parseRole('hub'), 'hub');
  assert.equal(parseRole(' agent-codex '), 'agent-codex');
  assert.equal(parseRole(''), undefined);
  assert.equal(parseRole('agent'), undefined);
  assert.equal(parseRole(3), undefined);
  assert.equal(agentOfRole('agent-claude'), 'claude');
  assert.equal(agentOfRole('editor'), undefined);
});

test('readRoleConfig defaults', () => {
  const c = cfg({});
  assert.equal(c.role, undefined);
  assert.equal(c.autoSend, true);
  assert.equal(c.virtualDocPlacement, 'agentWindow');
  assert.equal(c.sender, 'osKeys');
  assert.equal(c.nodePath, 'node');
  assert.equal(cfg({ autoSend: false, sender: 'none', virtualDocPlacement: 'auxWindow' }).autoSend, false);
  assert.equal(cfg({ pipeName: '  ' }).pipeName, undefined);
});

test('unmanaged window builds no WindowInfo', () => {
  assert.equal(buildWindowInfo(cfg({}), env), undefined);
});

test('agent window info carries slot, folder, session', () => {
  const info = buildWindowInfo(cfg({ role: 'agent-claude', slotId: 's1', folderPath: 'C:\\Dev\\proj' }), env, 'sess-1');
  assert.deepEqual(info, {
    role: 'agent-claude',
    pid: 4242,
    appVersion: '1.142.0',
    extensions: [{ id: 'anthropic.claude-code', version: '2.1.301' }],
    folderPath: 'C:\\Dev\\proj',
    slotId: 's1',
    sessionId: 'sess-1',
    workspaceFile: env.workspaceFile,
  });
});

test('role workspace detection: only <trusted home>\\roles\\<dir>\\<role>[.<slot>].code-workspace', () => {
  const t = (f: string | undefined, homes: string[] = [HOME]) => roleOfWorkspaceFile(f, homes, W);
  assert.deepEqual(t(env.workspaceFile), { role: 'agent-claude', home: HOME, file: env.workspaceFile });
  assert.deepEqual(t(`${HOME}\\roles\\_hub\\hub.code-workspace`), { role: 'hub', home: HOME, file: `${HOME}\\roles\\_hub\\hub.code-workspace` });
  assert.equal(t(`${HOME}\\roles\\${FID}\\editor.code-workspace`)?.role, 'editor');
  assert.equal(t(`${HOME}\\roles\\${FID}\\agent-codex.a1b2c3d4.code-workspace`)?.role, 'agent-codex');
  assert.equal(t('C:\\repo\\project.code-workspace'), undefined);
  assert.equal(t(`${HOME}\\roles\\hub.code-workspace`), undefined, 'needs the per-folder subdirectory');
  assert.equal(t(`${HOME}\\notroles\\_hub\\hub.code-workspace`), undefined);
  assert.equal(t(undefined), undefined);
  assert.equal(t(''), undefined);
});

test('trust bypass: any repository can ship roles\\x\\hub.code-workspace — location decides, not the name', () => {
  const t = (f: string, homes: string[] = [HOME]) => roleOfWorkspaceFile(f, homes, W);
  for (const f of [
    'C:\\repo\\roles\\_hub\\hub.code-workspace',
    `C:\\repo\\roles\\${FID}\\agent-claude.s1.code-workspace`,
    `C:\\repo\\roles\\${FID}\\editor.code-workspace`,
    'D:\\src\\evil\\roles\\x\\hub.code-workspace',
    // 신뢰 home 아래라도 한 단계 더 깊으면 다른 home이에요
    `${HOME}\\sub\\roles\\_hub\\hub.code-workspace`,
    `${HOME}\\roles\\_hub\\nested\\hub.code-workspace`,
    // 신뢰 home의 부모·형제
    'C:\\Users\\u\\AppData\\Local\\roles\\_hub\\hub.code-workspace',
    'C:\\Users\\u\\AppData\\Local\\Mark42x\\roles\\_hub\\hub.code-workspace',
    'C:\\Users\\u\\AppData\\Local\\Mark4\\roles\\_hub\\hub.code-workspace',
  ]) {
    assert.equal(t(f), undefined, f);
  }
});

test('trust bypass: traversal, dot segments and doubled separators are rejected even if they resolve inside', () => {
  const t = (f: string) => roleOfWorkspaceFile(f, [HOME], W);
  for (const f of [
    'C:\\repo\\..\\Users\\u\\AppData\\Local\\Mark42\\roles\\_hub\\hub.code-workspace',
    `C:\\repo\\roles\\_hub\\..\\..\\..\\Users\\u\\AppData\\Local\\Mark42\\roles\\_hub\\hub.code-workspace`,
    `${HOME}\\roles\\_hub\\..\\_hub\\hub.code-workspace`,
    `${HOME}\\.\\roles\\_hub\\hub.code-workspace`,
    `${HOME}\\roles\\.\\_hub\\hub.code-workspace`,
    `${HOME}\\\\roles\\_hub\\hub.code-workspace`,
    `${HOME}\\roles\\_hub\\\\hub.code-workspace`,
    `${HOME}/roles/_hub/../_hub/hub.code-workspace`,
    `${HOME}\\roles\\_hub\\hub.code-workspace\\`,
    `${HOME}\\roles\\_hub\\hub.code-workspace\\.`,
  ]) {
    assert.equal(t(f), undefined, f);
  }
});

test('trust bypass: Windows name aliasing — trailing dots/spaces, ADS, 8.3 names, reserved names, control chars', () => {
  const t = (f: string) => roleOfWorkspaceFile(f, [HOME], W);
  for (const f of [
    `${HOME}\\roles\\_hub\\hub.code-workspace.`,
    `${HOME}\\roles\\_hub\\hub.code-workspace `,
    `${HOME}\\roles\\_hub\\hub.code-workspace. .`,
    `${HOME}\\roles\\_hub.\\hub.code-workspace`,
    `${HOME}\\roles \\_hub\\hub.code-workspace`,
    `${HOME}\\roles.\\_hub\\hub.code-workspace`,
    `${HOME}.\\roles\\_hub\\hub.code-workspace`,
    `${HOME} \\roles\\_hub\\hub.code-workspace`,
    `${HOME}\\roles\\_hub\\hub.code-workspace:x`,
    `${HOME}\\roles\\_hub\\hub.code-workspace::$DATA`,
    `${HOME}\\roles\\_hub:x\\hub.code-workspace`,
    `${HOME}\\ROLES~1\\_hub\\hub.code-workspace`,
    `${HOME}\\roles\\_HUB~1\\hub.code-workspace`,
    `${HOME}\\roles\\_hub\\HUB~1.COD`,
    `${HOME}\\roles\\_hub\\HUBCOD~1.COD`,
    'C:\\Users\\u\\AppData\\Local\\MARK42~1\\roles\\_hub\\hub.code-workspace',
    'C:\\Users\\u\\APPDAT~1\\Local\\Mark42\\roles\\_hub\\hub.code-workspace',
    `${HOME}\\roles\\_hub\\hub.code-workspace\u0000.txt`,
    `${HOME}\\roles\\_hub\\hub.code-workspace\n`,
    `${HOME}\\roles\\_hub\\hub*.code-workspace`,
    `${HOME}\\roles\\_hub\\hub?.code-workspace`,
    `${HOME}\\roles\\con\\editor.code-workspace`,
    `${HOME}\\roles\\${FID}\\nul`,
    // JS toLowerCase가 접지만 NTFS는 다른 이름으로 보는 글자(KELVIN SIGN, 점 있는 I)
    'C:\\Users\\u\\AppData\\Local\\Mar\u212A42\\roles\\_hub\\hub.code-workspace',
    'C:\\Users\\u\\AppData\\Local\\Mark42\\roles\\_hub\\hub.code-workspace'.replace('AppData', 'App\u0130ata'),
    `${HOME}\\roles\\_hub\\hub.code-wor\u212Aspace`,
  ]) {
    assert.equal(t(f), undefined, JSON.stringify(f));
  }
  // realpath가 그런 글자로 풀려도 거부
  const file = `${HOME}\\roles\\_hub\\hub.code-workspace`;
  const kelvinHome = 'C:\\Users\\u\\AppData\\Local\\Mar\u212A42';
  assert.equal(
    roleOfWorkspaceFile(file, [HOME], { platform: 'win32', realpath: (p) => (p === HOME ? HOME : `${kelvinHome}\\roles\\_hub\\hub.code-workspace`) }),
    undefined,
  );
});

test('trust bypass: UNC, device, long-UNC, volume GUID, relative and drive-relative paths are rejected', () => {
  const unc = '\\\\server\\share\\Mark42';
  for (const f of [
    `${unc}\\roles\\_hub\\hub.code-workspace`,
    '\\\\?\\UNC\\server\\share\\Mark42\\roles\\_hub\\hub.code-workspace',
    `\\\\.\\${HOME}\\roles\\_hub\\hub.code-workspace`,
    '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\Mark42\\roles\\_hub\\hub.code-workspace',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\Mark42\\roles\\_hub\\hub.code-workspace',
    '//server/share/Mark42/roles/_hub/hub.code-workspace',
    '\\Users\\u\\AppData\\Local\\Mark42\\roles\\_hub\\hub.code-workspace',
    'roles\\_hub\\hub.code-workspace',
    'C:Users\\u\\AppData\\Local\\Mark42\\roles\\_hub\\hub.code-workspace',
  ]) {
    assert.equal(roleOfWorkspaceFile(f, [HOME, unc, '\\\\?\\UNC\\server\\share\\Mark42'], W), undefined, f);
  }
  assert.deepEqual(canonicalTrustedHomes([unc, '\\\\.\\pipe\\x', 'relative\\home', 'C:x', 42, HOME], 'win32'), [HOME]);
});

test('role/file shape must match exactly what the daemon writes', () => {
  const t = (f: string) => roleOfWorkspaceFile(f, [HOME], W);
  assert.equal(t(`${HOME}\\roles\\${FID}\\hub.code-workspace`), undefined, 'hub lives in _hub');
  assert.equal(t(`${HOME}\\roles\\_hub\\editor.code-workspace`), undefined, 'editor lives in a folder-id dir');
  assert.equal(t(`${HOME}\\roles\\_hub\\agent-claude.s1.code-workspace`), undefined);
  assert.equal(t(`${HOME}\\roles\\abc\\editor.code-workspace`), undefined, 'folder id is 16 hex');
  assert.equal(t(`${HOME}\\roles\\${FID}0\\editor.code-workspace`), undefined);
  assert.equal(t(`${HOME}\\roles\\${FID}\\agent-claude.code-workspace`), undefined, 'agent needs a slot');
  assert.equal(t(`${HOME}\\roles\\${FID}\\editor.s1.code-workspace`), undefined, 'editor has no slot');
  assert.equal(t(`${HOME}\\roles\\_hub\\hub.s1.code-workspace`), undefined, 'hub has no slot');
  assert.equal(t(`${HOME}\\roles\\${FID}\\agent-claude.s.1.code-workspace`), undefined);
  assert.equal(t(`${HOME}\\roles\\${FID}\\agent-claude.${'x'.repeat(65)}.code-workspace`), undefined);
  assert.equal(t(`${HOME}\\roles\\${FID}\\agent.s1.code-workspace`), undefined);
  assert.equal(t(`${HOME}\\roles\\${FID}\\agent-claude.s1.code-workspace.bak`), undefined);
});

test('normalization is single-sourced: case, mixed separators and \\\\?\\ prefix map to the same trusted file', () => {
  const t = (f: string, homes: string[] = [HOME]) => roleOfWorkspaceFile(f, homes, W);
  const want = { role: 'hub', home: HOME, file: `${HOME}\\roles\\_hub\\hub.code-workspace` };
  assert.deepEqual(t('C:/Users/u/AppData/Local/Mark42/roles/_hub/hub.code-workspace'), want);
  assert.deepEqual(t('C:\\Users\\u\\AppData/Local\\Mark42/roles\\_hub/hub.code-workspace'), want);
  assert.deepEqual(t(`\\\\?\\${HOME}\\roles\\_hub\\hub.code-workspace`), want);
  assert.deepEqual(t(`c:${want.file.slice(2)}`), want, 'drive letter case');
  const lower = t('c:\\users\\U\\appdata\\local\\MARK42\\ROLES\\_HUB\\HUB.code-workspace');
  assert.equal(lower?.role, 'hub');
  assert.equal(lower?.home, 'C:\\users\\U\\appdata\\local\\MARK42', 'home comes from the same normalized path');
  // 신뢰 home 표기(끝 구분자·/·대소문자)가 달라도 같은 home
  assert.equal(t(want.file, ['c:/users/u/appdata/local/mark42/'])?.home, HOME);
  assert.equal(t(want.file, [`${HOME}\\\\`])?.home, HOME);
  assert.equal(t(want.file, [`${HOME}\\..\\Mark42`]), undefined, 'trusted home entries must be canonical too');
  assert.equal(canonicalLocalPath(`${HOME}\\`, 'win32'), undefined);
  assert.equal(canonicalLocalPath(`${HOME}\\`, 'win32', true), HOME);
  // 드라이브 루트 home
  assert.deepEqual(t('D:\\roles\\_hub\\hub.code-workspace', ['D:\\']), { role: 'hub', home: 'D:\\', file: 'D:\\roles\\_hub\\hub.code-workspace' });
});

test('POSIX: exact, case-sensitive, no traversal', () => {
  const P: TrustOptions = { platform: 'linux', realpath: null };
  const home = '/home/u/.mark42';
  const t = (f: string) => roleOfWorkspaceFile(f, [home], P);
  assert.deepEqual(t(`${home}/roles/_hub/hub.code-workspace`), { role: 'hub', home, file: `${home}/roles/_hub/hub.code-workspace` });
  assert.equal(t(`/home/u/.MARK42/roles/_hub/hub.code-workspace`), undefined);
  assert.equal(t(`/repo/roles/_hub/hub.code-workspace`), undefined);
  assert.equal(t(`${home}/roles/_hub/../_hub/hub.code-workspace`), undefined);
  assert.equal(t(`${home}//roles/_hub/hub.code-workspace`), undefined);
  assert.equal(t(`roles/_hub/hub.code-workspace`), undefined);
  assert.equal(roleOfWorkspaceFile(`/roles/_hub/hub.code-workspace`, ['/'], P)?.home, '/');
});

test('realpath must land at <real home>\\roles\\<dir>\\<file> (fake resolver)', () => {
  const file = `${HOME}\\roles\\_hub\\hub.code-workspace`;
  const map = (m: Record<string, string>) => (p: string) => {
    const r = m[p.toLowerCase()];
    if (r === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return r;
  };
  const opts = (m: Record<string, string>): TrustOptions => ({ platform: 'win32', realpath: map(m) });
  const H = HOME.toLowerCase();
  const F = file.toLowerCase();
  assert.equal(roleOfWorkspaceFile(file, [HOME], opts({ [H]: HOME, [F]: file }))?.role, 'hub');
  assert.equal(roleOfWorkspaceFile(file, [HOME], opts({ [H]: HOME, [F]: `\\\\?\\${file}` }))?.role, 'hub', '\\\\?\\ from realpath is fine');
  assert.equal(roleOfWorkspaceFile(file, [HOME], opts({ [H]: HOME, [F]: 'C:\\repo\\roles\\_hub\\hub.code-workspace' })), undefined, 'symlink out');
  assert.equal(roleOfWorkspaceFile(file, [HOME], opts({ [H]: HOME, [F]: 'C:\\repo\\x.code-workspace' })), undefined);
  assert.equal(roleOfWorkspaceFile(file, [HOME], opts({ [H]: HOME, [F]: '\\\\attacker\\share\\hub.code-workspace' })), undefined);
  assert.equal(roleOfWorkspaceFile(file, [HOME], opts({ [H]: HOME })), undefined, 'missing file');
  assert.equal(roleOfWorkspaceFile(file, [HOME], opts({ [F]: file })), undefined, 'home cannot be resolved');
  // home 자체가 정션이면 같이 풀려서 일관돼요
  assert.equal(roleOfWorkspaceFile(file, [HOME], opts({ [H]: 'E:\\Real\\M42', [F]: 'E:\\Real\\M42\\roles\\_hub\\hub.code-workspace' }))?.role, 'hub');
  // 8.3 이름이 풀린 실제 경로도 같은 곳이면 통과
  assert.equal(roleOfWorkspaceFile(file, [HOME], opts({ [H]: 'C:\\Users\\LongUserName\\AppData\\Local\\Mark42', [F]: 'C:\\Users\\LongUserName\\AppData\\Local\\Mark42\\roles\\_hub\\HUB.code-workspace' }))?.role, 'hub');
});

test('realpath on the real file system: junction/symlink escapes are rejected', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'm42-role-'));
  try {
    const home = join(root, 'home');
    const hubDir = join(home, 'roles', '_hub');
    mkdirSync(hubDir, { recursive: true });
    const hubFile = join(hubDir, 'hub.code-workspace');
    writeFileSync(hubFile, '{}');
    assert.equal(roleOfWorkspaceFile(hubFile, [home])?.role, 'hub', 'real file under the real home');
    assert.equal(roleOfWorkspaceFile(join(hubDir, 'missing.code-workspace'), [home]), undefined);
    assert.equal(roleOfWorkspaceFile(join(home, 'roles', '_hub', 'editor.code-workspace'), [home]), undefined);

    // roles\<FID> 가 바깥(저장소) 폴더로 가는 정션/심볼릭 링크
    const outside = join(root, 'repo', 'payload');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'editor.code-workspace'), '{}');
    const link = join(home, 'roles', FID);
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      t.diagnostic(`junction not available: ${String(e)}`);
      return;
    }
    assert.equal(roleOfWorkspaceFile(join(link, 'editor.code-workspace'), [home]), undefined, 'junction escape');

    // home 전체를 가리키는 정션을 신뢰 home으로 주면 일관되게 통과
    const homeLink = join(root, 'homelink');
    symlinkSync(home, homeLink, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(roleOfWorkspaceFile(join(homeLink, 'roles', '_hub', 'hub.code-workspace'), [homeLink])?.role, 'hub');
    // 신뢰하지 않은 경로의 정션이 진짜 home을 가리켜도, 문자열 위치가 신뢰 home이 아니면 거부
    assert.equal(roleOfWorkspaceFile(join(homeLink, 'roles', '_hub', 'hub.code-workspace'), [home]), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scoped config: role keys only from a matching role workspace; daemon paths only from user settings', () => {
  const scoped = (ws: Record<string, unknown>, global: Record<string, unknown>, file: string | undefined) =>
    readRoleConfigScoped(
      (k) => ({ workspaceValue: ws[k], globalValue: global[k] }),
      (k) => ws[k] ?? global[k],
      file,
      { ...W, defaultHome: HOME },
    );
  const repo = { role: 'hub', pipeName: '\\\\.\\pipe\\nonexistent', daemonPath: '\\\\attacker@SSL\\dav\\x.js', nodePath: 'C:\\evil\\node.exe' };
  // 폴더 창(.vscode/settings.json)은 workspaceValue로 보여도 받지 않아요
  const folder = scoped(repo, {}, undefined);
  assert.equal(folder.role, undefined);
  assert.equal(folder.pipeName, undefined);
  assert.equal(folder.daemonPath, undefined);
  assert.equal(folder.nodePath, 'node');
  // 이름은 역할 워크스페이스지만 역할 값이 다르면 무시
  assert.equal(scoped({ role: 'hub' }, {}, env.workspaceFile).role, undefined);
  // 데몬이 만든 역할 워크스페이스
  const ok = scoped(
    { role: 'agent-claude', slotId: 's1', folderPath: 'C:\\Dev\\proj', pipeName: '\\\\.\\pipe\\custom', daemonPath: 'C:\\ws\\x.js' },
    { daemonPath: 'C:\\m42\\daemon\\main.ts' },
    env.workspaceFile,
  );
  assert.equal(ok.role, 'agent-claude');
  assert.equal(ok.slotId, 's1');
  assert.equal(ok.pipeName, '\\\\.\\pipe\\custom');
  assert.equal(ok.daemonPath, 'C:\\m42\\daemon\\main.ts', 'workspace daemonPath is ignored');
  assert.equal(ok.home, HOME, 'trusted role workspace exposes its home');
  assert.equal(folder.home, undefined);
  assert.equal(scoped({}, { pipeName: '\\\\.\\pipe\\user' }, undefined).pipeName, '\\\\.\\pipe\\user');
  // 저장소의 roles\x\hub.code-workspace는 이름이 맞아도 신뢰하지 않아요
  const fake = scoped({ role: 'hub', pipeName: '\\\\.\\pipe\\evil' }, {}, 'C:\\repo\\roles\\_hub\\hub.code-workspace');
  assert.equal(fake.role, undefined);
  assert.equal(fake.pipeName, undefined);
  assert.equal(fake.home, undefined);
});

test('scoped config: mark42.trustedHomes counts only from user (global) settings', () => {
  const file = 'D:\\m42\\roles\\_hub\\hub.code-workspace';
  const read = (ws: Record<string, unknown>, global: Record<string, unknown>) =>
    readRoleConfigScoped(
      (k) => ({ workspaceValue: ws[k], globalValue: global[k], workspaceFolderValue: ws[k] }),
      (k) => ws[k] ?? global[k],
      file,
      { ...W, defaultHome: HOME },
    );
  // 워크스페이스(=저장소)가 자기 자신을 신뢰 home으로 올리지 못해요
  const self = read({ role: 'hub', trustedHomes: ['D:\\m42'] }, {});
  assert.equal(self.role, undefined);
  const user = read({ role: 'hub' }, { trustedHomes: ['D:\\m42'] });
  assert.equal(user.role, 'hub');
  assert.equal(user.home, 'D:\\m42');
  assert.equal(read({ role: 'hub' }, { trustedHomes: 'D:\\m42' }).role, undefined, 'must be an array');
  assert.equal(read({ role: 'hub' }, { trustedHomes: ['\\\\srv\\m42'] }).role, undefined);
});

test('daemon spawn spec: hub only, absolute local paths, default pipe only', () => {
  const base = cfg({ role: 'hub', daemonPath: 'C:\\m42\\daemon\\src\\main.ts' });
  assert.deepEqual(daemonSpawnSpec(base, '\\\\.\\pipe\\d'), { nodePath: 'node', entry: 'C:\\m42\\daemon\\src\\main.ts' });
  assert.equal(daemonSpawnSpec(cfg({ role: 'editor', daemonPath: 'C:\\x.js' }), 'p'), undefined);
  assert.equal(daemonSpawnSpec(cfg({ role: 'hub' }), 'p'), undefined);
  const skip = (c: ReturnType<typeof cfg>) => {
    const r = daemonSpawnSpec(c, '\\\\.\\pipe\\d');
    return r !== undefined && 'skip' in r;
  };
  assert.ok(skip(cfg({ role: 'hub', daemonPath: '\\\\host@SSL\\dav\\x.js' })), 'UNC/WebDAV');
  assert.ok(skip(cfg({ role: 'hub', daemonPath: 'daemon\\main.ts' })), 'relative');
  assert.ok(skip(cfg({ role: 'hub', daemonPath: 'C:\\m42\\evil.exe' })), 'not a script');
  assert.ok(skip(cfg({ role: 'hub', daemonPath: 'C:\\x.js', nodePath: '\\\\host\\node.exe' })));
  assert.ok(skip(cfg({ role: 'hub', daemonPath: 'C:\\x.js', nodePath: '.\\node.exe' })));
  assert.ok(skip(cfg({ role: 'hub', daemonPath: 'C:\\x.js', pipeName: '\\\\.\\pipe\\custom' })), 'custom pipe');
  assert.ok(!skip(cfg({ role: 'hub', daemonPath: 'C:\\x.js', pipeName: '\\\\.\\PIPE\\D' })), 'default pipe written explicitly');
  assert.ok(!skip(cfg({ role: 'hub', daemonPath: 'C:\\x.js', nodePath: 'C:\\Program Files\\nodejs\\node.exe' })));
});

test('daemon entry: old m42d bundle path prefers the renamed mk42d bundle next to it (D41)', () => {
  const has = (...files: string[]) => (p: string) => files.includes(p);
  const old = 'C:\\src\\mark42\\daemon\\dist\\m42d.mjs';
  const renamed = 'C:\\src\\mark42\\daemon\\dist\\mk42d.mjs';
  assert.equal(preferRenamedDaemonEntry(old, has(old, renamed)), renamed, 'stale old bundle left by an earlier build');
  assert.equal(preferRenamedDaemonEntry(old, has(old)), old, 'not rebuilt yet');
  assert.equal(preferRenamedDaemonEntry('D:/x/M42D.MJS', has('D:/x/mk42d.MJS')), 'D:/x/mk42d.MJS');
  assert.equal(preferRenamedDaemonEntry(renamed, () => true), renamed);
  assert.equal(preferRenamedDaemonEntry('C:\\src\\daemon\\src\\main.ts', () => true), 'C:\\src\\daemon\\src\\main.ts');
  assert.equal(preferRenamedDaemonEntry('C:\\x\\notm42d.mjs', () => true), 'C:\\x\\notm42d.mjs');
});

test('folderPath falls back to first workspace folder; hub has none', () => {
  assert.equal(buildWindowInfo(cfg({ role: 'editor' }), env)?.folderPath, 'C:\\Dev\\proj');
  const hub = buildWindowInfo(cfg({ role: 'hub', slotId: 'x', folderPath: 'C:\\x' }), env, 'sess');
  assert.equal(hub?.folderPath, undefined);
  assert.equal(hub?.slotId, undefined);
  assert.equal(hub?.sessionId, undefined);
});
