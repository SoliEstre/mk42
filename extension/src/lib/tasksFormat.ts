// 백그라운드 작업(워크플로우·서브에이전트) 표시용 순수 함수 — 토큰·걸린 시간 줄임 표기, 지금 단계, 합계. vscode에 기대지 않아요.
import type { BackgroundAgent, BackgroundTaskStatus, BackgroundWorkflow, SessionTasks, TokenUsage } from '@mark42/protocol';
import { sourceText, type Translate } from './l10n.ts';

/** 412 → '412', 1234 → '1.2k', 412_345 → '412k', 1_234_567 → '1.2M' */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  if (k < 9.95) return `${trim1(k)}k`;
  if (Math.round(k) < 1000) return `${Math.round(k)}k`;
  const m = n / 1_000_000;
  if (m < 9.95) return `${trim1(m)}M`;
  return `${Math.round(m)}M`;
}

/** 소수 한 자리, 끝의 .0은 떼요 */
function trim1(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

/** 35_000 → '35초', 391_000 → '6분 31초', 3_720_000 → '1시간 2분'(한국어 번들 기준). 알 수 없으면 '' */
export function formatDuration(ms: number | undefined, tr: Translate = sourceText): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  if (total < 60) return tr('{0}s', total);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m ? tr('{0}h {1}m', h, m) : tr('{0}h', h);
  return s ? tr('{0}m {1}s', m, s) : tr('{0}m', m);
}

/** 걸린 시간 — 실행 중이면 지금까지, 끝났으면 끝난(없으면 마지막으로 움직인) 때까지 */
export function elapsedMs(
  t: { startedAt?: string; endedAt?: string; updatedAt?: string; status: BackgroundTaskStatus },
  now: number,
): number | undefined {
  const start = t.startedAt ? Date.parse(t.startedAt) : NaN;
  if (!Number.isFinite(start)) return undefined;
  const endIso = t.status === 'running' ? undefined : (t.endedAt ?? t.updatedAt);
  const end = endIso ? Date.parse(endIso) : now;
  if (!Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

/**
 * 지금 단계 번호(없으면 -1) — 허브(hub-ui model.currentPhaseIndex)와 같은 규칙이에요: 시작한 agent가 다 끝나지 않은
 * 첫 단계, 없으면(단계 사이) 마지막으로 시작한 단계, 아무것도 시작 전이면 -1. 실행 중인 워크플로우에만 있어요 —
 * 끝났거나 실패했거나 멈춘 워크플로우에는 지금 단계가 없어요.
 */
export function currentPhaseIndex(wf: Pick<BackgroundWorkflow, 'phases' | 'status'>): number {
  if (wf.status !== 'running') return -1;
  const open = wf.phases.findIndex((p) => p.started > p.done);
  if (open >= 0) return open;
  for (let i = wf.phases.length - 1; i >= 0; i--) if (wf.phases[i]!.started > 0) return i;
  return -1;
}

/** 진행률 0~1 —끝난 워크플로우는 1 */
export function progressRatio(wf: Pick<BackgroundWorkflow, 'progress' | 'status'>): number {
  if (wf.status === 'done') return 1;
  const { done, total } = wf.progress;
  if (!total || total <= 0) return 0;
  return Math.min(1, Math.max(0, done / total));
}

export interface TasksTotals {
  running: number;
  tokens: number;
}

export function tasksTotals(t: SessionTasks | undefined): TasksTotals {
  if (!t) return { running: 0, tokens: 0 };
  const running = Number.isFinite(t.running) ? Math.max(0, t.running) : 0;
  return { running, tokens: t.tokens?.total ?? 0 };
}

/** 보기 설명·상태 표시줄용 한 줄: '2 실행 중 · 412k' / '412k' / '' */
export function totalsText(t: TasksTotals, tr: Translate = sourceText): string {
  const parts: string[] = [];
  if (t.running > 0) parts.push(tr('{0} running', t.running));
  if (t.tokens > 0) parts.push(formatTokens(t.tokens));
  return parts.join(' · ');
}

/** 토큰 내역 한 줄(툴팁) — Codex는 total만 있어요 */
export function tokensDetail(t: TokenUsage | undefined, tr: Translate = sourceText): string {
  if (!t) return '';
  const parts: string[] = [];
  if (t.input) parts.push(tr('input {0}', formatTokens(t.input)));
  if (t.output) parts.push(tr('output {0}', formatTokens(t.output)));
  if (t.cacheRead) parts.push(tr('cache read {0}', formatTokens(t.cacheRead)));
  if (t.cacheCreation) parts.push(tr('cache write {0}', formatTokens(t.cacheCreation)));
  const total = tr('total {0}', formatTokens(t.total));
  return parts.length ? `${total} (${parts.join(' · ')})` : total;
}

/** 알려진 상태(이 밖의 값은 멈춤으로 봐요) */
export const TASK_STATUSES: readonly BackgroundTaskStatus[] = ['running', 'done', 'failed', 'stale'];

export function statusLabel(s: BackgroundTaskStatus, tr: Translate = sourceText): string {
  switch (s) {
    case 'running':
      return tr('running');
    case 'done':
      return tr('done');
    case 'failed':
      return tr('failed');
    default:
      return tr('stalled');
  }
}

/** 실행 중이 먼저, 그다음 최근에 움직인 순(같으면 원래 순서) */
export function sortAgents(list: readonly BackgroundAgent[]): BackgroundAgent[] {
  return list
    .map((a, i) => ({ a, i }))
    .sort(
      (x, y) =>
        Number(y.a.status === 'running') - Number(x.a.status === 'running') ||
        (y.a.updatedAt ?? '').localeCompare(x.a.updatedAt ?? '') ||
        x.i - y.i,
    )
    .map((x) => x.a);
}
