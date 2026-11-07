// Claude Code 세션 인덱서 — ~/.claude는 읽기 전용이에요.
// 목록: projects/<인코딩된 cwd>/<uuid>.jsonl 앞뒤만 읽기 (512MB 넘는 파일이 있어요).
// 실행 중: sessions/<pid>.json (같은 폴더의 *.key는 자격증명이라 절대 열지 않아요).
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SessionStatus, SessionSummary } from '@mark42/protocol';
import { claudeConfigDir, normalizePath, pathKey } from '@mark42/protocol/paths';
import { beforeThisBoot, bootTimeMs } from './boot.ts';
import { peekJsonl } from './jsonl-peek.ts';
import type { ListOptions, LiveSession, SessionIndexer } from './types.ts';
import { coalesce, pollSignature, type Coalescer, type Poller } from './watch.ts';

export interface ClaudeIndexerOptions {
  claudeDir?: string;
  log?: (m: string) => void;
  /** OS 부팅 시각(epoch ms) — 테스트용 */
  bootTime?: () => number;
  /** pid 생존 확인 — 테스트용 */
  pidAlive?: (pid: number) => boolean;
}

/** 테스트에서 조절할 수 있는 내부 값 */
export const CLAUDE_TUNING = {
  headBytes: 64 * 1024,
  maxHeadBytes: 4 * 1024 * 1024,
  tailBytes: 256 * 1024,
  maxTailBytes: 2 * 1024 * 1024,
  pollMs: 5000,
  debounceMs: 300,
};

const PROMPT_MAX = 200;
const SESSION_FILE = /^\d+\.json$/;
const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const MAX_SESSION_JSON = 1024 * 1024;

/**
 * Claude가 프로젝트 디렉터리 이름을 만드는 규칙: 영숫자가 아닌 글자 → '-'.
 * 200자를 넘으면 뒤에 해시가 붙어요(해시 규칙은 몰라서 앞 200자 접두로만 맞춰요).
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > PROMPT_MAX ? t.slice(0, PROMPT_MAX) : t;
}

/** 사람이 친 프롬프트 텍스트만 — tool_result·메타·명령 래퍼는 빼요. */
function userPromptText(r: Rec): string | undefined {
  if (r.type !== 'user' || r.isMeta === true || r.isSidechain === true) return undefined;
  if (r.toolUseResult !== undefined || r.sourceToolAssistantUUID !== undefined) return undefined;
  const msg = r.message;
  if (!isRec(msg)) return undefined;
  const c = msg.content;
  let text: string | undefined;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const b of c) {
      if (!isRec(b)) continue;
      if (b.type === 'tool_result') return undefined;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    text = parts.join(' ');
  }
  if (!text) return undefined;
  const t = text.trim();
  if (!t || t.startsWith('<command-') || t.startsWith('<local-command-') || t.startsWith('<system-reminder>')) return undefined;
  return t;
}

interface Extracted {
  cwd?: string;
  title?: string;
  lastPrompt?: string;
  model?: string;
  effort?: string;
}

/** 레코드를 파일 순서대로 받아 "나중 값이 이겨요" 규칙으로 요약해요. */
export function summarizeRecords(recs: Iterable<unknown>): Extracted {
  let cwd: string | undefined;
  let custom: string | undefined;
  let ai: string | undefined;
  let lastPromptRec: string | undefined;
  let lastUser: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  for (const r of recs) {
    if (!isRec(r)) continue;
    if (cwd === undefined) cwd = str(r.cwd);
    switch (r.type) {
      case 'custom-title':
        custom = str(r.customTitle) ?? custom;
        break;
      case 'ai-title':
        ai = str(r.aiTitle) ?? ai;
        break;
      case 'last-prompt':
        lastPromptRec = str(r.lastPrompt) ?? lastPromptRec;
        break;
      case 'user':
        lastUser = userPromptText(r) ?? lastUser;
        break;
      case 'assistant': {
        if (r.isSidechain === true) break;
        const msg = isRec(r.message) ? r.message : undefined;
        const m = str(r.requestedModel) ?? str(msg?.model);
        if (m && m !== '<synthetic>') model = m;
        effort = str(r.effort) ?? effort;
        break;
      }
    }
  }
  const prompt = lastPromptRec ?? lastUser;
  return {
    cwd,
    title: custom ?? ai,
    lastPrompt: prompt ? clip(prompt) : undefined,
    model,
    effort,
  };
}

function hasCwd(r: unknown): boolean {
  return isRec(r) && typeof r.cwd === 'string' && r.cwd.length > 0;
}

function tailHasModel(recs: unknown[]): boolean {
  return recs.some((r) => isRec(r) && r.type === 'assistant');
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: Omit<SessionSummary, 'status'> | null;
}

function liveStatus(v: unknown): SessionStatus {
  return v === 'busy' || v === 'waiting' ? v : 'idle';
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 있지만 신호 권한이 없음 → 살아 있다고 봐요(관리자 권한 VS Code의 claude일 수 있어요).
    // «죽었는데 살았다»는 재개를 건너뛸 뿐이지만 «살았는데 죽었다»는 한 세션을 두 곳에서 열게 돼요.
    // pid 재사용으로 남은 흔적은 부팅 시각 비교(readLive)로 걸러요.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function createClaudeIndexer(opts: ClaudeIndexerOptions = {}): SessionIndexer {
  const root = opts.claudeDir ?? claudeConfigDir();
  const projectsDir = join(root, 'projects');
  const sessionsDir = join(root, 'sessions');
  const log = opts.log ?? (() => {});
  const bootTime = opts.bootTime ?? (() => bootTimeMs());
  const pidAlive = opts.pidAlive ?? isPidAlive;
  const cache = new Map<string, CacheEntry>();
  let watchers: FSWatcher[] = [];
  let poller: Poller | undefined;
  let notify: Coalescer | undefined;

  async function listDirs(cwd?: string): Promise<{ dirs: string[]; full: boolean }> {
    let names: string[];
    try {
      names = (await readdir(projectsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return { dirs: [], full: true };
    }
    if (cwd) {
      const enc = encodeClaudeProjectDir(normalizePath(cwd)).toLowerCase();
      const hit = names.filter((n) => {
        const l = n.toLowerCase();
        return l === enc || (enc.length > 200 && l.startsWith(enc.slice(0, 200)));
      });
      // 인코딩이 맞는 폴더가 없으면(규칙 변경 대비) 전체를 훑고 cwd 필드로 걸러요.
      if (hit.length > 0) return { dirs: hit.map((n) => join(projectsDir, n)), full: false };
    }
    return { dirs: names.map((n) => join(projectsDir, n)), full: true };
  }

  async function summarizeFile(file: string, mtimeMs: number): Promise<CacheEntry['summary']> {
    const peek = await peekJsonl(file, {
      headBytes: CLAUDE_TUNING.headBytes,
      maxHeadBytes: CLAUDE_TUNING.maxHeadBytes,
      tailBytes: CLAUDE_TUNING.tailBytes,
      maxTailBytes: CLAUDE_TUNING.maxTailBytes,
      headUntil: hasCwd,
      tailUntil: tailHasModel,
    });
    const ex = summarizeRecords([...peek.head, ...peek.tail]);
    if (!ex.cwd) return null;
    const s: Omit<SessionSummary, 'status'> = {
      agent: 'claude',
      id: basename(file, '.jsonl'),
      cwd: normalizePath(ex.cwd),
      updatedAt: new Date(mtimeMs).toISOString(),
    };
    if (ex.title) s.title = ex.title;
    if (ex.lastPrompt) s.lastPrompt = ex.lastPrompt;
    if (ex.model) s.model = ex.model;
    if (ex.effort) s.effort = ex.effort;
    return s;
  }

  async function scan(dirs: string[], full: boolean): Promise<Omit<SessionSummary, 'status'>[]> {
    const out: Omit<SessionSummary, 'status'>[] = [];
    const scanned = new Set(dirs);
    const seen = new Set<string>();
    for (const dir of dirs) {
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => UUID_JSONL.test(f));
      } catch {
        continue;
      }
      for (const f of files) {
        const file = join(dir, f);
        seen.add(file);
        try {
          const st = await stat(file);
          if (!st.isFile()) continue;
          let entry = cache.get(file);
          if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
            entry = { mtimeMs: st.mtimeMs, size: st.size, summary: await summarizeFile(file, st.mtimeMs) };
            cache.set(file, entry);
          }
          if (entry.summary) out.push(entry.summary);
        } catch (e) {
          cache.delete(file);
          log(`claude: skip ${file}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    // 사라진 파일·폴더의 캐시 정리 (이번에 훑은 폴더 범위에서만)
    for (const k of cache.keys()) if (!seen.has(k) && (full || scanned.has(dirname(k)))) cache.delete(k);
    return out;
  }

  async function readLive(): Promise<LiveSession[]> {
    let names: string[];
    try {
      names = await readdir(sessionsDir);
    } catch {
      return [];
    }
    const out: LiveSession[] = [];
    const boot = bootTime();
    for (const name of names) {
      // <pid>.json만 — <pid>.<hash>.key 같은 다른 파일은 이름만 보고 건너뛰어요.
      if (!SESSION_FILE.test(name)) continue;
      const pid = Number(name.slice(0, -5));
      if (!pidAlive(pid)) continue;
      const file = join(sessionsDir, name);
      try {
        const st = await stat(file);
        if (!st.isFile() || st.size > MAX_SESSION_JSON) continue;
        // 이번 부팅 전에 쓴 파일은 비정상 종료·재부팅으로 남은 흔적이에요. pid는 금방 다른 프로세스가 다시 써요.
        if (beforeThisBoot(st.mtimeMs, boot)) continue;
        const j: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (!isRec(j)) continue;
        const sessionId = str(j.sessionId);
        const cwd = str(j.cwd);
        if (!sessionId || !cwd) continue;
        if (typeof j.pid === 'number' && j.pid !== pid) continue;
        if (typeof j.startedAt === 'number' && beforeThisBoot(j.startedAt, boot)) continue;
        out.push({ agent: 'claude', sessionId, cwd: normalizePath(cwd), status: liveStatus(j.status), pid });
      } catch (e) {
        // 쓰는 도중이면 다음 폴링에서 다시 읽어요.
        log(`claude: session file unreadable ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  async function signature(): Promise<string> {
    const parts: string[] = [];
    try {
      for (const name of (await readdir(sessionsDir)).sort()) {
        if (!SESSION_FILE.test(name)) continue;
        const pid = Number(name.slice(0, -5));
        try {
          const st = await stat(join(sessionsDir, name));
          parts.push(`s:${name}:${st.mtimeMs}:${st.size}:${isPidAlive(pid) ? 1 : 0}`);
        } catch {
          // 사라진 파일
        }
      }
    } catch {
      parts.push('s:none');
    }
    for (const dir of (await listDirs()).dirs) {
      try {
        for (const f of (await readdir(dir)).sort()) {
          if (!UUID_JSONL.test(f)) continue;
          try {
            const st = await stat(join(dir, f));
            parts.push(`p:${basename(dir)}/${f}:${st.mtimeMs}:${st.size}`);
          } catch {
            // 사라진 파일
          }
        }
      } catch {
        // 사라진 폴더
      }
    }
    return parts.join('\n');
  }

  function relevant(dir: 'projects' | 'sessions', filename: string | Buffer | null): boolean {
    if (filename === null) return true;
    const f = String(filename).replace(/\//g, '\\');
    if (dir === 'sessions') return SESSION_FILE.test(f);
    // projects: 최상위 <dir>\<uuid>.jsonl만 (서브에이전트·도구 결과 파일 변화는 무시)
    const parts = f.split('\\');
    return parts.length === 1 || (parts.length === 2 && UUID_JSONL.test(parts[1]!));
  }

  return {
    agent: 'claude',

    async list(o: ListOptions): Promise<SessionSummary[]> {
      const { dirs, full } = await listDirs(o.cwd);
      const [rows, live] = await Promise.all([scan(dirs, full), readLive()]);
      const liveById = new Map(live.map((l) => [l.sessionId, l] as const));
      const key = o.cwd ? pathKey(o.cwd) : undefined;
      const out: SessionSummary[] = [];
      for (const r of rows) {
        if (key !== undefined && pathKey(r.cwd) !== key) continue;
        const s: SessionSummary = { ...r };
        const l = liveById.get(r.id);
        if (l) s.status = l.status;
        out.push(s);
      }
      out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      return o.limit !== undefined && o.limit >= 0 ? out.slice(0, o.limit) : out;
    },

    live: readLive,

    async start(onChange: () => void): Promise<void> {
      if (notify) return;
      notify = coalesce(onChange, CLAUDE_TUNING.debounceMs);
      const n = notify;
      for (const [dir, kind, recursive] of [
        [projectsDir, 'projects', true],
        [sessionsDir, 'sessions', false],
      ] as const) {
        try {
          const w = watch(dir, { recursive, persistent: false }, (_ev, filename) => {
            if (relevant(kind, filename)) n.trigger();
          });
          w.on('error', (e) => {
            log(`claude: watch ${kind} failed, polling only: ${e.message}`);
            w.close();
          });
          watchers.push(w);
        } catch (e) {
          log(`claude: watch ${kind} unavailable, polling only: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // pid가 죽어도 파일 이벤트는 없어서 폴링은 항상 돌려요.
      poller = pollSignature(signature, CLAUDE_TUNING.pollMs, () => n.trigger(), log);
    },

    async stop(): Promise<void> {
      for (const w of watchers) w.close();
      watchers = [];
      poller?.stop();
      poller = undefined;
      notify?.cancel();
      notify = undefined;
    },
  };
}
