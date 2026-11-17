// «다시 시작해서 적용»(교훈 012) — 떠 있는 Mk42 main 판 고르기(실행기), appRestart 상태, app.restartToUpdate 흐름
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { test } from 'node:test';
import { CAPABILITY_QUIT_FOR_UPDATE, RpcPeer, type Mk42UpdateStatus, type WindowInfo } from '@mark42/protocol';
import {
  AppLauncher,
  mainPipeName,
  mainPipeScope,
  type AppLauncherLike,
  type DiscoveredInstall,
  type LaunchRequest,
  type Mark42AppState,
  PipeListError,
} from '../src/launcher.ts';
import { emptyRegistry, Registry, type DaemonSettings } from '../src/registry.ts';
import { DaemonCore } from '../src/server.ts';
import { roleWorkspacePath } from '../src/workspaces.ts';
import { delay, memoryChannelPair, sequenceIds, tempDir, until, wrapPeer, type TestClient } from './helpers.ts';

const NEW = '1.146.0';
const OLD = '1.143.1';

test('mainPipeScope: sha256 of the resolved --user-data-dir string, first 8 hex — case preserved like VS Code', () => {
  const dir = 'C:\\Users\\me\\.mk42\\user-data';
  assert.equal(mainPipeScope(dir), createHash('sha256').update(dir).digest('hex').slice(0, 8));
  assert.notEqual(mainPipeScope(dir), mainPipeScope(dir.toLowerCase()), 'a different case is a different main for VS Code');
  assert.equal(mainPipeScope('C:\\Users\\me\\.mk42\\user-data\\'), mainPipeScope(dir), 'path.resolve drops the trailing separator');
  assert.equal(mainPipeScope('rel\\ud'), createHash('sha256').update(win32.resolve('rel\\ud')).digest('hex').slice(0, 8));
  assert.equal(mainPipeName(dir, OLD), `${mainPipeScope(dir)}-${OLD}-main-sock`);
});

function launcherCtx(pipes: { list: string[] }, udd: string, extra: Partial<DiscoveredInstall> = {}) {
  const { dir: home, cleanup } = tempDir();
  const calls: { exe: string; args: string[] }[] = [];
  const installs: DiscoveredInstall[] = [
    { version: NEW, exe: 'C:\\Mk42\\app\\Mk42-1.146.0\\Mk42.exe', product: 'mark42', source: 'registry', userDataDir: udd, extensionsDir: join(home, 'ext') },
    { version: OLD, exe: 'C:\\Mk42\\app\\Mk42-1.143.1\\Mk42.exe', product: 'mark42', source: 'registry', userDataDir: udd, extensionsDir: join(home, 'ext'), ...extra },
    // 다른 앱(공식 VS Code) — 같은 판 번호여도 Mk42 main 고르기와 상관없어요
    { version: OLD, exe: 'C:\\VSC\\Code.exe', source: 'official', userDataDir: udd },
  ];
  const settings: DaemonSettings = { ...emptyRegistry().settings, separateFromUserVsCode: false, defaultAppProduct: 'mark42' };
  const launcher = new AppLauncher({
    home,
    getSettings: () => settings,
    discover: async () => installs,
    spawn: async (exe, args) => {
      calls.push({ exe, args });
      return { pid: 1 };
    },
    extensions: { ensure: async () => undefined, ensureVsix: async () => false },
    uiLanguage: async () => 'en',
    argvJsonPath: join(home, 'argv.json'),
    listPipes: () => pipes.list,
    env: {},
  });
  return { home, launcher, calls, settings, cleanup };
}

test('launcher: a new Mk42 window goes to the main already running on the same user-data (newest when none / both live)', async () => {
  const t0 = tempDir();
  const udd = join(t0.dir, 'user-data');
  const pipes = { list: [] as string[] };
  const { launcher, calls, cleanup } = launcherCtx(pipes, udd);
  try {
    const open = async (req: Partial<LaunchRequest> = {}) => (await launcher.launch({ workspaceFile: 'C:\\w.code-workspace', role: 'editor', ...req })).version;
    // 떠 있는 main 없음 → 가장 새 판
    pipes.list = ['mojo.1234', 'other-pipe'];
    assert.equal(await open(), NEW);
    assert.deepEqual(await launcher.mark42AppState(), { newest: NEW, live: [] });
    // 옛 판 main만 떠 있음 → 옛 판(두 번째 main을 만들지 않아요)
    pipes.list = ['x', mainPipeName(udd, OLD)];
    assert.equal(await open(), OLD);
    assert.equal(calls.at(-1)!.exe, 'C:\\Mk42\\app\\Mk42-1.143.1\\Mk42.exe');
    assert.deepEqual(await launcher.mark42AppState(), { newest: NEW, live: [OLD] });
    // 둘 다 떠 있음 → 가장 새 판
    pipes.list = [mainPipeName(udd, OLD), mainPipeName(udd, NEW)];
    assert.equal(await open(), NEW);
    assert.deepEqual(await launcher.mark42AppState(), { newest: NEW, live: [NEW, OLD] });
    // 판을 정한 요청(포커스·다시 시작)은 그대로
    pipes.list = [mainPipeName(udd, OLD)];
    assert.equal(await open({ appVersion: NEW }), NEW);
    assert.equal(await open({ appVersion: NEW, exactVersion: true }), NEW);
    // 공식 VS Code는 상관없어요
    assert.equal(await open({ appProduct: 'vscode' }), OLD);
    assert.equal(calls.at(-1)!.exe, 'C:\\VSC\\Code.exe');
    // 다른 user-data의 main → 무시
    pipes.list = [mainPipeName(join(t0.dir, 'other-user-data'), OLD)];
    assert.equal(await open(), NEW);
    // 같은 폴더라도 다른 글자(대소문자)로 계산한 파이프는 다른 main — 무시(VS Code도 그렇게 봐요)
    pipes.list = [mainPipeName(udd.toUpperCase(), OLD)];
    assert.equal(await open(), NEW);
    // 파이프 이름 비교는 대소문자를 가리지 않아요(hex·판·꼬리만 있어요)
    pipes.list = [mainPipeName(udd, OLD).toUpperCase()];
    assert.equal(await open(), OLD);
  } finally {
    cleanup();
    t0.cleanup();
  }
});

test('launcher: the old install with the same profile under another spelling counts by its own spelling; another profile does not', async () => {
  const t0 = tempDir();
  const udd = join(t0.dir, 'user-data');
  const pipes = { list: [] as string[] };
  // 옛 설치본은 같은 폴더를 대문자로 적었어요 — 그 설치본이 띄운 main 파이프는 그 글자로 계산돼요
  const a = launcherCtx(pipes, udd, { userDataDir: udd.toUpperCase() });
  try {
    pipes.list = [mainPipeName(udd.toUpperCase(), OLD)];
    assert.equal((await a.launcher.launch({ workspaceFile: 'w', role: 'editor' })).version, OLD);
  } finally {
    a.cleanup();
  }
  const b = launcherCtx(pipes, udd, { userDataDir: join(t0.dir, 'elsewhere') });
  try {
    pipes.list = [mainPipeName(join(t0.dir, 'elsewhere'), OLD)];
    assert.equal((await b.launcher.launch({ workspaceFile: 'w', role: 'editor' })).version, NEW, 'a main on another profile does not collide');
    assert.deepEqual(await b.launcher.mark42AppState(), { newest: NEW, live: [] });
  } finally {
    b.cleanup();
    t0.cleanup();
  }
});

test('launcher: the extension CLI target follows the running main too', async () => {
  const t0 = tempDir();
  const udd = join(t0.dir, 'user-data');
  const pipes = { list: [] as string[] };
  const { launcher, cleanup } = launcherCtx(pipes, udd);
  try {
    assert.equal((await launcher.mark42ExtensionTarget())?.appVersion, NEW);
    pipes.list = [mainPipeName(udd, OLD)];
    const t = await launcher.mark42ExtensionTarget();
    assert.equal(t?.appVersion, OLD);
    assert.equal(t?.exe, 'C:\\Mk42\\app\\Mk42-1.143.1\\Mk42.exe');
  } finally {
    cleanup();
    t0.cleanup();
  }
});

// ---- 데몬 코어: appRestart 상태와 app.restartToUpdate

class FakeLauncher implements AppLauncherLike {
  live: string[] = [OLD, NEW];
  newest = NEW;
  /** 판마다 그 설치 폴더의 프로세스(옛 main이 정말 끝났는지 — C8) */
  procs: Record<string, number[]> = { [OLD]: [101, 102], [NEW]: [201] };
  /** 파이프 목록을 못 읽어요(C13) */
  stateFails = false;
  /** 프로세스 목록을 못 읽어요 */
  procsFail = false;
  launches: LaunchRequest[] = [];
  /** 일어난 일 차례(quit 알림·파이프 확인·띄우기) */
  events: string[];
  constructor(events: string[]) {
    this.events = events;
  }
  /** 띄울 때 부르는 확인(그때까지 일어난 일 보기) */
  onLaunch: (() => void) | undefined;
  async launch(req: LaunchRequest) {
    this.onLaunch?.();
    this.launches.push(req);
    this.events.push(`launch ${req.role} ${req.appVersion ?? '-'}`);
    return { exe: 'Mk42.exe', args: [], version: req.appVersion ?? this.newest };
  }
  async mark42AppState(): Promise<Mark42AppState> {
    if (this.stateFails) throw new Error('could not list the named pipes (running Mk42 mains unknown)');
    return { newest: this.newest, live: [...this.live] };
  }
  async mark42AppProcesses(version: string): Promise<number[]> {
    if (this.procsFail) throw new Error('process list failed');
    return [...(this.procs[version] ?? [])];
  }
  /** 옛 main이 끝났어요 — 파이프도 프로세스도 */
  oldExited(): void {
    this.live = this.live.filter((v) => v !== OLD);
    this.procs[OLD] = [];
  }
}

async function coreCtx(appRestart: NonNullable<ConstructorParameters<typeof DaemonCore>[0]['appRestart']>) {
  const t = tempDir();
  const home = join(t.dir, 'home');
  const project = join(t.dir, 'proj');
  mkdirSync(project, { recursive: true });
  const registry = await Registry.load(home);
  const events: string[] = [];
  const launcher = new FakeLauncher(events);
  const core = new DaemonCore({ home, registry, indexers: [], launcher, newId: sequenceIds(), stateDebounceMs: 5, resumeGapMs: 0, appRestart });
  const clients: TestClient[] = [];
  const win = async (w: Partial<WindowInfo> & Pick<WindowInfo, 'role'>): Promise<TestClient> => {
    const [a, b] = memoryChannelPair();
    core.attach(new RpcPeer(a), 'pipe');
    const c = wrapPeer(new RpcPeer(b));
    clients.push(c);
    // 새 Mark42 확장은 app.quitForUpdate를 안다고 알려요(C11) — 옛 확장 흉내는 capabilities: undefined
    await c.hello({ appName: 'Mark42', capabilities: [CAPABILITY_QUIT_FOR_UPDATE], ...w });
    return c;
  };
  return {
    home,
    project,
    registry,
    core,
    launcher,
    events,
    win,
    cleanup: async () => {
      for (const c of clients) c.close();
      await core.close();
      t.cleanup();
    },
  };
}

test('appRestart: reported while a Mark42 window runs an older live main; not for VS Code windows, other profiles or current windows', async () => {
  const c = await coreCtx({});
  try {
    const cur = await c.win({ role: 'editor', appVersion: NEW, folderPath: c.project });
    const code = await c.win({ role: 'editor', appVersion: '1.100.0', appName: 'Visual Studio Code', folderPath: c.project });
    let s: Mk42UpdateStatus = await cur.request('update.status', {});
    assert.equal(s.appRestart, undefined, 'no old Mark42 window');
    assert.equal(s.state, 'disabled');
    void code;

    const old = await c.win({ role: 'agent-claude', appVersion: OLD, slotId: 's-a', folderPath: c.project, sessionId: 'sess-a' });
    s = await cur.request('update.status', {});
    assert.deepEqual(s.appRestart, { running: OLD, available: NEW });
    // 다른 창들도 update.changed로 알아요
    const changed = await cur.waitFor('update.changed', (p) => p.appRestart?.running === OLD);
    assert.equal(changed.appRestart?.available, NEW);

    // 옛 판 main이 이 프로필에 없으면(다른 프로필 창) 해당 없음
    c.launcher.live = [NEW];
    s = await cur.request('update.status', {});
    assert.equal(s.appRestart, undefined);
    c.launcher.live = [OLD, NEW];
    s = await cur.request('update.status', {});
    assert.ok(s.appRestart);
    // 옛 판 창이 닫히면 사라지고, 모두에게 알려요
    const n0 = cur.notifications.length;
    old.close();
    await until(() => cur.notifications.slice(n0).some((n) => n.method === 'update.changed' && (n.params as Mk42UpdateStatus).appRestart === undefined), 2000, 'cleared');
  } finally {
    await c.cleanup();
  }
});

test('app.restartToUpdate: quit request → wait for the old main pipe to go → reopen on the newest, agent slots rebind without a prompt; hub & current windows untouched', async () => {
  const c = await coreCtx({ timeoutMs: 5000, pollMs: 10, settleMs: 0 });
  try {
    const cur = await c.win({ role: 'editor', appVersion: NEW, folderPath: c.project });
    const agent = await c.win({ role: 'agent-claude', appVersion: OLD, slotId: 's-a', folderPath: c.project, sessionId: 'sess-a' });
    const editorWs = join(c.project, 'mine.code-workspace');
    const editor = await c.win({ role: 'editor', appVersion: OLD, folderPath: c.project, workspaceFile: editorWs });
    const agentNoSession = await c.win({ role: 'agent-codex', appVersion: OLD, slotId: 's-b', folderPath: c.project });
    // 통합 창(WebView2 — hub-ws)은 Mk42 main이 아니에요
    const [ha, hb] = memoryChannelPair();
    c.core.attach(new RpcPeer(ha), 'hub-ws');
    const hub = wrapPeer(new RpcPeer(hb));

    await assert.rejects(agent.request('app.restartToUpdate', { available: 7 as never }), /available/);
    const stale = await agent.request('app.restartToUpdate', { available: '1.150.0' });
    assert.equal(stale.started, false);
    assert.match(stale.error ?? '', /newest Mk42 app is now 1\.146\.0/);

    const r = await agent.request('app.restartToUpdate', { available: NEW });
    assert.deepEqual(r, { started: true, windows: 3 });
    const again = await cur.request('app.restartToUpdate', {});
    assert.equal(again.started, false, 'one restart at a time');

    for (const w of [agent, editor, agentNoSession]) {
      assert.deepEqual(await w.waitFor('app.quitForUpdate'), { appVersion: OLD, nextVersion: NEW });
    }
    await cur.waitFor('update.changed', (p) => p.appRestart?.restarting === true);
    await hub.waitFor('update.changed', (p) => p.appRestart?.restarting === true);
    assert.ok(!cur.notifications.some((n) => n.method === 'app.quitForUpdate'), 'the current-version window stays');
    assert.ok(!hub.notifications.some((n) => n.method === 'app.quitForUpdate'), 'the hub window stays');

    // 옛 main 파이프가 남아 있는 동안은 아무것도 띄우지 않아요(창이 먼저 닫혀도)
    for (const w of [agent, editor, agentNoSession]) w.close();
    await delay(80);
    assert.equal(c.launcher.launches.length, 0);

    let quitBeforeLaunch: boolean | undefined;
    c.launcher.onLaunch = () =>
      (quitBeforeLaunch ??= [agent, editor, agentNoSession].every((w) => w.notifications.some((n) => n.method === 'app.quitForUpdate')));
    c.launcher.oldExited();
    await until(() => c.launcher.launches.length === 3, 2000, 'relaunch');
    assert.equal(quitBeforeLaunch, true);
    for (const l of c.launcher.launches) {
      assert.equal(l.appVersion, NEW);
      assert.equal(l.appProduct, 'mark42');
      assert.equal(l.exactVersion, false);
    }
    const [la, le, lb] = c.launcher.launches;
    assert.equal(la!.role, 'agent-claude');
    assert.equal(la!.workspaceFile, roleWorkspacePath({ home: c.home, role: 'agent-claude', folderPath: c.project, slotId: 's-a' }));
    assert.equal(le!.role, 'editor');
    assert.equal(le!.workspaceFile, editorWs);
    assert.equal(lb!.role, 'agent-codex');
    assert.equal(lb!.workspaceFile, roleWorkspacePath({ home: c.home, role: 'agent-codex', folderPath: c.project, slotId: 's-b' }));
    await cur.waitFor('update.changed', (p) => p.appRestart === undefined);

    // 다시 연 에이전트 창: 같은 세션을 다시 묶고(openSession), 프롬프트·자동 전송은 없어요
    const reopened = await c.win({ role: 'agent-claude', appVersion: NEW, slotId: 's-a', folderPath: c.project });
    const open = await reopened.waitFor('agent.openSession');
    assert.equal(open.sessionId, 'sess-a');
    assert.equal(open.autoSend, false);
    assert.equal(open.prompt, undefined);
    assert.equal(open.newSession, undefined);
    // 세션이 없던 슬롯은 대기 알림 없이 같은 슬롯만
    const reopenedB = await c.win({ role: 'agent-codex', appVersion: NEW, slotId: 's-b', folderPath: c.project });
    await delay(30);
    assert.ok(!reopenedB.notifications.some((n) => n.method === 'agent.openSession'));
  } finally {
    await c.cleanup();
  }
});

test('app.restartToUpdate: if the old main does not go away in time, it stops (nothing relaunched, nothing killed) and reports failed: timeout', async () => {
  const c = await coreCtx({ timeoutMs: 60, pollMs: 10, settleMs: 0 });
  try {
    const old = await c.win({ role: 'editor', appVersion: OLD, folderPath: c.project });
    const r = await old.request('app.restartToUpdate', {});
    assert.equal(r.started, true);
    await old.waitFor('app.quitForUpdate');
    // 창이 저장 확인 등으로 끝내지 않았어요 — 그대로 붙어 있어요
    const failed = await old.waitFor('update.changed', (p) => p.appRestart?.failed === 'timeout', 3000);
    assert.equal(failed.appRestart?.restarting, undefined);
    assert.equal(failed.appRestart?.running, OLD);
    assert.match(failed.appRestart?.error ?? '', /did not close within/);
    assert.equal(c.launcher.launches.length, 0);
    const s = await old.request('update.status', {});
    assert.equal(s.appRestart?.failed, 'timeout');
    // 다시 해 볼 수 있어요
    const n0 = old.notifications.length;
    const again = await old.request('app.restartToUpdate', {});
    assert.equal(again.started, true);
    await until(() => old.notifications.slice(n0).some((n) => n.method === 'update.changed' && (n.params as Mk42UpdateStatus).appRestart?.restarting === true), 2000, 'restarting again');
    const last = old.notifications.slice(n0).filter((n) => n.method === 'update.changed').at(-1)!.params as Mk42UpdateStatus;
    assert.equal(last.appRestart?.failed, undefined, 'a new attempt clears the old failure');
  } finally {
    await c.cleanup();
  }
});

test('app.restartToUpdate: nothing to restart → started false', async () => {
  const c = await coreCtx({});
  try {
    const cur = await c.win({ role: 'editor', appVersion: NEW, folderPath: c.project });
    const r = await cur.request('app.restartToUpdate', {});
    assert.equal(r.started, false);
    assert.match(r.error ?? '', /no open Mk42 window runs an older app version/);
  } finally {
    await c.cleanup();
  }
});

// ---- 검토 C8–C13

test('launcher: a failed pipe listing is «unknown», not «nothing running» — mark42AppState throws, a launch keeps its fallback (C13)', async () => {
  const t0 = tempDir();
  const udd = join(t0.dir, 'user-data');
  const pipes = { list: [mainPipeName(udd, OLD)] as string[] | undefined };
  const { launcher, cleanup } = launcherCtx(pipes as { list: string[] }, udd);
  try {
    assert.equal((await launcher.launch({ workspaceFile: 'w', role: 'editor' })).version, OLD);
    pipes.list = undefined;
    await assert.rejects(launcher.mark42AppState(), PipeListError);
    // 새 창 띄우기는 지금처럼 기본 선택(가장 새 판)으로 물러나요
    assert.equal((await launcher.launch({ workspaceFile: 'w', role: 'editor' })).version, NEW);
    assert.equal((await launcher.mark42ExtensionTarget())?.appVersion, NEW);
  } finally {
    cleanup();
    t0.cleanup();
  }
});

test('launcher: mark42AppProcesses lists processes inside that version install folder only (C8)', async () => {
  const { dir: home, cleanup } = tempDir();
  const asked: string[] = [];
  const installs: DiscoveredInstall[] = [
    { version: NEW, exe: 'C:\\Mk42\\app\\Mk42-1.146.0\\Mk42.exe', product: 'mark42', source: 'registry' },
    { version: OLD, exe: 'C:\\Mk42\\app\\Mk42-1.143.1\\Mk42.exe', product: 'mark42', source: 'registry' },
    { version: OLD, exe: 'C:\\VSC\\Code.exe', source: 'official' },
  ];
  let fail = false;
  const alive = new Set<number>();
  const launcher = new AppLauncher({
    pidAlive: (pid) => alive.has(pid),
    home,
    getSettings: () => emptyRegistry().settings,
    discover: async () => installs,
    extensions: { ensure: async () => undefined, ensureVsix: async () => false },
    listProcesses: async (dir) => {
      if (fail) throw new Error('process list failed');
      asked.push(dir);
      return [7, process.pid, 8];
    },
    env: {},
  });
  try {
    assert.deepEqual(await launcher.mark42AppProcesses(OLD), [7, 8], 'the daemon itself is never counted');
    assert.deepEqual(asked, ['C:\\Mk42\\app\\Mk42-1.143.1'], 'only the Mk42 install of that version (not VS Code of the same version)');
    assert.deepEqual(await launcher.mark42AppProcesses('9.9.9'), [], 'no install → nothing to wait for');
    // 앞서 기록한 pid가 모두 끝났으면 목록(PowerShell) 없이 []
    asked.length = 0;
    assert.deepEqual(await launcher.mark42AppProcesses(OLD, [90, 91]), []);
    assert.equal(asked.length, 0, 'no listing when every recorded pid is gone');
    // 하나라도 살아 있으면 목록으로 확인해요(끝난 pid를 다른 프로세스가 받았을 수 있어요)
    alive.add(91);
    assert.deepEqual(await launcher.mark42AppProcesses(OLD, [90, 91]), [7, 8]);
    assert.equal(asked.length, 1);
    fail = true;
    await assert.rejects(launcher.mark42AppProcesses(OLD), /process list failed/);
  } finally {
    cleanup();
  }
});

test('app.restartToUpdate: the pipe going away is not enough — waits until the old install processes exit, then settles, then relaunches (C8)', async () => {
  const c = await coreCtx({ timeoutMs: 5000, pollMs: 10, settleMs: 60 });
  try {
    const old = await c.win({ role: 'editor', appVersion: OLD, folderPath: c.project });
    assert.equal((await old.request('app.restartToUpdate', {})).started, true);
    await old.waitFor('app.quitForUpdate');
    old.close();
    // main이 파이프를 놓았지만(onWillShutdown) 확장 호스트·Chromium이 아직 끝나는 중이에요
    c.launcher.live = [NEW];
    c.launcher.procs[OLD] = [102, 555]; // 555 = 그사이 같은 폴더에서 뜬 다른 프로세스(기록에 없어요 — 기다리지 않아요)
    await delay(120);
    assert.equal(c.launcher.launches.length, 0, 'no relaunch while a recorded old process is alive');
    c.launcher.procs[OLD] = [555];
    const t = Date.now();
    await until(() => c.launcher.launches.length === 1, 2000, 'relaunch after the processes exit');
    assert.ok(Date.now() - t >= 50, 'settles after the processes exit');
    assert.equal(c.launcher.launches[0]!.appVersion, NEW);
  } finally {
    await c.cleanup();
  }
});

test('app.restartToUpdate: without a process snapshot it waits the longer unverified settle after the pipe goes (C8)', async () => {
  const c = await coreCtx({ timeoutMs: 5000, pollMs: 10, settleMs: 0, unverifiedSettleMs: 150 });
  try {
    c.launcher.procsFail = true;
    const old = await c.win({ role: 'editor', appVersion: OLD, folderPath: c.project });
    assert.equal((await old.request('app.restartToUpdate', {})).started, true);
    await old.waitFor('app.quitForUpdate');
    old.close();
    c.launcher.live = [NEW];
    await delay(80);
    assert.equal(c.launcher.launches.length, 0);
    await until(() => c.launcher.launches.length === 1, 2000, 'relaunch after the long settle');
  } finally {
    await c.cleanup();
  }
});

test('app.restartToUpdate: a failed pipe listing during the wait counts as «still running» (C13)', async () => {
  const c = await coreCtx({ timeoutMs: 5000, pollMs: 10, settleMs: 0 });
  try {
    const old = await c.win({ role: 'editor', appVersion: OLD, folderPath: c.project });
    assert.equal((await old.request('app.restartToUpdate', {})).started, true);
    await old.waitFor('app.quitForUpdate');
    old.close();
    c.launcher.stateFails = true;
    c.launcher.oldExited();
    await delay(80);
    assert.equal(c.launcher.launches.length, 0, 'unknown is not gone');
    c.launcher.stateFails = false;
    await until(() => c.launcher.launches.length === 1, 2000, 'relaunch');
    assert.equal(c.launcher.launches[0]!.appVersion, NEW);
    // 시작할 때 목록을 못 읽으면 시작하지 않아요
    const cur = await c.win({ role: 'editor', appVersion: NEW, folderPath: c.project });
    c.launcher.stateFails = true;
    const r = await cur.request('app.restartToUpdate', {});
    assert.equal(r.started, false);
    assert.match(r.error ?? '', /could not tell which Mk42 apps are running/);
  } finally {
    await c.cleanup();
  }
});

test('app.restartToUpdate: on timeout the windows that already closed reopen on the running old main, the vetoing one stays; when the old main exits later all reopen on the newest (C9)', async () => {
  const c = await coreCtx({ timeoutMs: 80, pollMs: 10, settleMs: 0, watchPollMs: 20, watchMs: 60_000 });
  try {
    const agent = await c.win({ role: 'agent-claude', appVersion: OLD, slotId: 's-a', folderPath: c.project, sessionId: 'sess-a' });
    const veto = await c.win({ role: 'editor', appVersion: OLD, folderPath: c.project });
    assert.deepEqual(await agent.request('app.restartToUpdate', {}), { started: true, windows: 2 });
    await agent.waitFor('app.quitForUpdate');
    // 에이전트 창은 닫혔고, 편집 창은 «실행 중인 작업을 끝낼까요?»에 답을 기다려요(끝내기 취소)
    agent.close();
    const failed = await veto.waitFor('update.changed', (p) => p.appRestart?.failed === 'timeout', 3000);
    assert.match(failed.appRestart?.error ?? '', /save prompt or a running task/);
    assert.match(failed.appRestart?.error ?? '', /outdated Mark42 extension/);
    assert.match(failed.appRestart?.error ?? '', /reopen on 1\.146\.0 once Mk42 1\.143\.1 exits/);
    await until(() => c.launcher.launches.length === 1, 2000, 'the closed window reopens now');
    const [first] = c.launcher.launches;
    assert.equal(first!.role, 'agent-claude');
    assert.equal(first!.appVersion, undefined, 'no version → the launcher sends it to the still-running old main (no second main)');
    await delay(60);
    assert.equal(c.launcher.launches.length, 1, 'the vetoing window is not reopened while attached');

    // 다시 연 에이전트 창은 옛 main에 붙어요. 사용자가 나중에 «끝내기»를 골라 옛 main이 끝나요
    const agentAgain = await c.win({ role: 'agent-claude', appVersion: OLD, slotId: 's-a', folderPath: c.project });
    // 지켜보는 동안 옛 main에 새로 붙은 Mk42 창도 함께 기록해요
    const late = await c.win({ role: 'agent-codex', appVersion: OLD, slotId: 's-late', folderPath: c.project });
    await delay(40);
    assert.equal(c.launcher.launches.length, 1);
    for (const w of [agentAgain, late, veto]) w.close();
    c.launcher.oldExited();
    await until(() => c.launcher.launches.length === 4, 2000, 'all reopen on the newest');
    const rest = c.launcher.launches.slice(1);
    assert.deepEqual(rest.map((l) => [l.role, l.appVersion]).sort(), [
      ['agent-claude', NEW],
      ['agent-codex', NEW],
      ['editor', NEW],
    ]);
    await delay(60);
    assert.equal(c.launcher.launches.length, 4, 'each window once');
  } finally {
    await c.cleanup();
  }
});

test('app.restartToUpdate: while the old main closes, unversioned Mk42 launches are refused and the closing windows are not focused (C10)', async () => {
  const c = await coreCtx({ timeoutMs: 5000, pollMs: 10, settleMs: 0 });
  try {
    const cur = await c.win({ role: 'editor', appVersion: NEW, folderPath: c.project });
    const old = await c.win({ role: 'agent-claude', appVersion: OLD, slotId: 's-a', folderPath: c.project, sessionId: 'sess-a' });
    await c.registry.update((d) => {
      d.slots.push({ slotId: 's-a', folderPath: c.project, agent: 'claude', sessionId: 'sess-a', createdAt: new Date().toISOString() });
    });
    const oldEditor = await c.win({ role: 'editor', appVersion: OLD, folderPath: join(c.project, '..') });
    assert.equal((await cur.request('app.restartToUpdate', {})).started, true);
    await old.waitFor('app.quitForUpdate');
    const slots = c.registry.data.slots.length;

    // 새 세션 창: 슬롯을 만들기 전에 거절
    await assert.rejects(cur.request('window.open', { role: 'agent-claude', folderPath: c.project, newSession: true }), /Mk42 is restarting to apply 1\.146\.0/);
    assert.equal(c.registry.data.slots.length, slots, 'no orphan slot');
    // 닫는 중인 창이 든 세션: 그 창에 보내거나 포커스하지 않고 거절
    await assert.rejects(cur.request('window.open', { role: 'agent-claude', folderPath: c.project, sessionId: 'sess-a' }), /restarting/);
    assert.ok(!old.notifications.some((n) => n.method === 'agent.openSession'));
    // 닫는 중인 편집 창의 링크도 그 창에 보내지 않아요
    await assert.rejects(cur.request('editor.route', { folderPath: join(c.project, '..'), uri: 'file:///x', kind: 'file' }), /restarting/);
    assert.ok(!oldEditor.notifications.some((n) => n.method === 'editor.openUri'));
    // 새 판 창은 그대로 포커스(판을 정한 포커스는 지나가요)
    const f = await cur.request('window.open', { role: 'editor', folderPath: c.project });
    assert.equal(f.status, 'focused');
    await until(() => c.launcher.launches.length === 1, 2000, 'focus');
    assert.deepEqual([c.launcher.launches[0]!.appVersion, c.launcher.launches[0]!.exactVersion], [NEW, true]);
    // 다른 앱(공식 VS Code) 창은 상관없어요
    await c.registry.update((d) => {
      d.settings.defaultAppProduct = 'vscode';
    });
    assert.equal((await cur.request('window.open', { role: 'agent-codex', folderPath: c.project, newSession: true })).status, 'launched');
    await c.registry.update((d) => {
      d.settings.defaultAppProduct = 'mark42';
    });

    // 끝나면 다시 받아요
    old.close();
    oldEditor.close();
    c.launcher.oldExited();
    await until(() => c.launcher.launches.filter((l) => l.appVersion === NEW && !l.exactVersion).length === 2, 2000, 'relaunch');
    assert.equal((await cur.request('window.open', { role: 'agent-claude', folderPath: c.project, newSession: true })).status, 'launched');
  } finally {
    await c.cleanup();
  }
});

test('app.restartToUpdate: an old version whose windows all run an older Mark42 extension is not restarted; the status says to reload (C11)', async () => {
  const c = await coreCtx({ timeoutMs: 5000, pollMs: 10, settleMs: 0 });
  try {
    const cur = await c.win({ role: 'editor', appVersion: NEW, folderPath: c.project });
    const stale = await c.win({ role: 'editor', appVersion: OLD, folderPath: c.project, capabilities: undefined });
    let s: Mk42UpdateStatus = await cur.request('update.status', {});
    assert.deepEqual(s.appRestart, { running: OLD, available: NEW, needsReload: [OLD] });
    const r = await cur.request('app.restartToUpdate', {});
    assert.equal(r.started, false);
    assert.match(r.error ?? '', /older Mark42 extension .* reload one of those windows \(Developer: Reload Window\) or close them yourself/);
    assert.ok(!stale.notifications.some((n) => n.method === 'app.quitForUpdate'), 'nothing is asked to quit');
    // 그 판 창 하나라도 새 확장이면(다시 로드) 그 main 전체를 끝낼 수 있어요
    await c.win({ role: 'agent-claude', appVersion: OLD, slotId: 's-a', folderPath: c.project });
    s = await cur.request('update.status', {});
    assert.deepEqual(s.appRestart, { running: OLD, available: NEW });
    assert.deepEqual(await cur.request('app.restartToUpdate', {}), { started: true, windows: 2 });
    await stale.waitFor('app.quitForUpdate');
  } finally {
    await c.cleanup();
  }
});
