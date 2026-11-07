// hub UI 순수 로직 — DOM·전송과 무관해서 node:test로 바로 시험해요.
import {
  ErrorCode,
  type AgentKind,
  type AgentSettings,
  type BackgroundAgent,
  type BackgroundTaskStatus,
  type BackgroundWorkflow,
  type ClaudeEffort,
  type ClaudeSettings,
  type CodexSettings,
  type Folder,
  type PinnedSession,
  type SessionStatus,
  type SessionSummary,
  type SessionTasks,
  type TokenUsage,
  type WindowInfo,
  type WindowRole,
} from '@mark42/protocol';
import { locale, t, t as tr, type MessageKey } from './i18n.ts';

export const AGENT_ORDER: readonly AgentKind[] = ['claude', 'codex'];
export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' };
export const CLAUDE_EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function sessionKey(s: { agent: AgentKind; id: string }): string {
  return `${s.agent}:${s.id}`;
}

/** 브라우저용 경로 비교 키 — protocol/paths(Node 전용)의 pathKey와 같은 규칙의 가벼운 판 */
export function pathKeyLite(p: string): string {
  let s = p.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  const winLike = /^[a-z]:/i.test(s) || s.startsWith('\\\\') || s.includes('\\');
  if (!winLike) return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
  s = s.replace(/\//g, '\\');
  if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
  return s.toLowerCase();
}

export function samePathLite(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return pathKeyLite(a) === pathKeyLite(b);
}

/**
 * cwd가 속한 등록 폴더 — 같은 경로를 먼저, 없으면 cwd를 품은(하위 폴더인) 등록 폴더 중 가장 깊은 것.
 * 비교는 pathKeyLite 규칙(Windows 경로는 대소문자 무시)이고, 구분자 경계에서만 맞춰요(c:\dev\a ⊄ c:\dev\ab).
 */
export function folderForCwd<F extends Pick<Folder, 'path'>>(folders: readonly F[], cwd: string | undefined): F | undefined {
  if (cwd === undefined) return undefined;
  const ck = pathKeyLite(cwd);
  let best: F | undefined;
  let bestLen = -1;
  for (const f of folders) {
    const fk = pathKeyLite(f.path);
    if (!fk) continue;
    if (fk === ck) return f;
    const sep = fk.includes('\\') || /^[a-z]:/.test(fk) ? '\\' : '/';
    const prefix = fk.endsWith(sep) ? fk : fk + sep;
    if (ck.startsWith(prefix) && fk.length > bestLen) {
      best = f;
      bestLen = fk.length;
    }
  }
  return best;
}

export function folderLabel(f: Pick<Folder, 'label' | 'path'>): string {
  const label = f.label?.trim();
  if (label) return label;
  const parts = f.path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? f.path;
}

function firstLine(s: string, max: number): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** 제목 → 마지막 프롬프트 → id 순서로 대체해요. */
export function sessionTitle(s: Pick<SessionSummary, 'title' | 'lastPrompt' | 'id'>, max = 80): string {
  const t = s.title?.trim();
  if (t) return firstLine(t, max);
  const p = s.lastPrompt?.trim();
  if (p) return firstLine(p, max);
  return s.id;
}

function timeOf(iso: string | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}

/** 최신순. 시각이 같거나 없으면 id로 고정 순서 */
export function compareNewestFirst(a: SessionSummary, b: SessionSummary): number {
  const ta = timeOf(a.updatedAt);
  const tb = timeOf(b.updatedAt);
  const na = Number.isNaN(ta);
  const nb = Number.isNaN(tb);
  if (na !== nb) return na ? 1 : -1;
  if (!na && !nb && ta !== tb) return tb - ta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortNewestFirst(list: readonly SessionSummary[]): SessionSummary[] {
  return [...list].sort(compareNewestFirst);
}

/** «3분 전»·«3 min ago» 같은 상대 시간(화면 언어) */
export function formatRelativeTime(iso: string | undefined, now: number = Date.now()): string {
  const at = timeOf(iso);
  if (Number.isNaN(at)) return '';
  const sec = Math.floor((now - at) / 1000);
  if (sec < 60) return t('time.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('time.minutesAgo', min);
  const hour = Math.floor(min / 60);
  if (hour < 24) return t('time.hoursAgo', hour);
  const day = Math.floor(hour / 24);
  if (day === 1) return t('time.yesterday');
  if (day < 7) return t('time.daysAgo', day);
  if (day < 30) return t('time.weeksAgo', Math.floor(day / 7));
  if (day < 365) return t('time.monthsAgo', Math.max(1, Math.floor(day / 30)));
  return t('time.yearsAgo', Math.floor(day / 365));
}

export interface StatusView {
  label: string;
  cls: SessionStatus;
}
const STATUS_LABEL: Record<SessionStatus, MessageKey> = {
  busy: 'status.busy',
  waiting: 'status.waiting',
  idle: 'status.idle',
  stopped: 'status.stopped',
};
/** status 없음 = 살아 있지 않은 지난 세션 → 배지 없음 */
export function statusView(status: SessionStatus | undefined): StatusView | undefined {
  if (!status) return undefined;
  const key = STATUS_LABEL[status];
  return key ? { label: t(key), cls: status } : undefined;
}

export function groupByAgent(list: readonly SessionSummary[]): Record<AgentKind, SessionSummary[]> {
  const out: Record<AgentKind, SessionSummary[]> = { claude: [], codex: [] };
  for (const s of list) (out[s.agent] ??= []).push(s);
  for (const k of AGENT_ORDER) out[k] = sortNewestFirst(out[k]);
  return out;
}

export interface SessionNode {
  session: SessionSummary;
  children: SessionNode[];
  /** 자기 + 자손 수 − 1 */
  descendantCount: number;
}

/**
 * Codex 서브에이전트를 부모 아래 트리로 묶어요(D22). 부모가 목록에 없으면 루트로 올려요.
 * 같은 agent 안에서만 부모를 찾고, 순환 참조는 끊어요.
 */
export function buildSessionTree(list: readonly SessionSummary[]): SessionNode[] {
  const byKey = new Map<string, SessionNode>();
  for (const s of sortNewestFirst(list)) {
    const k = sessionKey(s);
    if (!byKey.has(k)) byKey.set(k, { session: s, children: [], descendantCount: 0 });
  }
  const parentOf = (n: SessionNode): SessionNode | undefined => {
    const pid = n.session.parentId;
    if (!pid || pid === n.session.id) return undefined;
    return byKey.get(sessionKey({ agent: n.session.agent, id: pid }));
  };
  // 실제로 붙인 부모만 따라가요. p의 조상 중에 n이 있으면 붙이면 순환이에요.
  const attached = new Map<SessionNode, SessionNode>();
  const createsCycle = (n: SessionNode, p: SessionNode): boolean => {
    for (let cur: SessionNode | undefined = p; cur; cur = attached.get(cur)) if (cur === n) return true;
    return false;
  };
  const isRoot = new Set<SessionNode>();
  for (const n of byKey.values()) {
    const p = parentOf(n);
    if (p && !createsCycle(n, p)) {
      p.children.push(n);
      attached.set(n, p);
    } else isRoot.add(n);
  }
  // 최신순 유지: byKey는 정렬된 순서라 그대로 걸러요.
  const roots = [...byKey.values()].filter((n) => isRoot.has(n));
  const count = (n: SessionNode): number => {
    let c = 0;
    for (const ch of n.children) c += 1 + count(ch);
    n.descendantCount = c;
    return c;
  };
  for (const r of roots) count(r);
  return roots;
}

/** 공백으로 나눈 낱말이 제목·마지막 프롬프트에 모두 들어 있으면 일치(대소문자 무시) */
export function matchesQuery(s: Pick<SessionSummary, 'title' | 'lastPrompt'>, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = `${s.title ?? ''}\n${s.lastPrompt ?? ''}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export interface FilteredTree {
  nodes: SessionNode[];
  /** 자손이 일치해서 펼쳐 보여야 하는 노드 키 */
  forceExpanded: Set<string>;
  matchCount: number;
}

/** 검색 중에는 자손이 일치하는 부모도 남기고 펼쳐요. */
export function filterTree(nodes: readonly SessionNode[], query: string): FilteredTree {
  const forceExpanded = new Set<string>();
  let matchCount = 0;
  if (!query.trim()) {
    const all = (ns: readonly SessionNode[]): number => ns.reduce((a, n) => a + 1 + all(n.children), 0);
    return { nodes: [...nodes], forceExpanded, matchCount: all(nodes) };
  }
  const walk = (n: SessionNode): SessionNode | undefined => {
    const self = matchesQuery(n.session, query);
    if (self) matchCount++;
    const kids: SessionNode[] = [];
    for (const c of n.children) {
      const k = walk(c);
      if (k) kids.push(k);
    }
    if (!self && kids.length === 0) return undefined;
    if (kids.length > 0) forceExpanded.add(sessionKey(n.session));
    const countAll = (ns: SessionNode[]): number => ns.reduce((a, x) => a + 1 + countAll(x.children), 0);
    return { session: n.session, children: kids, descendantCount: countAll(kids) };
  };
  const out: SessionNode[] = [];
  for (const n of nodes) {
    const k = walk(n);
    if (k) out.push(k);
  }
  return { nodes: out, forceExpanded, matchCount };
}

export function chipsFor(s: Pick<SessionSummary, 'model' | 'effort'>): string[] {
  const out: string[] = [];
  if (s.model?.trim()) out.push(s.model.trim());
  if (s.effort?.trim()) out.push(s.effort.trim());
  return out;
}

export function isClaudeEffort(v: unknown): v is ClaudeEffort {
  return typeof v === 'string' && (CLAUDE_EFFORTS as readonly string[]).includes(v);
}

export function settingsFromSession(s: Pick<SessionSummary, 'agent' | 'model' | 'effort'>): AgentSettings {
  if (s.agent === 'claude') {
    const st: ClaudeSettings = {};
    if (s.model) st.model = s.model;
    if (isClaudeEffort(s.effort)) st.effort = s.effort;
    return st;
  }
  const st: CodexSettings = {};
  if (s.model) st.model = s.model;
  if (s.effort) st.reasoningEffort = s.effort;
  return st;
}

export function sortPinned(list: readonly PinnedSession[]): PinnedSession[] {
  return [...list].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function findPinned(
  list: readonly PinnedSession[],
  agent: AgentKind,
  sessionId: string,
): PinnedSession | undefined {
  return list.find((p) => p.agent === agent && p.sessionId === sessionId);
}

/** resumePrompt·autoSend를 빼면 데몬이 판 기본값(pinned.defaults)을 넣어요 */
export type PinnedDraft = Omit<PinnedSession, 'id' | 'resumePrompt' | 'autoSend'> & { id?: string; resumePrompt?: string; autoSend?: boolean };

/** 새 고정 세션: 재개 프롬프트·자동 전송은 데몬 기본값, 부팅 재개는 꺼짐, 설정은 세션의 model/effort, 순서는 맨 뒤 */
export function makePinnedDraft(
  folderPath: string,
  s: SessionSummary,
  existing: readonly PinnedSession[],
): PinnedDraft {
  const maxOrder = existing.reduce((m, p) => Math.max(m, p.order), -1);
  const title = s.title?.trim() || s.lastPrompt?.trim();
  const draft: PinnedDraft = {
    folderPath,
    agent: s.agent,
    sessionId: s.id,
    settings: settingsFromSession(s),
    enabled: false, // 부팅 재개는 고정한 뒤 직접 켜요(사용자 결정 2026-10-21)
    order: maxOrder + 1,
  };
  if (title) draft.label = firstLine(title, 80);
  return draft;
}

/**
 * 고정 세션 하나를 위(-1)·아래(+1)로 옮긴 결과에서 order가 바뀐 항목만 돌려줘요.
 * 순서는 0..n-1로 다시 매겨요. `among`(지금 보이는 같은 묶음의 id, 화면 순서)을 주면 그 안의 이웃과 자리를 바꿔요 —
 * 그룹·검색으로 나눠 볼 때 ↑↓가 같은 그룹 안에서 움직이게.
 */
export function movePinned(
  list: readonly PinnedSession[],
  pinnedId: string,
  delta: -1 | 1,
  among?: readonly string[],
): PinnedSession[] {
  const sorted = sortPinned(list);
  const i = sorted.findIndex((p) => p.id === pinnedId);
  let j = i + delta;
  if (among) {
    const k = among.indexOf(pinnedId);
    const neighbor = k < 0 ? undefined : among[k + delta];
    j = neighbor === undefined ? -1 : sorted.findIndex((p) => p.id === neighbor);
  }
  if (i < 0 || j < 0 || j >= sorted.length) return [];
  const moved = [...sorted];
  const tmp = moved[i]!;
  moved[i] = moved[j]!;
  moved[j] = tmp;
  const changed: PinnedSession[] = [];
  moved.forEach((p, idx) => {
    if (p.order !== idx) changed.push({ ...p, order: idx });
  });
  return changed;
}

/** 고정 세션 묶어 보기 */
export type PinnedGroupBy = 'none' | 'folder' | 'agent' | 'group';
export const PINNED_GROUP_BY: readonly PinnedGroupBy[] = ['none', 'folder', 'agent', 'group'];
const PINNED_GROUP_BY_LABEL: Record<PinnedGroupBy, MessageKey> = {
  none: 'pinnedGroupBy.none',
  folder: 'pinnedGroupBy.folder',
  agent: 'pinnedGroupBy.agent',
  group: 'pinnedGroupBy.group',
};
export function pinnedGroupByLabel(by: PinnedGroupBy): string {
  return t(PINNED_GROUP_BY_LABEL[by]);
}

export function isPinnedGroupBy(v: unknown): v is PinnedGroupBy {
  return typeof v === 'string' && (PINNED_GROUP_BY as readonly string[]).includes(v);
}

/** 고정 세션 한 줄을 찾을 때 보는 글: 화면 제목, 붙인 이름, 세션 ID, 폴더 이름·경로, 그룹, 에이전트 */
export interface PinnedView {
  pinned: PinnedSession;
  title: string;
  folderName: string;
}

/** 검색: 빈칸으로 나눈 낱말이 모두(대소문자 무시) 어딘가에 있으면 */
export function pinnedMatches(v: PinnedView, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const p = v.pinned;
  const hay = [v.title, p.label ?? '', p.sessionId, v.folderName, p.folderPath, p.group ?? '', AGENT_LABEL[p.agent]].join('\n').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export interface PinnedGroup {
  /** 접기 기억 열쇠(묶음 방식 + 값) */
  key: string;
  label: string;
  items: PinnedView[];
}

/**
 * 묶기. 묶음 안은 재개 순서 그대로. 묶음 순서: 폴더·내 그룹은 이름순(«그룹 없음»은 맨 뒤), 에이전트는 Claude → Codex.
 * `none`이면 묶음 하나(이름 없음).
 */
export function groupPinned(views: readonly PinnedView[], by: PinnedGroupBy): PinnedGroup[] {
  if (by === 'none') return [{ key: 'none:', label: '', items: [...views] }];
  const map = new Map<string, PinnedGroup>();
  for (const v of views) {
    const p = v.pinned;
    const value = by === 'folder' ? pathKeyLite(p.folderPath) : by === 'agent' ? p.agent : (p.group?.trim() ?? '');
    const label = by === 'folder' ? v.folderName : by === 'agent' ? AGENT_LABEL[p.agent] : value || t('pinned.noGroup');
    const key = `${by}:${value.toLowerCase()}`;
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, label, items: [] }));
    g.items.push(v);
  }
  const groups = [...map.values()];
  if (by === 'agent') return groups.sort((a, b) => AGENT_ORDER.indexOf(a.items[0]!.pinned.agent) - AGENT_ORDER.indexOf(b.items[0]!.pinned.agent));
  const last = by === 'group' ? `group:` : undefined;
  return groups.sort((a, b) => (a.key === last ? 1 : 0) - (b.key === last ? 1 : 0) || a.label.localeCompare(b.label, 'ko'));
}

/** 내 그룹 이름 목록(입력 칸 추천용), 이름순 */
export function pinnedGroupNames(list: readonly PinnedSession[]): string[] {
  const seen = new Map<string, string>();
  for (const p of list) {
    const g = p.group?.trim();
    if (g && !seen.has(g.toLowerCase())) seen.set(g.toLowerCase(), g);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'ko'));
}

export interface WindowCount {
  total: number;
  byRole: Partial<Record<WindowRole, number>>;
}

export function windowsByFolder(windows: readonly WindowInfo[], folders: readonly Folder[]): Map<string, WindowCount> {
  const out = new Map<string, WindowCount>();
  for (const f of folders) out.set(f.id, { total: 0, byRole: {} });
  for (const w of windows) {
    if (!w.folderPath || w.role === 'hub') continue;
    const f = folders.find((x) => samePathLite(x.path, w.folderPath));
    if (!f) continue;
    const c = out.get(f.id)!;
    c.total++;
    c.byRole[w.role] = (c.byRole[w.role] ?? 0) + 1;
  }
  return out;
}

function roleLabel(role: WindowRole): string {
  return role === 'hub' ? t('role.hub') : role === 'agent-claude' ? 'Claude' : role === 'agent-codex' ? 'Codex' : t('role.editor');
}

export function windowCountTooltip(c: WindowCount): string {
  const parts: string[] = [];
  for (const role of ['agent-claude', 'agent-codex', 'editor'] as const) {
    const n = c.byRole[role];
    if (n) parts.push(`${roleLabel(role)} ${n}`);
  }
  return parts.length ? t('windows.open', parts.join(', ')) : t('windows.none');
}

// ---- 탭 ----

/** 통합 창 탭 — 고정 세션 · 폴더 · 작업(백그라운드 워크플로우·서브에이전트) */
export type HubTab = 'pinned' | 'folders' | 'tasks';
export const HUB_TABS: readonly HubTab[] = ['pinned', 'folders', 'tasks'];

export function isHubTab(v: unknown): v is HubTab {
  return typeof v === 'string' && (HUB_TABS as readonly string[]).includes(v);
}

/** 저장된 탭 값 → 탭(모르는 값이면 고정 세션) */
export function parseHubTab(v: unknown): HubTab {
  return isHubTab(v) ? v : 'pinned';
}

/** ←→ 키로 옆 탭 — 끝에서 반대쪽 끝으로 돌아요 */
export function adjacentTab(cur: HubTab, delta: -1 | 1): HubTab {
  const i = HUB_TABS.indexOf(cur);
  const n = HUB_TABS.length;
  return HUB_TABS[(((i < 0 ? 0 : i) + delta) % n + n) % n]!;
}

// ---- 백그라운드 작업(워크플로우·서브에이전트) ----

function trimOneDecimal(x: number): string {
  return (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

/** 토큰 수 짧게: 950 · 1.2k · 412k · 1.2M · 35M */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return '';
  const v = Math.round(n);
  if (v < 1000) return String(v);
  if (v < 9_950) return `${trimOneDecimal(v / 1000)}k`;
  if (v < 999_500) return `${Math.round(v / 1000)}k`;
  if (v < 9_950_000) return `${trimOneDecimal(v / 1_000_000)}M`;
  return `${Math.round(v / 1_000_000)}M`;
}

/** 토큰 내역 툴팁(입력·출력·캐시) — Codex처럼 total만 있으면 total만 */
export function tokenTooltip(t: TokenUsage | undefined): string {
  if (!t || !(t.total > 0)) return '';
  const parts: string[] = [];
  const add = (label: string, v: number) => {
    if (v > 0) parts.push(`${label} ${formatTokens(v)}`);
  };
  add(tr('tokens.input'), t.input);
  add(tr('tokens.output'), t.output);
  add(tr('tokens.cacheRead'), t.cacheRead);
  add(tr('tokens.cacheWrite'), t.cacheCreation);
  const total = tr('tokens.total', t.total.toLocaleString(locale()));
  return parts.length ? `${total}\n${parts.join(' · ')}` : total;
}

/** 걸린 시간: 35초 · 6분 31초 · 1시간 2분 · 2일 3시간 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return t('duration.s', sec);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min < 60) return s ? t('duration.ms', min, s) : t('duration.m', min);
  const hour = Math.floor(min / 60);
  const m = min % 60;
  if (hour < 24) return m ? t('duration.hm', hour, m) : t('duration.h', hour);
  const day = Math.floor(hour / 24);
  const h = hour % 24;
  return h ? t('duration.dh', day, h) : t('duration.d', day);
}

export interface Progress {
  done: number;
  total: number;
}

/** 0..1 (전체가 0이면 0) */
export function progressRatio(p: Progress): number {
  if (!(p.total > 0) || !(p.done > 0)) return 0;
  return Math.min(1, p.done / p.total);
}

/** «42%» — 다 끝나기 전에는 100%로 올리지 않게 내림. 전체가 0이면 빈 글 */
export function formatPercent(p: Progress): string {
  if (!(p.total > 0)) return '';
  return `${Math.floor(progressRatio(p) * 100)}%`;
}

/** 걸린 시간 계산에 쓰는 시각 — 워크플로우·agent 공통 */
export interface TimedTask {
  status: BackgroundTaskStatus;
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
}

/** 실행 중이면 시작 → 지금, 끝났으면 시작 → 끝(없으면 마지막 움직임). 시작 시각을 모르면 undefined */
export function taskElapsedMs(t: TimedTask, now: number = Date.now()): number | undefined {
  const start = timeOf(t.startedAt);
  if (Number.isNaN(start)) return undefined;
  const end = t.status === 'running' ? now : timeOf(t.endedAt ?? t.updatedAt);
  if (Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

/** 실행 중이면 매초 다시 셀 시작 시각(ms), 아니면 undefined */
export function liveStartMs(t: TimedTask): number | undefined {
  if (t.status !== 'running') return undefined;
  const start = timeOf(t.startedAt);
  return Number.isNaN(start) ? undefined : start;
}

/**
 * 지금 단계: 워크플로우가 실행 중일 때만 — 시작한 agent가 다 끝나지 않은 첫 단계, 없으면 마지막으로 시작한 단계.
 * 끝남·실패·멈춤이면 «지금» 단계가 없으니 -1이에요(시작한 단계가 없을 때도 -1)
 */
export function currentPhaseIndex(
  phases: readonly { started: number; done: number }[],
  status: BackgroundTaskStatus,
): number {
  if (status !== 'running') return -1;
  const open = phases.findIndex((p) => p.started > p.done);
  if (open >= 0) return open;
  for (let i = phases.length - 1; i >= 0; i--) if (phases[i]!.started > 0) return i;
  return -1;
}

export interface TaskStatusView {
  icon: string;
  label: string;
  cls: BackgroundTaskStatus;
}
const TASK_STATUS: Record<BackgroundTaskStatus, { icon: string; label: MessageKey }> = {
  running: { icon: '⟳', label: 'taskStatus.running' },
  done: { icon: '✔', label: 'taskStatus.done' },
  failed: { icon: '✖', label: 'taskStatus.failed' },
  stale: { icon: '⏸', label: 'taskStatus.stale' },
};

export function taskStatusView(status: BackgroundTaskStatus): TaskStatusView {
  const v = TASK_STATUS[status] ?? TASK_STATUS.stale;
  return { icon: v.icon, label: t(v.label), cls: TASK_STATUS[status] ? status : 'stale' };
}

/** 세션 전체 진행: 워크플로우 진행 합 + 워크플로우 밖 서브에이전트(실행 중이 아니면 끝난 것으로) */
export function sessionProgress(st: Pick<SessionTasks, 'workflows' | 'subagents'>): Progress {
  let done = 0;
  let total = 0;
  for (const w of st.workflows) {
    done += Math.max(0, w.progress?.done ?? 0);
    total += Math.max(0, w.progress?.total ?? 0);
  }
  for (const a of st.subagents) {
    total++;
    if (a.status !== 'running') done++;
  }
  return { done, total };
}

export function runningTotal(list: readonly Pick<SessionTasks, 'running'>[]): number {
  return list.reduce((n, s) => n + Math.max(0, s.running || 0), 0);
}

/** 펼침 기억 열쇠 */
export function taskSessionKey(st: Pick<SessionTasks, 'agent' | 'sessionId'>): string {
  return `s:${st.agent}:${st.sessionId}`;
}
export function workflowKey(w: Pick<BackgroundWorkflow, 'runId'>): string {
  return `w:${w.runId}`;
}

export function workflowName(w: Pick<BackgroundWorkflow, 'name' | 'runId'>): string {
  return w.name?.trim() || w.runId;
}

/** 세션 제목 한 줄(없으면 빈 글) */
export function taskSessionTitle(st: Pick<SessionTasks, 'title'>, max = 80): string {
  const t = st.title?.trim();
  return t ? firstLine(t, max) : '';
}

/** cwd의 마지막 폴더 이름 */
export function cwdBasename(cwd: string): string {
  return folderLabel({ label: '', path: cwd });
}

/** 시각 비교 — dir -1 최신순, 1 오래된 순. 시각이 없으면 어느 쪽이든 뒤로 */
function byTime(a: string | undefined, b: string | undefined, dir: -1 | 1): number {
  const ta = timeOf(a);
  const tb = timeOf(b);
  const na = Number.isNaN(ta);
  const nb = Number.isNaN(tb);
  if (na !== nb) return na ? 1 : -1;
  return na ? 0 : (ta - tb) * dir;
}
function newestFirst(a: string | undefined, b: string | undefined): number {
  return byTime(a, b, -1);
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 세션: 실행 중인 세션 먼저, 그다음 최근에 움직인 순 */
export function sortSessionTasks(list: readonly SessionTasks[]): SessionTasks[] {
  return [...list].sort(
    (a, b) =>
      Number(b.running > 0) - Number(a.running > 0) ||
      newestFirst(a.updatedAt, b.updatedAt) ||
      byId(taskSessionKey(a), taskSessionKey(b)),
  );
}

/** 워크플로우·서브에이전트: 실행 중 먼저, 그다음 최근에 움직인 순 */
export function sortByActivity<T extends { status: BackgroundTaskStatus; updatedAt: string }>(
  list: readonly T[],
  id: (x: T) => string,
): T[] {
  return [...list].sort(
    (a, b) =>
      Number(b.status === 'running') - Number(a.status === 'running') ||
      newestFirst(a.updatedAt, b.updatedAt) ||
      byId(id(a), id(b)),
  );
}

/** 워크플로우 안 agent: 단계 순서(모르는 단계는 뒤), 같은 단계는 시작한 순 */
export function sortWorkflowAgents(agents: readonly BackgroundAgent[], phases: readonly { title: string }[]): BackgroundAgent[] {
  const order = new Map(phases.map((p, i) => [p.title, i]));
  const rank = (a: BackgroundAgent) => (a.phase !== undefined && order.has(a.phase) ? order.get(a.phase)! : phases.length);
  return [...agents].sort((a, b) => rank(a) - rank(b) || byTime(a.startedAt, b.startedAt, 1) || byId(a.id, b.id));
}

/** 펼침 기억 — 사용자가 고른 쪽(펼침·접힘)을 다 기억하고, 고른 적 없으면 기본값(실행 중이면 펼침)을 따라요 */
export interface OpenState {
  open: Set<string>;
  closed: Set<string>;
}

export const OPEN_STATE_MAX = 200;

export function isOpen(s: OpenState, key: string, defaultOpen: boolean): boolean {
  if (s.open.has(key)) return true;
  if (s.closed.has(key)) return false;
  return defaultOpen;
}

/** 뒤집고 새 상태를 돌려줘요. 오래된 기억부터 지워 각 OPEN_STATE_MAX개로 묶어요. */
export function toggleOpen(s: OpenState, key: string, defaultOpen: boolean, max = OPEN_STATE_MAX): boolean {
  const next = !isOpen(s, key, defaultOpen);
  s.open.delete(key);
  s.closed.delete(key);
  (next ? s.open : s.closed).add(key);
  for (const set of [s.open, s.closed]) {
    while (set.size > max) set.delete(set.values().next().value!);
  }
  return next;
}

/** 저장 값 → 펼침 기억(배열이 아니거나 글이 아닌 값은 버려요) */
export function parseOpenState(open: unknown, closed: unknown, max = OPEN_STATE_MAX): OpenState {
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-max) : []);
  return { open: new Set(arr(open)), closed: new Set(arr(closed)) };
}

/** RpcError(또는 비슷한 모양) → 화면 언어 안내 */
export function describeError(e: unknown, action?: string): string {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  let text: string;
  switch (code) {
    case ErrorCode.NotFound:
      text = t('error.notFound');
      break;
    case ErrorCode.InvalidPath:
      text = t('error.invalidPath');
      break;
    case ErrorCode.LaunchFailed:
      text = t('error.launchFailed');
      break;
    case ErrorCode.SessionBusy:
      text = t('error.sessionBusy');
      break;
    case ErrorCode.Timeout:
      text = t('error.timeout');
      break;
    case ErrorCode.ProtocolMismatch:
      text = t('error.protocolMismatch');
      break;
    case ErrorCode.InvalidParams:
      text = t('error.invalidParams');
      break;
    default:
      text = /^(disconnected|channel closed|disposed)/.test(msg)
        ? t('error.disconnected')
        : t('error.generic');
  }
  const detail = msg && !/^(disconnected|channel closed|disposed|timeout)/.test(msg) ? ` (${msg})` : '';
  return action ? `${action}: ${text}${detail}` : `${text}${detail}`;
}

/** 재연결 대기 시간: 0.5→1→2→4…최대 30초 */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 30_000): number {
  const a = Math.max(0, Math.floor(attempt));
  return Math.min(maxMs, baseMs * 2 ** Math.min(a, 16));
}

/** `#token=…` (다른 키와 섞여도 됨)에서 토큰을 꺼내요. */
export function parseTokenFromHash(hash: string): string | undefined {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h) return undefined;
  const v = new URLSearchParams(h).get('token');
  return v ? v : undefined;
}

/** `#…&w=3`의 창 번호(데몬이 통합 창을 연 순서, 1 이상 정수). 없거나 이상하면 undefined */
export function parseWindowNumberFromHash(hash: string): number | undefined {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  const v = new URLSearchParams(h).get('w');
  if (!v || !/^[1-9]\d{0,8}$/.test(v)) return undefined;
  return Number(v);
}

export function rpcUrlFor(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/rpc`;
}
