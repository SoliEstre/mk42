// Codex state_5.sqlite 읽기 전용 목록 (app-server를 못 쓸 때의 대체 경로).
// 스키마는 sqlx 마이그레이션으로 바뀌어서 열을 런타임에 확인해요.
import { DatabaseSync } from 'node:sqlite';
import type { SessionSummary } from '@mark42/protocol';
import { normalizePath, pathKey } from '@mark42/protocol/paths';

export interface SqliteListOptions {
  cwd?: string;
  includeSubagents?: boolean;
  limit?: number;
}

type Row = Record<string, unknown>;

const TITLE_MAX = 200;

function s(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function n(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

export function clipTitle(t: string): string {
  const x = t.replace(/\s+/g, ' ').trim();
  return x.length > TITLE_MAX ? x.slice(0, TITLE_MAX) : x;
}

export interface SourceInfo {
  isSubagent: boolean;
  parentId?: string;
}

/**
 * threads.source 해석. 문자열(vscode·exec·cli…)이면 최상위,
 * JSON이면 `{"subagent":{"thread_spawn":{"parent_thread_id":…}}}` 또는 `{"subagent":{"other":"guardian"}}` 같은 서브에이전트예요.
 * app-server 응답(`{"subAgent":…}`)과 DB(`{"subagent":…}`) 둘 다 받아요.
 */
export function parseSource(src: unknown): SourceInfo {
  let v: unknown = src;
  if (typeof src === 'string') {
    if (!src.startsWith('{')) return { isSubagent: false };
    try {
      v = JSON.parse(src);
    } catch {
      return { isSubagent: true };
    }
  }
  if (typeof v !== 'object' || v === null) return { isSubagent: false };
  const o = v as Record<string, unknown>;
  const sub = o.subAgent ?? o.subagent ?? o.sub_agent;
  if (sub === undefined) return { isSubagent: false };
  const info: SourceInfo = { isSubagent: true };
  if (typeof sub === 'object' && sub !== null) {
    const ts = (sub as Record<string, unknown>).thread_spawn ?? (sub as Record<string, unknown>).threadSpawn;
    if (typeof ts === 'object' && ts !== null) {
      const p = s((ts as Record<string, unknown>).parent_thread_id) ?? s((ts as Record<string, unknown>).parentThreadId);
      if (p) info.parentId = p;
    }
  }
  return info;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

export interface RecentThreadRow {
  id: string;
  cwd: string;
  rolloutPath: string;
}

/** 최근에 갱신된 스레드의 rollout 파일 경로 (live() 추정용). rollout_path 열이 없으면 빈 목록. */
export function recentCodexRollouts(dbPath: string, limit: number): RecentThreadRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (!hasTable(db, 'threads')) return [];
    const cols = new Set((db.prepare('PRAGMA table_info(threads)').all() as Row[]).map((c) => String(c.name)));
    if (!cols.has('id') || !cols.has('cwd') || !cols.has('rollout_path')) return [];
    const order = cols.has('updated_at_ms') ? 'updated_at_ms' : cols.has('recency_at_ms') ? 'recency_at_ms' : cols.has('updated_at') ? 'updated_at' : 'rowid';
    const where = cols.has('archived') ? 'WHERE archived = 0' : '';
    const rows = db
      .prepare(`SELECT "id", "cwd", "rollout_path" FROM threads ${where} ORDER BY "${order}" DESC LIMIT ?`)
      .all(Math.max(1, Math.floor(limit))) as Row[];
    const out: RecentThreadRow[] = [];
    for (const r of rows) {
      const id = s(r.id);
      const cwd = s(r.cwd);
      const rolloutPath = s(r.rollout_path);
      if (id && cwd && rolloutPath) out.push({ id, cwd: normalizePath(cwd), rolloutPath });
    }
    return out;
  } finally {
    db.close();
  }
}

export function listCodexThreadsFromSqlite(dbPath: string, o: SqliteListOptions = {}): SessionSummary[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (!hasTable(db, 'threads')) throw new Error('threads table not found');
    const cols = new Set((db.prepare('PRAGMA table_info(threads)').all() as Row[]).map((c) => String(c.name)));
    if (!cols.has('id') || !cols.has('cwd')) throw new Error('threads table lacks id/cwd');
    const want = ['id', 'cwd', 'title', 'name', 'preview', 'model', 'reasoning_effort', 'source', 'archived', 'recency_at_ms', 'updated_at_ms', 'updated_at'];
    const sel = want.filter((c) => cols.has(c));
    const order = cols.has('recency_at_ms') ? 'recency_at_ms' : cols.has('updated_at_ms') ? 'updated_at_ms' : cols.has('updated_at') ? 'updated_at' : 'rowid';
    const where = cols.has('archived') ? 'WHERE archived = 0' : '';
    const rows = db.prepare(`SELECT ${sel.map((c) => `"${c}"`).join(', ')} FROM threads ${where} ORDER BY "${order}" DESC`).all() as Row[];

    // thread_spawn_edges: source JSON에 부모가 없을 때의 보조 정보
    const edgeParent = new Map<string, string>();
    if (hasTable(db, 'thread_spawn_edges')) {
      for (const e of db.prepare('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges').all() as Row[]) {
        const c = s(e.child_thread_id);
        const p = s(e.parent_thread_id);
        if (c && p) edgeParent.set(c, p);
      }
    }

    const key = o.cwd ? pathKey(o.cwd) : undefined;
    const out: SessionSummary[] = [];
    for (const r of rows) {
      const id = s(r.id);
      const rawCwd = s(r.cwd);
      if (!id || !rawCwd) continue;
      if (key !== undefined && pathKey(rawCwd) !== key) continue;
      const preview = s(r.preview);
      const title = s(r.name) ?? s(r.title) ?? preview;
      // app-server도 제목·미리보기가 빈 스레드(대화가 없는 서브에이전트)는 목록에서 빼요.
      if (!title) continue;
      const src = parseSource(r.source);
      if (src.isSubagent && !o.includeSubagents) continue;
      const ms = n(r.recency_at_ms) ?? n(r.updated_at_ms) ?? (n(r.updated_at) !== undefined ? n(r.updated_at)! * 1000 : undefined);
      const sum: SessionSummary = {
        agent: 'codex',
        id,
        cwd: normalizePath(rawCwd),
        title: clipTitle(title),
        updatedAt: new Date(ms ?? 0).toISOString(),
      };
      const model = s(r.model);
      if (model) sum.model = model;
      const effort = s(r.reasoning_effort);
      if (effort) sum.effort = effort;
      if (src.isSubagent) {
        sum.isSubagent = true;
        const p = src.parentId ?? edgeParent.get(id);
        if (p) sum.parentId = p;
      }
      out.push(sum);
      if (o.limit !== undefined && o.limit >= 0 && out.length >= o.limit) break;
    }
    return out;
  } finally {
    db.close();
  }
}
