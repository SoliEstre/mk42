import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RESUME_PROMPTS, ErrorCode, RpcError, type PinnedSession, type SessionSummary } from '@mark42/protocol';
import {
  backoffDelay,
  buildSessionTree,
  chipsFor,
  compareNewestFirst,
  describeError,
  filterTree,
  findPinned,
  folderLabel,
  formatRelativeTime,
  groupByAgent,
  groupPinned,
  isPinnedGroupBy,
  makePinnedDraft,
  pinnedGroupNames,
  pinnedMatches,
  type PinnedGroupBy,
  type PinnedView,
  matchesQuery,
  movePinned,
  parseTokenFromHash,
  parseWindowNumberFromHash,
  pathKeyLite,
  rpcUrlFor,
  samePathLite,
  sessionTitle,
  settingsFromSession,
  sortNewestFirst,
  sortPinned,
  statusView,
  windowCountTooltip,
  windowsByFolder,
} from '../src/model.ts';
import { setLanguage } from '../src/i18n.ts';

// 한국어 화면 글을 그대로 확인해요(이 PC의 표시 언어와 무관하게).
setLanguage('ko');

function sess(p: Partial<SessionSummary> & { id: string }): SessionSummary {
  return { agent: 'codex', cwd: 'c:\\dev\\a', updatedAt: '2026-10-17T00:00:00.000Z', ...p };
}

function pin(p: Partial<PinnedSession> & { id: string; order: number }): PinnedSession {
  return {
    folderPath: 'C:\\Dev\\a',
    agent: 'claude',
    sessionId: `s-${p.id}`,
    settings: {},
    resumePrompt: DEFAULT_RESUME_PROMPTS.en,
    autoSend: true,
    enabled: true,
    ...p,
  };
}

test('pathKeyLite: Windows 경로는 대소문자·구분자·끝 구분자를 무시해요', () => {
  assert.equal(pathKeyLite('C:\\Dev\\Proj\\'), 'c:\\dev\\proj');
  assert.equal(pathKeyLite('c:/dev/proj'), 'c:\\dev\\proj');
  assert.equal(pathKeyLite('\\\\?\\C:\\Dev'), 'c:\\dev');
  assert.equal(pathKeyLite('C:\\'), 'c:\\');
  assert.equal(pathKeyLite('/home/u/x/'), '/home/u/x');
  assert.ok(samePathLite('C:\\Dev\\Rocket', 'c:/dev/rocket/'));
  assert.ok(!samePathLite('C:\\Dev\\a', 'C:\\Dev\\b'));
  assert.ok(!samePathLite(undefined, 'C:\\'));
});

test('folderLabel: 라벨이 없으면 마지막 경로 조각', () => {
  assert.equal(folderLabel({ label: '', path: 'C:\\Dev\\work area\\Mark42' }), 'Mark42');
  assert.equal(folderLabel({ label: '  내 프로젝트 ', path: 'C:\\x' }), '내 프로젝트');
  assert.equal(folderLabel({ label: '', path: 'C:\\Dev\\proj\\' }), 'proj');
});

test('sessionTitle: 제목 → 마지막 프롬프트 → id, 줄바꿈 접고 길이 자르기', () => {
  assert.equal(sessionTitle({ id: 'x', title: ' 제목 ', lastPrompt: 'p' }), '제목');
  assert.equal(sessionTitle({ id: 'x', title: '  ', lastPrompt: '첫 줄\n둘째 줄' }), '첫 줄 둘째 줄');
  assert.equal(sessionTitle({ id: 'abc' }), 'abc');
  const long = sessionTitle({ id: 'x', title: 'a'.repeat(100) }, 10);
  assert.equal(long.length, 10);
  assert.ok(long.endsWith('…'));
});

test('formatRelativeTime: 한국어 상대 시간', () => {
  const now = Date.parse('2026-10-17T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  assert.equal(formatRelativeTime(ago(10_000), now), '방금 전');
  assert.equal(formatRelativeTime(ago(-5_000), now), '방금 전');
  assert.equal(formatRelativeTime(ago(3 * MIN), now), '3분 전');
  assert.equal(formatRelativeTime(ago(59 * MIN), now), '59분 전');
  assert.equal(formatRelativeTime(ago(2 * HOUR), now), '2시간 전');
  assert.equal(formatRelativeTime(ago(DAY + HOUR), now), '어제');
  assert.equal(formatRelativeTime(ago(3 * DAY), now), '3일 전');
  assert.equal(formatRelativeTime(ago(15 * DAY), now), '2주 전');
  assert.equal(formatRelativeTime(ago(65 * DAY), now), '2개월 전');
  assert.equal(formatRelativeTime(ago(800 * DAY), now), '2년 전');
  assert.equal(formatRelativeTime(undefined, now), '');
  assert.equal(formatRelativeTime('not a date', now), '');
});

test('정렬: 최신순, 시각 없는 항목은 뒤로, 같으면 id 순', () => {
  const a = sess({ id: 'a', updatedAt: '2026-10-17T01:00:00Z' });
  const b = sess({ id: 'b', updatedAt: '2026-10-17T03:00:00Z' });
  const c = sess({ id: 'c', updatedAt: '' });
  const d = sess({ id: 'd', updatedAt: '2026-10-17T03:00:00Z' });
  assert.deepEqual(sortNewestFirst([a, c, d, b]).map((s) => s.id), ['b', 'd', 'a', 'c']);
  assert.equal(compareNewestFirst(a, a), 0);
});

test('groupByAgent: 에이전트별로 나누고 각각 최신순', () => {
  const g = groupByAgent([
    sess({ id: 'c1', agent: 'claude', updatedAt: '2026-10-01T00:00:00Z' }),
    sess({ id: 'x1', agent: 'codex', updatedAt: '2026-10-01T00:00:00Z' }),
    sess({ id: 'c2', agent: 'claude', updatedAt: '2026-10-02T00:00:00Z' }),
  ]);
  assert.deepEqual(g.claude.map((s) => s.id), ['c2', 'c1']);
  assert.deepEqual(g.codex.map((s) => s.id), ['x1']);
});

test('buildSessionTree: 서브에이전트를 부모 아래로, 고아는 루트, 순환은 끊어요 (D22)', () => {
  const list = [
    sess({ id: 'p', updatedAt: '2026-10-17T01:00:00Z' }),
    sess({ id: 'k1', parentId: 'p', isSubagent: true, updatedAt: '2026-10-17T02:00:00Z' }),
    sess({ id: 'k2', parentId: 'p', isSubagent: true, updatedAt: '2026-10-17T03:00:00Z' }),
    sess({ id: 'g1', parentId: 'k1', isSubagent: true, updatedAt: '2026-10-17T04:00:00Z' }),
    sess({ id: 'orphan', parentId: 'gone', isSubagent: true, updatedAt: '2026-10-16T00:00:00Z' }),
    sess({ id: 'cy1', parentId: 'cy2', updatedAt: '2026-10-10T00:00:00Z' }),
    sess({ id: 'cy2', parentId: 'cy1', updatedAt: '2026-10-09T00:00:00Z' }),
    sess({ id: 'self', parentId: 'self', updatedAt: '2026-10-08T00:00:00Z' }),
    // 다른 agent의 같은 id는 부모가 아니에요
    sess({ id: 'cl', agent: 'claude', parentId: 'p', updatedAt: '2026-10-07T00:00:00Z' }),
  ];
  const roots = buildSessionTree(list);
  const ids = roots.map((r) => r.session.id);
  assert.deepEqual(ids.slice(0, 2), ['p', 'orphan']);
  assert.ok(ids.includes('self'));
  assert.ok(ids.includes('cl'));
  const p = roots[0]!;
  assert.deepEqual(p.children.map((c) => c.session.id), ['k2', 'k1']);
  assert.equal(p.descendantCount, 3);
  assert.deepEqual(p.children[1]!.children.map((c) => c.session.id), ['g1']);
  // 순환 둘 중 하나는 루트로 남고 나머지는 그 아래로
  const cyRoots = roots.filter((r) => r.session.id === 'cy1' || r.session.id === 'cy2');
  assert.equal(cyRoots.length, 1);
  assert.equal(cyRoots[0]!.descendantCount, 1);
  // 모든 세션이 정확히 한 번씩 나와요
  const all: string[] = [];
  const walk = (ns: typeof roots) => ns.forEach((n) => (all.push(`${n.session.agent}:${n.session.id}`), walk(n.children)));
  walk(roots);
  assert.equal(all.length, list.length);
  assert.equal(new Set(all).size, list.length);
});

test('buildSessionTree: 같은 세션이 두 번 오면 하나만', () => {
  const roots = buildSessionTree([sess({ id: 'a' }), sess({ id: 'a' })]);
  assert.equal(roots.length, 1);
});

test('matchesQuery: 낱말 모두 포함, 대소문자 무시, 제목·마지막 프롬프트', () => {
  const s = { title: 'Fix Login Bug', lastPrompt: '로그인 화면 고쳐 줘' };
  assert.ok(matchesQuery(s, ''));
  assert.ok(matchesQuery(s, 'login'));
  assert.ok(matchesQuery(s, 'bug 로그인'));
  assert.ok(!matchesQuery(s, 'bug 회원가입'));
  assert.ok(matchesQuery({ lastPrompt: 'Deploy' }, 'deploy'));
});

test('filterTree: 자손이 일치하면 부모를 남기고 펼쳐요', () => {
  const roots = buildSessionTree([
    sess({ id: 'p', title: '부모' }),
    sess({ id: 'k', parentId: 'p', title: '테스트 돌리기' }),
    sess({ id: 'q', title: '다른 일' }),
  ]);
  const none = filterTree(roots, '  ');
  assert.equal(none.nodes.length, 2);
  assert.equal(none.matchCount, 3);
  const f = filterTree(roots, '테스트');
  assert.deepEqual(f.nodes.map((n) => n.session.id), ['p']);
  assert.ok(f.forceExpanded.has('codex:p'));
  assert.equal(f.matchCount, 1);
  assert.equal(f.nodes[0]!.descendantCount, 1);
  const g = filterTree(roots, '부모');
  assert.equal(g.nodes[0]!.children.length, 0);
  assert.equal(g.forceExpanded.size, 0);
});

test('chipsFor·statusView', () => {
  assert.deepEqual(chipsFor({ model: 'gpt-5.5', effort: 'high' }), ['gpt-5.5', 'high']);
  assert.deepEqual(chipsFor({ model: ' ' }), []);
  assert.deepEqual(statusView('busy'), { label: '작업 중', cls: 'busy' });
  assert.equal(statusView('waiting')?.label, '입력 대기');
  assert.equal(statusView('idle')?.label, '대기 중');
  assert.equal(statusView('stopped')?.label, '멈춤');
  assert.equal(statusView(undefined), undefined);
});

test('settingsFromSession: Claude는 effort 검증, Codex는 reasoningEffort', () => {
  assert.deepEqual(settingsFromSession({ agent: 'claude', model: 'opus', effort: 'xhigh' }), { model: 'opus', effort: 'xhigh' });
  assert.deepEqual(settingsFromSession({ agent: 'claude', effort: 'weird' }), {});
  assert.deepEqual(settingsFromSession({ agent: 'codex', model: 'gpt-5.5', effort: 'medium' }), {
    model: 'gpt-5.5',
    reasoningEffort: 'medium',
  });
});

test('makePinnedDraft: 기본값', () => {
  const s = sess({ id: 'th1', agent: 'codex', title: '빌드 고치기', model: 'gpt-5.5', effort: 'high' });
  const d = makePinnedDraft('C:\\Dev\\a', s, [pin({ id: 'a', order: 3 }), pin({ id: 'b', order: 7 })]);
  assert.equal(d.id, undefined);
  assert.equal(d.folderPath, 'C:\\Dev\\a');
  assert.equal(d.agent, 'codex');
  assert.equal(d.sessionId, 'th1');
  // 재개 프롬프트·자동 전송은 데몬이 판 기본값으로 채워요
  assert.equal(d.resumePrompt, undefined);
  assert.equal(d.autoSend, undefined);
  assert.equal(d.enabled, false); // 부팅 재개는 고정한 뒤 직접 켜요
  assert.equal(d.order, 8);
  assert.equal(d.label, '빌드 고치기');
  assert.deepEqual(d.settings, { model: 'gpt-5.5', reasoningEffort: 'high' });
  assert.equal(makePinnedDraft('C:\\x', sess({ id: 'z' }), []).order, 0);
  assert.equal(makePinnedDraft('C:\\x', sess({ id: 'z' }), []).label, undefined);
});

test('고정 세션 검색·묶기·묶음 안에서 옮기기·그룹 이름', () => {
  const views: PinnedView[] = [
    { pinned: pin({ id: 'a', order: 0, folderPath: 'C:\\Dev\\Rocket', group: '일상' }), title: '빌드 고치기', folderName: 'Rocket' },
    { pinned: pin({ id: 'b', order: 1, agent: 'codex', folderPath: 'C:\\Dev\\Orbit' }), title: '리뷰', folderName: 'Orbit' },
    { pinned: pin({ id: 'c', order: 2, folderPath: 'c:\\dev\\rocket\\', group: '일상' }), title: '문서', folderName: 'Rocket' },
    { pinned: pin({ id: 'd', order: 3, folderPath: 'C:\\Dev\\Orbit', group: '가끔' }), title: '배포', folderName: 'Orbit' },
  ];
  assert.deepEqual(views.filter((v) => pinnedMatches(v, '')).length, 4);
  assert.deepEqual(views.filter((v) => pinnedMatches(v, 'rocket 빌드')).map((v) => v.pinned.id), ['a']);
  assert.deepEqual(views.filter((v) => pinnedMatches(v, 'codex')).map((v) => v.pinned.id), ['b']);
  assert.deepEqual(views.filter((v) => pinnedMatches(v, '일상')).map((v) => v.pinned.id), ['a', 'c']);
  assert.deepEqual(views.filter((v) => pinnedMatches(v, 's-d')).map((v) => v.pinned.id), ['d'], 'session id');

  const g = (by: PinnedGroupBy) => groupPinned(views, by).map((x) => [x.label, x.items.map((v) => v.pinned.id).join('')]);
  assert.deepEqual(g('none'), [['', 'abcd']]);
  assert.deepEqual(g('folder'), [['Orbit', 'bd'], ['Rocket', 'ac']], 'same folder despite case and trailing slash');
  assert.deepEqual(g('agent'), [['Claude', 'acd'], ['Codex', 'b']]);
  assert.deepEqual(g('group'), [['가끔', 'd'], ['일상', 'ac'], ['그룹 없음', 'b']], '«그룹 없음» last');
  assert.deepEqual(pinnedGroupNames(views.map((v) => v.pinned)), ['가끔', '일상']);
  assert.equal(isPinnedGroupBy('group'), true);
  assert.equal(isPinnedGroupBy('x'), false);

  // 일상 묶음(a, c) 안에서 c를 위로: 사이의 b는 그대로, a와 c만 자리를 바꿔요
  const list = views.map((v) => v.pinned);
  const moved = Object.fromEntries(movePinned(list, 'c', -1, ['a', 'c']).map((p) => [p.id, p.order]));
  assert.deepEqual(moved, { c: 0, a: 2 });
  assert.deepEqual(movePinned(list, 'a', -1, ['a', 'c']), [], 'first in its group');
  assert.deepEqual(movePinned(list, 'b', 1, ['b']), [], 'alone in its group');
});

test('sortPinned·findPinned·movePinned', () => {
  const list = [pin({ id: 'c', order: 5 }), pin({ id: 'a', order: 1 }), pin({ id: 'b', order: 1 })];
  assert.deepEqual(sortPinned(list).map((p) => p.id), ['a', 'b', 'c']);
  assert.equal(findPinned(list, 'claude', 's-b')?.id, 'b');
  assert.equal(findPinned(list, 'codex', 's-b'), undefined);

  // c를 위로: a(0) c(1) b(2) — order가 바뀐 항목만
  const changed = movePinned(list, 'c', -1);
  const byId = Object.fromEntries(changed.map((p) => [p.id, p.order]));
  assert.deepEqual(byId, { a: 0, c: 1, b: 2 });
  assert.deepEqual(movePinned(list, 'a', -1), []);
  assert.deepEqual(movePinned(list, 'c', 1), []);
  assert.deepEqual(movePinned(list, 'nope', 1), []);
  const tidy = [pin({ id: 'x', order: 0 }), pin({ id: 'y', order: 1 }), pin({ id: 'z', order: 2 })];
  assert.deepEqual(
    movePinned(tidy, 'x', 1).map((p) => [p.id, p.order]),
    [
      ['y', 0],
      ['x', 1],
    ],
  );
});

test('windowsByFolder: 경로 비교로 폴더별 창 수 (hub 제외)', () => {
  const folders = [
    { id: 'f1', path: 'C:\\Dev\\A', label: '', addedAt: '' },
    { id: 'f2', path: 'C:\\Dev\\B', label: '', addedAt: '' },
  ];
  const w = (role: 'hub' | 'agent-claude' | 'agent-codex' | 'editor', folderPath?: string) => ({
    role,
    pid: 1,
    appVersion: '1',
    extensions: [],
    ...(folderPath ? { folderPath } : {}),
  });
  const m = windowsByFolder(
    [w('hub'), w('agent-claude', 'c:/dev/a'), w('agent-claude', 'C:\\Dev\\A\\'), w('editor', 'C:\\Dev\\A'), w('agent-codex', 'C:\\Other')],
    folders,
  );
  assert.equal(m.get('f1')?.total, 3);
  assert.deepEqual(m.get('f1')?.byRole, { 'agent-claude': 2, editor: 1 });
  assert.equal(m.get('f2')?.total, 0);
  assert.equal(windowCountTooltip(m.get('f1')!), '열린 창: Claude 2, 편집기 1');
  assert.equal(windowCountTooltip(m.get('f2')!), '열린 창 없음');
});

test('describeError: 오류 코드별 한국어 안내', () => {
  assert.equal(describeError(new RpcError(ErrorCode.InvalidPath, 'nope'), '폴더 등록'), '폴더 등록: 폴더 경로가 없거나 폴더가 아니에요 (nope)');
  assert.equal(describeError(new RpcError(ErrorCode.SessionBusy, 'busy')), '이 세션은 이미 다른 곳에서 실행 중이에요 (busy)');
  assert.equal(describeError(new RpcError(ErrorCode.Timeout, 'timeout: x')), '데몬이 제때 응답하지 않았어요');
  assert.equal(describeError(new RpcError(ErrorCode.InternalError, 'disconnected: x')), '데몬에 연결돼 있지 않아요');
  assert.equal(describeError('boom'), '요청을 처리하지 못했어요 (boom)');
});

test('backoffDelay: 0.5초부터 두 배, 최대 30초', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((a) => backoffDelay(a)), [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(backoffDelay(1000), 30000);
  assert.equal(backoffDelay(-3), 500);
  assert.equal(backoffDelay(2, 100, 250), 250);
});

test('parseWindowNumberFromHash: 데몬이 붙인 창 번호만', () => {
  assert.equal(parseWindowNumberFromHash('#token=a&w=3'), 3);
  assert.equal(parseWindowNumberFromHash('#token=a'), undefined);
  assert.equal(parseWindowNumberFromHash('#token=a&w=0'), undefined);
  assert.equal(parseWindowNumberFromHash('#token=a&w=1e9'), undefined);
  assert.equal(parseWindowNumberFromHash('#token=a&w=-2'), undefined);
});

test('parseTokenFromHash·rpcUrlFor', () => {
  assert.equal(parseTokenFromHash('#token=abc123'), 'abc123');
  assert.equal(parseTokenFromHash('#x=1&token=a%2Bb'), 'a+b');
  assert.equal(parseTokenFromHash('token=t'), 't');
  assert.equal(parseTokenFromHash('#token='), undefined);
  assert.equal(parseTokenFromHash(''), undefined);
  assert.equal(rpcUrlFor({ protocol: 'http:', host: '127.0.0.1:51234' }), 'ws://127.0.0.1:51234/rpc');
  assert.equal(rpcUrlFor({ protocol: 'https:', host: 'h' }), 'wss://h/rpc');
});
