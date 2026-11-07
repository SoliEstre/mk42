// 백그라운드 작업 수집 공용 — 토큰 합산, 상태 판정, 덧붙은 바이트만 읽는 JSONL 리더, 표시용 문자열 다듬기.
// 에이전트 홈(~/.claude·~/.codex)은 읽기 전용이에요. 여기서 만드는 문자열은 화면용이고 로그에 남기지 않아요.
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import type { BackgroundAgent, BackgroundTaskStatus, SessionTasks, TokenUsage } from '@mark42/protocol';

/** 테스트에서 조절할 수 있는 내부 값 */
export const TASKS_TUNING = {
  /** 끝났다는 기록 없이 이만큼 안 움직이면 stale */
  staleMs: 15 * 60 * 1000,
  /** 한 번에 읽는 크기 */
  chunkBytes: 1024 * 1024,
  /** 이보다 긴 줄은 건너뛰어요(큰 도구 결과) */
  maxLineBytes: 8 * 1024 * 1024,
  /** 이만큼 안 쓰인 캐시 항목은 버려요 */
  cacheIdleMs: 30 * 60 * 1000,
};

export const DEFAULT_SINCE_MS = 12 * 60 * 60 * 1000;
export const MAX_SINCE_MS = 30 * 24 * 60 * 60 * 1000;
export const WORKFLOWS_PER_SESSION = 10;
export const SUBAGENTS_PER_SESSION = 30;

const LABEL_MAX = 120;
const SUMMARY_MAX = 300;

export type Rec = Record<string, unknown>;

export function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

/** 제어 문자·연속 공백을 한 칸으로 줄이고 max자로 잘라요 */
export function clipText(s: string, max: number): string {
  const t = s.replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function clipLabel(s: string): string {
  return clipText(s, LABEL_MAX);
}

export function clipSummary(s: string): string {
  return clipText(s, SUMMARY_MAX);
}

export function zeroTokens(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
}

export function addTokens(into: TokenUsage, t: TokenUsage | undefined): TokenUsage {
  if (!t) return into;
  into.input += t.input;
  into.output += t.output;
  into.cacheRead += t.cacheRead;
  into.cacheCreation += t.cacheCreation;
  into.total += t.total;
  return into;
}

/** 끝난 기록이 없을 때: 최근에 움직였으면 running, 아니면 stale */
export function liveness(mtimeMs: number, now: number): BackgroundTaskStatus {
  return now - mtimeMs <= TASKS_TUNING.staleMs ? 'running' : 'stale';
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a >= b ? a : b;
}

export function earlierIso(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a <= b ? a : b;
}

/** ISO 문자열이면 그대로(정규화), 아니면 undefined */
export function isoOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * 도구 이름 + 파일 이름만 — 명령·패턴·본문은 넣지 않아요.
 * 파일 경로 인자(file_path·path·notebook_path)가 있으면 그 basename만 붙여요.
 */
export function toolActivity(name: string, input: unknown): string {
  const tool = clipText(name, 60);
  if (isRec(input)) {
    const p = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
    if (p) {
      const base = clipText(basename(p.replace(/[\\/]+$/, '').replace(/\\/g, '/')), 60);
      if (base) return `${tool} ${base}`;
    }
  }
  return tool;
}

/** 실행 중이 먼저, 그다음 최근 순 */
export function byRunningThenRecent<T extends { status: BackgroundTaskStatus; updatedAt: string }>(a: T, b: T): number {
  const ra = a.status === 'running' ? 0 : 1;
  const rb = b.status === 'running' ? 0 : 1;
  if (ra !== rb) return ra - rb;
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

/** 세션 정렬: 실행 중인 agent가 있는 세션이 먼저, 그다음 최근 순 */
export function compareSessions(a: SessionTasks, b: SessionTasks): number {
  const ra = a.running > 0 ? 0 : 1;
  const rb = b.running > 0 ? 0 : 1;
  if (ra !== rb) return ra - rb;
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

export function countRunning(agents: readonly BackgroundAgent[]): number {
  let n = 0;
  for (const a of agents) if (a.status === 'running') n++;
  return n;
}

// ---- 덧붙은 바이트만 읽는 JSONL 리더

/** 파일 하나를 어디까지 읽었는지 */
export interface TailCursor {
  /** 다 읽은 바이트 수(줄 경계 — 건너뛰는 긴 줄 중간일 수 있어요) */
  offset: number;
  /** 긴 줄을 건너뛰는 중(다음 개행까지 버려요) */
  skipping: boolean;
}

export function newCursor(): TailCursor {
  return { offset: 0, skipping: false };
}

function parseLine(buf: Buffer): unknown {
  if (buf.length === 0) return undefined;
  const text = buf.toString('utf8').trim();
  if (!text.startsWith('{')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * cursor.offset부터 size까지 읽어 완성된 줄마다 onRecord를 불러요.
 * 아직 쓰는 중인 마지막 줄(개행 없음)은 다음 번에 다시 읽게 offset을 그 줄 앞에 둬요.
 * 깨진 줄·JSON이 아닌 줄은 건너뛰어요.
 * 읽다가 실패해도(EBUSY 등) 이미 넘긴 줄까지는 cursor에 남겨요 — 다시 읽을 때 같은 줄을 두 번 세지 않게요.
 */
export async function readAppended(file: string, cursor: TailCursor, size: number, onRecord: (rec: unknown) => void): Promise<void> {
  if (size <= cursor.offset) return;
  const fh = await open(file, 'r');
  let consumed = cursor.offset;
  let skipping = cursor.skipping;
  try {
    let pos = cursor.offset;
    let carry: Buffer[] = [];
    let carryLen = 0;
    while (pos < size) {
      const len = Math.min(TASKS_TUNING.chunkBytes, size - pos);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        if (nl < 0) break;
        if (skipping) {
          skipping = false;
        } else {
          const piece = chunk.subarray(start, nl);
          const rec = parseLine(carryLen > 0 ? Buffer.concat([...carry, piece]) : piece);
          if (rec !== undefined) onRecord(rec);
        }
        carry = [];
        carryLen = 0;
        start = nl + 1;
        consumed = pos + start;
      }
      if (start < chunk.length && !skipping) {
        const rest = Buffer.from(chunk.subarray(start));
        carry.push(rest);
        carryLen += rest.length;
        if (carryLen > TASKS_TUNING.maxLineBytes) {
          carry = [];
          carryLen = 0;
          skipping = true;
        }
      }
      pos += bytesRead;
      // 건너뛰는 중이면 읽은 데까지 다 소비한 셈이에요(다음 번에 다시 읽지 않게)
      if (skipping) consumed = pos;
    }
  } finally {
    cursor.offset = consumed;
    cursor.skipping = skipping;
    await fh.close();
  }
}

// ---- 한 번에 하나씩 모으기

/**
 * 수집을 한 번에 하나씩만 돌려요(두 패스가 같은 TailCursor를 동시에 읽지 않게).
 * 앞 패스가 도는 중이면 그 뒤에 이어 돌고, 같은 옵션으로 아직 시작 안 한 차례가 있으면 그 결과를 같이 써요.
 */
export function singleFlight<A, R>(fn: (a: A) => Promise<R>, keyOf: (a: A) => string): (a: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  let queued: { key: string; p: Promise<R> } | undefined;
  return (a) => {
    const key = keyOf(a);
    if (queued && queued.key === key) return queued.p;
    const entry: { key: string; p: Promise<R> } = { key, p: Promise.resolve() as Promise<R> };
    entry.p = tail.then(() => {
      if (queued === entry) queued = undefined;
      return fn(a);
    });
    queued = entry;
    tail = entry.p.catch(() => undefined);
    return entry.p;
  };
}

/** 캐시 항목의 마지막 사용(시각 + 전체 패스 번호) */
export interface CacheTouch {
  seen: number;
  pass: number;
}

/**
 * 오래 안 쓴 캐시 항목을 버려요. 시간(cacheIdleMs)으로 늘 버리고,
 * 전체 패스(full)에서는 최근 두 번의 전체 패스에서 안 쓰인 항목(창 밖으로 나간 파일·세션)도 버려요.
 */
export function sweepCache(maps: readonly Map<string, CacheTouch>[], t: number, pass: number, full: boolean): void {
  const old = t - TASKS_TUNING.cacheIdleMs;
  for (const m of maps) {
    for (const [k, v] of m) if (v.seen < old || (full && v.pass < pass - 1)) m.delete(k);
  }
}
