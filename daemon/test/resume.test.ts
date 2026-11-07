import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RpcPeer, type PinnedSession } from '@mark42/protocol';
import { Registry } from '../src/registry.ts';
import {
  createRemoteSessionProbe,
  isRemoteSessionFromEnv,
  runBootResume,
  runResume,
  startResume,
  type ResumeOutcome,
} from '../src/resume.ts';
import { DaemonCore } from '../src/server.ts';
import {
  delay,
  fakeLauncher,
  FakeIndexer,
  memoryChannelPair,
  sequenceIds,
  tempDir,
  until,
  wrapPeer,
  type SpawnCall,
} from './helpers.ts';

function pin(over: Partial<PinnedSession> & Pick<PinnedSession, 'id' | 'sessionId' | 'agent'>): PinnedSession {
  return {
    folderPath: 'C:\\proj',
    settings: {},
    resumePrompt: 'go',
    autoSend: true,
    enabled: true,
    order: 0,
    ...over,
  };
}

test('runResume: order, enabled filter, alive skip, explicit ids, launch failure', async () => {
  const opened: string[] = [];
  const sleeps: number[] = [];
  const pins = [
    pin({ id: 'b', sessionId: 's-b', agent: 'codex', order: 2 }),
    pin({ id: 'a', sessionId: 's-a', agent: 'claude', order: 1 }),
    pin({ id: 'c', sessionId: 's-c', agent: 'claude', order: 3, enabled: false }),
    pin({ id: 'd', sessionId: 's-d', agent: 'claude', order: 4 }),
    pin({ id: 'e', sessionId: 's-e', agent: 'claude', order: 5 }),
  ];
  let liveCalls = 0;
  const deps = {
    pinned: () => pins,
    live: async (agent: string) => {
      liveCalls++;
      return agent === 'claude' ? [{ agent: 'claude' as const, sessionId: 's-d', cwd: 'C:\\proj', status: 'idle' as const }] : [];
    },
    open: async (p: { sessionId?: string }) => {
      if (p.sessionId === 's-e') throw new Error('boom');
      opened.push(p.sessionId!);
      return { status: 'launched' as const, slotId: 'x' };
    },
    gapMs: 7,
    sleep: async (ms: number) => void sleeps.push(ms),
  };
  const r = await runResume(deps);
  assert.deepEqual(r.started, ['a', 'b']);
  assert.deepEqual(opened, ['s-a', 's-b']);
  assert.deepEqual(
    r.skipped.map((s) => [s.id, s.reason]),
    [
      ['d', 'alive'],
      ['e', 'launch-failed'],
    ],
  );
  assert.equal(liveCalls, 2, 'live() once per agent');
  assert.deepEqual(sleeps, [7, 7], 'gap only between launches');

  const r2 = await runResume(deps, ['c', 'zz']);
  assert.deepEqual(r2.started, ['c'], 'explicit ids ignore enabled');
  assert.deepEqual(r2.skipped, [{ id: 'zz', reason: 'not-found' }]);
});

test('runResume: live check failure skips (never risks opening a session twice)', async () => {
  const r = await runResume({
    pinned: () => [pin({ id: 'a', sessionId: 's', agent: 'claude' })],
    live: async () => {
      throw new Error('cannot read');
    },
    open: async () => {
      throw new Error('should not open');
    },
  });
  assert.deepEqual(r.started, []);
  assert.equal(r.skipped[0]?.reason, 'live-check-failed');
});

test('resume.runNow through the core: skips alive, launches others with prompt/settings delivered on hello', async () => {
  const t = tempDir();
  try {
    const home = join(t.dir, 'home');
    const project = join(t.dir, 'proj');
    mkdirSync(project, { recursive: true });
    const registry = await Registry.load(home);
    const calls: SpawnCall[] = [];
    const claude = new FakeIndexer('claude');
    const codex = new FakeIndexer('codex');
    claude.liveSessions = [{ agent: 'claude', sessionId: 'alive-1', cwd: project, status: 'busy' }];
    const core = new DaemonCore({
      home,
      registry,
      indexers: [claude, codex],
      launcher: fakeLauncher(home, () => registry.settings, calls),
      newId: sequenceIds(),
      resumeGapMs: 0,
      stateDebounceMs: 5,
    });
    const [a, b] = memoryChannelPair();
    core.attach(new RpcPeer(a), 'pipe');
    const ctl = wrapPeer(new RpcPeer(b));

    const p1 = await ctl.request('pinned.upsert', {
      folderPath: project,
      agent: 'claude',
      sessionId: 'alive-1',
      settings: {},
      resumePrompt: 'p1',
      autoSend: true,
      enabled: true,
      order: 1,
    });
    const p2 = await ctl.request('pinned.upsert', {
      folderPath: project,
      agent: 'codex',
      sessionId: 'thread-2',
      settings: { reasoningEffort: 'high' },
      resumePrompt: '재개해 주세요',
      autoSend: false,
      enabled: true,
      order: 2,
    });
    const r = await ctl.request('resume.runNow', {});
    assert.deepEqual(r.started, [p2.id]);
    assert.ok(!r.started.includes(p1.id));
    await until(() => calls.length === 1, 2000, 'launch');
    const slot = registry.data.slots.find((s) => s.sessionId === 'thread-2');
    assert.ok(slot);

    // 재개된 창이 붙으면 프롬프트·설정이 담긴 openSession
    const [c, d] = memoryChannelPair();
    core.attach(new RpcPeer(c), 'pipe');
    const win = wrapPeer(new RpcPeer(d));
    await win.hello({ role: 'agent-codex', slotId: slot.slotId, folderPath: project });
    const open = await win.waitFor('agent.openSession');
    assert.equal(open.sessionId, 'thread-2');
    assert.equal(open.prompt, '재개해 주세요');
    assert.equal(open.autoSend, false);
    assert.deepEqual(open.settings, { reasoningEffort: 'high' });

    // 그 세션을 든 Mark42 창이 이미 있으면(Codex live()가 못 봐도) 건너뛰고, 그 창에 프롬프트를 다시 넣지 않아요
    const r2 = await ctl.request('resume.runNow', { pinnedIds: [p2.id] });
    assert.deepEqual(r2.started, []);
    await delay(50);
    assert.equal(win.notifications.filter((n) => n.method === 'agent.openSession').length, 1);
    assert.equal(calls.length, 1);
    const out = await core.resumeNow([p2.id]);
    assert.deepEqual(out.skipped, [{ id: p2.id, reason: 'alive', detail: 'held by a Mark42 window' }]);

    // window.open(세션)으로 직접 와도 그 창은 포커스만 — openSession을 다시 보내지 않아요
    const focus = await core.openWindow({ role: 'agent-codex', folderPath: project, sessionId: 'thread-2' }, { prompt: 'x', autoSend: true });
    assert.equal(focus.status, 'focused');
    assert.equal(focus.requestId, undefined);
    await delay(20);
    assert.equal(win.notifications.filter((n) => n.method === 'agent.openSession').length, 1);
    await core.close();
  } finally {
    t.cleanup();
  }
});

test('runBootResume: console runs immediately', async () => {
  const outcome: ResumeOutcome = { started: ['x'], skipped: [] };
  const h = runBootResume({ mode: 'console', run: async () => outcome, isRemoteSession: () => false });
  assert.deepEqual(await h.done, outcome);
});

test('runBootResume: firstRemoteApp polls every pollMs until an RDP session, then runs once', async () => {
  const timers: { cb: () => void; ms: number }[] = [];
  let remote = false;
  let runs = 0;
  const h = runBootResume({
    mode: 'firstRemoteApp',
    run: async () => {
      runs++;
      return { started: [], skipped: [] };
    },
    isRemoteSession: () => remote,
    setTimer: (cb, ms) => timers.push({ cb, ms }),
    clearTimer: () => undefined,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 0);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, 10_000);
  timers.shift()!.cb();
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 0);
  remote = true;
  timers.shift()!.cb();
  await h.done;
  assert.equal(runs, 1);
});

test('runBootResume: cancel while waiting resolves undefined', async () => {
  const h = runBootResume({
    mode: 'firstRemoteApp',
    run: async () => ({ started: ['nope'], skipped: [] }),
    isRemoteSession: () => false,
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  h.cancel();
  assert.equal(await h.done, undefined);
});

test('startResume: auto-send windows go one at a time (waits for each report), planned resolves early', async () => {
  const events: string[] = [];
  const pending = new Map<string, (r: { ok: boolean }) => void>();
  let n = 0;
  const run = startResume({
    pinned: () => [
      pin({ id: 'a', sessionId: 's-a', agent: 'claude', order: 1 }),
      pin({ id: 'b', sessionId: 's-b', agent: 'codex', order: 2, autoSend: false }),
      pin({ id: 'c', sessionId: 's-c', agent: 'claude', order: 3 }),
      pin({ id: 'h', sessionId: 's-h', agent: 'codex', order: 4 }),
    ],
    live: async () => [],
    held: (_agent, sid) => sid === 's-h',
    open: async (p) => {
      events.push(`open ${p.sessionId}`);
      return { status: 'launched', requestId: `r${++n}` };
    },
    waitResult: (requestId) =>
      new Promise((resolve) => {
        events.push(`wait ${requestId}`);
        pending.set(requestId, resolve);
      }),
    gapMs: 0,
  });
  assert.deepEqual(await run.planned, ['a', 'b', 'c']);
  await until(() => pending.has('r1'));
  assert.deepEqual(events, ['open s-a', 'wait r1'], 'next window is not launched before the report');
  pending.get('r1')!({ ok: true });
  // b는 autoSend가 아니라서 기다리지 않고 바로 c
  await until(() => pending.has('r3'));
  assert.deepEqual(events, ['open s-a', 'wait r1', 'open s-b', 'open s-c', 'wait r3']);
  pending.get('r3')!({ ok: false });
  const out = await run.done;
  assert.deepEqual(out.started, ['a', 'b', 'c']);
  assert.deepEqual(out.skipped, [{ id: 'h', reason: 'alive', detail: 'held by a Mark42 window' }]);
});

test('startResume: a report timeout does not block the rest', async () => {
  const opened: string[] = [];
  const out = await runResume({
    pinned: () => [pin({ id: 'a', sessionId: 's-a', agent: 'claude', order: 1 }), pin({ id: 'b', sessionId: 's-b', agent: 'claude', order: 2 })],
    live: async () => [],
    open: async (p) => {
      opened.push(p.sessionId!);
      return { status: 'launched', requestId: `q-${p.sessionId}` };
    },
    waitResult: async () => undefined,
    gapMs: 0,
  });
  assert.deepEqual(opened, ['s-a', 's-b']);
  assert.deepEqual(out.started, ['a', 'b']);
});

test('DaemonCore.waitForResult resolves on window.reportResult, or undefined on timeout', async () => {
  const t = tempDir();
  try {
    const home = join(t.dir, 'home');
    const registry = await Registry.load(home);
    const core = new DaemonCore({ home, registry, indexers: [], launcher: fakeLauncher(home, () => registry.settings, []), newId: sequenceIds() });
    const [a, b] = memoryChannelPair();
    core.attach(new RpcPeer(a), 'pipe');
    const win = wrapPeer(new RpcPeer(b));
    await win.hello({ role: 'agent-claude', slotId: 'zz', folderPath: t.dir });
    const waiting = core.waitForResult('req-1', 2000);
    await win.request('window.reportResult', { requestId: 'req-1', ok: true, detail: 'sent' });
    const got = await waiting;
    assert.equal(got?.ok, true);
    assert.equal(got?.windowId, 'w1');
    assert.equal((await core.waitForResult('req-1', 10))?.detail, 'sent', 'already reported');
    assert.equal(await core.waitForResult('never', 10), undefined);
    await core.close();
  } finally {
    t.cleanup();
  }
});

test('runBootResume: trigger runs a waiting firstRemoteApp resume once', async () => {
  let runs = 0;
  const h = runBootResume({
    mode: 'firstRemoteApp',
    run: async () => {
      runs++;
      return { started: [], skipped: [] };
    },
    isRemoteSession: () => false,
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.waiting, true);
  assert.equal(h.trigger('forwarded'), true);
  assert.equal(h.trigger('again'), false);
  await h.done;
  assert.equal(runs, 1);
  assert.equal(h.waiting, false);
});

test('createRemoteSessionProbe: asks the OS each time (not the start-up env), falls back to env', async () => {
  const outputs = ['False', 'True', 'garbage'];
  const calls: string[][] = [];
  const probe = createRemoteSessionProbe(
    async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: outputs.shift() ?? '' };
    },
    { SESSIONNAME: 'RDP-Tcp#1' },
    'win32',
  );
  assert.equal(await probe(), false, 'console now even though the process started in RDP');
  assert.equal(await probe(), true);
  assert.equal(await probe(), true, 'unparsable → env fallback');
  assert.equal(calls.length, 3);
  assert.equal(calls[0]![0], 'powershell.exe');
  assert.ok(calls[0]!.some((a) => a.includes('TerminalServerSession')));
  assert.equal(await createRemoteSessionProbe(async () => ({ code: 0, stdout: 'True' }), {}, 'linux')(), false);
});

test('isRemoteSessionFromEnv', () => {
  assert.equal(isRemoteSessionFromEnv({ SESSIONNAME: 'RDP-Tcp#3' }), true);
  assert.equal(isRemoteSessionFromEnv({ SESSIONNAME: 'Console' }), false);
  assert.equal(isRemoteSessionFromEnv({}), false);
});
