// 새 Claude 세션 창이 자기 세션 ID를 알아내는 휴리스틱(window.sessionBound).
//
// 근거(2.1.301 실측): ~/.claude/sessions/<pid>.json 의 pid는 claude.exe이고, 그 부모는 창의 확장 호스트
// (Code.exe --utility-sub-type=node.mojom.NodeService)예요. 그래서 «부모 pid == 이 확장 호스트 pid»가 가장 확실해요.
// 후보가 하나여도 부모 pid로 확인해요 — 같은 폴더의 다른 창(다른 Mark42 창, 사용자 창)에서 먼저 뜬 세션일 수 있어요.
// 부모 pid 조회(CIM, 수 초)가 안 되면 «열자마자 뜬 하나뿐인 후보»만 받아요(UNVERIFIED_FRESH_MS).
//
// 후보 조건: entrypoint가 claude-vscode(없으면 허용) · cwd가 이 창 폴더와 같음 · 열기 전 스냅숏에 없던 세션 ID ·
// startedAt이 열기 시각 − 여유(기본 5초) 이후. 남은 후보 중 startedAt이 가장 늦은 것.
import { samePath } from '@mark42/protocol/paths';

export interface ClaudeSessionEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  /** epoch ms */
  startedAt: number;
  entrypoint?: string;
  kind?: string;
  status?: string;
  /** epoch ms */
  updatedAt?: number;
}

/** sessions/<pid>.json 본문 → 필요한 필드만. 대화 내용은 이 파일에 없지만, 그래도 필드만 골라 담아요. */
export function parseClaudeSessionFile(text: string): ClaudeSessionEntry | undefined {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof o !== 'object' || o === null) return undefined;
  const r = o as Record<string, unknown>;
  if (typeof r.pid !== 'number' || typeof r.sessionId !== 'string' || typeof r.cwd !== 'string') return undefined;
  const startedAt = typeof r.startedAt === 'number' ? r.startedAt : 0;
  const e: ClaudeSessionEntry = { pid: r.pid, sessionId: r.sessionId, cwd: r.cwd, startedAt };
  if (typeof r.entrypoint === 'string') e.entrypoint = r.entrypoint;
  if (typeof r.kind === 'string') e.kind = r.kind;
  if (typeof r.status === 'string') e.status = r.status;
  if (typeof r.updatedAt === 'number') e.updatedAt = r.updatedAt;
  return e;
}

/** 자격 증명 파일(<pid>.<hash>.key)은 절대 읽지 않아요. `<숫자>.json`만 대상이에요. */
export function isSessionRegistryFile(name: string): boolean {
  return /^\d+\.json$/i.test(name);
}

export interface BindingCriteria {
  folderPath: string;
  /** epoch ms — 세션을 연 시각 */
  openedAt: number;
  /** 열기 전에 이미 있던 세션 ID */
  excludeSessionIds: ReadonlySet<string>;
  /** startedAt 비교 여유 */
  slackMs?: number;
}

export function bindingCandidates(entries: readonly ClaudeSessionEntry[], c: BindingCriteria): ClaudeSessionEntry[] {
  const slack = c.slackMs ?? 5_000;
  return entries
    .filter((e) => e.entrypoint === undefined || e.entrypoint === 'claude-vscode')
    .filter((e) => samePath(e.cwd, c.folderPath))
    .filter((e) => !c.excludeSessionIds.has(e.sessionId))
    .filter((e) => e.startedAt === 0 || e.startedAt >= c.openedAt - slack)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export type BindingResult =
  | { status: 'bound'; sessionId: string; pid: number; via: 'single' | 'parentPid' }
  | { status: 'none' }
  | { status: 'ambiguous'; candidates: ClaudeSessionEntry[] };

/**
 * 1단계(동기): 후보가 하나면 그걸로, 없으면 none, 둘 이상이면 ambiguous.
 * ambiguous면 호출자가 부모 pid를 조회해 `resolveByParent`로 가려요.
 */
export function pickClaudeSession(entries: readonly ClaudeSessionEntry[], c: BindingCriteria): BindingResult {
  const cands = bindingCandidates(entries, c);
  if (cands.length === 0) return { status: 'none' };
  if (cands.length === 1) return { status: 'bound', sessionId: cands[0]!.sessionId, pid: cands[0]!.pid, via: 'single' };
  return { status: 'ambiguous', candidates: cands };
}

/** 부모 pid 확인 없이 받아 주는 «열기 직후» 범위 */
export const UNVERIFIED_FRESH_MS = 20_000;

/**
 * 부모 pid를 알 수 없을 때: 후보가 하나이고 열기 직후(freshMs 안)에 시작한 경우만.
 * 30분까지 기다리는 «채우기만» 경로에서 아무 창의 새 세션이나 잡지 않게 해요.
 */
export function resolveWithoutParents(
  candidates: readonly ClaudeSessionEntry[],
  openedAt: number,
  freshMs = UNVERIFIED_FRESH_MS,
): BindingResult {
  if (candidates.length !== 1) return candidates.length === 0 ? { status: 'none' } : { status: 'ambiguous', candidates: [...candidates] };
  const c = candidates[0]!;
  if (c.startedAt === 0 || c.startedAt - openedAt > freshMs) return { status: 'none' };
  return { status: 'bound', sessionId: c.sessionId, pid: c.pid, via: 'single' };
}

/** 2단계: 부모 pid가 이 확장 호스트인 후보(가장 최근) */
export function resolveByParent(
  candidates: readonly ClaudeSessionEntry[],
  parentOf: ReadonlyMap<number, number | undefined>,
  hostPid: number,
): BindingResult {
  const mine = candidates.filter((e) => parentOf.get(e.pid) === hostPid);
  if (mine.length === 0) return { status: 'none' };
  const best = [...mine].sort((a, b) => b.startedAt - a.startedAt)[0]!;
  return { status: 'bound', sessionId: best.sessionId, pid: best.pid, via: 'parentPid' };
}
