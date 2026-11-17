// Claude 세션의 터미널 명령(«실행» 보기) — 본 세션 transcript에서 Bash·PowerShell 도구 호출과 그 끝을 모아요(읽기 전용).
// 시작: assistant tool_use(설명 description·run_in_background·timeout만 — 명령 전문은 보지 않아요).
// 끝: 포그라운드는 같은 id의 tool_result. 결과에 backgroundTaskId가 있으면 백그라운드로 넘어간 것이라 끝이 아니고,
//     그 작업의 <task-notification>(task-id·tool-use-id·status)이 오거나 TaskStop이 불리면 끝나요.
// 끝 기록이 없으면: 포그라운드는 그 뒤 다른 응답(다른 message id)이 왔는데 결과가 없으면 stale(끊김·건너뛴 큰 결과) — 권한 확인을
// 기다리는 동안은 다음 응답이 없으니 실행 중으로 둬요. 그 밖에는 12시간이 지나면 stale(세션이 꺼지면 아무것도 안 와요).
// 에이전트 CLI(claude·codex·grok·agy)를 띄운 명령은 시작 때 명령어 자리만 판별해(agentCli.ts) 호출 목록(cli·허용 모양의 model·effort)만
// 남겨요 — 명령 전문은 그 자리에서 버려요. 이런 명령은 «작업»의 블록이 되고 «실행»에서 빠져요.
import type { AgentCliCall, BackgroundRun, BackgroundTaskStatus } from '@mark42/protocol';
import { detectAgentCliCalls } from './agentCli.ts';
import { clipLabel, clipText, isoOf, isRec, str } from './common.ts';

const RUN_TOOLS = new Set(['Bash', 'PowerShell']);
/** 백그라운드 명령을 멈추는 도구(입력 task_id·shell_id) */
const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash']);
/** 끝 기록 없이 이만큼 지난 명령은 stale(세션이 꺼지면 알림·결과가 오지 않아요) */
export const BG_STALE_MS = 12 * 60 * 60 * 1000;
/** 들고 있는 명령 수 상한 — 넘으면 오래전에 끝난 것부터 버려요 */
const RUNS_KEEP = 200;
/** 세션 하나에 싣는 수 */
export const RUNS_PER_SESSION = 30;
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const ENDED_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped', 'error', 'cancelled', 'canceled', 'timeout']);
/** agent transcript의 백그라운드 결과에는 toolUseResult가 없어요 — 결과 글에서 작업 id를 읽어요(«Command running in background with ID: <id>») */
const BG_RESULT = /running in background with ID:\s*([A-Za-z0-9_-]{1,128})/;

function resultText(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 4096);
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const c of content) {
    if (isRec(c) && c.type === 'text' && typeof c.text === 'string') out += c.text.slice(0, 4096);
    if (out.length >= 4096) break;
  }
  return out;
}

interface RunRec {
  id: string;
  label: string;
  tool: string;
  background: boolean;
  taskId?: string;
  startedAt: string;
  endedAt?: string;
  outcome?: 'done' | 'failed';
  /** 부른 응답의 message id(한 응답의 병렬 호출은 같은 id) */
  msgId?: string;
  /** 결과 없이 다음 응답이 왔어요(포그라운드만) */
  superseded?: boolean;
  /** 이 명령이 띄운 에이전트 CLI 호출(있으면 «작업»의 블록) */
  calls?: AgentCliCall[];
}

export interface RunsState {
  runs: Map<string, RunRec>;
  /** 백그라운드 작업 id → 도구 호출 id */
  byTask: Map<string, string>;
  /** 에이전트 CLI 블록만 들고 있어요(서브에이전트·워크플로우 agent transcript — 그 밖의 명령은 «실행»에 싣지 않아요) */
  onlyCli: boolean;
}

export function newRunsState(onlyCli = false): RunsState {
  return { runs: new Map(), byTask: new Map(), onlyCli };
}

/** 명령의 에이전트 CLI 호출 — 판별기는 던지지 않지만 여기서도 감싸요(명령 글이 로그로 새지 않게 오류는 버려요) */
function callsOf(command: string | undefined): AgentCliCall[] | undefined {
  if (!command) return undefined;
  try {
    const calls = detectAgentCliCalls(command);
    return calls.length ? calls : undefined;
  } catch {
    return undefined;
  }
}

function end(run: RunRec | undefined, ts: string | undefined, outcome: 'done' | 'failed'): void {
  if (!run || run.endedAt !== undefined || !ts) return;
  run.endedAt = ts;
  run.outcome = outcome;
}

function tag(body: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body);
  const v = m?.[1]?.trim();
  return v ? v : undefined;
}

function applyNotifications(st: RunsState, text: string, ts: string | undefined): void {
  if (!text.includes('<task-notification>')) return;
  for (const m of text.matchAll(NOTIFICATION)) {
    const body = m[1] ?? '';
    const status = tag(body, 'status')?.toLowerCase();
    if (!status || !ENDED_STATUSES.has(status)) continue;
    const toolUseId = tag(body, 'tool-use-id');
    const taskId = tag(body, 'task-id');
    const id = toolUseId && st.runs.has(toolUseId) ? toolUseId : taskId ? st.byTask.get(taskId) : undefined;
    end(id ? st.runs.get(id) : undefined, ts, status === 'completed' ? 'done' : 'failed');
  }
}

/** transcript 한 줄을 반영해요 */
export function applyRunRecord(st: RunsState, r: unknown): void {
  if (!isRec(r)) return;
  const ts = isoOf(r.timestamp);
  const msg = isRec(r.message) ? r.message : undefined;
  if (r.type === 'assistant' && msg && Array.isArray(msg.content)) {
    const msgId = str(msg.id);
    // 다른 응답이 왔는데 아직 결과가 없는 포그라운드 명령 — 결과가 빠졌어요(끊김·건너뛴 큰 줄)
    if (msgId && ts) {
      for (const run of st.runs.values()) {
        if (run.endedAt === undefined && !run.background && run.msgId !== undefined && run.msgId !== msgId && run.startedAt <= ts) run.superseded = true;
      }
    }
    for (const b of msg.content) {
      if (!isRec(b) || b.type !== 'tool_use') continue;
      const name = str(b.name);
      const id = str(b.id);
      const input = isRec(b.input) ? b.input : {};
      if (name && RUN_TOOLS.has(name) && id && ts && !st.runs.has(id)) {
        const calls = callsOf(str(input.command));
        if (st.onlyCli && !calls) continue;
        const desc = str(input.description);
        const label = desc ? clipLabel(desc.replace(/\s+/g, ' ')) : '';
        const run: RunRec = { id: clipText(id, 128), label: label || name, tool: name, background: input.run_in_background === true, startedAt: ts };
        if (msgId) run.msgId = msgId;
        if (calls) run.calls = calls;
        st.runs.set(id, run);
      } else if (name && STOP_TOOLS.has(name)) {
        const task = str(input.task_id) ?? str(input.shell_id) ?? str(input.bash_id);
        const runId = task ? st.byTask.get(task) : undefined;
        end(runId ? st.runs.get(runId) : undefined, ts, 'failed');
      }
    }
  } else if (r.type === 'user' && msg) {
    if (typeof msg.content === 'string') {
      applyNotifications(st, msg.content, ts);
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!isRec(b) || b.type !== 'tool_result') continue;
        const id = str(b.tool_use_id);
        const run = id ? st.runs.get(id) : undefined;
        if (!run || run.endedAt !== undefined) continue;
        const tur = isRec(r.toolUseResult) ? r.toolUseResult : undefined;
        // 본 세션 결과에는 toolUseResult가 있어요 — 결과 글은 그게 없을 때만(명령이 찍은 글을 오해하지 않게)
        const taskId = tur ? str(tur.backgroundTaskId) : BG_RESULT.exec(resultText(b.content))?.[1];
        if (b.is_error !== true && (taskId || (run.background && !tur))) {
          // 백그라운드로 실행(또는 도중에 넘어감) — 끝은 알림으로(agent transcript는 알림에 tool-use-id가 거의 없어 작업 id로 맞춰요)
          run.background = true;
          delete run.superseded;
          if (taskId) {
            run.taskId = clipText(taskId, 128);
            st.byTask.set(taskId, run.id);
          }
        } else {
          end(run, ts, b.is_error === true || tur?.interrupted === true ? 'failed' : 'done');
        }
      }
    }
  } else if (r.type === 'attachment' && isRec(r.attachment) && r.attachment.type === 'queued_command') {
    const prompt = str(r.attachment.prompt);
    if (prompt) applyNotifications(st, prompt, ts ?? isoOf(r.attachment.timestamp));
  }
  if (st.runs.size > RUNS_KEEP) prune(st);
}

function prune(st: RunsState): void {
  const ended = [...st.runs.values()].filter((r) => r.endedAt !== undefined).sort((a, b) => (a.endedAt! < b.endedAt! ? -1 : 1));
  for (const r of ended.slice(0, st.runs.size - RUNS_KEEP)) {
    st.runs.delete(r.id);
    if (r.taskId) st.byTask.delete(r.taskId);
  }
}

function statusOf(r: RunRec, t: number): BackgroundTaskStatus {
  if (r.outcome) return r.outcome;
  if (r.superseded && !r.background) return 'stale';
  return t - Date.parse(r.startedAt) > BG_STALE_MS ? 'stale' : 'running';
}

/** plain = 보통 명령(«실행»), cli = 에이전트 CLI 블록(«작업»), all = 둘 다 */
export type RunKind = 'plain' | 'cli' | 'all';

function isKind(r: RunRec, kind: RunKind): boolean {
  return kind === 'all' || (kind === 'cli') === (r.calls !== undefined);
}

/** 지금 실행 중인 명령 수 — 서명에 넣어 시간이 지나 stale로 넘어가는 순간도 알아채요 */
export function runningCount(st: RunsState, t: number, kind: RunKind = 'all'): number {
  let n = 0;
  for (const r of st.runs.values()) if (isKind(r, kind) && statusOf(r, t) === 'running') n++;
  return n;
}

/**
 * 화면에 실을 명령 — 실행 중(·stale)은 모두, 끝난 것은 창(cutoff) 안에 끝난 것만. 실행 중 먼저, 그다음 최근 순.
 * 에이전트 CLI 블록은 창보다 먼저 시작해 끝 기록 없이 남은 stale도 버려요(그것만 남은 세션이 통합 창 카드 자리를 차지하지 않게)
 */
export function runsOf(st: RunsState, t: number, cutoffMs: number, kind: RunKind = 'plain'): BackgroundRun[] {
  const out: BackgroundRun[] = [];
  for (const r of st.runs.values()) {
    if (!isKind(r, kind)) continue;
    const status = statusOf(r, t);
    const updatedAt = r.endedAt ?? r.startedAt;
    if ((status === 'done' || status === 'failed') && Date.parse(updatedAt) < cutoffMs) continue;
    if (r.calls && status === 'stale' && Date.parse(updatedAt) < cutoffMs) continue;
    const run: BackgroundRun = { id: r.id, label: r.label, tool: r.tool, background: r.background, status, startedAt: r.startedAt, updatedAt };
    if (r.taskId) run.taskId = r.taskId;
    if (r.endedAt) run.endedAt = r.endedAt;
    if (r.calls) run.calls = r.calls.map((c) => ({ ...c }));
    out.push(run);
  }
  sortRuns(out);
  return out.slice(0, RUNS_PER_SESSION);
}

/** 실행 중 먼저, 그다음 최근 순 */
export function sortRuns(runs: BackgroundRun[]): BackgroundRun[] {
  const rank = (s: BackgroundTaskStatus) => (s === 'running' ? 0 : 1);
  return runs.sort((a, b) => rank(a.status) - rank(b.status) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
