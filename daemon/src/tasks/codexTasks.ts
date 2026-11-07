// Codex 백그라운드 작업 수집 — 하위 스레드(thread_spawn)를 부모 스레드의 서브에이전트로 묶어요.
// state_5.sqlite는 읽기 전용으로 열고 열은 런타임에 확인해요(codex-sqlite.ts와 같은 방식).
// 하위 스레드 상태는 rollout 뒤쪽의 task_started·task_complete·turn_aborted 중 마지막으로 정해요.
// 손주(깊이 2+) 스레드도 부모 링크를 따라 맨 위(본) 세션 아래로 묶어요. 창 밖 하위 스레드는 rollout 꼬리를 읽지 않아요.
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BackgroundAgent, BackgroundTaskStatus, SessionTasks } from '@mark42/protocol';
import { codexHome, normalizePath } from '@mark42/protocol/paths';
import { parseSource } from '../indexers/codex-sqlite.ts';
import { peekJsonl } from '../indexers/jsonl-peek.ts';
import type { CollectOptions, TaskCollector } from './claudeTasks.ts';
import {
  byRunningThenRecent,
  clipLabel,
  DEFAULT_SINCE_MS,
  iso,
  isRec,
  liveness,
  num,
  singleFlight,
  str,
  SUBAGENTS_PER_SESSION,
  sweepCache,
  toolActivity,
  zeroTokens,
  type CacheTouch,
} from './common.ts';

export interface CodexTaskOptions {
  codexHome?: string;
  now?: () => number;
}

type Row = Record<string, unknown>;

const DB_FILES = ['state_5.sqlite', 'state_5.sqlite-wal'];
const TASK_EVENTS = new Set(['task_started', 'task_complete', 'turn_aborted']);
const TOOL_ITEMS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
/** rollout 꼬리 캐시 상한(넘으면 가장 오래 안 쓴 것부터 버려요) */
export const ROLLOUT_CACHE_MAX = 512;

interface ThreadRow {
  id: string;
  cwd?: string;
  title?: string;
  nickname?: string;
  role?: string;
  rolloutPath?: string;
  tokensUsed?: number;
  createdMs?: number;
  updatedMs?: number;
  parentId?: string;
}

interface RolloutEntry extends CacheTouch {
  size: number;
  mtimeMs: number;
  /** 마지막 task 이벤트 */
  last?: string;
  activity?: string;
}

/**
 * 부모 링크를 따라 맨 위 스레드까지 올라가요. 고리가 있으면 고리 안에서 가장 작은 id로 멈춰요
 * (어느 스레드에서 시작해도 같은 곳으로 모이게요).
 */
export function rootThread(id: string, parentOf: ReadonlyMap<string, string>): string {
  let cur = id;
  const seen = new Set<string>([cur]);
  for (;;) {
    const p = parentOf.get(cur);
    if (p === undefined) return cur;
    if (seen.has(p)) {
      // 고리 — 고리에 든 스레드 중 가장 작은 id
      const ring: string[] = [p];
      for (let x = parentOf.get(p); x !== undefined && x !== p && ring.length <= seen.size; x = parentOf.get(x)) ring.push(x);
      return ring.sort()[0]!;
    }
    seen.add(p);
    cur = p;
  }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

function msOf(r: Row, msCol: string, secCol: string): number | undefined {
  const ms = num(r[msCol]);
  if (ms !== undefined) return ms;
  const sec = num(r[secCol]);
  return sec !== undefined ? sec * 1000 : undefined;
}

/** 부모가 있는(서브에이전트) 스레드와 그 부모를 읽어요. 테이블·열이 없으면 빈 목록 */
export function readCodexSpawnTree(dbPath: string): { children: ThreadRow[]; parents: Map<string, ThreadRow> } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (!hasTable(db, 'threads')) return { children: [], parents: new Map() };
    const cols = new Set((db.prepare('PRAGMA table_info(threads)').all() as Row[]).map((c) => String(c.name)));
    if (!cols.has('id')) return { children: [], parents: new Map() };
    const want = [
      'id',
      'cwd',
      'title',
      'name',
      'agent_nickname',
      'agent_role',
      'rollout_path',
      'tokens_used',
      'created_at_ms',
      'created_at',
      'updated_at_ms',
      'updated_at',
      'source',
    ];
    const sel = want.filter((c) => cols.has(c)).map((c) => `"${c}"`).join(', ');
    const edgeParent = new Map<string, string>();
    const hasEdges = hasTable(db, 'thread_spawn_edges');
    if (hasEdges) {
      for (const e of db.prepare('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges').all() as Row[]) {
        const c = str(e.child_thread_id);
        const p = str(e.parent_thread_id);
        if (c && p) edgeParent.set(c, p);
      }
    }
    const toRow = (r: Row): ThreadRow | undefined => {
      const id = str(r.id);
      if (!id) return undefined;
      const t: ThreadRow = { id };
      const cwd = str(r.cwd);
      if (cwd) t.cwd = cwd;
      const title = str(r.name) ?? str(r.title);
      if (title) t.title = clipLabel(title);
      const nickname = str(r.agent_nickname);
      if (nickname) t.nickname = clipLabel(nickname);
      const role = str(r.agent_role);
      if (role) t.role = clipLabel(role);
      const rp = str(r.rollout_path);
      if (rp) t.rolloutPath = rp;
      const tk = num(r.tokens_used);
      if (tk !== undefined) t.tokensUsed = tk;
      const c = msOf(r, 'created_at_ms', 'created_at');
      if (c !== undefined) t.createdMs = c;
      const u = msOf(r, 'updated_at_ms', 'updated_at');
      if (u !== undefined) t.updatedMs = u;
      const p = parseSource(r.source).parentId ?? edgeParent.get(id);
      if (p) t.parentId = p;
      return t;
    };
    const children: ThreadRow[] = [];
    const parentIds = new Set<string>();
    // 서브에이전트만 — source JSON이 subagent이거나 spawn 간선이 있는 스레드
    const conds: string[] = [];
    if (cols.has('source')) conds.push(`"source" LIKE '{%'`);
    if (hasEdges) conds.push('"id" IN (SELECT child_thread_id FROM thread_spawn_edges)');
    if (conds.length > 0) {
      for (const r of db.prepare(`SELECT ${sel} FROM threads WHERE ${conds.join(' OR ')}`).all() as Row[]) {
        const t = toRow(r);
        if (!t?.parentId) continue;
        children.push(t);
        parentIds.add(t.parentId);
      }
    }
    const parents = new Map<string, ThreadRow>();
    if (parentIds.size > 0) {
      const ids = [...parentIds];
      const q = db.prepare(`SELECT ${sel} FROM threads WHERE "id" = ?`);
      for (const id of ids) {
        const r = q.get(id) as Row | undefined;
        const t = r ? toRow(r) : undefined;
        if (t) parents.set(id, t);
      }
    }
    return { children, parents };
  } finally {
    db.close();
  }
}

function applyRolloutRecord(e: RolloutEntry, r: unknown): void {
  if (!isRec(r) || !isRec(r.payload)) return;
  const p = r.payload;
  const t = str(p.type);
  if (!t) return;
  if (r.type === 'event_msg' && TASK_EVENTS.has(t)) e.last = t;
  else if (r.type === 'response_item' && TOOL_ITEMS.has(t)) {
    // 도구 이름만 — arguments(명령·패치 본문)는 보지 않아요
    e.activity = toolActivity(str(p.name) ?? t, undefined);
  }
}

export function createCodexTaskCollector(opts: CodexTaskOptions = {}): TaskCollector & { readonly cachedRollouts: number } {
  const home = opts.codexHome ?? codexHome();
  const dbPath = join(home, 'state_5.sqlite');
  const now = opts.now ?? Date.now;
  const rollouts = new Map<string, RolloutEntry>();
  /** 끝나지 않은 하위 스레드의 rollout → 맨 위 세션 id */
  const hot = new Map<string, string>();
  /** 전체(세션 필터 없는) 수집 패스 번호 */
  let pass = 0;

  async function rolloutState(path: string, t: number): Promise<RolloutEntry | undefined> {
    let s;
    try {
      s = await stat(path);
    } catch {
      rollouts.delete(path);
      return undefined;
    }
    const c = rollouts.get(path);
    if (c && c.size === s.size && c.mtimeMs === s.mtimeMs) {
      c.seen = t;
      c.pass = pass;
      return c;
    }
    const e: RolloutEntry = { size: s.size, mtimeMs: s.mtimeMs, seen: t, pass };
    try {
      const peek = await peekJsonl(path, {
        headBytes: 4 * 1024,
        maxHeadBytes: 4 * 1024,
        tailBytes: 256 * 1024,
        maxTailBytes: 2 * 1024 * 1024,
        tailUntil: (recs) => recs.some((r) => isRec(r) && r.type === 'event_msg' && isRec(r.payload) && TASK_EVENTS.has(String(r.payload.type))),
      });
      for (const r of [...peek.head, ...peek.tail]) applyRolloutRecord(e, r);
    } catch {
      // 쓰는 중·지워짐 — 다음 번에
    }
    rollouts.set(path, e);
    return e;
  }

  async function collectOnce(o: CollectOptions): Promise<SessionTasks[]> {
    const t = now();
    const full = o.sessionId === undefined;
    if (full) pass++;
    const cutoff = t - (o.sinceMs ?? DEFAULT_SINCE_MS);
    let tree: ReturnType<typeof readCodexSpawnTree>;
    try {
      await stat(dbPath);
      tree = readCodexSpawnTree(dbPath);
    } catch {
      hot.clear();
      return [];
    }
    // 손주 스레드도 맨 위 세션으로 — 부모 링크를 따라 올라가요
    const parentOf = new Map<string, string>();
    for (const c of tree.children) parentOf.set(c.id, c.parentId!);
    const bySession = new Map<string, BackgroundAgent[]>();
    const cwdOf = new Map<string, string>();
    const nextHot = new Map<string, string>();
    for (const c of tree.children) {
      const rootId = rootThread(c.id, parentOf);
      if (o.sessionId !== undefined && rootId !== o.sessionId) continue;
      // 창 밖이면 rollout 꼬리를 읽기 전에 걸러요(DB 시각을 모를 때만 rollout 시각으로)
      const dbMs = Math.max(c.updatedMs ?? 0, c.createdMs ?? 0);
      const knowsTime = c.updatedMs !== undefined || c.createdMs !== undefined;
      if (knowsTime && dbMs < cutoff) continue;
      const ro = c.rolloutPath ? await rolloutState(c.rolloutPath, t) : undefined;
      const updatedMs = Math.max(dbMs, ro?.mtimeMs ?? 0);
      if (updatedMs < cutoff) continue;
      let status: BackgroundTaskStatus;
      if (ro?.last === 'task_complete') status = 'done';
      else if (ro?.last === 'turn_aborted') status = 'failed';
      else status = liveness(updatedMs, t);
      if ((status === 'running' || status === 'stale') && c.rolloutPath) nextHot.set(c.rolloutPath, rootId);
      const label = c.nickname ? (c.title ? `${c.nickname} · ${c.title}` : c.nickname) : (c.title ?? c.id.slice(0, 8));
      const a: BackgroundAgent = { id: c.id, label: clipLabel(label), status, updatedAt: iso(updatedMs) };
      if (c.role) a.kind = c.role;
      if (c.createdMs !== undefined) a.startedAt = iso(c.createdMs);
      if (status === 'done' || status === 'failed') a.endedAt = a.updatedAt;
      if (c.tokensUsed !== undefined && c.tokensUsed > 0) a.tokens = { ...zeroTokens(), total: c.tokensUsed };
      if (ro?.activity) a.activity = ro.activity;
      const list = bySession.get(rootId) ?? [];
      list.push(a);
      bySession.set(rootId, list);
      if (c.cwd && !cwdOf.has(rootId)) cwdOf.set(rootId, c.cwd);
    }
    if (full) hot.clear();
    else for (const [p, root] of hot) if (root === o.sessionId) hot.delete(p);
    for (const [p, root] of nextHot) hot.set(p, root);

    const out: SessionTasks[] = [];
    for (const [rootId, agents] of bySession) {
      const parent = tree.parents.get(rootId);
      const cwd = parent?.cwd ?? cwdOf.get(rootId);
      const tokens = zeroTokens();
      let running = 0;
      let updatedAt = '';
      for (const a of agents) {
        tokens.total += a.tokens?.total ?? 0;
        if (a.status === 'running') running++;
        if (a.updatedAt > updatedAt) updatedAt = a.updatedAt;
      }
      const st: SessionTasks = {
        agent: 'codex',
        sessionId: rootId,
        cwd: cwd ? normalizePath(cwd) : '',
        workflows: [],
        subagents: agents.sort(byRunningThenRecent).slice(0, SUBAGENTS_PER_SESSION),
        running,
        tokens,
        updatedAt,
      };
      if (parent?.title) st.title = parent.title;
      out.push(st);
    }
    sweepCache([rollouts], t, pass, full);
    // 상한을 넘으면 가장 오래 안 쓴 것부터
    if (rollouts.size > ROLLOUT_CACHE_MAX) {
      const byAge = [...rollouts].sort((a, b) => a[1].seen - b[1].seen);
      for (const [k] of byAge.slice(0, rollouts.size - ROLLOUT_CACHE_MAX)) rollouts.delete(k);
    }
    return out;
  }

  return {
    // 한 번에 하나씩 — 같은 옵션으로 기다리는 차례가 있으면 같이 써요
    collect: singleFlight(collectOnce, (o) => `${o.sessionId ?? ''}|${o.sinceMs ?? ''}`),

    /** 테스트용: 지금 들고 있는 rollout 꼬리 캐시 수 */
    get cachedRollouts(): number {
      return rollouts.size;
    },

    async fingerprint() {
      const t = now();
      const h = createHash('sha1');
      for (const f of DB_FILES) {
        try {
          const s = await stat(join(home, f));
          h.update(`${f}|${s.size}|${s.mtimeMs}\n`);
        } catch {
          h.update(`${f}|none\n`);
        }
      }
      for (const p of [...hot.keys()].sort()) {
        try {
          const s = await stat(p);
          h.update(`${p}|${s.size}|${s.mtimeMs}|${liveness(s.mtimeMs, t)}\n`);
        } catch {
          h.update(`${p}|gone\n`);
        }
      }
      return h.digest('hex');
    },
  };
}
