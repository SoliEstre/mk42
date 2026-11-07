// Mark42 패치 빌드(Mk42.exe) — 앱 고르기(같은 버전 번호의 다른 앱과 구별), Mk42 확장(갤러리 + 덧층 사이드로드)
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExtensionInstaller, type EnsureRequest, type RunFn } from '../src/extensions.ts';
import { AppLauncher, type DiscoveredInstall } from '../src/launcher.ts';
import { emptyRegistry, type DaemonSettings } from '../src/registry.ts';
import { tempDir } from './helpers.ts';

const CODE: DiscoveredInstall = { version: '1.143.1', exe: 'C:\\VSC\\Code.exe', source: 'official' };
let MK42: DiscoveredInstall;
function mk42In(home: string): DiscoveredInstall {
  MK42 = {
    version: '1.143.1',
    exe: 'C:\\Mk42\\Mk42.exe',
    product: 'mark42',
    source: 'registry',
    userDataDir: join(home, '.mk42', 'user-data'),
    extensionsDir: join(home, '.mk42', 'extensions'),
  };
  return MK42;
}

function launcherWith(settings: DaemonSettings, home: string, calls: { exe: string; args: string[] }[], ensured: EnsureRequest[] = []) {
  return new AppLauncher({
    home,
    getSettings: () => settings,
    discover: async () => [mk42In(home), CODE],
    spawn: async (exe, args) => {
      calls.push({ exe, args });
      return { pid: 1 };
    },
    extensions: { ensure: async (r) => void ensured.push(r), ensureVsix: async () => false },
    // 판 덧층이 사이드로드 공급원을 줄 때 — 덧층이 없으면 두 확장 모두 검증 경로(agentUpdates)
    overlay: { sideload: () => ({ 'openai.chatgpt': async () => 'C:\\cache\\codex.vsix' }), sideloadIds: ['openai.chatgpt'] },
    defaultAppProduct: 'vscode',
    uiLanguage: async () => 'en',
    argvJsonPath: join(home, 'user-home', '.mk42', 'argv.json'),
  });
}

test('app choice: Code.exe unless the window asks for Mark42 — same version number, different app', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    const settings: DaemonSettings = { ...emptyRegistry().settings, separateFromUserVsCode: false };
    const calls: { exe: string; args: string[] }[] = [];
    const ensured: EnsureRequest[] = [];
    const l = launcherWith(settings, home, calls, ensured);
    await l.launch({ workspaceFile: 'C:\\w', role: 'editor' });
    assert.equal(calls.at(-1)!.exe, CODE.exe, 'default stays the official app (migration is per folder)');
    await l.launch({ workspaceFile: 'C:\\w', role: 'agent-claude', appProduct: 'mark42' });
    assert.equal(calls.at(-1)!.exe, MK42.exe);
    assert.ok(calls.at(-1)!.args.includes('--user-data-dir') && calls.at(-1)!.args.includes(MK42.userDataDir!));
    // focus keeps the app of the window: exact version within that app only
    await l.launch({ workspaceFile: 'C:\\w', role: 'agent-claude', appVersion: '1.143.1', exactVersion: true, appProduct: 'vscode' });
    assert.equal(calls.at(-1)!.exe, CODE.exe);
    settings.defaultAppProduct = 'mark42';
    await l.launch({ workspaceFile: 'C:\\w', role: 'editor' });
    assert.equal(calls.at(-1)!.exe, MK42.exe);

    // Mk42's extensions dir is Mark42's: a sideloaded extension comes from its VSIX
    assert.ok(ensured.length >= 1);
    const r = ensured[0]!;
    assert.equal(r.exe, MK42.exe);
    assert.equal(r.extensionsDir, MK42.extensionsDir);
    assert.deepEqual(Object.keys(r.sideload ?? {}), ['openai.chatgpt']);
    assert.equal(await r.sideload!['openai.chatgpt']!(), 'C:\\cache\\codex.vsix');

    const noApp = new AppLauncher({ home, getSettings: () => settings, discover: async () => [CODE], spawn: async () => ({}) });
    await assert.rejects(noApp.launch({ workspaceFile: 'w', role: 'editor', appProduct: 'mark42' }), /no Mk42 app/);
  } finally {
    cleanup();
  }
});

test('installer: gallery ids in one run, sideloaded ones from their VSIX; a failed VSIX is skipped', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const exe = join(dir, 'Mk42.exe');
    mkdirSync(join(dir, 'resources', 'app', 'out'), { recursive: true });
    writeFileSync(join(dir, 'resources', 'app', 'out', 'cli.js'), '');
    const ext = join(dir, 'ext');
    const runs: string[][] = [];
    const run: RunFn = async (_c, args) => {
      runs.push(args);
      // pretend the CLI installed what it was asked for
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--install-extension') continue;
        const id = args[i + 1]!.endsWith('.vsix') ? 'openai.chatgpt' : args[i + 1]!;
        mkdirSync(join(ext, `${id}-1.0.0`), { recursive: true });
      }
      return { code: 0, output: '' };
    };
    const installer = new ExtensionInstaller({ ids: ['ms-ceintl.vscode-language-pack-ko', 'anthropic.claude-code', 'openai.chatgpt'], run, env: {} });
    await installer.ensure({ exe, userDataDir: join(dir, 'ud'), extensionsDir: ext, sideload: { 'openai.chatgpt': async () => 'C:\\c\\codex.vsix' } });
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[0]!.filter((a, i) => runs[0]![i - 1] === '--install-extension'), ['ms-ceintl.vscode-language-pack-ko', 'anthropic.claude-code']);
    assert.deepEqual(runs[1]!.slice(-3), ['--install-extension', 'C:\\c\\codex.vsix', '--force']);

    const ext2 = join(dir, 'ext2');
    runs.length = 0;
    await installer.ensure({ exe, userDataDir: join(dir, 'ud'), extensionsDir: ext2, ids: ['openai.chatgpt'], sideload: { 'openai.chatgpt': async () => { throw new Error('offline'); } } });
    assert.equal(runs.length, 0, 'no VSIX: nothing to run, no throw');
  } finally {
    cleanup();
  }
});

