import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackgroundAgent, SessionTasks } from '@mark42/protocol';
import {
  currentPhaseIndex,
  elapsedMs,
  formatDuration,
  formatTokens,
  progressRatio,
  sortAgents,
  statusLabel,
  TASK_STATUSES,
  tasksTotals,
  tokensDetail,
  totalsText,
} from '../src/lib/tasksFormat.ts';
import { koT } from './helpers/l10n.ts';

test('tokens: plain under 1k, one decimal under 10k/10M, rounded otherwise; 999.6k rolls over to 1M', () => {
  assert.equal(formatTokens(undefined), '0');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(412), '412');
  assert.equal(formatTokens(1000), '1k');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(9_960), '10k');
  assert.equal(formatTokens(412_345), '412k');
  assert.equal(formatTokens(999_600), '1M');
  assert.equal(formatTokens(1_234_567), '1.2M');
  assert.equal(formatTokens(12_600_000), '13M');
  assert.equal(formatTokens(Number.NaN), '0');
});

test('durations: seconds, minutes+seconds, hours+minutes; unknown is empty', () => {
  assert.equal(formatDuration(0, koT), '0초');
  assert.equal(formatDuration(35_400, koT), '35초');
  assert.equal(formatDuration(391_000, koT), '6분 31초');
  assert.equal(formatDuration(360_000, koT), '6분');
  assert.equal(formatDuration(3_720_000, koT), '1시간 2분');
  assert.equal(formatDuration(7_200_000, koT), '2시간');
  assert.equal(formatDuration(undefined, koT), '');
  assert.equal(formatDuration(-1, koT), '');
  // 번역 함수 없이는 영어 원문
  assert.equal(formatDuration(391_000), '6m 31s');
  assert.equal(formatDuration(3_720_000), '1h 2m');
  assert.equal(formatDuration(35_400), '35s');
});

test('elapsed: running counts to now, finished to endedAt (else updatedAt); no start is unknown', () => {
  const now = Date.parse('2026-10-30T10:10:00Z');
  const startedAt = '2026-10-30T10:00:00Z';
  assert.equal(elapsedMs({ status: 'running', startedAt, endedAt: '2026-10-30T10:01:00Z' }, now), 600_000);
  assert.equal(elapsedMs({ status: 'done', startedAt, endedAt: '2026-10-30T10:01:00Z', updatedAt: '2026-10-30T10:05:00Z' }, now), 60_000);
  assert.equal(elapsedMs({ status: 'failed', startedAt, updatedAt: '2026-10-30T10:05:00Z' }, now), 300_000);
  assert.equal(elapsedMs({ status: 'running' }, now), undefined);
  assert.equal(elapsedMs({ status: 'running', startedAt: 'nope' }, now), undefined);
});

test('current phase (same rule as the hub): first phase with unfinished agents, else the last started one; none when not running', () => {
  const ph = (...p: [number, number][]) => p.map(([started, done], i) => ({ title: `p${i}`, started, done }));
  assert.equal(currentPhaseIndex({ status: 'running', phases: ph([2, 2], [3, 1], [0, 0]) }), 1);
  assert.equal(currentPhaseIndex({ status: 'running', phases: ph([2, 1], [3, 1], [0, 0]) }), 0, 'the first open phase, not the last');
  assert.equal(currentPhaseIndex({ status: 'running', phases: ph([2, 2], [3, 3], [0, 0]) }), 1, 'between phases');
  assert.equal(currentPhaseIndex({ status: 'running', phases: ph([0, 0], [0, 0]) }), -1, 'nothing started yet');
  assert.equal(currentPhaseIndex({ status: 'running', phases: [] }), -1);
  for (const status of ['done', 'failed', 'stale'] as const) {
    assert.equal(currentPhaseIndex({ status, phases: ph([2, 2], [3, 1]) }), -1, `${status}: no current phase`);
  }
});

test('progress: done/total clamped, done workflows are full, zero total is empty', () => {
  assert.equal(progressRatio({ status: 'running', progress: { done: 3, total: 7 } }), 3 / 7);
  assert.equal(progressRatio({ status: 'running', progress: { done: 0, total: 0 } }), 0);
  assert.equal(progressRatio({ status: 'running', progress: { done: 9, total: 7 } }), 1);
  assert.equal(progressRatio({ status: 'done', progress: { done: 3, total: 7 } }), 1);
});

test('totals: running + total tokens, one-line text for the view description', () => {
  const tokens = { input: 1000, output: 2000, cacheRead: 400_000, cacheCreation: 9_345, total: 412_345 };
  const t = { running: 2, tokens } as SessionTasks;
  assert.deepEqual(tasksTotals(t), { running: 2, tokens: 412_345 });
  assert.deepEqual(tasksTotals(undefined), { running: 0, tokens: 0 });
  assert.equal(totalsText({ running: 2, tokens: 412_345 }, koT), '2 실행 중 · 412k');
  assert.equal(totalsText({ running: 0, tokens: 412_345 }, koT), '412k');
  assert.equal(totalsText({ running: 0, tokens: 0 }, koT), '');
  assert.equal(tokensDetail(tokens, koT), '합계 412k (입력 1k · 출력 2k · 캐시 읽기 400k · 캐시 쓰기 9.3k)');
  assert.equal(tokensDetail({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5000 }, koT), '합계 5k', 'Codex has total only');
  // 번역 함수 없이는 영어 원문
  assert.equal(totalsText({ running: 2, tokens: 412_345 }), '2 running · 412k');
  assert.equal(tokensDetail(tokens), 'total 412k (input 1k · output 2k · cache read 400k · cache write 9.3k)');
});

test('status labels: every known status has its own label; unknown ones read as stalled', () => {
  assert.deepEqual(
    TASK_STATUSES.map((s) => statusLabel(s, koT)),
    ['실행 중', '완료', '실패', '멈춤'],
  );
  assert.equal(statusLabel('done'), 'done');
});

test('agents sort running first, then most recently updated, stable otherwise', () => {
  const a = (id: string, status: BackgroundAgent['status'], updatedAt: string): BackgroundAgent => ({ id, label: id, status, updatedAt });
  const list = [a('d1', 'done', '2026-10-30T10:05:00Z'), a('r1', 'running', '2026-10-30T10:01:00Z'), a('d2', 'done', '2026-10-30T10:09:00Z'), a('r2', 'running', '2026-10-30T10:01:00Z')];
  assert.deepEqual(sortAgents(list).map((x) => x.id), ['r1', 'r2', 'd2', 'd1']);
});
