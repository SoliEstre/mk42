// Codex 세션(스레드) 인덱서.
// sqlite(기본): state_5.sqlite 읽기 전용.
// auto·appServer(선택): 데몬 전용 `codex app-server`(같은 CODEX_HOME)로 thread/list → 실패하면 sqlite.
//   app-server 프로세스는 DB를 읽기-쓰기로 열고 sqlx 마이그레이션을 돌릴 수 있어서 «~/.codex 읽기 전용» 규칙의 예외예요.
// 살아 있는 스레드의 owner는 확장 창·Desktop 앱·CLI 중 하나라서(D23) 이 프로세스의 app-server로는 알 수 없어요.
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionStatus, SessionSummary } from '@mark42/protocol';
import { codexHome as defaultCodexHome, normalizePath, pathKey } from '@mark42/protocol/paths';
import { AppServerClient } from './codex-app-server.ts';
import { findCodexBinary } from './codex-bin.ts';
import { bootTimeMs } from './boot.ts';
import { clipTitle, listCodexThreadsFromSqlite, parseSource, recentCodexRollouts } from './codex-sqlite.ts';
import type { ListOptions, LiveSession, SessionIndexer } from './types.ts';
import { pollSignature, type Poller } from './watch.ts';

export type CodexIndexerMode = 'appServer' | 'sqlite' | 'auto';

export interface CodexIndexerOptions {
  codexHome?: string;
  /** codex 실행 파일. 없으면 확장 번들·Desktop 설치본에서 찾아요 */
  codexBin?: string;
  log?: (m: string) => void;
  /** 기본 'sqlite' */
  mode?: CodexIndexerMode;
  /** OS 부팅 시각(epoch ms) — 테스트용 */
  bootTime?: () => number;
  now?: () => number;
}

/** 테스트에서 조절할 수 있는 내부 값 */
export const CODEX_TUNING = {
  handshakeTimeoutMs: 5000,
  requestTimeoutMs: 10_000,
  /** app-server 실패 뒤 다시 시도하기까지 */
  retryAfterMs: 60_000,
  /** 이만큼 안 쓰면 app-server를 닫아요 */
  idleCloseMs: 5 * 60_000,
  pollMs: 3000,
  pageSize: 200,
  /** limit 없는 목록의 상한 */
  maxThreads: 5000,
  /** rollout 파일이 이 시간 안에(그리고 이번 부팅 뒤에) 쓰였으면 어딘가에서 돌고 있다고 봐요 */
  activeWindowMs: 10 * 60_000,
  /** live() 때 rollout을 확인할 최근 스레드 수 */
  activeScanThreads: 40,
};

const TOP_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'unknown'];
const ALL_KINDS = [...TOP_KINDS, 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'];

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** app-server ThreadStatus → SessionStatus. notLoaded·systemError는 상태 없음 */
export function mapThreadStatus(st: unknown): SessionStatus | undefined {
  if (!isObj(st)) return undefined;
  if (st.type === 'idle') return 'idle';
  if (st.type === 'active') {
    const flags = Array.isArray(st.activeFlags) ? st.activeFlags : [];
    return flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput') ? 'waiting' : 'busy';
  }
  return undefined;
}

/** app-server Thread → SessionSummary (빈 제목·미리보기면 undefined) */
export function mapAppServerThread(t: unknown): SessionSummary | undefined {
  if (!isObj(t)) return undefined;
  const id = str(t.id);
  const cwd = str(t.cwd);
  if (!id || !cwd) return undefined;
  const title = str(t.name) ?? str(t.preview);
  const sec = typeof t.recencyAt === 'number' ? t.recencyAt : typeof t.updatedAt === 'number' ? t.updatedAt : 0;
  const s: SessionSummary = { agent: 'codex', id, cwd: normalizePath(cwd), updatedAt: new Date(sec * 1000).toISOString() };
  if (title) s.title = clipTitle(title);
  const model = str(t.model);
  if (model) s.model = model;
  const effort = str(t.reasoningEffort);
  if (effort) s.effort = effort;
  const status = mapThreadStatus(t.status);
  if (status) s.status = status;
  const src = parseSource(t.source);
  if (src.isSubagent) {
    s.isSubagent = true;
    const p = str(t.parentThreadId) ?? src.parentId;
    if (p) s.parentId = p;
  }
  return s;
}

export function createCodexIndexer(opts: CodexIndexerOptions = {}): SessionIndexer {
  const home = opts.codexHome ?? defaultCodexHome();
  const dbPath = join(home, 'state_5.sqlite');
  const mode: CodexIndexerMode = opts.mode ?? 'sqlite';
  const log = opts.log ?? (() => {});
  const bootTime = opts.bootTime ?? (() => bootTimeMs());
  const now = opts.now ?? Date.now;
  let client: AppServerClient | undefined;
  let failedAt = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let poller: Poller | undefined;
  let stopped = false;
  /** 마지막 app-server 목록 (live()에서 cwd 찾기용) */
  const lastSeen = new Map<string, SessionSummary>();

  function resolveBin(): string | undefined {
    return opts.codexBin ?? findCodexBinary();
  }

  function touchIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const c = client;
      client = undefined;
      void c?.close();
    }, CODEX_TUNING.idleCloseMs);
    idleTimer.unref?.();
  }

  async function getClient(): Promise<AppServerClient> {
    if (client?.alive) {
      await client.start();
      return client;
    }
    const bin = resolveBin();
    if (!bin) throw new Error('codex binary not found');
    const c = new AppServerClient({
      bin,
      codexHome: opts.codexHome,
      log,
      handshakeTimeoutMs: CODEX_TUNING.handshakeTimeoutMs,
    });
    c.onExit(() => {
      if (client === c) client = undefined;
    });
    client = c;
    try {
      await c.start();
    } catch (e) {
      if (client === c) client = undefined;
      throw e;
    }
    log(`codex: app-server started (${bin})`);
    return c;
  }

  async function listViaAppServer(o: ListOptions): Promise<SessionSummary[]> {
    const c = await getClient();
    touchIdle();
    const cap = o.limit !== undefined && o.limit >= 0 ? o.limit : CODEX_TUNING.maxThreads;
    const out: SessionSummary[] = [];
    let cursor: string | undefined;
    const key = o.cwd ? pathKey(o.cwd) : undefined;
    while (out.length < cap) {
      const params: Obj = {
        limit: Math.min(CODEX_TUNING.pageSize, Math.max(1, cap - out.length)),
        sortKey: 'recency_at',
        sortDirection: 'desc',
        sourceKinds: o.includeSubagents ? ALL_KINDS : TOP_KINDS,
        // true가 아니면 app-server가 rollout JSONL을 훑어 DB 메타데이터를 "고쳐" 써요 — 읽기만 해요.
        useStateDbOnly: true,
      };
      // cwd 필터는 app-server가 Windows에서 대소문자·\\?\·구분자 차이를 무시하고 맞춰요(실측). 결과는 한 번 더 걸러요.
      if (o.cwd) params.cwd = normalizePath(o.cwd);
      if (cursor) params.cursor = cursor;
      const res = await c.request('thread/list', params, CODEX_TUNING.requestTimeoutMs);
      if (!isObj(res) || !Array.isArray(res.data)) throw new Error('thread/list: unexpected response');
      for (const t of res.data) {
        const s = mapAppServerThread(t);
        if (!s) continue;
        if (s.isSubagent && !o.includeSubagents) continue;
        if (key !== undefined && pathKey(s.cwd) !== key) continue;
        lastSeen.set(s.id, s);
        out.push(s);
        if (out.length >= cap) break;
      }
      cursor = str(res.nextCursor);
      if (!cursor || res.data.length === 0) break;
    }
    return out;
  }

  async function listViaSqlite(o: ListOptions): Promise<SessionSummary[]> {
    return listCodexThreadsFromSqlite(dbPath, o);
  }

  async function sig(): Promise<string> {
    const parts: string[] = [];
    for (const f of ['state_5.sqlite', 'state_5.sqlite-wal']) {
      try {
        const st = await stat(join(home, f));
        parts.push(`${f}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${f}:none`);
      }
    }
    return parts.join('|');
  }

  return {
    agent: 'codex',

    async list(o: ListOptions): Promise<SessionSummary[]> {
      if (mode === 'sqlite') return listViaSqlite(o);
      if (mode === 'appServer') return listViaAppServer(o);
      if (Date.now() - failedAt >= CODEX_TUNING.retryAfterMs) {
        try {
          return await listViaAppServer(o);
        } catch (e) {
          failedAt = Date.now();
          log(`codex: app-server unavailable, using sqlite: ${e instanceof Error ? e.message : String(e)}`);
          const c = client;
          client = undefined;
          c?.kill();
        }
      }
      return listViaSqlite(o);
    },

    async live(): Promise<LiveSession[]> {
      const out: LiveSession[] = [];
      // 1) 다른 프로세스(확장 창·Desktop 앱·CLI)가 돌리는 스레드는 owner를 물어볼 길이 없어요(D23).
      //    턴이 도는 동안 rollout JSONL이 계속 쓰이니, 이번 부팅 뒤 최근에 쓰인 rollout은 «돌고 있을 수 있음»으로 봐요(추정).
      //    대기 중(idle)으로 열려 있기만 한 스레드는 이 방법으로 못 봐요.
      if (existsSync(dbPath)) {
        const boot = bootTime();
        const t = now();
        for (const r of recentCodexRollouts(dbPath, CODEX_TUNING.activeScanThreads)) {
          let mtime: number;
          try {
            mtime = (await stat(r.rolloutPath)).mtimeMs;
          } catch {
            continue;
          }
          if (mtime < boot || t - mtime > CODEX_TUNING.activeWindowMs) continue;
          out.push({ agent: 'codex', sessionId: r.id, cwd: r.cwd, status: 'busy', owner: 'unknown (recent rollout write)' });
        }
      }
      // 2) 데몬 app-server에 올라온(loaded) 스레드 (auto·appServer 모드만)
      const c = client;
      if (c?.alive) {
        try {
          const res = await c.request('thread/loaded/list', {}, CODEX_TUNING.requestTimeoutMs);
          if (isObj(res) && Array.isArray(res.data)) {
            for (const id of res.data) {
              if (typeof id !== 'string' || out.some((l) => l.sessionId === id)) continue;
              const s = lastSeen.get(id);
              if (!s) continue;
              out.push({ agent: 'codex', sessionId: id, cwd: s.cwd, status: s.status ?? 'idle', owner: 'mark42-app-server' });
            }
          }
        } catch (e) {
          log(`codex: thread/loaded/list failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return out;
    },

    async start(onChange: () => void): Promise<void> {
      if (poller) return;
      stopped = false;
      poller = pollSignature(sig, CODEX_TUNING.pollMs, () => {
        if (!stopped) onChange();
      }, log);
    },

    async stop(): Promise<void> {
      stopped = true;
      poller?.stop();
      poller = undefined;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      const c = client;
      client = undefined;
      await c?.close();
    },
  };
}
