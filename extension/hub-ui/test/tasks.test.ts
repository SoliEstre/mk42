import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, type BackgroundAgent, type BackgroundWorkflow, type SessionTasks, type TokenUsage } from '@mark42/protocol';
import {
  adjacentTab,
  currentPhaseIndex,
  cwdBasename,
  folderForCwd,
  formatDuration,
  formatPercent,
  formatTokens,
  HUB_TABS,
  isOpen,
  liveStartMs,
  parseHubTab,
  parseOpenState,
  progressRatio,
  runningTotal,
  sessionProgress,
  sortByActivity,
  sortSessionTasks,
  sortWorkflowAgents,
  taskElapsedMs,
  taskSessionKey,
  taskSessionTitle,
  taskStatusView,
  toggleOpen,
  tokenTooltip,
  workflowKey,
  workflowName,
} from '../src/model.ts';
import { ALL_TOPICS } from '../src/refresh.ts';
import { HubStore } from '../src/store.ts';
import { FakeConnection, FakeTimers, flush } from './fakes.ts';
import { setLanguage } from '../src/i18n.ts';

// 한국어 화면 글을 그대로 확인해요(이 PC의 표시 언어와 무관하게).
setLanguage('ko');

const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };

function agent(p: Partial<BackgroundAgent> & { id: string }): BackgroundAgent {
  return { label: p.id, status: 'done', updatedAt: '2026-10-30T00:00:00.000Z', ...p };
}

function workflow(p: Partial<BackgroundWorkflow> & { runId: string }): BackgroundWorkflow {
  return {
    phases: [],
    agents: [],
    status: 'done',
    updatedAt: '2026-10-30T00:00:00.000Z',
    progress: { done: 0, total: 0 },
    tokens: NO_TOKENS,
    ...p,
  };
}

function session(p: Partial<SessionTasks> & { sessionId: string }): SessionTasks {
  return {
    agent: 'claude',
    cwd: 'c:\\dev\\rocket',
    workflows: [],
    subagents: [],
    running: 0,
    tokens: NO_TOKENS,
    updatedAt: '2026-10-30T00:00:00.000Z',
    ...p,
  };
}

// ---- 탭 ----

test('parseHubTab: 저장된 탭을 되살리고 모르는 값은 고정 세션으로', () => {
  assert.equal(parseHubTab('tasks'), 'tasks');
  assert.equal(parseHubTab('folders'), 'folders');
  assert.equal(parseHubTab('pinned'), 'pinned');
  assert.equal(parseHubTab(undefined), 'pinned');
  assert.equal(parseHubTab('bogus'), 'pinned');
  assert.equal(parseHubTab(3), 'pinned');
});

test('adjacentTab: ←→로 세 탭을 돌아요(끝에서 반대쪽 끝으로)', () => {
  assert.deepEqual(HUB_TABS, ['pinned', 'folders', 'tasks']);
  assert.equal(adjacentTab('pinned', 1), 'folders');
  assert.equal(adjacentTab('folders', 1), 'tasks');
  assert.equal(adjacentTab('tasks', 1), 'pinned');
  assert.equal(adjacentTab('pinned', -1), 'tasks');
  assert.equal(adjacentTab('tasks', -1), 'folders');
});

test('펼침 기억: 고른 적 없으면 기본값, 고르면 그쪽을 기억하고 저장 → 불러오기로 이어져요', () => {
  const s = parseOpenState(undefined, undefined);
  assert.equal(isOpen(s, 'k', true), true);
  assert.equal(isOpen(s, 'k', false), false);
  // 실행 중(기본 펼침)인 것을 접으면 접힘으로 기억
  assert.equal(toggleOpen(s, 'k', true), false);
  assert.equal(isOpen(s, 'k', true), false);
  // 끝나서 기본이 접힘으로 바뀌어도 고른 대로
  assert.equal(isOpen(s, 'k', false), false);
  assert.equal(toggleOpen(s, 'k', false), true);
  assert.equal(isOpen(s, 'k', false), true);
  assert.deepEqual([...s.open], ['k']);
  assert.deepEqual([...s.closed], []);
  toggleOpen(s, 'other', false);
  toggleOpen(s, 'third', true);
  // 저장(JSON) → 불러오기
  const saved = JSON.parse(JSON.stringify({ openTasks: [...s.open], closedTasks: [...s.closed] })) as Record<string, unknown>;
  const back = parseOpenState(saved.openTasks, saved.closedTasks);
  assert.equal(isOpen(back, 'k', false), true);
  assert.equal(isOpen(back, 'other', false), true);
  assert.equal(isOpen(back, 'third', true), false);
  assert.equal(isOpen(back, 'unknown', true), true);
});

test('펼침 기억: 이상한 저장 값은 버리고 개수를 묶어요(오래된 것부터 지움)', () => {
  const s = parseOpenState(['a', 1, null, 'b'], 'nope');
  assert.deepEqual([...s.open], ['a', 'b']);
  assert.deepEqual([...s.closed], []);
  const t = parseOpenState([], []);
  for (let i = 0; i < 5; i++) toggleOpen(t, `k${i}`, false, 3);
  assert.deepEqual([...t.open], ['k2', 'k3', 'k4']);
  // 다시 고르면 맨 뒤(가장 최근)로
  toggleOpen(t, 'k2', false, 3);
  toggleOpen(t, 'k2', false, 3);
  assert.deepEqual([...t.open], ['k3', 'k4', 'k2']);
  assert.deepEqual([...parseOpenState(['x', 'y', 'z'], [], 2).open], ['y', 'z']);
});

// ---- 형식 ----

test('formatTokens: 950 · 1.2k · 412k · 1.2M', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1000), '1k');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(9_949), '9.9k');
  assert.equal(formatTokens(9_950), '10k');
  assert.equal(formatTokens(412_345), '412k');
  assert.equal(formatTokens(999_499), '999k');
  assert.equal(formatTokens(999_500), '1M');
  assert.equal(formatTokens(1_234_567), '1.2M');
  assert.equal(formatTokens(35_400_000), '35M');
  assert.equal(formatTokens(undefined), '');
  assert.equal(formatTokens(-1), '');
  assert.equal(formatTokens(Number.NaN), '');
});

test('tokenTooltip: 합계와 0이 아닌 내역만', () => {
  assert.equal(tokenTooltip(undefined), '');
  assert.equal(tokenTooltip(NO_TOKENS), '');
  const t = tokenTooltip({ input: 1200, output: 3400, cacheRead: 400_000, cacheCreation: 0, total: 404_600 });
  assert.match(t, /^토큰 합계 404,600\n/);
  assert.match(t, /입력 1\.2k · 출력 3\.4k · 캐시 읽기 400k$/);
  assert.equal(tokenTooltip({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5000 }), '토큰 합계 5,000');
});

test('formatDuration: 35초 · 6분 31초 · 1시간 2분', () => {
  assert.equal(formatDuration(0), '0초');
  assert.equal(formatDuration(35_400), '35초');
  assert.equal(formatDuration(60_000), '1분');
  assert.equal(formatDuration(391_000), '6분 31초');
  assert.equal(formatDuration(3_600_000), '1시간');
  assert.equal(formatDuration(3_725_000), '1시간 2분');
  assert.equal(formatDuration(26 * 3_600_000), '1일 2시간');
  assert.equal(formatDuration(48 * 3_600_000), '2일');
  assert.equal(formatDuration(undefined), '');
  assert.equal(formatDuration(-5), '');
});

test('progressRatio·formatPercent: 다 끝나기 전에는 100%가 아니고, 전체 0이면 빈 글', () => {
  assert.equal(progressRatio({ done: 0, total: 0 }), 0);
  assert.equal(progressRatio({ done: 3, total: 4 }), 0.75);
  assert.equal(progressRatio({ done: 5, total: 4 }), 1);
  assert.equal(formatPercent({ done: 0, total: 0 }), '');
  assert.equal(formatPercent({ done: 1, total: 3 }), '33%');
  assert.equal(formatPercent({ done: 999, total: 1000 }), '99%');
  assert.equal(formatPercent({ done: 4, total: 4 }), '100%');
});

test('taskElapsedMs·liveStartMs: 실행 중은 지금까지, 끝난 것은 끝(없으면 마지막 움직임)까지', () => {
  const now = Date.parse('2026-10-30T01:00:00Z');
  const startedAt = '2026-10-30T00:50:00Z';
  assert.equal(taskElapsedMs({ status: 'running', startedAt, updatedAt: '2026-10-30T00:55:00Z' }, now), 600_000);
  assert.equal(taskElapsedMs({ status: 'done', startedAt, endedAt: '2026-10-30T00:52:00Z', updatedAt: '2026-10-30T00:59:00Z' }, now), 120_000);
  assert.equal(taskElapsedMs({ status: 'stale', startedAt, updatedAt: '2026-10-30T00:53:00Z' }, now), 180_000);
  assert.equal(taskElapsedMs({ status: 'done', updatedAt: '2026-10-30T00:53:00Z' }, now), undefined);
  // 시계가 어긋나도 음수가 아니게
  assert.equal(taskElapsedMs({ status: 'running', startedAt: '2026-10-30T02:00:00Z', updatedAt: startedAt }, now), 0);
  assert.equal(liveStartMs({ status: 'running', startedAt, updatedAt: startedAt }), Date.parse(startedAt));
  assert.equal(liveStartMs({ status: 'done', startedAt, updatedAt: startedAt }), undefined);
  assert.equal(liveStartMs({ status: 'running', updatedAt: startedAt }), undefined);
});

test('currentPhaseIndex: 실행 중이면 덜 끝난 첫 단계, 없으면 마지막으로 시작한 단계', () => {
  assert.equal(currentPhaseIndex([], 'running'), -1);
  assert.equal(currentPhaseIndex([{ started: 0, done: 0 }], 'running'), -1);
  const ph = (started: number, done: number) => ({ started, done });
  assert.equal(currentPhaseIndex([ph(3, 3), ph(2, 1), ph(1, 0)], 'running'), 1);
  assert.equal(currentPhaseIndex([ph(3, 3), ph(2, 2), ph(0, 0)], 'running'), 1);
  assert.equal(currentPhaseIndex([ph(3, 3), ph(2, 2), ph(4, 4)], 'running'), 2);
});

test('currentPhaseIndex: 끝남·실패·멈춤이면 지금 단계가 없어요', () => {
  const ph = (started: number, done: number) => ({ started, done });
  const allDone = [ph(3, 3), ph(2, 2), ph(4, 4)];
  const midway = [ph(3, 3), ph(2, 1), ph(0, 0)];
  for (const status of ['done', 'failed', 'stale'] as const) {
    assert.equal(currentPhaseIndex(allDone, status), -1, status);
    assert.equal(currentPhaseIndex(midway, status), -1, status);
  }
});

test('folderForCwd: 같은 경로 먼저, 없으면 cwd를 품은 가장 깊은 등록 폴더', () => {
  const folders = [
    { id: 'dev', path: 'C:\\Dev' },
    { id: 'mark42', path: 'C:\\Dev\\work area\\Mark42' },
    { id: 'src', path: 'c:/dev/work area/mark42/mark42/' },
    { id: 'posix', path: '/home/Me/proj' },
  ];
  const id = (cwd: string | undefined) => folderForCwd(folders, cwd)?.id;
  // 같은 경로(대소문자·구분자·끝 구분자 무시)
  assert.equal(id('c:\\dev\\work area\\mark42'), 'mark42');
  assert.equal(id('C:\\Dev\\work area\\Mark42\\mark42'), 'src');
  // 하위 폴더 → 가장 깊은 등록 폴더
  assert.equal(id('c:\\DEV\\work area\\mark42\\mark42\\extension\\hub-ui'), 'src');
  assert.equal(id('C:/Dev/work area/Mark42/.agent'), 'mark42');
  assert.equal(id('c:\\dev\\other'), 'dev');
  // 구분자 경계에서만: Mark42x는 Mark42의 하위가 아니에요
  assert.equal(id('C:\\Dev\\work area\\Mark42x'), 'dev');
  assert.equal(id('C:\\Devel'), undefined);
  assert.equal(id('D:\\Dev\\work area\\Mark42'), undefined);
  // POSIX 경로는 구분자 /
  assert.equal(id('/home/Me/proj/sub/dir'), 'posix');
  assert.equal(id('/home/Me/project'), undefined);
  assert.equal(id(undefined), undefined);
  // 루트 등록 폴더
  assert.equal(folderForCwd([{ path: 'C:\\' }], 'c:\\work\\x')?.path, 'C:\\');
  assert.equal(folderForCwd([{ path: '/' }], '/srv/app')?.path, '/');
  // 순서와 상관없이 가장 깊은 것
  assert.equal(folderForCwd([...folders].reverse(), 'c:\\dev\\work area\\mark42\\mark42\\daemon')?.id, 'src');
});

test('taskStatusView: 아이콘과 글', () => {
  assert.deepEqual(
    (['running', 'done', 'failed', 'stale'] as const).map((s) => taskStatusView(s).icon),
    ['⟳', '✔', '✖', '⏸'],
  );
  assert.equal(taskStatusView('failed').cls, 'failed');
  assert.equal(taskStatusView('bogus' as never).cls, 'stale');
});

test('sessionProgress·runningTotal: 워크플로우 진행 합 + 서브에이전트(실행 중 아니면 끝)', () => {
  const st = session({
    sessionId: 's',
    workflows: [workflow({ runId: 'wf_1', progress: { done: 3, total: 5 } }), workflow({ runId: 'wf_2', progress: { done: 2, total: 2 } })],
    subagents: [agent({ id: 'a', status: 'running' }), agent({ id: 'b', status: 'done' }), agent({ id: 'c', status: 'failed' })],
    running: 3,
  });
  assert.deepEqual(sessionProgress(st), { done: 7, total: 10 });
  assert.deepEqual(sessionProgress(session({ sessionId: 'e' })), { done: 0, total: 0 });
  assert.equal(runningTotal([st, session({ sessionId: 'x', running: 2 }), session({ sessionId: 'y' })]), 5);
});

test('이름·열쇠: 워크플로우 이름 없으면 runId, 세션 제목 한 줄, cwd 마지막 폴더', () => {
  assert.equal(workflowName(workflow({ runId: 'wf_9', name: '  ' })), 'wf_9');
  assert.equal(workflowName(workflow({ runId: 'wf_9', name: 'mark42-tasks' })), 'mark42-tasks');
  assert.equal(workflowKey({ runId: 'wf_9' }), 'w:wf_9');
  assert.equal(taskSessionKey({ agent: 'codex', sessionId: 't1' }), 's:codex:t1');
  assert.equal(taskSessionTitle({ title: '  여러\n줄  제목 ' }), '여러 줄 제목');
  assert.equal(taskSessionTitle({}), '');
  assert.equal(cwdBasename('c:\\dev\\work area\\mark42\\'), 'mark42');
  assert.equal(cwdBasename('/home/me/proj'), 'proj');
});

test('정렬: 세션은 실행 중 먼저·최근순, 작업은 실행 중 먼저·최근순, 워크플로우 agent는 단계·시작 순', () => {
  const sessions = sortSessionTasks([
    session({ sessionId: 'old', updatedAt: '2026-10-30T00:00:00Z' }),
    session({ sessionId: 'new', updatedAt: '2026-10-30T02:00:00Z' }),
    session({ sessionId: 'run', running: 1, updatedAt: '2026-10-29T00:00:00Z' }),
  ]);
  assert.deepEqual(sessions.map((s) => s.sessionId), ['run', 'new', 'old']);

  const subs = sortByActivity(
    [
      agent({ id: 'd1', status: 'done', updatedAt: '2026-10-30T03:00:00Z' }),
      agent({ id: 'r1', status: 'running', updatedAt: '2026-10-30T01:00:00Z' }),
      agent({ id: 'd2', status: 'failed', updatedAt: '2026-10-30T04:00:00Z' }),
    ],
    (a) => a.id,
  );
  assert.deepEqual(subs.map((a) => a.id), ['r1', 'd2', 'd1']);

  const phases = [{ title: '조사', started: 2, done: 2 }, { title: '구현', started: 2, done: 1 }];
  const agents = sortWorkflowAgents(
    [
      agent({ id: 'x', phase: '모름' }),
      agent({ id: 'b2', phase: '구현', startedAt: '2026-10-30T00:05:00Z' }),
      agent({ id: 'a2', phase: '조사', startedAt: '2026-10-30T00:02:00Z' }),
      agent({ id: 'b1', phase: '구현', startedAt: '2026-10-30T00:04:00Z' }),
      agent({ id: 'a1', phase: '조사', startedAt: '2026-10-30T00:01:00Z' }),
      agent({ id: 'b0', phase: '구현' }),
    ],
    phases,
  );
  assert.deepEqual(agents.map((a) => a.id), ['a1', 'a2', 'b1', 'b2', 'b0', 'x']);
});

// ---- 저장소 ----

test('store: 작업 목록을 처음에 읽고, state.changed tasks와 refreshTasks로 다시 읽어요', async () => {
  const conn = new FakeConnection();
  let list: SessionTasks[] = [session({ sessionId: 'a', updatedAt: '2026-10-30T00:00:00Z' })];
  conn
    .on('folders.list', () => [])
    .on('windows.list', () => [])
    .on('pinned.list', () => [])
    .on('autostart.get', () => ({ enabled: false, method: 'taskScheduler', taskName: '' }))
    .on('tasks.list', () => list);
  const timers = new FakeTimers();
  const errors: string[] = [];
  const store = new HubStore(conn, { timers, onError: (m) => errors.push(m) });
  const kinds: string[] = [];
  store.onChange((k) => kinds.push(...k));
  assert.ok(ALL_TOPICS.includes('tasks'));
  store.start();
  await flush(20);
  assert.equal(conn.count('tasks.list'), 1);
  assert.deepEqual(conn.requests.find((r) => r.method === 'tasks.list')?.params, {});
  assert.ok(store.data.loaded.has('tasks'));
  assert.ok(kinds.includes('tasks'));

  list = [session({ sessionId: 'a' }), session({ sessionId: 'b', running: 2 })];
  conn.emitNotification('state.changed', { topics: ['tasks'] });
  timers.advance(150);
  await flush(20);
  assert.equal(conn.count('tasks.list'), 2);
  // 실행 중인 세션이 먼저
  assert.deepEqual(store.data.tasks.map((s) => s.sessionId), ['b', 'a']);
  // tasks만 바뀌면 다른 목록은 다시 읽지 않아요
  assert.equal(conn.count('folders.list'), 1);
  assert.equal(conn.count('pinned.list'), 1);

  await store.refreshTasks();
  assert.equal(conn.count('tasks.list'), 3);
  assert.deepEqual(errors, []);
  store.dispose();
});

test('store: 옛 데몬(tasks.list 모름)·실패는 토스트 없이 tasksError로', async () => {
  const conn = new FakeConnection();
  const errors: string[] = [];
  const store = new HubStore(conn, { timers: new FakeTimers(), onError: (m) => errors.push(m) });
  await store.refreshTasks();
  assert.match(store.data.tasksError ?? '', /데몬/);
  assert.equal(store.data.loaded.has('tasks'), false);
  assert.equal(errors.length, 0);

  const orig = console.error;
  console.error = () => {};
  try {
    conn.on('tasks.list', () => {
      throw Object.assign(new Error('boom'), { code: ErrorCode.InternalError });
    });
    await store.refreshTasks();
    assert.match(store.data.tasksError ?? '', /^작업 목록: .*boom/);
  } finally {
    console.error = orig;
  }
  conn.on('tasks.list', () => [session({ sessionId: 'ok' })]);
  await store.refreshTasks();
  assert.equal(store.data.tasksError, undefined);
  assert.deepEqual(store.data.tasks.map((s) => s.sessionId), ['ok']);
  assert.equal(errors.length, 0);
});
