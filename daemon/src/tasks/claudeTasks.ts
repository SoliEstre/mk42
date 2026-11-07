// Claude Code 백그라운드 작업 수집 — ~/.claude는 읽기 전용이에요.
// 서브에이전트: projects/<프로젝트>/<세션>/subagents/agent-<id>.jsonl + .meta.json
// 워크플로우: <세션>/subagents/workflows/wf_<runId>/journal.jsonl + agent-<id>.*, 스크립트 meta는 <세션>/workflows/scripts/<이름>-<runId>.js
// 끝난 워크플로우는 <세션>/workflows/<runId>.json(실행 결과)이 생겨요 — 상태·이름·agent 수만 읽고 script·result 본문은 버려요.
// 스크립트 meta·실행 결과는 세션의 지금 cwd 쪽 프로젝트 폴더에 쓰일 수 있어서, 같은 세션의 다른 프로젝트 폴더도 찾아봐요.
// 스크립트는 실행하지 않고 앞부분만 정규식으로 읽어요. 활동 줄에는 도구 이름 + 파일 이름만 넣어요(명령·패턴·본문 없음).
import { createHash } from 'node:crypto';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackgroundAgent, BackgroundTaskStatus, BackgroundWorkflow, SessionTasks, TokenUsage } from '@mark42/protocol';
import { claudeConfigDir, normalizePath } from '@mark42/protocol/paths';
import { summarizeRecords } from '../indexers/claude.ts';
import { peekJsonl } from '../indexers/jsonl-peek.ts';
import {
  addTokens,
  byRunningThenRecent,
  clipLabel,
  clipSummary,
  clipText,
  countRunning,
  DEFAULT_SINCE_MS,
  earlierIso,
  iso,
  isoOf,
  isRec,
  laterIso,
  liveness,
  newCursor,
  num,
  readAppended,
  singleFlight,
  str,
  SUBAGENTS_PER_SESSION,
  sweepCache,
  toolActivity,
  WORKFLOWS_PER_SESSION,
  zeroTokens,
  type CacheTouch,
  type TailCursor,
} from './common.ts';

export interface CollectOptions {
  sessionId?: string;
  sinceMs?: number;
}

/** 한 에이전트(Claude/Codex)의 백그라운드 작업 수집기 */
export interface TaskCollector {
  collect(o: CollectOptions): Promise<SessionTasks[]>;
  /** 싼 stat 서명 — 바뀌면 다시 collect할 만해요 */
  fingerprint(): Promise<string>;
}

export interface ClaudeTaskOptions {
  claudeDir?: string;
  now?: () => number;
  /** 덧붙은 줄 읽기 바꿔 끼우기(테스트용 — 잠긴 파일 흉내) */
  readAppended?: typeof readAppended;
}

const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,128})\.jsonl$/;
const WORKFLOW_DIR = /^wf_[A-Za-z0-9_-]{1,128}$/;
const META_MAX = 64 * 1024;
/** 워크플로우 하나에 싣는 agent 수 상한(진행률은 전체로 세요) */
const WORKFLOW_AGENTS_MAX = 200;
const SCRIPT_HEAD = 16 * 1024;
/** 본 세션 파일(제목·cwd)을 다시 들여다보는 최소 간격 */
const MAIN_REPEEK_MS = 60 * 1000;
/** 실행 결과 json은 script·result 본문까지 들어 있어 커요 — 이보다 크면 읽지 않아요 */
const RUN_JSON_MAX = 16 * 1024 * 1024;

// ---- 워크플로우 스크립트 meta (실행하지 않고 글자로만)

export interface WorkflowScriptMeta {
  name?: string;
  description?: string;
  phases: string[];
}

const STRING_LIT = String.raw`(['"\x60])((?:\\[\s\S]|(?!\1)[^\\])*)\1`;

function unescapeLit(s: string): string {
  return s.replace(/\\(?:\r?\n|([\s\S]))/g, (_m, c: string | undefined) => (c === undefined ? '' : c === 'n' || c === 't' || c === 'r' ? ' ' : c));
}

/** open 위치의 괄호와 짝인 닫는 괄호 위치(문자열·주석은 건너뛰어요). 못 찾으면 src 끝 */
function matchClose(src: string, openIdx: number): number {
  const openCh = src[openIdx];
  const closeCh = openCh === '[' ? ']' : '}';
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
    } else if (c === openCh || c === '[' || c === '{') {
      depth++;
    } else if (c === closeCh || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

/** `export const meta = { name, description, phases: [{ title }] }` 앞부분에서 이름·설명·단계 제목만 뽑아요 */
export function parseWorkflowScriptMeta(src: string): WorkflowScriptMeta | null {
  const m = /export\s+const\s+meta\s*=\s*\{/.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let body = src.slice(open, matchClose(src, open) + 1);
  const phases: string[] = [];
  const pm = /\bphases\s*:\s*\[/.exec(body);
  if (pm) {
    const pOpen = pm.index + pm[0].length - 1;
    const pClose = matchClose(body, pOpen);
    const arr = body.slice(pOpen, pClose + 1);
    for (const t of arr.matchAll(new RegExp(String.raw`\btitle\s*:\s*${STRING_LIT}`, 'g'))) {
      const title = clipLabel(unescapeLit(t[2] ?? ''));
      if (title) phases.push(title);
    }
    body = body.slice(0, pm.index) + body.slice(pClose + 1);
  }
  const field = (key: string, max: number): string | undefined => {
    const f = new RegExp(String.raw`\b${key}\s*:\s*${STRING_LIT}`).exec(body);
    const v = f ? clipText(unescapeLit(f[2] ?? ''), max) : '';
    return v || undefined;
  };
  const out: WorkflowScriptMeta = { phases };
  const name = field('name', 120);
  if (name) out.name = name;
  const description = field('description', 300);
  if (description) out.description = description;
  return out;
}

// ---- 캐시 항목

interface FileStamp {
  size: number;
  mtimeMs: number;
}

/** 서브에이전트 transcript 하나의 누적 상태(덧붙은 바이트만 읽어요) */
interface AgentFileState extends FileStamp, CacheTouch {
  cursor: TailCursor;
  firstTs?: string;
  lastTs?: string;
  cwd?: string;
  /** message.id → usage (한 메시지가 여러 줄로 같은 usage를 되풀이해요) */
  usage: Map<string, TokenUsage>;
  /** id 없는 usage 합 */
  anon: TokenUsage;
  /** 마지막 응답의 usage — 표시 total은 Claude Code처럼 이것의 문맥(input + 캐시 읽기·쓰기)이에요 */
  last?: TokenUsage;
  activity?: string;
}

interface AgentMeta {
  agentType?: string;
  description?: string;
  finished?: boolean;
  workflowPhase?: string;
}

interface MetaEntry extends FileStamp, CacheTouch {
  meta: AgentMeta | null;
}

interface JournalEntry {
  key: string;
  agentId?: string;
  label?: string;
  phase?: string;
  order: number;
  outcome?: 'done' | 'failed';
  summary?: string;
}

interface JournalState extends FileStamp, CacheTouch {
  cursor: TailCursor;
  byKey: Map<string, JournalEntry>;
  /** 같은 key를 다시 시작해 밀려난 앞선 시도의 agentId — 그 agent 파일은 목록·진행률에 넣지 않아요 */
  superseded: Set<string>;
}

interface ScriptEntry extends CacheTouch {
  mtimeMs: number;
  meta: WorkflowScriptMeta | null;
}

interface DirListEntry extends CacheTouch {
  mtimeMs: number;
  names: string[];
}

interface MainEntry extends CacheTouch {
  mtimeMs: number;
  readAt: number;
  cwd?: string;
  title?: string;
}

/** 워크플로우 실행 결과 json에서 쓰는 값만 */
export interface WorkflowRunInfo {
  status?: 'completed' | 'killed' | 'failed';
  workflowName?: string;
  agentCount?: number;
  durationMs?: number;
  startTimeMs?: number;
  totalTokens?: number;
  phases: string[];
}

interface RunEntry extends FileStamp, CacheTouch {
  info: WorkflowRunInfo | null;
}

/** runId별로 찾아 둔 스크립트·실행 결과 파일 경로 */
interface RunRef extends CacheTouch {
  script?: string;
  run?: string;
}

/** 실행 결과 json에서 상태·이름·agent 수·시각·단계 제목만 뽑아요(script·result 본문은 버려요) */
export function parseWorkflowRun(o: unknown): WorkflowRunInfo | null {
  if (!isRec(o)) return null;
  const info: WorkflowRunInfo = { phases: [] };
  const status = str(o.status);
  if (status === 'completed' || status === 'killed' || status === 'failed') info.status = status;
  const name = str(o.workflowName);
  if (name) {
    const n = clipText(name, 120);
    if (n) info.workflowName = n;
  }
  const count = num(o.agentCount);
  if (count !== undefined && count >= 0) info.agentCount = Math.floor(count);
  const duration = num(o.durationMs);
  if (duration !== undefined && duration >= 0) info.durationMs = duration;
  const start = num(o.startTime);
  if (start !== undefined && start > 0) info.startTimeMs = start;
  const tk = num(o.totalTokens);
  if (tk !== undefined && tk >= 0) info.totalTokens = tk;
  if (Array.isArray(o.phases)) {
    for (const p of o.phases) {
      const title = isRec(p) ? str(p.title) : undefined;
      const t = title ? clipLabel(title) : '';
      if (t) info.phases.push(t);
    }
  }
  return info;
}

function usageOf(u: unknown): TokenUsage | undefined {
  if (!isRec(u)) return undefined;
  const input = num(u.input_tokens) ?? 0;
  const output = num(u.output_tokens) ?? 0;
  const cacheRead = num(u.cache_read_input_tokens) ?? 0;
  const cacheCreation = num(u.cache_creation_input_tokens) ?? 0;
  return { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation };
}

function applyAgentRecord(st: AgentFileState, r: unknown): void {
  if (!isRec(r)) return;
  const ts = isoOf(r.timestamp);
  if (ts) {
    st.firstTs = earlierIso(st.firstTs, ts);
    st.lastTs = laterIso(st.lastTs, ts);
  }
  if (st.cwd === undefined) st.cwd = str(r.cwd);
  if (r.type !== 'assistant' || !isRec(r.message)) return;
  const msg = r.message;
  const u = usageOf(msg.usage);
  if (u) {
    const id = str(msg.id);
    if (id) st.usage.set(id, u);
    else addTokens(st.anon, u);
    st.last = u;
  }
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (isRec(b) && b.type === 'tool_use') {
        const name = str(b.name);
        if (name) st.activity = toolActivity(name, b.input);
      }
    }
  }
}

/**
 * input·output·cacheRead·cacheCreation은 응답마다 더한 값, total은 Claude Code가 보여 주는 수(«45.2k tokens», 워크플로우
 * totalTokens)와 같게 마지막 응답의 문맥(input + 캐시 읽기·쓰기)이에요 — 캐시 읽기는 요청마다 다시 세서 더하면 수십 배로 부풀어요
 * (2026-10-30 실제 워크플로우 43개: 실행 결과 json totalTokens 대비 중앙값 0.9999).
 */
function agentTokens(st: AgentFileState): TokenUsage {
  const t = addTokens(zeroTokens(), st.anon);
  for (const u of st.usage.values()) addTokens(t, u);
  t.total = st.last ? st.last.input + st.last.cacheRead + st.last.cacheCreation : 0;
  return t;
}

function applyJournalRecord(st: JournalState, r: unknown): void {
  if (!isRec(r)) return;
  const agentId = str(r.agentId);
  const key = str(r.key) ?? agentId;
  if (!key) return;
  let e = st.byKey.get(key);
  if (r.type === 'started') {
    if (!e) {
      e = { key, order: st.byKey.size };
      st.byKey.set(key, e);
    }
    // 같은 key의 재시도는 새 agent로 다시 시작해요(사이에 failed가 있든 없든) — 앞선 시도는 밀려나요
    if (agentId) {
      if (e.agentId && e.agentId !== agentId) st.superseded.add(e.agentId);
      st.superseded.delete(agentId);
      e.agentId = agentId;
    }
    delete e.outcome;
    delete e.summary;
    const label = str(r.label);
    if (label) e.label = clipLabel(label);
    const phase = str(r.phase);
    if (phase) e.phase = clipLabel(phase);
  } else if (r.type === 'result' || r.type === 'failed') {
    if (!e) {
      e = { key, order: st.byKey.size };
      st.byKey.set(key, e);
    }
    // 밀려난 시도의 늦은 결과는 지금 시도의 결과가 아니에요
    if (agentId && e.agentId && agentId !== e.agentId && st.superseded.has(agentId)) return;
    if (agentId && !e.agentId) e.agentId = agentId;
    e.outcome = r.type === 'result' ? 'done' : 'failed';
    const res = r.result;
    if (r.type === 'result' && isRec(res) && typeof res.summary === 'string' && res.summary.trim()) {
      e.summary = clipSummary(res.summary);
    }
  }
}

async function statOrUndef(p: string): Promise<FileStamp | undefined> {
  try {
    const s = await stat(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

interface SessionDirInfo {
  projDir: string;
  sessionId: string;
  sessionDir: string;
  /** subagents·subagents/workflows 폴더와 본 세션 transcript mtime 중 큰 값 */
  mtimeMs: number;
  stampKey: string;
}

interface SessionScan {
  infos: SessionDirInfo[];
  /** 세션 id → 그 세션 폴더가 있는 프로젝트 폴더들(스크립트·실행 결과를 다른 프로젝트 폴더에서도 찾아요) */
  homes: Map<string, string[]>;
}

/** 한 번의 수집 패스에서 같이 쓰는 값 */
interface PassCtx {
  t: number;
  cutoff: number;
  homes: Map<string, string[]>;
}

export function createClaudeTaskCollector(opts: ClaudeTaskOptions = {}): TaskCollector & { readonly cachedFiles: number } {
  const projectsDir = join(opts.claudeDir ?? claudeConfigDir(), 'projects');
  const now = opts.now ?? Date.now;
  const readTail = opts.readAppended ?? readAppended;
  const agentFiles = new Map<string, AgentFileState>();
  const metas = new Map<string, MetaEntry>();
  const journals = new Map<string, JournalState>();
  const scripts = new Map<string, ScriptEntry>();
  const dirLists = new Map<string, DirListEntry>();
  const mains = new Map<string, MainEntry>();
  const runs = new Map<string, RunEntry>();
  /** `<세션>/<runId>` → 찾아 둔 스크립트·실행 결과 경로 */
  const runRefs = new Map<string, RunRef>();
  /** 끝나지 않은 agent·워크플로우 파일 → 세션 폴더 (서명에 넣어 덧붙임을 알아채요) */
  const hot = new Map<string, string>();
  /** 전체(세션 필터 없는) 수집 패스 번호 — 최근 두 패스에서 안 쓰인 캐시를 버려요 */
  let pass = 0;

  function touch<T extends CacheTouch>(e: T, t: number): T {
    e.seen = t;
    e.pass = pass;
    return e;
  }

  async function scanSessions(only?: string): Promise<SessionScan> {
    const homes = new Map<string, string[]>();
    let projects: string[];
    try {
      projects = (await readdir(projectsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return { infos: [], homes };
    }
    const infos: SessionDirInfo[] = [];
    for (const projDir of projects) {
      const projPath = join(projectsDir, projDir);
      let names: string[];
      try {
        names = (await readdir(projPath, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        continue;
      }
      for (const sessionId of names) {
        if (only !== undefined && sessionId !== only) continue;
        const h = homes.get(sessionId);
        if (h) h.push(projDir);
        else homes.set(sessionId, [projDir]);
        const sessionDir = join(projPath, sessionId);
        const sub = await statOrUndef(join(sessionDir, 'subagents'));
        if (!sub) continue;
        const wf = await statOrUndef(join(sessionDir, 'subagents', 'workflows'));
        // 폴더 mtime은 파일이 새로 생길 때만 바뀌어요 — 오래 도는 일은 본 세션 transcript가 움직이는 걸로도 창 안에 둬요
        const main = await statOrUndef(join(projPath, `${sessionId}.jsonl`));
        infos.push({
          projDir,
          sessionId,
          sessionDir,
          mtimeMs: Math.max(sub.mtimeMs, wf?.mtimeMs ?? 0, main?.mtimeMs ?? 0),
          stampKey: `${sub.mtimeMs}/${wf?.mtimeMs ?? 0}/${main?.mtimeMs ?? 0}`,
        });
      }
    }
    return { infos, homes };
  }

  async function listDir(dir: string, t: number): Promise<string[]> {
    const s = await statOrUndef(dir);
    if (!s) {
      dirLists.delete(dir);
      return [];
    }
    const c = dirLists.get(dir);
    if (c && c.mtimeMs === s.mtimeMs) {
      touch(c, t);
      return c.names;
    }
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    dirLists.set(dir, { mtimeMs: s.mtimeMs, names, seen: t, pass });
    return names;
  }

  async function agentState(file: string, s: FileStamp, t: number): Promise<AgentFileState> {
    let st = agentFiles.get(file);
    // 줄었거나 바뀐 파일은 처음부터 다시 읽어요
    if (st && s.size < st.cursor.offset) st = undefined;
    if (!st) {
      st = { cursor: newCursor(), size: 0, mtimeMs: 0, usage: new Map(), anon: zeroTokens(), seen: t, pass };
      agentFiles.set(file, st);
    }
    touch(st, t);
    if (st.size !== s.size || st.mtimeMs !== s.mtimeMs) {
      const cur = st;
      try {
        await readTail(file, cur.cursor, s.size, (r) => applyAgentRecord(cur, r));
        st.size = s.size;
        st.mtimeMs = s.mtimeMs;
      } catch {
        // 읽는 중에 지워졌거나 잠겼어요(EBUSY 등) — 크기·시각을 그대로 둬서 다음 번에 다시 읽어요
      }
    }
    return st;
  }

  async function readMeta(file: string, t: number): Promise<{ meta: AgentMeta | null; mtimeMs: number }> {
    const s = await statOrUndef(file);
    if (!s) {
      metas.delete(file);
      return { meta: null, mtimeMs: 0 };
    }
    const c = metas.get(file);
    if (c && c.mtimeMs === s.mtimeMs && c.size === s.size) {
      touch(c, t);
      return c;
    }
    let meta: AgentMeta | null = null;
    if (s.size <= META_MAX) {
      try {
        const o: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (isRec(o)) {
          meta = {};
          const agentType = str(o.agentType);
          if (agentType) meta.agentType = clipLabel(agentType);
          const description = str(o.description);
          if (description) meta.description = clipLabel(description);
          if (typeof o.finished === 'boolean') meta.finished = o.finished;
          const phase = str(o.workflowPhase);
          if (phase) meta.workflowPhase = clipLabel(phase);
        }
      } catch {
        // 쓰는 중이면 다음 번에
      }
    }
    metas.set(file, { ...s, meta, seen: t, pass });
    return { meta, mtimeMs: s.mtimeMs };
  }

  async function journalState(file: string, t: number): Promise<JournalState | undefined> {
    const s = await statOrUndef(file);
    if (!s) {
      journals.delete(file);
      return undefined;
    }
    let st = journals.get(file);
    if (st && s.size < st.cursor.offset) st = undefined;
    if (!st) {
      st = { cursor: newCursor(), size: 0, mtimeMs: 0, byKey: new Map(), superseded: new Set(), seen: t, pass };
      journals.set(file, st);
    }
    touch(st, t);
    if (st.size !== s.size || st.mtimeMs !== s.mtimeMs) {
      const cur = st;
      try {
        await readTail(file, cur.cursor, s.size, (r) => applyJournalRecord(cur, r));
        st.size = s.size;
        st.mtimeMs = s.mtimeMs;
      } catch {
        // 잠겼어요 — 크기·시각을 그대로 둬서 다음 번에 다시
      }
    }
    return st;
  }

  /** 이 세션의 workflows 폴더 후보: 이 프로젝트 폴더 먼저, 그다음 같은 세션이 있는 다른 프로젝트 폴더 */
  function workflowDirs(info: SessionDirInfo, ctx: PassCtx): string[] {
    const out = [join(info.sessionDir, 'workflows')];
    for (const p of ctx.homes.get(info.sessionId) ?? []) {
      if (p !== info.projDir) out.push(join(projectsDir, p, info.sessionId, 'workflows'));
    }
    return out;
  }

  function runRef(info: SessionDirInfo, runId: string, t: number): RunRef {
    const k = `${info.sessionId}/${runId}`;
    let r = runRefs.get(k);
    if (!r) {
      r = { seen: t, pass };
      runRefs.set(k, r);
    }
    return touch(r, t);
  }

  async function findScript(info: SessionDirInfo, runId: string, ctx: PassCtx): Promise<{ file: string; s: FileStamp } | undefined> {
    const ref = runRef(info, runId, ctx.t);
    if (ref.script) {
      const s = await statOrUndef(ref.script);
      if (s) return { file: ref.script, s };
      delete ref.script;
    }
    for (const wd of workflowDirs(info, ctx)) {
      const dir = join(wd, 'scripts');
      const name = (await listDir(dir, ctx.t)).find((n) => n === `${runId}.js` || n.endsWith(`-${runId}.js`));
      if (!name) continue;
      const file = join(dir, name);
      const s = await statOrUndef(file);
      if (!s) continue;
      ref.script = file;
      return { file, s };
    }
    return undefined;
  }

  /** 실행 결과 json(끝난 워크플로우에만 있어요). candidates는 아직 없을 때 생길 자리(서명에 넣어요) */
  async function runResult(info: SessionDirInfo, runId: string, ctx: PassCtx): Promise<{ info: WorkflowRunInfo | null; candidates: string[] }> {
    const ref = runRef(info, runId, ctx.t);
    const candidates = workflowDirs(info, ctx).map((wd) => join(wd, `${runId}.json`));
    let found: { file: string; s: FileStamp } | undefined;
    if (ref.run) {
      const s = await statOrUndef(ref.run);
      if (s) found = { file: ref.run, s };
      else delete ref.run;
    }
    if (!found) {
      for (const file of candidates) {
        const s = await statOrUndef(file);
        if (!s) continue;
        ref.run = file;
        found = { file, s };
        break;
      }
    }
    if (!found) return { info: null, candidates };
    const { file, s } = found;
    const c = runs.get(file);
    if (c && c.mtimeMs === s.mtimeMs && c.size === s.size) return { info: touch(c, ctx.t).info, candidates };
    let parsed: WorkflowRunInfo | null = null;
    if (s.size <= RUN_JSON_MAX) {
      try {
        parsed = parseWorkflowRun(JSON.parse(await readFile(file, 'utf8')));
      } catch {
        // 쓰는 중이면 다음 번에(캐시하지 않아요)
        return { info: null, candidates };
      }
    }
    runs.set(file, { ...s, info: parsed, seen: ctx.t, pass });
    return { info: parsed, candidates };
  }

  async function scriptMeta(info: SessionDirInfo, runId: string, ctx: PassCtx): Promise<WorkflowScriptMeta | null> {
    const t = ctx.t;
    const found = await findScript(info, runId, ctx);
    if (!found) return null;
    const { file, s } = found;
    const c = scripts.get(file);
    if (c && c.mtimeMs === s.mtimeMs) {
      touch(c, t);
      return c.meta;
    }
    let meta: WorkflowScriptMeta | null = null;
    try {
      const fh = await open(file, 'r');
      try {
        const buf = Buffer.alloc(Math.min(SCRIPT_HEAD, s.size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        meta = parseWorkflowScriptMeta(buf.subarray(0, bytesRead).toString('utf8'));
      } finally {
        await fh.close();
      }
    } catch {
      meta = null;
    }
    scripts.set(file, { mtimeMs: s.mtimeMs, meta, seen: t, pass });
    return meta;
  }

  /** 본 세션 transcript에서 cwd·제목(사용자가 붙인 제목 / AI 제목)만 */
  async function mainInfo(info: SessionDirInfo, t: number): Promise<MainEntry | undefined> {
    const file = join(projectsDir, info.projDir, `${info.sessionId}.jsonl`);
    const s = await statOrUndef(file);
    if (!s) return mains.get(file);
    const c = mains.get(file);
    if (c && (c.mtimeMs === s.mtimeMs || t - c.readAt < MAIN_REPEEK_MS)) {
      return touch(c, t);
    }
    const e: MainEntry = { mtimeMs: s.mtimeMs, readAt: t, seen: t, pass };
    if (c?.cwd) e.cwd = c.cwd;
    if (c?.title) e.title = c.title;
    try {
      const peek = await peekJsonl(file, {
        headBytes: 64 * 1024,
        maxHeadBytes: 1024 * 1024,
        tailBytes: 256 * 1024,
        maxTailBytes: 256 * 1024,
        headUntil: (r) => isRec(r) && typeof r.cwd === 'string' && r.cwd.length > 0,
      });
      const ex = summarizeRecords([...peek.head, ...peek.tail]);
      if (ex.cwd) e.cwd = ex.cwd;
      if (ex.title) e.title = clipLabel(ex.title);
    } catch {
      // 다음 번에
    }
    mains.set(file, e);
    return e;
  }

  function buildAgent(
    id: string,
    file: AgentFileState | undefined,
    meta: AgentMeta | null,
    j: JournalEntry | undefined,
    /** agent 파일의 stat mtime(파일이 없으면 journal·폴더 시각) — 읽기에 실패한 파일도 시각은 맞게요 */
    mtimeMs: number,
    t: number,
    /** 워크플로우 실행이 끝났으면(실행 결과 json) 끝난 기록 없는 agent도 이 상태로 */
    runOutcome?: 'done' | 'failed',
  ): BackgroundAgent {
    const status: BackgroundTaskStatus = j?.outcome ?? (meta?.finished === true ? 'done' : (runOutcome ?? liveness(mtimeMs, t)));
    const updatedAt = iso(mtimeMs);
    const a: BackgroundAgent = {
      id,
      label: j?.label ?? meta?.description ?? meta?.agentType ?? id,
      status,
      updatedAt,
    };
    if (meta?.agentType) a.kind = meta.agentType;
    const phase = j?.phase ?? meta?.workflowPhase;
    if (phase) a.phase = phase;
    if (file?.firstTs) a.startedAt = file.firstTs;
    if (status === 'done' || status === 'failed') a.endedAt = file?.lastTs ?? updatedAt;
    if (file) {
      const tk = agentTokens(file);
      if (tk.total > 0) a.tokens = tk;
      if (file.activity) a.activity = file.activity;
    }
    if (j?.summary) a.summary = j.summary;
    return a;
  }

  async function collectWorkflow(
    info: SessionDirInfo,
    runId: string,
    ctx: PassCtx,
    hotOut: string[],
    cwdOut: { cwd?: string },
  ): Promise<BackgroundWorkflow | undefined> {
    const t = ctx.t;
    const wfDir = join(info.sessionDir, 'subagents', 'workflows', runId);
    const dirStat = await statOrUndef(wfDir);
    if (!dirStat) return undefined;
    const journalFile = join(wfDir, 'journal.jsonl');
    const jStat = await statOrUndef(journalFile);
    const baseMtime = Math.max(dirStat.mtimeMs, jStat?.mtimeMs ?? 0);
    // agent가 시작·끝날 때마다 journal이 자라요 — 폴더·journal이 창 밖이면 agent 파일까지 보지 않아요
    if (baseMtime < ctx.cutoff) return undefined;
    const names = await listDir(wfDir, t);
    const fileIds = new Map<string, FileStamp>();
    for (const n of names) {
      const m = AGENT_FILE.exec(n);
      if (!m) continue;
      const s = await statOrUndef(join(wfDir, n));
      if (s) fileIds.set(m[1]!, s);
    }

    const journal = jStat ? await journalState(journalFile, t) : undefined;
    const entries = journal ? [...journal.byKey.values()].sort((a, b) => a.order - b.order) : [];
    const byAgent = new Map<string, JournalEntry>();
    for (const e of entries) if (e.agentId) byAgent.set(e.agentId, e);
    const ids: string[] = [];
    for (const e of entries) if (e.agentId) ids.push(e.agentId);
    // 재시도로 밀려난 앞선 시도의 파일은 끝나지 않은 agent로 되살리지 않아요
    for (const id of fileIds.keys()) if (!byAgent.has(id) && !journal?.superseded.has(id)) ids.push(id);

    // 실행 결과 json이 있으면 워크플로우는 끝났어요 — completed는 done, killed·failed는 failed
    const run = await runResult(info, runId, ctx);
    const ri = run.info;
    const runOutcome: 'done' | 'failed' | undefined = ri?.status === 'completed' ? 'done' : ri?.status ? 'failed' : undefined;

    const agents: BackgroundAgent[] = [];
    const tokens = zeroTokens();
    let startedAt: string | undefined;
    const fallbackMtime = jStat?.mtimeMs ?? dirStat.mtimeMs;
    for (const id of ids) {
      const s = fileIds.get(id);
      const path = join(wfDir, `agent-${id}.jsonl`);
      const file = s ? await agentState(path, s, t) : undefined;
      if (file?.cwd && !cwdOut.cwd) cwdOut.cwd = file.cwd;
      const { meta } = await readMeta(join(wfDir, `agent-${id}.meta.json`), t);
      const a = buildAgent(id, file, meta, byAgent.get(id), s?.mtimeMs ?? fallbackMtime, t, runOutcome);
      if (a.status === 'running' || a.status === 'stale') {
        if (s) hotOut.push(path);
      }
      addTokens(tokens, a.tokens);
      startedAt = earlierIso(startedAt, a.startedAt);
      agents.push(a);
    }
    // 진행률: 시작한 agent 중 끝난 수(journal 기준, journal이 없으면 파일 기준)
    const resolved = agents.filter((a) => a.status === 'done' || a.status === 'failed').length;
    const running = agents.some((a) => a.status === 'running');
    const unresolved = agents.length - resolved;
    let status: BackgroundTaskStatus;
    if (runOutcome) status = runOutcome;
    else if (running) status = 'running';
    else if (unresolved > 0) status = 'stale';
    else if (agents.length === 0) status = liveness(baseMtime, t);
    else status = agents.some((a) => a.status === 'failed') ? 'failed' : 'done';
    if (status === 'running' || status === 'stale') {
      hotOut.push(wfDir);
      if (jStat) hotOut.push(journalFile);
      // 끝나면 실행 결과 json이 생겨요 — 생기는 순간을 서명이 알아채게
      hotOut.push(...run.candidates);
    }

    const sm = await scriptMeta(info, runId, ctx);
    const phaseTitles = [...(sm?.phases.length ? sm.phases : (ri?.phases ?? []))];
    for (const a of agents) if (a.phase && !phaseTitles.includes(a.phase)) phaseTitles.push(a.phase);
    const phases = phaseTitles.map((title) => {
      const inPhase = agents.filter((a) => a.phase === title);
      return { title, started: inPhase.length, done: inPhase.filter((a) => a.status === 'done' || a.status === 'failed').length };
    });

    let updatedAt = iso(baseMtime);
    for (const a of agents) updatedAt = laterIso(updatedAt, a.updatedAt)!;
    if (ri?.startTimeMs !== undefined) {
      startedAt = earlierIso(startedAt, iso(ri.startTimeMs));
      if (ri.durationMs !== undefined) updatedAt = laterIso(updatedAt, iso(ri.startTimeMs + ri.durationMs))!;
    }
    // 전체 수: 아는 agent 수와 실행 결과의 agentCount 중 큰 값. 다 끝난(completed) 실행은 전부 끝난 걸로
    const total = Math.max(agents.length, ri?.agentCount ?? 0);
    const done = ri?.status === 'completed' ? total : resolved;
    // agent 파일이 하나도 없으면 실행 결과의 토큰 합으로
    if (tokens.total === 0 && ri?.totalTokens) tokens.total = ri.totalTokens;
    const wf: BackgroundWorkflow = {
      runId,
      phases,
      agents: agents.sort(byRunningThenRecent).slice(0, WORKFLOW_AGENTS_MAX),
      status,
      updatedAt,
      progress: { done, total },
      tokens,
    };
    const name = sm?.name ?? ri?.workflowName;
    if (name) wf.name = name;
    if (sm?.description) wf.description = sm.description;
    if (startedAt) wf.startedAt = startedAt;
    return wf;
  }

  async function collectSession(info: SessionDirInfo, ctx: PassCtx): Promise<SessionTasks | undefined> {
    const { t, cutoff } = ctx;
    const sub = join(info.sessionDir, 'subagents');
    const hotOut: string[] = [];
    const cwdOut: { cwd?: string } = {};
    const subagents: BackgroundAgent[] = [];
    const tokens = zeroTokens();
    for (const n of await listDir(sub, t)) {
      const m = AGENT_FILE.exec(n);
      if (!m) continue;
      const id = m[1]!;
      const path = join(sub, n);
      const s = await statOrUndef(path);
      if (!s || s.mtimeMs < cutoff) continue;
      const file = await agentState(path, s, t);
      if (file.cwd && !cwdOut.cwd) cwdOut.cwd = file.cwd;
      const { meta } = await readMeta(join(sub, `agent-${id}.meta.json`), t);
      const a = buildAgent(id, file, meta, undefined, s.mtimeMs, t);
      if (a.status === 'running' || a.status === 'stale') hotOut.push(path);
      addTokens(tokens, a.tokens);
      subagents.push(a);
    }
    const workflows: BackgroundWorkflow[] = [];
    for (const n of await listDir(join(sub, 'workflows'), t)) {
      if (!WORKFLOW_DIR.test(n)) continue;
      const wf = await collectWorkflow(info, n, ctx, hotOut, cwdOut);
      if (!wf) continue;
      addTokens(tokens, wf.tokens);
      workflows.push(wf);
    }
    // 이 세션의 hot 목록을 새로 바꿔요
    for (const [p, dir] of hot) if (dir === info.sessionDir) hot.delete(p);
    for (const p of hotOut) hot.set(p, info.sessionDir);
    if (subagents.length === 0 && workflows.length === 0) return undefined;

    let running = countRunning(subagents);
    for (const wf of workflows) running += countRunning(wf.agents);
    let updatedAt: string | undefined;
    for (const a of subagents) updatedAt = laterIso(updatedAt, a.updatedAt);
    for (const wf of workflows) updatedAt = laterIso(updatedAt, wf.updatedAt);
    const main = await mainInfo(info, t);
    // 본 세션 cwd가 먼저 — 서브에이전트는 하위 폴더·worktree에서 돌 수 있어서 본 세션 cwd가 없을 때만 써요
    const cwd = main?.cwd ?? cwdOut.cwd;
    const out: SessionTasks = {
      agent: 'claude',
      sessionId: info.sessionId,
      cwd: cwd ? normalizePath(cwd) : '',
      workflows: workflows.sort(byRunningThenRecent).slice(0, WORKFLOWS_PER_SESSION),
      subagents: subagents.sort(byRunningThenRecent).slice(0, SUBAGENTS_PER_SESSION),
      running,
      tokens,
      updatedAt: updatedAt ?? iso(info.mtimeMs),
    };
    if (main?.title) out.title = main.title;
    return out;
  }

  async function collectOnce(o: CollectOptions): Promise<SessionTasks[]> {
    const t = now();
    const full = o.sessionId === undefined;
    if (full) pass++;
    const sinceMs = o.sinceMs ?? DEFAULT_SINCE_MS;
    const cutoff = t - sinceMs;
    const hotDirs = new Set(hot.values());
    const out: SessionTasks[] = [];
    const scan = await scanSessions(o.sessionId);
    const ctx: PassCtx = { t, cutoff, homes: scan.homes };
    for (const info of scan.infos) {
      if (info.mtimeMs < cutoff && !hotDirs.has(info.sessionDir)) {
        // 이 세션은 창 밖 — 남은 hot 표시도 지워요
        for (const [p, dir] of hot) if (dir === info.sessionDir) hot.delete(p);
        continue;
      }
      try {
        const st = await collectSession(info, ctx);
        if (st) out.push(st);
      } catch {
        // 세션 하나가 깨져도 나머지는 보여줘요
      }
    }
    if (full) {
      // 사라진 세션 폴더의 hot 표시도 버려요
      const live = new Set(scan.infos.map((i) => i.sessionDir));
      for (const [p, dir] of hot) if (!live.has(dir)) hot.delete(p);
    }
    sweepCache([agentFiles, metas, journals, scripts, dirLists, mains, runs, runRefs], t, pass, full);
    return out;
  }

  return {
    // 두 패스가 같은 TailCursor를 동시에 읽지 않게 한 번에 하나씩
    collect: singleFlight(collectOnce, (o) => `${o.sessionId ?? ''}|${o.sinceMs ?? ''}`),

    /** 테스트용: 지금 들고 있는 agent·journal 파일 상태 수 */
    get cachedFiles(): number {
      return agentFiles.size + journals.size;
    },

    async fingerprint() {
      const t = now();
      const h = createHash('sha1');
      for (const info of (await scanSessions()).infos) h.update(`${info.sessionDir}|${info.stampKey}\n`);
      for (const p of [...hot.keys()].sort()) {
        const s = await statOrUndef(p);
        // stale로 넘어가는 순간도 바뀜이에요(파일은 그대로여도)
        h.update(s ? `${p}|${s.size}|${s.mtimeMs}|${liveness(s.mtimeMs, t)}\n` : `${p}|gone\n`);
      }
      return h.digest('hex');
    },
  };
}

