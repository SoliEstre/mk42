import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ErrorCode,
  RpcError,
  type Folder,
  type PinnedSession,
  type SessionSummary,
} from '@mark42/protocol';
import { CLONE_REQUEST_TIMEOUT_MS, HubStore } from '../src/store.ts';
import { TopicDebouncer, expandTopics } from '../src/refresh.ts';
import { FakeConnection, FakeTimers, flush } from './fakes.ts';
import { setLanguage } from '../src/i18n.ts';

// 한국어 화면 글을 그대로 확인해요(이 PC의 표시 언어와 무관하게).
setLanguage('ko');

const FOLDERS: Folder[] = [
  { id: 'f1', path: 'C:\\Dev\\A', label: 'A', addedAt: '2026-10-17T00:00:00Z' },
  { id: 'f2', path: 'C:\\Dev\\B', label: '', addedAt: '2026-10-17T00:00:00Z' },
];

const SESSIONS: Record<string, SessionSummary[]> = {
  'C:\\Dev\\A': [
    { agent: 'claude', id: 'c1', cwd: 'c:\\dev\\a', updatedAt: '2026-10-17T01:00:00Z', model: 'opus', effort: 'high', title: '제목' },
    { agent: 'codex', id: 't1', cwd: 'c:\\dev\\a', updatedAt: '2026-10-17T02:00:00Z', model: 'gpt-5.5', effort: 'medium' },
  ],
  'C:\\Dev\\B': [],
};

function silence(): () => void {
  const orig = console.error;
  console.error = () => {};
  return () => {
    console.error = orig;
  };
}

function makeStore() {
  const conn = new FakeConnection();
  let pinned: PinnedSession[] = [];
  let nextPin = 1;
  conn
    .on('folders.list', () => FOLDERS)
    .on('sessions.list', (p) => SESSIONS[(p as { cwd: string }).cwd] ?? [])
    .on('windows.list', () => [])
    .on('pinned.list', () => pinned)
    .on('autostart.get', () => ({ enabled: false, method: 'taskScheduler', taskName: 'Mark42 resume' }))
    .on('autostart.set', (p) => ({ enabled: (p as { enabled: boolean }).enabled }))
    .on('pinned.upsert', (p) => {
      const v = { ...(p as PinnedSession) };
      if (!v.id) v.id = `p${nextPin++}`;
      pinned = [...pinned.filter((x) => x.id !== v.id), v];
      return v;
    })
    .on('pinned.remove', (p) => {
      pinned = pinned.filter((x) => x.id !== (p as { pinnedId: string }).pinnedId);
      return {};
    })
    .on('window.open', () => ({ status: 'launched' }))
    .on('resume.runNow', () => ({ started: ['p1'] }));
  const timers = new FakeTimers();
  const errors: string[] = [];
  const infos: string[] = [];
  const store = new HubStore(conn, { timers, onError: (m) => errors.push(m), onInfo: (m) => infos.push(m) });
  return { conn, store, timers, errors, infos, pinnedOnServer: () => pinned };
}

test('start: 연결돼 있으면 전부 읽고, 폴더마다 cwd로 세션을 읽어요(includeSubagents)', async () => {
  const { conn, store } = makeStore();
  const kinds: string[] = [];
  store.onChange((k) => kinds.push(...k));
  store.start();
  await flush(20);
  assert.equal(conn.count('folders.list'), 1);
  assert.equal(conn.count('windows.list'), 1);
  assert.equal(conn.count('pinned.list'), 1);
  assert.equal(conn.count('autostart.get'), 1);
  const sl = conn.requests.filter((r) => r.method === 'sessions.list').map((r) => r.params);
  assert.deepEqual(sl, [
    { cwd: 'C:\\Dev\\A', includeSubagents: true },
    { cwd: 'C:\\Dev\\B', includeSubagents: true },
  ]);
  assert.equal(store.data.sessions.get('f1')?.length, 2);
  assert.ok(store.data.loaded.has('sessions'));
  assert.equal(store.data.autostart?.taskName, 'Mark42 resume');
  assert.ok(kinds.includes('folders') && kinds.includes('sessions'));
});

test('start: 끊긴 상태면 기다렸다가 연결되면 읽어요', async () => {
  const { conn, store } = makeStore();
  conn.status = 'connecting';
  store.start();
  await flush();
  assert.equal(conn.requests.length, 0);
  conn.setStatus('connected');
  await flush(20);
  assert.equal(conn.count('folders.list'), 1);
  // 재연결 때도 다시 읽어요
  conn.setStatus('disconnected');
  conn.setStatus('connected');
  await flush(20);
  assert.equal(conn.count('folders.list'), 2);
});

test('state.changed는 150ms로 모아 한 번만, 주제별로 다시 읽어요', async () => {
  const { conn, store, timers } = makeStore();
  store.start();
  await flush(20);
  conn.requests.length = 0;
  conn.emitNotification('state.changed', { topics: ['pinned'] });
  timers.advance(100);
  conn.emitNotification('state.changed', { topics: ['pinned', 'windows'] });
  timers.advance(149);
  assert.equal(conn.requests.length, 0);
  timers.advance(1);
  await flush(20);
  assert.deepEqual(conn.requests.map((r) => r.method).sort(), ['pinned.list', 'windows.list']);

  conn.requests.length = 0;
  conn.emitNotification('state.changed', { topics: ['folders'] });
  timers.advance(150);
  await flush(20);
  assert.equal(conn.count('folders.list'), 1);
  assert.equal(conn.count('sessions.list'), 2);
  assert.equal(conn.count('windows.list'), 1);

  // 다른 알림은 무시
  conn.requests.length = 0;
  conn.emitNotification('editor.openUri', { uri: 'x', kind: 'file' });
  timers.advance(500);
  await flush();
  assert.equal(conn.requests.length, 0);
});

test('togglePin: 기본값으로 upsert, 다시 누르면 remove', async () => {
  const { store, conn, pinnedOnServer } = makeStore();
  store.start();
  await flush(20);
  const f = FOLDERS[0]!;
  const s = store.data.sessions.get('f1')!.find((x) => x.agent === 'claude')!;
  await store.togglePin(f, s);
  const up = conn.requests.find((r) => r.method === 'pinned.upsert')!.params as Omit<PinnedSession, 'id'>;
  assert.deepEqual(up, {
    folderPath: 'C:\\Dev\\A',
    agent: 'claude',
    sessionId: 'c1',
    settings: { model: 'opus', effort: 'high' },
    // 재개 프롬프트·자동 전송은 보내지 않아요 — 데몬이 판 기본값을 넣어요(pinned.defaults)
    enabled: false, // 부팅 재개는 고정한 뒤 직접 켜요
    order: 0,
    label: '제목',
  });
  assert.ok(store.isPinned(s));
  assert.equal(pinnedOnServer().length, 1);

  await store.togglePin(f, s);
  assert.equal(conn.count('pinned.remove'), 1);
  assert.equal(store.isPinned(s), undefined);
  assert.equal(pinnedOnServer().length, 0);
});

test('updatePinned·movePinned: 낙관적 갱신 후 저장, 순서는 바뀐 것만', async () => {
  const { store, conn } = makeStore();
  store.start();
  await flush(20);
  const [cs, xs] = [store.data.sessions.get('f1')![0]!, store.data.sessions.get('f1')![1]!];
  await store.togglePin(FOLDERS[0]!, cs);
  await store.togglePin(FOLDERS[0]!, xs);
  const [a, b] = store.data.pinned;
  assert.ok(a && b);

  conn.requests.length = 0;
  const pending = store.updatePinned(a.id, { resumePrompt: '이어서 해 주세요', autoSend: false });
  assert.equal(store.data.pinned.find((p) => p.id === a.id)?.resumePrompt, '이어서 해 주세요');
  await pending;
  const sent = conn.requests[0]!.params as PinnedSession;
  assert.equal(sent.id, a.id);
  assert.equal(sent.autoSend, false);
  assert.equal(sent.sessionId, a.sessionId);

  conn.requests.length = 0;
  await store.movePinned(b.id, -1);
  assert.deepEqual(store.data.pinned.map((p) => p.id), [b.id, a.id]);
  assert.equal(conn.count('pinned.upsert'), 2);
  conn.requests.length = 0;
  await store.movePinned(b.id, -1);
  assert.equal(conn.requests.length, 0);
});

test('addFolder: 절대 경로만, 따옴표는 벗겨요', async () => {
  const { store, conn, errors } = makeStore();
  conn.on('folders.add', (p) => ({ id: 'n', path: (p as { path: string }).path, label: '', addedAt: '' }));
  assert.equal(await store.addFolder('   '), false);
  assert.equal(await store.addFolder('relative\\dir'), false);
  assert.equal(errors.length, 1);
  assert.equal(await store.addFolder('"C:\\Dev\\New Proj"'), true);
  assert.deepEqual(conn.requests.find((r) => r.method === 'folders.add')?.params, { path: 'C:\\Dev\\New Proj' });
  assert.equal(await store.addFolder('\\\\server\\share\\x'), true);
});

test('cloneFolder: 넉넉한 요청 시간(데몬 10분보다 길게), 실패는 알리고 null', async () => {
  const restore = silence();
  try {
    const { store, conn, errors } = makeStore();
    conn.on('folders.clone', (p) => {
      const q = p as { url: string; parentDir: string };
      if (q.url.endsWith('/missing')) throw new RpcError(ErrorCode.CloneFailed, 'git clone 실패: Repository not found.');
      return { id: 'c', path: `${q.parentDir}\\repo`, label: 'repo', addedAt: '' };
    });
    const f = await store.cloneFolder('https://github.com/o/repo', 'C:\\Dev');
    assert.equal(f?.path, 'C:\\Dev\\repo');
    const req = conn.requests.find((r) => r.method === 'folders.clone')!;
    assert.deepEqual(req.params, { url: 'https://github.com/o/repo', parentDir: 'C:\\Dev' });
    assert.ok((req.timeoutMs ?? 0) > 10 * 60_000, 'longer than the daemon git limit — the 30 s default would give up mid-clone');
    assert.equal(CLONE_REQUEST_TIMEOUT_MS, req.timeoutMs);
    assert.equal(await store.cloneFolder('https://github.com/o/missing', 'C:\\Dev'), null);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /Repository not found/);
  } finally {
    restore();
  }
});

test('오류는 한국어로 알리고, 끊긴 상태의 조회 실패는 조용히', async () => {
  const restore = silence();
  try {
    const { store, conn, errors } = makeStore();
    conn.on('window.open', () => {
      throw new RpcError(ErrorCode.LaunchFailed, 'code.exe not found');
    });
    store.start();
    await flush(20);
    await store.openNewSession(FOLDERS[0]!, 'codex');
    assert.deepEqual(conn.requests.find((r) => r.method === 'window.open')?.params, {
      folderPath: 'C:\\Dev\\A',
      role: 'agent-codex',
      newSession: true,
    });
    assert.equal(errors.at(-1), '창 열기: 창을 띄우지 못했어요 (code.exe not found)');

    // 연결된 상태의 조회 실패는 알려요
    conn.on('pinned.list', () => {
      throw new RpcError(ErrorCode.InternalError, 'boom');
    });
    const before = errors.length;
    await store.refresh(new Set(['pinned']));
    assert.equal(errors.length, before + 1);
    assert.equal(errors.at(-1), '고정 세션 목록: 요청을 처리하지 못했어요 (boom)');
    // 조회 도중 끊겨서 실패한 건 헤더 상태로 보이니 조용히
    conn.on('pinned.list', () => {
      conn.status = 'disconnected';
      throw new RpcError(ErrorCode.InternalError, 'channel closed');
    });
    await store.refresh(new Set(['pinned']));
    assert.equal(errors.length, before + 1);
  } finally {
    restore();
  }
});

test('window.open 매개변수: 세션 열기·편집기', async () => {
  const { store, conn, infos } = makeStore();
  store.start();
  await flush(20);
  const s = store.data.sessions.get('f1')![1]!;
  await store.openSession(FOLDERS[0]!, s);
  await store.openEditor(FOLDERS[1]!);
  const opens = conn.requests.filter((r) => r.method === 'window.open').map((r) => r.params);
  assert.deepEqual(opens, [
    { folderPath: 'C:\\Dev\\A', role: 'agent-codex', sessionId: 't1' },
    { folderPath: 'C:\\Dev\\B', role: 'editor' },
  ]);
  assert.deepEqual(infos.slice(0, 2), ['창을 여는 중…', '창을 띄우고 있어요'], 'right away, then the result');
});

test('runNow·setAutostart', async () => {
  const { store, conn, infos } = makeStore();
  store.start();
  await flush(20);
  await store.runNow(['p1']);
  assert.deepEqual(conn.requests.find((r) => r.method === 'resume.runNow')?.params, { pinnedIds: ['p1'] });
  assert.equal(infos.at(-1), '1개 세션 재개를 시작했어요');
  await store.runNow();
  assert.deepEqual(conn.requests.filter((r) => r.method === 'resume.runNow')[1]?.params, {});
  await store.setAutostart(true);
  assert.equal(store.data.autostart?.enabled, true);
  assert.equal(store.data.autostart?.taskName, 'Mark42 resume');
});

test('removeFolder: 목록과 세션에서 바로 빼요', async () => {
  const { store, conn } = makeStore();
  conn.on('folders.remove', () => ({}));
  store.start();
  await flush(20);
  await store.removeFolder('f1');
  assert.deepEqual(store.data.folders.map((f) => f.id), ['f2']);
  assert.equal(store.data.sessions.has('f1'), false);
});

test('늦게 온 이전 응답은 버려요', async () => {
  const { store, conn } = makeStore();
  const resolvers: ((v: unknown) => void)[] = [];
  conn.on('windows.list', () => new Promise((r) => resolvers.push(r)));
  const p1 = store.refresh(new Set(['windows']));
  const p2 = store.refresh(new Set(['windows']));
  await flush();
  resolvers[1]!([{ role: 'editor', pid: 2, appVersion: '1', extensions: [], folderPath: 'C:\\Dev\\A' }]);
  resolvers[0]!([]);
  await Promise.all([p1, p2]);
  assert.equal(store.data.windows.length, 1);
});

test('expandTopics·TopicDebouncer', () => {
  assert.deepEqual([...expandTopics(['folders'])].sort(), ['folders', 'sessions', 'windows']);
  assert.deepEqual([...expandTopics(['bogus' as never, 'pinned'])], ['pinned']);
  const timers = new FakeTimers();
  const flushed: string[][] = [];
  const d = new TopicDebouncer((t) => flushed.push([...t].sort()), 150, timers);
  d.push([]);
  assert.equal(timers.pending, 0);
  d.push(['sessions']);
  d.push(['windows']);
  timers.advance(150);
  assert.deepEqual(flushed, [['sessions', 'windows']]);
  d.push(['pinned']);
  d.dispose();
  timers.advance(1000);
  assert.equal(flushed.length, 1);
});
