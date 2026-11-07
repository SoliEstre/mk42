// C3: 창 띄우기 준비 진행 파일·진행 창, C2: 한국어 언어 팩·argv.json을 창보다 먼저, Mark42 확장 .vsix는 차례에서 앞에
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExtensionInstaller, type EnsureRequest, type RunFn } from '../src/extensions.ts';
import { AppLauncher, type DiscoveredInstall } from '../src/launcher.ts';
import { formatBytesDetail, LaunchProgress, launchProgressPath, stepEndOfUpdate, type LaunchProgressDoc, type LaunchProgressOptions } from '../src/launchProgress.ts';
import { emptyRegistry, type DaemonSettings } from '../src/registry.ts';
import { tempDir } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function readDoc(home: string): LaunchProgressDoc | undefined {
  try {
    return JSON.parse(readFileSync(launchProgressPath(home), 'utf8')) as LaunchProgressDoc;
  } catch {
    return undefined;
  }
}

function progressIn(home: string, spawned: string[], extra: Partial<LaunchProgressOptions> = {}): LaunchProgress {
  return new LaunchProgress({
    home,
    language: async () => 'ko',
    showDelayMs: 30,
    writeDelayMs: 1,
    spawnWindow: async (file) => (spawned.push(file), { pid: 777 }),
    isAlive: () => false,
    ...extra,
  });
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test('progress: helpers — MB detail, update status to step end', () => {
  assert.equal(formatBytesDetail(120 * 1024 * 1024, 600 * 1024 * 1024), '120 / 600 MB');
  assert.equal(formatBytesDetail(5 * 1024 * 1024), '5 MB');
  assert.equal(stepEndOfUpdate('updated'), 'done');
  assert.equal(stepEndOfUpdate('current'), 'done');
  assert.equal(stepEndOfUpdate('pending'), 'skipped');
  assert.equal(stepEndOfUpdate('blocked'), 'failed');
  assert.equal(stepEndOfUpdate(undefined), 'failed');
});

test('progress: an ordinary launch (nothing to prepare) writes no file and opens no window', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    const spawned: string[] = [];
    const p = progressIn(home, spawned);
    const t = p.begin();
    t.waitForWindow('C:\\w\\a.code-workspace'); // no preparation: not a step
    t.seal();
    await sleep(80);
    assert.equal(existsSync(launchProgressPath(home)), false);
    assert.deepEqual(spawned, []);
    assert.equal(p.snapshot(), undefined);
  } finally {
    cleanup();
  }
});

test('progress: quick preparation (done before the delay) opens no window', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    const spawned: string[] = [];
    const p = progressIn(home, spawned, { showDelayMs: 60 });
    const t = p.begin();
    t.start('mark42-extension');
    t.finish('mark42-extension', 'done');
    t.seal();
    await sleep(120);
    assert.deepEqual(spawned, []);
  } finally {
    cleanup();
  }
});

test('progress: slow preparation — file in C3 shape, one window after the delay, open-window until hello, then done', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    const spawned: string[] = [];
    const p = progressIn(home, spawned);
    const t = p.begin();
    t.start('mark42-extension');
    await waitFor(() => spawned.length === 1, 'progress window');
    assert.deepEqual(spawned, [launchProgressPath(home)]);
    let doc = readDoc(home)!;
    assert.equal(doc.schema, 1);
    assert.equal(doc.lang, 'ko');
    assert.equal(doc.title, 'Mk42 준비 중');
    assert.equal(doc.done, false);
    assert.equal(doc.error, null);
    assert.deepEqual(doc.steps, [{ id: 'mark42-extension', label: 'Mark42 확장 설치', state: 'running' }]);
    assert.ok(!Number.isNaN(Date.parse(doc.updatedAt)));

    t.finish('mark42-extension', 'done');
    t.waitForWindow('C:\\Users\\u\\AppData\\Local\\Mark42\\ws\\a.code-workspace');
    t.seal();
    await waitFor(() => readDoc(home)?.steps.some((s) => s.id === 'open-window') === true, 'open-window step');
    doc = readDoc(home)!;
    assert.equal(doc.done, false, 'still waiting for the window');
    assert.deepEqual(doc.steps.map((s) => [s.id, s.state]), [['mark42-extension', 'done'], ['open-window', 'running']]);
    assert.equal(doc.steps[1]!.label, '창 여는 중');

    p.windowHello('c:/users/u/appdata/local/mark42/ws/A.code-workspace'); // same path, other spelling
    await waitFor(() => readDoc(home)?.done === true, 'done');
    doc = readDoc(home)!;
    assert.equal(doc.error, null);
    assert.deepEqual(doc.steps.map((s) => s.state), ['done', 'done']);
    assert.equal(spawned.length, 1);
  } finally {
    cleanup();
  }
});

test('progress: concurrent launches share one file — done only when all finished; a failure becomes the error line', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    const spawned: string[] = [];
    const p = progressIn(home, spawned, { language: async () => 'en', logFile: 'C:\\H\\logs\\mk42d.log' });
    const a = p.begin();
    const b = p.begin();
    a.start('mark42-extension');
    b.start('mark42-extension'); // the same shared install
    b.start('codex-extension');
    b.bytes('codex-extension', 120 * 1024 * 1024, 600 * 1024 * 1024);
    a.seal();
    b.seal();
    await waitFor(() => spawned.length === 1, 'window');
    await waitFor(() => readDoc(home)?.steps.find((s) => s.id === 'codex-extension')?.detail === '120 / 600 MB', 'byte detail');
    assert.equal(readDoc(home)!.title, 'Preparing Mk42');
    a.finish('mark42-extension', 'done');
    b.finish('mark42-extension', 'done');
    await sleep(20);
    assert.equal(readDoc(home)!.done, false, 'Codex still downloading');
    b.finish('codex-extension', 'failed');
    await waitFor(() => readDoc(home)?.done === true, 'done');
    const doc = readDoc(home)!;
    assert.equal(doc.error, null, 'background agent-extension failure: a ✕ step, no error line');
    assert.deepEqual(doc.steps.map((s) => [s.id, s.state]), [['mark42-extension', 'done'], ['codex-extension', 'failed']]);
    assert.equal(doc.steps[1]!.label, 'Downloading the Codex extension');

    // the same failing step on a later launch is not shown again; a step the user waits on that fails gives the error line
    const c = p.begin();
    c.start('codex-extension');
    c.finish('codex-extension', 'failed');
    c.start('language-pack');
    c.finish('language-pack', 'failed');
    c.seal();
    await waitFor(() => readDoc(home)?.done === true && readDoc(home)!.steps.some((s) => s.id === 'language-pack'), 'third run done');
    const doc3 = readDoc(home)!;
    assert.deepEqual(doc3.steps.map((s) => s.id), ['language-pack']);
    assert.equal(doc3.error, 'Something went wrong while preparing — log: C:\\H\\logs\\mk42d.log');
  } finally {
    cleanup();
  }
});

test('progress: no hello in time → open-window skipped; a live progress window is reused, not spawned again', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    const spawned: string[] = [];
    let alive = true;
    const p = progressIn(home, spawned, { windowTimeoutMs: 40, isAlive: () => alive });
    const t = p.begin();
    t.start('language-pack');
    await waitFor(() => spawned.length === 1, 'window');
    t.finish('language-pack', 'done');
    t.waitForWindow('C:\\w');
    t.seal();
    await waitFor(() => readDoc(home)?.done === true, 'done after timeout');
    assert.equal(readDoc(home)!.steps.find((s) => s.id === 'open-window')!.state, 'skipped');
    assert.equal(readDoc(home)!.error, null);

    // next run while the first window is still up: it just reads the new file
    const t2 = p.begin();
    t2.start('claude-extension');
    // 쓰기는 150 ms씩 묶여요 — 고정 대기 대신 새 판이 쓰일 때까지(부하가 큰 전체 시험에서 80 ms는 모자랐어요)
    await waitFor(() => readDoc(home)?.done === false, 'second run written');
    await sleep(80);
    assert.equal(spawned.length, 1);
    t2.finish('claude-extension', 'done');
    t2.seal();
    await waitFor(() => readDoc(home)?.done === true, 'second run done');

    alive = false; // window gone (closed or hidden): the next slow run opens one again
    const t3 = p.begin();
    t3.start('codex-extension');
    await waitFor(() => spawned.length === 2, 'second window');
    t3.finish('codex-extension', 'done');
    t3.seal();
    await waitFor(() => readDoc(home)?.done === true, 'third run done');
  } finally {
    cleanup();
  }
});

test('progress: a stale file from an earlier daemon run is removed', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    mkdirSync(join(home, 'run'));
    writeFileSync(launchProgressPath(home), '{"schema":1,"done":false}');
    await progressIn(home, []).clearStale();
    assert.equal(existsSync(launchProgressPath(home)), false);
  } finally {
    cleanup();
  }
});

// ---- launcher: C2 + priority ----

const KO = 'ms-ceintl.vscode-language-pack-ko';

function mk42(home: string): DiscoveredInstall {
  return {
    version: '1.143.1',
    exe: 'C:\\Mk42\\Mk42.exe',
    product: 'mark42',
    source: 'registry',
    userDataDir: join(home, '.mk42', 'user-data'),
    extensionsDir: join(home, '.mk42', 'extensions'),
  };
}

test('launcher (Korean Windows): language pack + Mark42 vsix before the window, argv locale ko, Codex keeps going in the background', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    writeFileSync(join(home, 'mark42-0.1.7.vsix'), '');
    const settings: DaemonSettings = { ...emptyRegistry().settings, extensionVsix: home, separateFromUserVsCode: false };
    const install = mk42(home);
    const ext = install.extensionsDir!;
    const order: string[] = [];
    const codex = deferred();
    const spawned: string[] = [];
    const progress = progressIn(home, spawned, { showDelayMs: 0 });
    const argv = join(home, 'user-home', '.mk42', 'argv.json');
    const launcher = new AppLauncher({ defaultAppProduct: 'vscode',
      home,
      env: {},
      getSettings: () => settings,
      discover: async () => [install],
      spawn: async () => (order.push('spawn'), { pid: 1 }),
      uiLanguage: async () => 'ko',
      argvJsonPath: argv,
      progress,
      extensions: {
        ensure: async (r: EnsureRequest) => {
          if (r.ids?.includes(KO)) {
            assert.equal(r.priority, true, 'the window waits for it: priority');
            await sleep(10);
            mkdirSync(join(ext, `${KO}-1.143.0`), { recursive: true });
            order.push('language-pack');
            return;
          }
          assert.ok(!r.ids?.includes(KO), 'language pack is not in the background list');
          order.push('background-start');
          await r.sideload!['openai.chatgpt']!();
          await codex.promise;
          mkdirSync(join(ext, 'openai.chatgpt-26.1.1-win32-x64'), { recursive: true });
          order.push('background-done');
        },
        ensureVsix: async () => {
          if (existsSync(join(ext, 'mark42.mark42-0.1.7'))) return true; // like the real installer: present = no install
          await sleep(10);
          mkdirSync(join(ext, 'mark42.mark42-0.1.7'), { recursive: true });
          order.push('vsix');
          return true;
        },
      },
      // 판 덧층이 Codex를 사이드로드로 마련하는 경우(받은 바이트가 진행 창에 보여요)
      overlay: {
        sideloadIds: ['openai.chatgpt'],
        sideload: () => ({
          'openai.chatgpt': async (onProgress) => {
            onProgress?.(50 * 1024 * 1024, 600 * 1024 * 1024);
            return 'C:\\cache\\codex.vsix';
          },
        }),
      },
    });
    const r = await launcher.launch({ workspaceFile: 'C:\\w\\a.code-workspace', role: 'agent-claude', appProduct: 'mark42' });
    assert.equal(r.exe, install.exe);
    assert.ok(order.indexOf('language-pack') < order.indexOf('spawn'), order.join(','));
    assert.ok(order.indexOf('vsix') < order.indexOf('spawn'), order.join(','));
    assert.ok(!order.includes('background-done'), 'the window does not wait for Codex');
    assert.deepEqual(JSON.parse(readFileSync(argv, 'utf8')), { locale: 'ko' });

    await waitFor(() => readDoc(home)?.steps.some((s) => s.id === 'open-window') === true, 'open-window');
    let doc = readDoc(home)!;
    assert.equal(doc.steps.find((s) => s.id === 'codex-extension')?.detail, '50 / 600 MB');
    // (Claude Code is missing too, but without onVerifiedExtensionMissing there is nothing to track)
    assert.deepEqual(
      doc.steps.map((s) => [s.id, s.state]),
      [
        ['mark42-extension', 'done'],
        ['language-pack', 'done'],
        ['open-window', 'running'],
        ['codex-extension', 'running'],
      ],
    );
    progress.windowHello('C:\\w\\a.code-workspace');
    await sleep(20);
    assert.equal(readDoc(home)!.done, false, 'Codex still running');
    codex.resolve();
    await waitFor(() => readDoc(home)?.done === true, 'done');
    doc = readDoc(home)!;
    assert.deepEqual(doc.steps.map((s) => s.state), ['done', 'done', 'done', 'done']);
    assert.equal(doc.error, null);
    assert.equal(spawned.length, 1);

    // second launch: everything in place — no steps, no window, argv untouched
    const before = readFileSync(argv, 'utf8');
    order.length = 0;
    await launcher.launch({ workspaceFile: 'C:\\w\\b.code-workspace', role: 'editor', appProduct: 'mark42' });
    assert.ok(!order.includes('language-pack') && !order.includes('vsix'), `nothing to install before the window: ${order.join(',')}`);
    assert.equal(readFileSync(argv, 'utf8'), before);
    await sleep(30);
    assert.equal(spawned.length, 1);
  } finally {
    cleanup();
  }
});

test('launcher (non-Korean Windows): no language pack, no argv.json; a missing Claude Code shows as a step until the verified install ends', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    const settings: DaemonSettings = { ...emptyRegistry().settings, separateFromUserVsCode: false };
    const install = mk42(home);
    mkdirSync(join(install.extensionsDir!, 'openai.chatgpt-26.1.1-win32-x64'), { recursive: true });
    const ensured: EnsureRequest[] = [];
    const claude = deferred<unknown>();
    const spawned: string[] = [];
    const progress = progressIn(home, spawned, { showDelayMs: 0, language: async () => 'en' });
    const argv = join(home, 'user-home', '.mk42', 'argv.json');
    const launcher = new AppLauncher({ defaultAppProduct: 'vscode',
      home,
      env: {},
      getSettings: () => settings,
      discover: async () => [install],
      spawn: async () => ({ pid: 1 }),
      uiLanguage: async () => 'en',
      argvJsonPath: argv,
      progress,
      extensions: { ensure: async (r) => void ensured.push(r), ensureVsix: async () => true },
      onVerifiedExtensionMissing: () => claude.promise,
    });
    await launcher.launch({ workspaceFile: 'C:\\w', role: 'agent-claude', appProduct: 'mark42' });
    assert.ok(ensured.every((r) => !r.ids?.includes(KO)), 'no language pack on English Windows');
    assert.equal(existsSync(argv), false);
    await waitFor(() => readDoc(home)?.steps.some((s) => s.id === 'open-window') === true, 'claude step + open-window');
    assert.deepEqual(readDoc(home)!.steps.map((s) => [s.id, s.state]), [['open-window', 'running'], ['claude-extension', 'running']]);
    assert.equal(readDoc(home)!.steps[1]!.label, 'Installing the Claude Code extension');
    progress.windowHello('C:\\w');
    claude.resolve('skipped'); // waiting for the user's approval in the window
    await waitFor(() => readDoc(home)?.done === true, 'done');
    assert.deepEqual(readDoc(home)!.steps.map((s) => s.state), ['done', 'skipped']);
  } finally {
    cleanup();
  }
});

test('installer: Mark42 vsix and the language pack jump the queue; the Codex download does not hold the queue', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const exe = join(dir, 'Mk42.exe');
    mkdirSync(join(dir, 'resources', 'app', 'out'), { recursive: true });
    writeFileSync(join(dir, 'resources', 'app', 'out', 'cli.js'), '');
    const ext = join(dir, 'ext');
    const runs: string[] = [];
    const gate = deferred();
    let first = true;
    const run: RunFn = async (_c, args) => {
      const what = args.filter((_, i) => args[i - 1] === '--install-extension').join('+');
      runs.push(what);
      if (first) {
        first = false;
        await gate.promise; // a long background install already running
      }
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--install-extension') continue;
        const a = args[i + 1]!;
        const folder = a.endsWith('mark42-0.1.7.vsix') ? 'mark42.mark42-0.1.7' : a.endsWith('.vsix') ? 'openai.chatgpt-1.0.0' : `${a}-1.0.0`;
        mkdirSync(join(ext, folder), { recursive: true });
      }
      return { code: 0, output: '' };
    };
    const installer = new ExtensionInstaller({ ids: [], run, env: {} });
    const req: EnsureRequest = { exe, userDataDir: join(dir, 'ud'), extensionsDir: ext };

    // 1) the Codex VSIX is still downloading: the Mark42 vsix installs right away
    const download = deferred<string>();
    const codexDone = installer.ensure({ ...req, ids: ['openai.chatgpt'], sideload: { 'openai.chatgpt': () => download.promise } });
    const busy = installer.ensure({ ...req, ids: ['a.background'] }); // starts running, held by the gate
    await sleep(10);
    const later = installer.ensure({ ...req, ids: ['b.background'] }); // queued (not priority)
    const vsix = installer.ensureVsix(req, { path: join(dir, 'mark42-0.1.7.vsix'), version: '0.1.7' });
    const ko = installer.ensure({ ...req, ids: [KO], priority: true });
    await sleep(10);
    assert.deepEqual(runs, ['a.background'], 'one CLI at a time');
    gate.resolve();
    assert.equal(await vsix, true);
    await Promise.all([busy, later, ko]);
    assert.equal(runs.length, 4);
    assert.equal(runs[0], 'a.background');
    assert.deepEqual(runs.slice(1, 3).sort(), [KO, join(dir, 'mark42-0.1.7.vsix')].sort(), 'priority before the queued background install');
    assert.equal(runs[3], 'b.background');
    download.resolve('C:\\c\\codex.vsix');
    await codexDone;
    assert.equal(runs.at(-1), 'C:\\c\\codex.vsix');
  } finally {
    cleanup();
  }
});
