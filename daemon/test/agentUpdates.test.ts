import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentExtensionUpdater, AGENT_EXTENSION_SOURCES, type AgentExtensionSource, type ExtensionVerifier } from '../src/agentUpdates.ts';
import { compareTrees, hashTree, stageInstallAndHash } from '../src/extVerify.ts';
import { ExtensionInstaller, newestInstalledVersion, type EnsureRequest, type RunFn } from '../src/extensions.ts';
import { AppLauncher, CLAUDE_EXTENSION_ID, CODEX_EXTENSION_ID, type DiscoveredInstall } from '../src/launcher.ts';
import { engineAccepts, latestOpenVsxVersion, type FetchFn } from '../src/gallery.ts';
import { emptyRegistry, type DaemonSettings } from '../src/registry.ts';
import { tempDir } from './helpers.ts';

function fakeApp(dir: string): string {
  const exe = join(dir, 'Mk42.exe');
  writeFileSync(exe, '');
  mkdirSync(join(dir, 'resources', 'app', 'out'), { recursive: true });
  writeFileSync(join(dir, 'resources', 'app', 'out', 'cli.js'), '');
  return exe;
}

test('agent updates: newest installed version reads <id>-<version>[-platform] folders and skips .obsolete ones', async () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.equal(await newestInstalledVersion(join(dir, 'none'), CLAUDE_EXTENSION_ID), undefined);
    mkdirSync(join(dir, 'anthropic.claude-code-2.1.311-win32-x64'));
    mkdirSync(join(dir, 'anthropic.claude-code-2.1.312-win32-x64'));
    mkdirSync(join(dir, 'anthropic.claude-code-2.1.9-win32-x64'));
    mkdirSync(join(dir, 'openai.chatgpt-26.1021.22027'));
    mkdirSync(join(dir, 'openai.codex-audio-26.1021.22027-universal'));
    assert.equal(await newestInstalledVersion(dir, CLAUDE_EXTENSION_ID), '2.1.312');
    assert.equal(await newestInstalledVersion(dir, CODEX_EXTENSION_ID), '26.1021.22027');
    writeFileSync(join(dir, '.obsolete'), JSON.stringify({ 'anthropic.claude-code-2.1.312-win32-x64': true }));
    assert.equal(await newestInstalledVersion(dir, CLAUDE_EXTENSION_ID), '2.1.311', 'a version being removed does not count');
  } finally {
    cleanup();
  }
});

test('agent updates: installer installs only when the folder is behind, waits for a running ensure, verifies the result', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const exe = fakeApp(dir);
    const ext = join(dir, 'ext');
    mkdirSync(join(ext, 'openai.chatgpt-26.1021.22027'), { recursive: true });
    const order: string[] = [];
    let installVersion: string | undefined = '26.1101.1';
    const run: RunFn = async (_c, args) => {
      const arg = args[args.indexOf('--install-extension') + 1]!;
      order.push(`run ${arg}`);
      await new Promise((r) => setTimeout(r, 20));
      if (!arg.endsWith('.vsix')) mkdirSync(join(ext, `${arg}-1.0.0`), { recursive: true });
      else if (installVersion) mkdirSync(join(ext, `openai.chatgpt-${installVersion}`), { recursive: true });
      return { code: 0, output: '' };
    };
    const installer = new ExtensionInstaller({ ids: ['ms-ceintl.vscode-language-pack-ko'], run, env: {} });
    const req: EnsureRequest = { exe, userDataDir: join(dir, 'ud'), extensionsDir: ext };

    let prepared = 0;
    const current = await installer.updateExtension(req, CODEX_EXTENSION_ID, '26.1021.22027', async () => (prepared++, 'x.vsix'));
    assert.deepEqual(current, { status: 'current', installed: '26.1021.22027' });
    assert.equal(prepared, 0, 'up to date: nothing downloaded');

    // an ensure (missing language pack) already running for the same folder goes first
    const [, updated] = await Promise.all([
      installer.ensure(req),
      installer.updateExtension(req, CODEX_EXTENSION_ID, '26.1101.1', async () => (order.push('prepare'), 'new.vsix')),
    ]);
    // (the download may finish before or after the ensure's CLI run starts — it is outside the queue)
    assert.ok(order.includes('prepare'));
    assert.deepEqual(order.filter((o) => o !== 'prepare'), ['run ms-ceintl.vscode-language-pack-ko', 'run new.vsix'], 'the download runs outside the queue, CLI installs one at a time per folder');
    assert.deepEqual(updated, { status: 'updated', installed: '26.1101.1', previous: '26.1021.22027' });

    installVersion = undefined; // the CLI "succeeds" but nothing new appears
    const failed = await installer.updateExtension(req, CODEX_EXTENSION_ID, '26.1200.1', async () => 'newer.vsix');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.installed, '26.1101.1');
    const noSource = await installer.updateExtension(req, CODEX_EXTENSION_ID, '26.1200.1', async () => {
      throw new Error('HTTP 503');
    });
    assert.equal(noSource.status, 'failed');
    assert.match(noSource.error ?? '', /HTTP 503/);
  } finally {
    cleanup();
  }
});

test('agent updates: Open VSX latest is the platform release, never a pre-release', async () => {
  const reply = (body: unknown, ok = true): FetchFn => async (url) => {
    assert.equal(url, 'https://open-vsx.org/api/anthropic/claude-code/win32-x64');
    return { ok, status: ok ? 200 : 503, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  assert.equal(await latestOpenVsxVersion(CLAUDE_EXTENSION_ID, 'win32-x64', reply({ version: '2.1.314', preRelease: false })), '2.1.314');
  assert.equal(await latestOpenVsxVersion(CLAUDE_EXTENSION_ID, 'win32-x64', reply({ version: '2.2.0', preRelease: true })), undefined, 'a pre-release is no new release');
  await assert.rejects(latestOpenVsxVersion(CLAUDE_EXTENSION_ID, 'win32-x64', reply({}, false)), /HTTP 503/);
  await assert.rejects(latestOpenVsxVersion('bad id', 'win32-x64', reply({})), /bad extension id/);
});

test('agent updates: launcher gives the Mk42 extension folder as the target, nothing without Mk42 or with installs off', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    const settings: DaemonSettings = { ...emptyRegistry().settings };
    const installs: DiscoveredInstall[] = [{ version: '1', exe: 'C:\\A\\Code.exe', source: 'official' }];
    const launcher = new AppLauncher({ home, env: {}, getSettings: () => settings, discover: async () => installs, spawn: async () => ({}) });
    assert.equal(await launcher.mark42ExtensionTarget(), undefined, 'no Mk42 app');
    installs.push({ version: '1', exe: 'C:\\M\\Mk42.exe', source: 'registry', product: 'mark42', userDataDir: join(home, 'mk42', 'user-data'), extensionsDir: join(home, 'mk42', 'ext') });
    assert.deepEqual(await launcher.mark42ExtensionTarget(), {
      exe: 'C:\\M\\Mk42.exe',
      userDataDir: join(home, 'mk42', 'user-data'),
      extensionsDir: join(home, 'mk42', 'ext'),
      sharedDataDir: `${join(home, 'mk42', 'user-data')}-shared`,
      agentPluginsDir: `${join(home, 'mk42', 'user-data')}-agent-plugins`,
      appVersion: '1',
    });
    settings.installExtensions = false;
    assert.equal(await launcher.mark42ExtensionTarget(), undefined);
  } finally {
    cleanup();
  }
});

// ---- verification (2026-10-30): Open VSX builds are compared with the Marketplace build fetched by the official VS Code ----

interface Harness {
  downloads: number;
  dir: string;
  ext: string;
  updater: AgentExtensionUpdater;
  installs: { id: string; latest: string; arg: string }[];
  notified: string[][];
  files: Map<string, string>;
  cleanup: () => void;
}

/** Claude(검증) + Codex(검증 없이 믿는 출처, verify=false) 공급원, 가짜 검증기·설치기 */
function harness(o: {
  claudeLatest?: string;
  codexLatest?: string;
  reference?: (id: string, v: string) => Record<string, string> | undefined;
  candidate?: Record<string, string>;
  candidateVersion?: string;
  candidateId?: string;
  candidateThrows?: boolean;
  /** 살펴본 직후 파일 바이트를 바꿔요(바꿔치기) */
  tamperAfterInspect?: boolean;
  installed?: Record<string, string>;
  installFails?: boolean;
}): Harness {
  const t = tempDir();
  const dir = t.dir;
  const ext = join(dir, 'ext');
  mkdirSync(join(ext, `${CLAUDE_EXTENSION_ID}-2.1.312-win32-x64`), { recursive: true });
  mkdirSync(join(ext, `${CODEX_EXTENSION_ID}-26.1021.22027`), { recursive: true });
  const files = new Map<string, string>();
  let h: Harness;
  const download = (tag: string) => async (version: string, cacheDir: string) => {
    mkdirSync(cacheDir, { recursive: true });
    const f = join(cacheDir, `${tag}-${version}.vsix`);
    writeFileSync(f, 'PK');
    files.set(tag, f);
    h.downloads++;
    return f;
  };
  const sources: AgentExtensionSource[] = [
    { id: CLAUDE_EXTENSION_ID, verify: true, latest: async () => o.claudeLatest ?? '2.1.314', download: download('claude') },
    { id: CODEX_EXTENSION_ID, verify: false, latest: async () => o.codexLatest ?? '26.1021.22027', download: download('codex') },
  ];
  const verifier: ExtensionVerifier = {
    reference: async (id, v) => {
      const r = o.reference?.(id, v);
      if (!r) throw new Error('not on the Marketplace yet');
      return r;
    },
    candidate: async (_id, vsix) => {
      if (o.candidateThrows) throw new Error('engine not compatible');
      files.set('inspected', vsix);
      if (o.tamperAfterInspect) writeFileSync(vsix, 'PK-EVIL');
      return { id: o.candidateId ?? CLAUDE_EXTENSION_ID, version: o.candidateVersion ?? o.claudeLatest ?? '2.1.314', files: o.candidate ?? { 'a.js': 'h1' } };
    },
    installed: async () => o.installed ?? { 'a.js': 'h0' },
  };
  const installs: Harness['installs'] = [];
  const notified: string[][] = [];
  const updater = new AgentExtensionUpdater({
    home: dir,
    target: async () => ({ exe: 'C:\\M\\Mk42.exe', userDataDir: join(dir, 'ud'), extensionsDir: ext, appVersion: '1.143.1' }),
    sources,
    verifier,
    onUpdated: (ids) => notified.push(ids),
    installer: {
      updateExtension: async (_req, id, latest, installArg) => {
        let arg: string;
        try {
          arg = await installArg();
        } catch (e) {
          return { status: 'failed', error: (e as Error).message };
        }
        installs.push({ id, latest, arg });
        if (o.installFails) return { status: 'failed', error: 'cli failed' };
        mkdirSync(join(ext, `${id}-${latest}`), { recursive: true });
        return { status: 'updated', installed: latest };
      },
    },
  });
  h = { downloads: 0, dir, ext, updater, installs, notified, files, cleanup: t.cleanup };
  return h;
}

test('verify: an Open VSX build that matches the Marketplace build is installed from that very file, then deleted', async () => {
  const h = harness({ reference: () => ({ 'a.js': 'h1' }) });
  try {
    const r = await h.updater.check({ ids: [CLAUDE_EXTENSION_ID], manual: true });
    assert.equal(r.length, 1, 'a Claude window checks only Claude');
    assert.deepEqual(
      { status: r[0]!.status, verification: r[0]!.verification, installed: r[0]!.installed },
      { status: 'updated', verification: 'verified', installed: '2.1.314' },
    );
    assert.deepEqual(h.installs, [{ id: CLAUDE_EXTENSION_ID, latest: '2.1.314', arg: h.files.get('inspected') }], 'the inspected file itself');
    assert.match(h.files.get('inspected')!, /claude-2\.1\.314-.+\.vsix$/, 'a per-check name, not the shared download name');
    assert.ok(!existsSync(h.files.get('inspected')!), 'the VSIX does not stay');
    assert.deepEqual(h.notified, [[CLAUDE_EXTENSION_ID]]);
    assert.equal(h.updater.status([CLAUDE_EXTENSION_ID])[0]!.installedVerification, 'verified');
  } finally {
    h.cleanup();
  }
});

test('verify: no Marketplace build to compare with → not installed, waits for the user; only that version can be approved', async () => {
  const h = harness({ claudeLatest: '2.1.315' });
  try {
    const [u] = await h.updater.check({ ids: [CLAUDE_EXTENSION_ID] });
    assert.equal(u!.status, 'pending');
    assert.equal(u!.verification, 'unverified');
    assert.equal(u!.pending, '2.1.315');
    assert.match(u!.reason ?? '', /no official build hashes/);
    assert.equal(h.installs.length, 0, 'nothing installed without consent');
    const before = h.files.get('inspected')!;
    assert.ok(existsSync(before), 'the file waits for approval');
    // 다시 확인해도 다시 받지 않아요(기준만 다시 찾아요)
    await h.updater.check({ ids: [CLAUDE_EXTENSION_ID] });
    await h.updater.check({ ids: [CLAUDE_EXTENSION_ID], manual: true });
    assert.equal(h.downloads, 1);
    await assert.rejects(h.updater.installUnverified(CLAUDE_EXTENSION_ID, '2.1.316'), /not waiting/);
    const done = await h.updater.installUnverified(CLAUDE_EXTENSION_ID, '2.1.315');
    assert.deepEqual({ status: done.status, installedVerification: done.installedVerification }, { status: 'updated', installedVerification: 'unverified' });
    assert.equal(h.installs.at(-1)!.arg, before, 'the same file that was inspected');
    assert.ok(!existsSync(before!));
    await assert.rejects(h.updater.installUnverified(CLAUDE_EXTENSION_ID, '2.1.315'), /not waiting/, 'one approval, one install');
  } finally {
    h.cleanup();
  }
});

test('verify: an Open VSX build that differs from the Marketplace build is blocked, deleted and cannot be approved', async () => {
  const h = harness({ claudeLatest: '2.1.313', reference: () => ({ 'a.js': 'h1', 'b.js': 'h2' }), candidate: { 'a.js': 'EVIL', 'c.js': 'h3' } });
  try {
    const [u] = await h.updater.check({ ids: [CLAUDE_EXTENSION_ID], manual: true });
    assert.equal(u!.status, 'blocked');
    assert.equal(u!.verification, 'mismatch');
    assert.match(u!.reason ?? '', /1 differ, 1 missing, 1 extra/);
    assert.equal(h.installs.length, 0);
    assert.ok(!existsSync(h.files.get('inspected')!));
    await assert.rejects(h.updater.installUnverified(CLAUDE_EXTENSION_ID, '2.1.313'), /not waiting/);
    // 정해진 확인은 같은 버전을 다시 받지 않아요
    const [again] = await h.updater.check({ ids: [CLAUDE_EXTENSION_ID] });
    assert.equal(again!.status, 'blocked');
    assert.equal(h.downloads, 1, 'not downloaded again');
  } finally {
    h.cleanup();
  }
});

test('verify: an Open VSX file that claims another version is a mismatch', async () => {
  const h = harness({ reference: () => ({ 'a.js': 'h1' }), candidateVersion: '2.1.999' });
  try {
    const [u] = await h.updater.check({ ids: [CLAUDE_EXTENSION_ID], manual: true });
    assert.equal(u!.status, 'blocked');
    assert.match(u!.reason ?? '', /is anthropic\.claude-code 2\.1\.999, not anthropic\.claude-code 2\.1\.314/);
  } finally {
    h.cleanup();
  }
});

test('verify: a trusted source (verify=false) installs as is; the installed Claude copy is checked once per version', async () => {
  let refs = 0;
  const h = harness({
    claudeLatest: '2.1.312',
    codexLatest: '26.1101.1',
    reference: (_id, v) => (refs++, v === '2.1.312' ? { 'a.js': 'h0' } : undefined),
    installed: { 'a.js': 'h0' },
  });
  try {
    const r = await h.updater.check({ manual: true });
    const claude = r.find((u) => u.id === CLAUDE_EXTENSION_ID)!;
    const codex = r.find((u) => u.id === CODEX_EXTENSION_ID)!;
    assert.deepEqual({ status: claude.status, installedVerification: claude.installedVerification }, { status: 'current', installedVerification: 'verified' });
    assert.deepEqual({ status: codex.status, verification: codex.verification }, { status: 'updated', verification: 'marketplace' });
    const n = refs;
    await h.updater.check();
    assert.equal(refs, n, 'the installed copy is not re-hashed every check');
  } finally {
    h.cleanup();
  }
});

test('verify: tree hashing ignores the installer metadata in package.json, compareTrees names the differences', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    for (const [root, ts] of [[a, 1], [b, 2]] as const) {
      mkdirSync(join(root, 'dist'), { recursive: true });
      writeFileSync(join(root, 'dist', 'x.js'), 'same');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'n', version: '1.0.0', __metadata: { installedTimestamp: ts } }));
    }
    const ha = await hashTree(a);
    const hb = await hashTree(b);
    assert.deepEqual(Object.keys(ha).sort(), ['dist/x.js', 'package.json']);
    assert.deepEqual(compareTrees(ha, hb), { same: true });
    writeFileSync(join(b, 'dist', 'x.js'), 'changed');
    writeFileSync(join(b, 'evil.js'), 'x');
    const cmp = compareTrees(ha, await hashTree(b));
    assert.deepEqual(cmp, { same: false, differ: ['dist/x.js'], missing: [], extra: ['evil.js'] });
  } finally {
    cleanup();
  }
});

test('verify: while waiting for approval, every check looks for the Marketplace build again — a later mismatch blocks it, a match installs it', async () => {
  let ref: Record<string, string> | undefined;
  const h = harness({ claudeLatest: '2.1.315', reference: () => ref, candidate: { 'a.js': 'EVIL' } });
  try {
    assert.equal((await h.updater.check({ ids: [CLAUDE_EXTENSION_ID] }))[0]!.status, 'pending');
    ref = { 'a.js': 'h1' }; // the real 2.1.315 reached the Marketplace — and it differs
    const [u] = await h.updater.check({ ids: [CLAUDE_EXTENSION_ID] });
    assert.equal(u!.status, 'blocked', 'a timed check is enough');
    assert.equal(h.installs.length, 0);
    await assert.rejects(h.updater.installUnverified(CLAUDE_EXTENSION_ID, '2.1.315'), /not waiting/);
  } finally {
    h.cleanup();
  }
  let ref2: Record<string, string> | undefined;
  const g = harness({ claudeLatest: '2.1.315', reference: () => ref2, candidate: { 'a.js': 'h1' } });
  try {
    await g.updater.check({ ids: [CLAUDE_EXTENSION_ID] });
    ref2 = { 'a.js': 'h1' };
    // the user approves just as the Marketplace build appears: it is installed as VERIFIED
    const u = await g.updater.installUnverified(CLAUDE_EXTENSION_ID, '2.1.315');
    assert.deepEqual({ status: u.status, verification: u.verification, installedVerification: u.installedVerification }, { status: 'updated', verification: 'verified', installedVerification: 'verified' });
  } finally {
    g.cleanup();
  }
  let ref3: Record<string, string> | undefined;
  const k = harness({ claudeLatest: '2.1.315', reference: () => ref3, candidate: { 'a.js': 'EVIL' } });
  try {
    await k.updater.check({ ids: [CLAUDE_EXTENSION_ID] });
    ref3 = { 'a.js': 'h1' };
    await assert.rejects(k.updater.installUnverified(CLAUDE_EXTENSION_ID, '2.1.315'), /differs from the official build/, 'approval refused once it can be compared');
    assert.equal(k.installs.length, 0);
  } finally {
    k.cleanup();
  }
});

test('verify: a file whose bytes change after inspection is not installed', async () => {
  const h = harness({ reference: () => ({ 'a.js': 'h1' }), tamperAfterInspect: true });
  try {
    const [u] = await h.updater.check({ ids: [CLAUDE_EXTENSION_ID], manual: true });
    assert.equal(u!.status, 'failed');
    assert.match(u!.error ?? '', /changed after it was checked/);
    assert.equal(h.installs.length, 0);
  } finally {
    h.cleanup();
  }
});

test('verify: a build that cannot even be inspected is a failure, never something to approve', async () => {
  const h = harness({ claudeLatest: '2.1.315', candidateThrows: true });
  try {
    const [u] = await h.updater.check({ ids: [CLAUDE_EXTENSION_ID], manual: true });
    assert.equal(u!.status, 'failed');
    assert.match(u!.error ?? '', /could not be inspected/);
    await assert.rejects(h.updater.installUnverified(CLAUDE_EXTENSION_ID, '2.1.315'), /not waiting/);
    const other = harness({ claudeLatest: '2.1.315', candidateId: 'evil.claude-code', reference: () => undefined });
    try {
      assert.equal((await other.updater.check({ ids: [CLAUDE_EXTENSION_ID] }))[0]!.status, 'blocked', 'another extension id inside is blocked');
    } finally {
      other.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test('verify: timed checks do not retry a version that failed; manual checks do; one check at a time per extension', async () => {
  const h = harness({ reference: () => ({ 'a.js': 'h1' }), installFails: true });
  try {
    const [a] = await h.updater.check({ ids: [CLAUDE_EXTENSION_ID] });
    assert.equal(a!.status, 'failed');
    await h.updater.check({ ids: [CLAUDE_EXTENSION_ID] });
    assert.equal(h.downloads, 1, 'timed: not downloaded again');
    await h.updater.check({ ids: [CLAUDE_EXTENSION_ID], manual: true });
    assert.equal(h.downloads, 2, 'manual: retried');
    // a timed and a manual check at once never interleave on the same extension
    const [x, y] = await Promise.all([h.updater.check({ manual: true }), h.updater.check({ ids: [CLAUDE_EXTENSION_ID], manual: true })]);
    assert.ok(x && y);
    assert.equal(h.downloads, 4, 'each ran its own full pass, one after the other');
  } finally {
    h.cleanup();
  }
});

test('verify: leftovers of an earlier run (downloads, staging folders) are swept at start', async () => {
  const h = harness({});
  try {
    mkdirSync(join(h.dir, 'cache', 'vsix'), { recursive: true });
    writeFileSync(join(h.dir, 'cache', 'vsix', 'openvsx-x-1.0.0-win32-x64-1.vsix'), 'PK');
    writeFileSync(join(h.dir, 'cache', 'vsix', 'x.vsix.123.tmp'), 'PK');
    mkdirSync(join(h.dir, 'verify', 'stage-1-abc', 'ext'), { recursive: true });
    writeFileSync(join(h.dir, 'verify', 'anthropic.claude-code-2.1.314-win32-x64.json'), '{}');
    h.updater.start();
    await new Promise((r) => setTimeout(r, 50));
    h.updater.close();
    assert.deepEqual(readdirSync(join(h.dir, 'cache', 'vsix')), []);
    assert.deepEqual(readdirSync(join(h.dir, 'verify')), ['anthropic.claude-code-2.1.314-win32-x64.json'], 'reference store kept');
  } finally {
    h.cleanup();
  }
});

test('verify: a launch never installs a missing Claude Code from Open VSX directly — it asks the verified updater', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    const settings: DaemonSettings = { ...emptyRegistry().settings };
    const ensured: EnsureRequest[] = [];
    const missing: string[] = [];
    const ext = join(home, 'mk42', 'ext');
    mkdirSync(ext, { recursive: true });
    const launcher = new AppLauncher({
      home,
      env: {},
      getSettings: () => settings,
      discover: async () => [{ version: '1', exe: 'C:\\M\\Mk42.exe', source: 'registry', product: 'mark42', userDataDir: join(home, 'mk42', 'ud'), extensionsDir: ext }],
      spawn: async () => ({}),
      extensions: { ensure: async (r) => void ensured.push(r), ensureVsix: async () => false },
      onVerifiedExtensionMissing: (id) => missing.push(id),
      uiLanguage: async () => 'en',
    });
    await launcher.launch({ workspaceFile: 'C:\\w', role: 'editor', appProduct: 'mark42' });
    await new Promise((r) => setTimeout(r, 20));
    // 공개판: 두 에이전트 확장 모두 검증 경로 — 갤러리 ID로 바로 깔지 않아요(덧층 사이드로드는 mark42App 시험)
    assert.equal(ensured.length, 0, 'no direct gallery install');
    assert.deepEqual(missing, [CLAUDE_EXTENSION_ID, CODEX_EXTENSION_ID]);
  } finally {
    cleanup();
  }
});

test('agent updates: nothing installed and no release that runs on this app → failed, never «current»', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const ext = join(dir, 'ext');
    mkdirSync(ext, { recursive: true });
    const u = new AgentExtensionUpdater({
      home: dir,
      target: async () => ({ exe: fakeApp(dir), userDataDir: join(dir, 'ud'), extensionsDir: ext, appVersion: '1.143.1' }),
      installer: { updateExtension: async () => ({ status: 'failed', error: 'should not install' }) },
      sources: [{ id: CLAUDE_EXTENSION_ID, verify: true, latest: async () => undefined, download: async () => 'x' }],
      firstDelayMs: 60_000,
    });
    const [r] = await u.check({ ids: [CLAUDE_EXTENSION_ID] });
    assert.equal(r!.status, 'failed');
    assert.match(r!.error ?? '', /no release that runs on this app \(1\.143\.1\)/);
    u.close();
  } finally {
    cleanup();
  }
});
