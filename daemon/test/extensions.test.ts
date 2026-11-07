import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildInstallArgs,
  ExtensionInstaller,
  hasExtensionVersion,
  missingExtensions,
  resolveCliScript,
  resolveVsix,
  type EnsureRequest,
  type RunFn,
} from '../src/extensions.ts';
import { AppLauncher, REQUIRED_EXTENSIONS, requiredExtensions, type DiscoveredInstall } from '../src/launcher.ts';
import { emptyRegistry, type DaemonSettings } from '../src/registry.ts';
import { tempDir } from './helpers.ts';

const IDS = ['ms-ceintl.vscode-language-pack-ko', 'anthropic.claude-code', 'openai.chatgpt'];

test('extensions: required set is Claude and Codex, plus the language pack on Korean Windows only (R1, C2)', () => {
  assert.deepEqual([...REQUIRED_EXTENSIONS], IDS.slice(1));
  assert.deepEqual(requiredExtensions('ko'), IDS);
  assert.deepEqual(requiredExtensions('en'), IDS.slice(1));
});

test('extensions: missing = no <id>-<version> folder, or only one listed in .obsolete', async () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.deepEqual(await missingExtensions(join(dir, 'none'), IDS), IDS);
    mkdirSync(join(dir, 'anthropic.claude-code-2.1.304-win32-x64'));
    mkdirSync(join(dir, 'MS-CEINTL.vscode-language-pack-ko-1.131.2026090407'));
    mkdirSync(join(dir, 'openai.chatgpt-26.1007.21434-win32-x64'));
    mkdirSync(join(dir, 'anthropic.claude-code-helper-1.0.0')); // another id with the same prefix
    assert.deepEqual(await missingExtensions(dir, IDS), []);
    writeFileSync(join(dir, '.obsolete'), JSON.stringify({ 'openai.chatgpt-26.1007.21434-win32-x64': true }));
    assert.deepEqual(await missingExtensions(dir, IDS), ['openai.chatgpt']);
    assert.deepEqual(await missingExtensions(dir, ['anthropic.claude']), ['anthropic.claude']);
  } finally {
    cleanup();
  }
});

test('extensions: cli.js is found in the commit folder (bin\\code.cmd layout), else at the root, else none', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const exe = join(dir, 'Code.exe');
    writeFileSync(exe, '');
    assert.equal(await resolveCliScript(exe), undefined);
    mkdirSync(join(dir, 'resources', 'app', 'out'), { recursive: true });
    writeFileSync(join(dir, 'resources', 'app', 'out', 'cli.js'), '');
    assert.equal(await resolveCliScript(exe), join(dir, 'resources', 'app', 'out', 'cli.js'));
    mkdirSync(join(dir, '6d62b1d5da', 'resources', 'app', 'out'), { recursive: true });
    writeFileSync(join(dir, '6d62b1d5da', 'resources', 'app', 'out', 'cli.js'), '');
    assert.equal(await resolveCliScript(exe), join(dir, '6d62b1d5da', 'resources', 'app', 'out', 'cli.js'));
    assert.equal(await resolveCliScript(join(dir, 'gone', 'Code.exe')), undefined);
  } finally {
    cleanup();
  }
});

test('extensions: install args pin user data and extensions dir, one --install-extension per id', () => {
  assert.deepEqual(buildInstallArgs('C:\\c\\cli.js', ['a.b', 'c.d'], 'C:\\ud', 'C:\\ext'), [
    'C:\\c\\cli.js',
    '--user-data-dir',
    'C:\\ud',
    '--extensions-dir',
    'C:\\ext',
    '--install-extension',
    'a.b',
    '--install-extension',
    'c.d',
  ]);
  // Daemon/005: with the window's own shared storage, right after the dirs
  assert.deepEqual(buildInstallArgs('cli.js', ['a.b'], 'C:\\ud', 'C:\\ext', { sharedDataDir: 'C:\\sh', agentPluginsDir: 'C:\\ap' }).slice(5, 9), [
    '--shared-data-dir',
    'C:\\sh',
    '--agent-plugins-dir',
    'C:\\ap',
  ]);
});

test('extensions: installer runs Code.exe as node once for the missing ones, shares a running install, never throws', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const exe = join(dir, 'Code.exe');
    writeFileSync(exe, '');
    mkdirSync(join(dir, 'resources', 'app', 'out'), { recursive: true });
    writeFileSync(join(dir, 'resources', 'app', 'out', 'cli.js'), '');
    const ext = join(dir, 'ext');
    mkdirSync(join(ext, 'anthropic.claude-code-2.1.304-win32-x64'), { recursive: true });
    const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    let fail = false;
    const run: RunFn = async (command, args, env) => {
      calls.push({ command, args, env });
      await new Promise((r) => setTimeout(r, 20));
      if (fail) return { code: 1, output: 'Failed Installing Extensions' };
      for (let i = 0; i < args.length; i++) if (args[i] === '--install-extension') mkdirSync(join(ext, `${args[i + 1]}-1.0.0`));
      return { code: 0, output: '' };
    };
    const installer = new ExtensionInstaller({ ids: IDS, run, env: { PATH: 'p' } });
    const req: EnsureRequest = { exe, userDataDir: join(dir, 'ud'), extensionsDir: ext };
    await Promise.all([installer.ensure(req), installer.ensure(req)]);
    assert.equal(calls.length, 1, 'two launches at once share one install');
    assert.equal(calls[0]!.command, exe);
    assert.deepEqual(calls[0]!.args.filter((_, i, a) => a[i - 1] === '--install-extension'), ['ms-ceintl.vscode-language-pack-ko', 'openai.chatgpt']);
    assert.equal(calls[0]!.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(calls[0]!.env.PATH, 'p');

    await installer.ensure(req); // all there now: no run
    assert.equal(calls.length, 1);

    const ext2 = join(dir, 'ext2');
    fail = true;
    await installer.ensure({ ...req, extensionsDir: ext2 }); // failure is logged, not thrown
    assert.equal(calls.length, 2);
    const throwing = new ExtensionInstaller({ ids: IDS, env: {}, run: async () => { throw new Error('ENOENT'); } });
    await throwing.ensure({ ...req, extensionsDir: ext2 });
    const noCli = new ExtensionInstaller({ ids: IDS, env: {}, run: async () => assert.fail('no cli.js: must not run') });
    await noCli.ensure({ ...req, exe: join(dir, 'gone', 'Code.exe'), extensionsDir: ext2 });
  } finally {
    cleanup();
  }
});

test('vsix: a mark42-<x.y.z>.vsix file, or the highest one in a folder', async () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.equal(await resolveVsix(join(dir, 'none')), undefined);
    for (const v of ['0.1.9', '0.1.12710144', '0.1.12710200']) writeFileSync(join(dir, `mark42-${v}.vsix`), '');
    writeFileSync(join(dir, 'other-9.9.9.vsix'), '');
    assert.deepEqual(await resolveVsix(dir), { path: join(dir, 'mark42-0.1.12710200.vsix'), version: '0.1.12710200' });
    assert.deepEqual(await resolveVsix(join(dir, 'mark42-0.1.9.vsix')), { path: join(dir, 'mark42-0.1.9.vsix'), version: '0.1.9' });
    assert.equal(await resolveVsix(join(dir, 'other-9.9.9.vsix')), undefined);
    assert.equal(await resolveVsix(join(dir, 'empty-dir-missing')), undefined);
  } finally {
    cleanup();
  }
});

test('vsix: installed = that exact version folder, not marked obsolete', async () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.equal(await hasExtensionVersion(join(dir, 'nope'), 'mark42.mark42', '0.1.5'), false);
    mkdirSync(join(dir, 'mark42.mark42-0.1.5'));
    assert.equal(await hasExtensionVersion(dir, 'mark42.mark42', '0.1.5'), true);
    assert.equal(await hasExtensionVersion(dir, 'mark42.mark42', '0.1.6'), false);
    writeFileSync(join(dir, '.obsolete'), JSON.stringify({ 'mark42.mark42-0.1.5': true }));
    assert.equal(await hasExtensionVersion(dir, 'mark42.mark42', '0.1.5'), false);
  } finally {
    cleanup();
  }
});

test('vsix: installs a new version with --force once, skips when present, false when it fails', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const exe = join(dir, 'Code.exe');
    writeFileSync(exe, '');
    mkdirSync(join(dir, 'resources', 'app', 'out'), { recursive: true });
    writeFileSync(join(dir, 'resources', 'app', 'out', 'cli.js'), '');
    const ext = join(dir, 'ext');
    const calls: string[][] = [];
    let fail = false;
    const run: RunFn = async (_command, args) => {
      calls.push(args);
      await new Promise((r) => setTimeout(r, 20));
      if (!fail) mkdirSync(join(ext, 'mark42.mark42-0.1.7'), { recursive: true });
      return { code: fail ? 1 : 0, output: '' };
    };
    const installer = new ExtensionInstaller({ ids: [], run, env: {} });
    const req: EnsureRequest = { exe, userDataDir: join(dir, 'ud'), extensionsDir: ext };
    const vsix = { path: join(dir, 'mark42-0.1.7.vsix'), version: '0.1.7' };
    const [a, b] = await Promise.all([installer.ensureVsix(req, vsix), installer.ensureVsix(req, vsix)]);
    assert.deepEqual([a, b], [true, true]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.slice(-3), ['--install-extension', vsix.path, '--force']);
    assert.ok(!calls[0]!.includes('--shared-data-dir'), 'no shared dir asked for: none passed');
    assert.equal(await installer.ensureVsix(req, vsix), true);
    assert.equal(calls.length, 1, 'present: not installed again');
    fail = true;
    assert.equal(await installer.ensureVsix(req, { path: join(dir, 'mark42-0.1.8.vsix'), version: '0.1.8' }), false);
  } finally {
    cleanup();
  }
});

test('launcher: with the Mark42 vsix in place the window gets no development path; without it, it does', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    writeFileSync(join(home, 'mark42-0.1.7.vsix'), '');
    const settings: DaemonSettings = { ...emptyRegistry().settings, extensionDevelopmentPath: 'C:\\dev\\ext', extensionVsix: home };
    const installs: DiscoveredInstall[] = [
      { version: '1.142.0', exe: 'C:\\A\\Code.exe', source: 'registry', userDataDir: 'C:\\T\\ud', extensionsDir: 'C:\\T\\ext' },
      { version: '1.0.0', exe: 'C:\\B\\Code.exe', source: 'official' }, // user's own folders
    ];
    let vsixOk = true;
    const vsixCalls: { extensionsDir: string; version: string }[] = [];
    const launcher = new AppLauncher({ defaultAppProduct: 'vscode',
      home,
      getSettings: () => settings,
      discover: async () => installs,
      spawn: async () => ({}),
      devPathFor: async (_ws, target) => target,
      extensions: {
        ensure: async () => {},
        ensureVsix: async (r, v) => (vsixCalls.push({ extensionsDir: r.extensionsDir, version: v.version }), vsixOk),
      },
    });
    const r1 = await launcher.launch({ workspaceFile: 'C:\\w', role: 'editor', appVersion: '1.142.0' });
    assert.deepEqual(vsixCalls, [{ extensionsDir: 'C:\\T\\ext', version: '0.1.7' }]);
    assert.ok(!r1.args.some((a) => a.startsWith('--extensionDevelopmentPath')), 'packaged: no dev path');

    vsixOk = false; // install failed: fall back to the development path
    const r2 = await launcher.launch({ workspaceFile: 'C:\\w', role: 'editor', appVersion: '1.142.0' });
    assert.ok(r2.args.includes('--extensionDevelopmentPath=C:\\dev\\ext'));

    const r3 = await launcher.launch({ workspaceFile: 'C:\\w', role: 'editor', appVersion: '1.0.0' });
    assert.equal(vsixCalls.length, 2, 'never into the user’s default extensions folder');
    assert.ok(r3.args.includes('--extensionDevelopmentPath=C:\\dev\\ext'));
  } finally {
    cleanup();
  }
});
