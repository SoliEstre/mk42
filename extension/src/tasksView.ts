// 에이전트 창의 «작업» 보기 — 이 창 세션의 백그라운드 작업(워크플로우 단계·진행률, 서브에이전트 상태·토큰·걸린 시간)을
// 에이전트 패널과 같은 보조 사이드바 컨테이너(패널 아래)에 보여 줘요. 실행 중이면 상태 표시줄에도 수·토큰을 띄워요.
// 웹뷰는 확장이 만든(모두 이스케이프한) HTML만 그려요. 문서는 보일 때 한 번 쓰고, 그다음엔 본문만 메시지로 바꿔 끼워요 — 통째로
// 다시 쓰면 실행 중 몇 초마다 스크롤이 처음으로 가요. 스크립트는 nonce 하나(본문 바꾸기·펼침 기억·포커스 유지)뿐이고 명령 URI·로컬 파일은 막아요.
// 데이터: 데몬 tasks.list(이 창이 든 세션만) — state.changed {topics:['tasks']}와 세션이 바뀔 때 다시 읽어요.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { AgentKind, BackgroundAgent, BackgroundTaskStatus, BackgroundWorkflow, SessionTasks } from '@mark42/protocol';
import type { DaemonClient } from './daemonClient.ts';
import {
  currentPhaseIndex,
  elapsedMs,
  formatDuration,
  formatTokens,
  progressRatio,
  sortAgents,
  statusLabel,
  TASK_STATUSES,
  tasksTotals,
  tokensDetail,
  totalsText,
  type TasksTotals,
} from './lib/tasksFormat.ts';
import { t as l10nT } from './l10n.ts';
import type { Logger } from './log.ts';

/** package.json views — 각 에이전트 확장의 보조 사이드바 컨테이너에 넣어요(이 창 에이전트 것만 when으로 보여요) */
export const TASKS_VIEW_IDS: Record<AgentKind, string> = { claude: 'mark42.tasks.claude', codex: 'mark42.tasks.codex' };
export const AGENT_KIND_CONTEXT = 'mark42.agentKind';
/** state.changed가 몰려도 1초에 한 번만 다시 읽어요 */
const THROTTLE_MS = 1000;
/** 실행 중이고 보기가 보이면 걸린 시간을 이 간격으로 다시 그려요 */
const TICK_MS = 5000;

type TasksDaemon = Pick<DaemonClient, 'api' | 'state' | 'onStateChange'>;

/** 보기에 그릴 것 — 안내 한 줄이거나 작업 목록 */
export type TasksViewModel = { message: string } | { tasks: SessionTasks; now: number };

export class TasksMonitor implements vscode.WebviewViewProvider, vscode.Disposable {
  #daemon: TasksDaemon;
  #log: Logger;
  #agent: () => AgentKind | undefined;
  #sessionId: () => string | undefined;
  #now: () => number;
  #status: vscode.StatusBarItem;
  #views = new Map<vscode.WebviewView, { subs: vscode.Disposable[]; body: string; shell: boolean }>();
  #subs: vscode.Disposable[] = [];
  /** 이 세션의 작업(마지막으로 읽은 것) */
  #data: SessionTasks | undefined;
  /** #data가 어느 세션 것인지 — 세션이 바뀌면 비워요 */
  #for: string | undefined;
  #loaded = false;
  #error = false;
  #inflight: Promise<void> | undefined;
  #again = false;
  #lastLoad = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #tick: ReturnType<typeof setInterval> | undefined;
  /** 마지막으로 setContext한 에이전트(null = 아직 안 함) */
  #ctxAgent: AgentKind | '' | null = null;
  #disposed = false;

  /** agent·sessionId는 읽을 때마다 — 역할은 신뢰 뒤에, 세션은 창이 세션을 든 뒤에 정해져요 */
  constructor(o: {
    daemon: TasksDaemon;
    log: Logger;
    agent: () => AgentKind | undefined;
    sessionId: () => string | undefined;
    now?: () => number;
  }) {
    this.#daemon = o.daemon;
    this.#log = o.log;
    this.#agent = o.agent;
    this.#sessionId = o.sessionId;
    this.#now = o.now ?? Date.now;
    this.#status = vscode.window.createStatusBarItem('mark42.tasks.status', vscode.StatusBarAlignment.Left, 95);
    this.#status.name = vscode.l10n.t('Mark42 background tasks');
    this.#subs.push(
      this.#status,
      ...Object.values(TASKS_VIEW_IDS).map((id) => vscode.window.registerWebviewViewProvider(id, this)),
      // 끊기면 바로 실행 중 표시를 거두고, 붙으면 다시 읽어요
      o.daemon.onStateChange(() => {
        this.#render();
        this.refresh();
      }),
    );
    this.#syncContext();
    this.refresh();
  }

  /** 지금 보여 줄 데이터 — 연결돼 있고 이 창이 지금 든 세션 것일 때만 */
  #current(): SessionTasks | undefined {
    if (!this.#daemon.api || !this.#loaded || this.#for === undefined || this.#for !== this.#sessionId()) return undefined;
    return this.#data;
  }

  /** 지금 합계(상태 표시줄·배지와 같은 값) */
  get totals(): TasksTotals {
    return tasksTotals(this.#current());
  }

  /** state.changed {topics:['tasks']} 등 — 몰려도 1초에 한 번만 다시 읽어요 */
  refresh(): void {
    if (this.#disposed || this.#timer) return;
    const wait = Math.max(0, this.#lastLoad + THROTTLE_MS - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.reload();
    }, wait);
  }

  /** 바로 다시 읽어요(창이 세션을 들었을 때). 읽는 중이면 끝난 뒤 한 번 더 */
  reload(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#inflight) {
      this.#again = true;
      return this.#inflight;
    }
    this.#inflight = this.#load().finally(() => {
      this.#inflight = undefined;
      if (this.#again && !this.#disposed) {
        this.#again = false;
        this.refresh();
      }
    });
    return this.#inflight;
  }

  async #load(): Promise<void> {
    this.#lastLoad = Date.now();
    const agent = this.#syncContext();
    const api = this.#daemon.api;
    const sessionId = agent ? this.#sessionId() : undefined;
    if (sessionId !== this.#for) {
      this.#for = sessionId;
      this.#data = undefined;
      this.#loaded = false;
      this.#error = false;
    }
    if (!agent || !api || !sessionId) {
      // 연결이 끊기면 실행 중 표시가 남지 않게 비워요
      this.#data = undefined;
      this.#loaded = false;
      this.#render();
      return;
    }
    if (!this.#loaded) this.#render();
    try {
      const list = await api.request('tasks.list', { sessionId, agent });
      if (this.#disposed) return;
      if (this.#sessionId() !== sessionId) {
        this.#again = true; // 읽는 사이 세션이 바뀌었어요 — 옛 답은 버리고 새 세션으로 다시
      } else {
        this.#data = Array.isArray(list) ? list.find((t) => t?.sessionId === sessionId) : undefined;
        this.#loaded = true;
        this.#error = false;
      }
    } catch (e) {
      if (this.#disposed) return;
      this.#log.warn(`tasks view load failed: ${e instanceof Error ? e.message : String(e)}`);
      // 옛 «실행 중»을 붙들고 있지 않게 비워요
      this.#data = undefined;
      this.#loaded = false;
      this.#error = true;
    }
    this.#render();
  }

  /** 에이전트 종류 컨텍스트 키(보기 when)를 맞춰요 */
  #syncContext(): AgentKind | undefined {
    const agent = this.#agent();
    const v = agent ?? '';
    if (v !== this.#ctxAgent) {
      this.#ctxAgent = v;
      void vscode.commands.executeCommand('setContext', AGENT_KIND_CONTEXT, v);
    }
    return agent;
  }

  model(): TasksViewModel {
    const agent = this.#agent();
    if (!agent) return { message: vscode.l10n.t('Tasks are shown only in agent windows.') };
    if (!this.#daemon.api) {
      return { message: this.#daemon.state === 'connecting' ? vscode.l10n.t('Connecting to the daemon…') : vscode.l10n.t('Not connected to the daemon.') };
    }
    const sessionId = this.#sessionId();
    if (!sessionId) return { message: vscode.l10n.t('No session is open in this window yet.') };
    if (this.#error && this.#for === sessionId) return { message: vscode.l10n.t('Could not load the task list.') };
    if (!this.#loaded || this.#for !== sessionId) return { message: vscode.l10n.t('Loading…') };
    const t = this.#current();
    if (!t || (t.workflows.length === 0 && t.subagents.length === 0)) {
      return {
        message: `${vscode.l10n.t('This session has no background tasks.')}\n${vscode.l10n.t('Workflows and subagents appear here when you run them.')}`,
      };
    }
    return { tasks: t, now: this.#now() };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    if (this.#disposed) return;
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [] };
    // body: 지금 그려진 본문, shell: 이 문서가 살아 있는지(숨기면 웹뷰가 버려져서 다시 보일 때 문서부터 다시 써요)
    const entry = { subs: [] as vscode.Disposable[], body: '', shell: false };
    this.#views.set(view, entry);
    entry.subs.push(
      view.onDidChangeVisibility(() => {
        if (!view.visible) entry.shell = false;
        else this.#renderView(view, this.model());
        this.#syncTick();
      }),
      view.onDidDispose(() => {
        for (const s of entry.subs.splice(0)) s.dispose();
        this.#views.delete(view);
        this.#syncTick();
      }),
      view.webview.onDidReceiveMessage((m: unknown) => {
        const px = (m as { type?: unknown; px?: unknown } | undefined)?.type === 'height' ? (m as { px: unknown }).px : undefined;
        if (typeof px === 'number' && Number.isFinite(px) && px >= 0) this.#fitHeight(view, px);
      }),
    );
    this.#render();
    if (!this.#loaded) this.refresh();
  }

  #fitTimers = new Map<vscode.WebviewView, ReturnType<typeof setTimeout>>();
  #canFit: boolean | undefined;

  /** 보기 높이를 내용에 맞춰요(Mk42 패치 mark42.views.fitHeight — 최대 컨테이너의 반). 옛 빌드면 그대로 */
  #fitHeight(view: vscode.WebviewView, px: number): void {
    clearTimeout(this.#fitTimers.get(view));
    this.#fitTimers.set(
      view,
      setTimeout(() => {
        this.#fitTimers.delete(view);
        void (async () => {
          if (this.#canFit === undefined) this.#canFit = (await vscode.commands.getCommands(true)).includes(FIT_HEIGHT_COMMAND);
          if (this.#canFit && view.visible && !this.#disposed) await vscode.commands.executeCommand(FIT_HEIGHT_COMMAND, view.viewType, px);
        })().catch(() => undefined);
      }, FIT_DEBOUNCE_MS),
    );
  }

  #render(): void {
    if (this.#disposed) return;
    const totals = this.totals;
    const agent = this.#agent();
    if (agent && totals.running > 0) {
      this.#status.text = `$(sync~spin) ${totals.running}${totals.tokens > 0 ? ` · ${formatTokens(totals.tokens)}` : ''}`;
      this.#status.tooltip =
        totals.tokens > 0
          ? vscode.l10n.t('{0} background task(s) running · tokens {1} — click to show tasks', totals.running, formatTokens(totals.tokens))
          : vscode.l10n.t('{0} background task(s) running — click to show tasks', totals.running);
      this.#status.command = `${TASKS_VIEW_IDS[agent]}.focus`;
      this.#status.show();
    } else {
      this.#status.hide();
    }
    const model = this.model();
    for (const view of this.#views.keys()) {
      view.badge = totals.running > 0 ? { value: totals.running, tooltip: l10nT('{0} running', totals.running) } : undefined;
      view.description = totalsText(totals, l10nT) || undefined;
      if (view.visible) this.#renderView(view, model);
    }
    this.#syncTick();
  }

  #renderView(view: vscode.WebviewView, model: TasksViewModel): void {
    const entry = this.#views.get(view);
    if (!entry) return;
    const body = renderTasksBody(model);
    if (!entry.shell) {
      entry.shell = true;
      entry.body = body;
      view.webview.html = renderTasksHtml(model, randomBytes(16).toString('base64'));
      return;
    }
    if (body === entry.body) return;
    entry.body = body;
    void view.webview.postMessage({ body });
  }

  /** 실행 중이고 보이는 보기가 있을 때만 걸린 시간을 새로 그려요 */
  #syncTick(): void {
    const need = !this.#disposed && this.totals.running > 0 && [...this.#views.keys()].some((v) => v.visible);
    if (need && !this.#tick) {
      this.#tick = setInterval(() => {
        const model = this.model();
        for (const v of this.#views.keys()) if (v.visible) this.#renderView(v, model);
      }, TICK_MS);
    } else if (!need && this.#tick) {
      clearInterval(this.#tick);
      this.#tick = undefined;
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#tick) clearInterval(this.#tick);
    for (const t of this.#fitTimers.values()) clearTimeout(t);
    this.#fitTimers.clear();
    this.#timer = undefined;
    this.#tick = undefined;
    for (const e of this.#views.values()) for (const s of e.subs.splice(0)) s.dispose();
    this.#views.clear();
    for (const s of this.#subs.splice(0)) s.dispose();
  }
}

// ---- HTML (모든 데이터는 esc로 — 라벨·활동·요약은 세션 기록에서 온 값이에요)

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]!);
}

function statusOf(s: BackgroundTaskStatus | undefined): BackgroundTaskStatus {
  return s && TASK_STATUSES.includes(s) ? s : 'stale';
}

const CSP = "default-src 'none'; style-src 'unsafe-inline';";

const CSS = `
body { margin: 0; padding: 4px 12px 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.empty { color: var(--vscode-descriptionForeground); margin: 8px 0; line-height: 1.5; }
.empty p { margin: 0 0 4px; }
section { padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
section:last-child { border-bottom: 0; }
h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 0 0 4px; }
.head { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.name { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta, .l2, .act, summary { color: var(--vscode-descriptionForeground); }
.meta { font-size: 11px; white-space: nowrap; }
.bar { height: 3px; margin: 6px 0 4px; background: var(--vscode-editorWidget-border, rgba(128,128,128,.25)); border-radius: 2px; overflow: hidden; }
.fill { height: 100%; background: var(--vscode-progressBar-background); }
.st-failed .fill { background: var(--vscode-errorForeground); }
.phases { list-style: none; display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 2px; padding: 0; }
.phases li { font-size: 11px; padding: 1px 6px; border-radius: 9px; border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.35)); color: var(--vscode-descriptionForeground); }
.phases li.done { color: var(--vscode-foreground); }
.phases li.cur { color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); border-color: transparent; font-weight: 600; }
.phases .n { opacity: .8; margin-left: 3px; }
details { margin-top: 4px; }
summary { cursor: pointer; font-size: 11px; padding: 2px 0; }
ul.agents { list-style: none; margin: 2px 0 0; padding: 0; }
.ag { display: flex; gap: 6px; padding: 4px 0; min-width: 0; }
.ag .main { flex: 1; min-width: 0; }
.l1 { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kind { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.l2, .act { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.act { font-family: var(--vscode-editor-font-family, monospace); opacity: .85; }
.ic { width: 14px; flex: none; text-align: center; display: inline-block; }
.ic::before { display: inline-block; }
.st-running > .ic::before, .st-running > .head > .ic::before { content: '\\25D0'; color: var(--vscode-progressBar-background); animation: spin 1.2s linear infinite; }
.st-done > .ic::before, .st-done > .head > .ic::before { content: '\\2713'; color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, inherit)); }
.st-failed > .ic::before, .st-failed > .head > .ic::before { content: '\\2715'; color: var(--vscode-errorForeground); }
.st-stale > .ic::before, .st-stale > .head > .ic::before { content: '\\25CC'; color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
.ag.st-failed .stl { color: var(--vscode-errorForeground); }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ic::before { animation: none !important; } }
`;

/** 본문 — 문서가 뜬 뒤에는 이것만 메시지로 보내요 */
export function renderTasksBody(model: TasksViewModel): string {
  return 'message' in model
    ? `<div class="empty">${model.message
        .split('\n')
        .map((l) => `<p>${esc(l)}</p>`)
        .join('')}</div>`
    : renderTasks(model.tasks, model.now);
}

/**
 * 본문을 바꿔 끼우는 스크립트 — 본문은 확장이 이스케이프해서 만든 것만 와요.
 * - 펼침 기억: 사용자가 <details data-key>의 <summary>를 눌렀을 때(키보드로 열어도 click이 나요)만 기록해요. toggle 이벤트는
 *   처음부터 열린 채 만들어진 details(첫 파싱·본문 바꾸기)에도 나서 기본값을 사용자 선택으로 잘못 기억하니 쓰지 않아요.
 *   보기를 숨기면 웹뷰가 버려지니 setState에 두고, 문서가 뜰 때와 본문을 바꿀 때마다 다시 적용해요.
 * - 포커스: 바꾸기 전에 포커스가 data-focus 요소나 data-key details의 summary에 있었으면 바꾼 뒤 같은 것에 돌려놔요.
 * - 선택: 본문 안에 글자를 선택하고 있으면 바꾸지 않고 마지막 본문만 들고 있다가, 선택이 풀리면(누르던 단추를 뗀 뒤) 적용해요.
 */
/** Mk42 패치(2026-11-02~): 보기 높이를 내용에 맞춰요 */
export const FIT_HEIGHT_COMMAND = 'mark42.views.fitHeight';
const FIT_DEBOUNCE_MS = 250;

const SCRIPT = `const vscode = acquireVsCodeApi();
const MAX_KEYS = 200;
const userOpen = new Map();
try {
  const s = vscode.getState();
  const o = s && s.open;
  if (o && typeof o === 'object') for (const k of Object.keys(o)) if (typeof o[k] === 'boolean') userOpen.set(k, o[k]);
} catch (_) {}
function save() {
  try { vscode.setState({ open: Object.fromEntries(userOpen) }); } catch (_) {}
}
function summaryOf(d) {
  const s = d.firstElementChild;
  return s && s.tagName === 'SUMMARY' ? s : null;
}
function applyOpen() {
  for (const d of document.querySelectorAll('details[data-key]')) {
    const v = userOpen.get(d.dataset.key);
    if (v !== undefined && d.open !== v) d.open = v;
  }
}
document.addEventListener('click', (e) => {
  if (e.defaultPrevented) return;
  const t = e.target;
  const s = t && t.closest ? t.closest('summary') : null;
  const d = s ? s.parentElement : null;
  if (!d || d.tagName !== 'DETAILS' || !d.dataset.key || summaryOf(d) !== s) return;
  const key = d.dataset.key;
  setTimeout(() => {
    userOpen.delete(key);
    userOpen.set(key, d.open);
    while (userOpen.size > MAX_KEYS) userOpen.delete(userOpen.keys().next().value);
    save();
    applyOpen();
  });
});
function focusTarget() {
  const a = document.activeElement;
  if (!a || a === document.body || !document.body.contains(a)) return null;
  if (a.dataset && a.dataset.focus) return { focus: a.dataset.focus };
  const d = a.tagName === 'SUMMARY' ? a.parentElement : null;
  if (d && d.tagName === 'DETAILS' && d.dataset.key && summaryOf(d) === a) return { summary: d.dataset.key };
  return null;
}
function restoreFocus(f) {
  if (!f) return;
  let el = null;
  if (f.focus !== undefined) {
    for (const x of document.querySelectorAll('[data-focus]')) if (x.dataset.focus === f.focus) { el = x; break; }
  } else {
    for (const d of document.querySelectorAll('details[data-key]')) if (d.dataset.key === f.summary) { el = summaryOf(d); break; }
  }
  if (el) try { el.focus({ preventScroll: true }); } catch (_) {}
}
function selecting() {
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || !sel.rangeCount || !String(sel)) return false;
  return document.body.contains(sel.anchorNode) || document.body.contains(sel.focusNode);
}
let pending = null;
let pointerDown = false;
// 내용 높이를 확장에 알려요 — Mk42가 보기 높이를 내용에 맞춰요(최대 컨테이너의 반, mark42.views.fitHeight)
let lastHeight = -1;
let heightQueued = false;
function reportHeight() {
  if (heightQueued) return;
  heightQueued = true;
  requestAnimationFrame(() => {
    heightQueued = false;
    let bottom = 0;
    for (const el of document.body.children) bottom = Math.max(bottom, el.getBoundingClientRect().bottom + window.scrollY);
    const px = Math.ceil(bottom + 8);
    if (Math.abs(px - lastHeight) < 2) return;
    lastHeight = px;
    vscode.postMessage({ type: 'height', px });
  });
}
document.addEventListener('toggle', reportHeight, true);
window.addEventListener('resize', reportHeight);
function swap(body) {
  if (selecting()) { pending = body; return; }
  pending = null;
  const f = focusTarget();
  document.body.innerHTML = body;
  applyOpen();
  restoreFocus(f);
  reportHeight();
}
function flush() {
  if (pending === null) return;
  setTimeout(() => { if (pending !== null && !pointerDown && !selecting()) swap(pending); });
}
window.addEventListener('pointerdown', () => { pointerDown = true; }, true);
window.addEventListener('pointerup', () => { pointerDown = false; flush(); }, true);
window.addEventListener('pointercancel', () => { pointerDown = false; flush(); }, true);
document.addEventListener('selectionchange', flush);
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || typeof m.body !== 'string') return;
  swap(m.body);
});
applyOpen();
reportHeight();`;

export function renderTasksHtml(model: TasksViewModel, nonce = randomBytes(16).toString('base64')): string {
  return (
    `<!DOCTYPE html><html lang="${esc(vscode.env.language || 'en')}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP} script-src 'nonce-${nonce}';">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>${CSS}</style></head><body>${renderTasksBody(model)}<script nonce="${nonce}">${SCRIPT}</script></body></html>`
  );
}

function renderTasks(t: SessionTasks, now: number): string {
  const out: string[] = [];
  // 실행 중인 워크플로우가 먼저(같으면 데몬이 준 순서)
  const wfs = t.workflows
    .map((w, i) => ({ w, i }))
    .sort((a, b) => Number(b.w.status === 'running') - Number(a.w.status === 'running') || a.i - b.i)
    .map((x) => x.w);
  for (const wf of wfs) out.push(renderWorkflow(wf, now));
  if (t.subagents.length) {
    const subs = sortAgents(t.subagents);
    const running = subs.filter((a) => a.status === 'running');
    const ended = subs.filter((a) => a.status !== 'running');
    let html = `<section class="subs"><h2>${esc(l10nT('Subagents {0}', subs.length))}</h2>`;
    if (running.length) html += `<ul class="agents">${running.map((a) => renderAgent(a, now)).join('')}</ul>`;
    if (ended.length) {
      html +=
        `<details data-key="ended"${running.length ? '' : ' open'}><summary>${esc(l10nT('{0} ended', ended.length))}</summary>` +
        `<ul class="agents">${ended.map((a) => renderAgent(a, now)).join('')}</ul></details>`;
    }
    out.push(`${html}</section>`);
  }
  return out.join('');
}

function renderWorkflow(wf: BackgroundWorkflow, now: number): string {
  const st = statusOf(wf.status);
  const name = wf.name?.trim() || wf.description?.trim() || wf.runId;
  const pct = Math.round(progressRatio(wf) * 1000) / 10;
  const elapsed = formatDuration(elapsedMs(wf, now), l10nT);
  const label = statusLabel(st, l10nT);
  const meta = [
    `${wf.progress.done}/${wf.progress.total}`,
    wf.tokens?.total ? `<span title="${esc(tokensDetail(wf.tokens, l10nT))}">${esc(formatTokens(wf.tokens.total))}</span>` : undefined,
    elapsed ? esc(elapsed) : undefined,
    st !== 'running' ? esc(label) : undefined,
  ].filter(Boolean);
  const cur = currentPhaseIndex(wf);
  const phases = wf.phases.length
    ? `<ol class="phases">${wf.phases
        .map((p, i) => {
          const cls = i === cur ? 'cur' : p.started > 0 && p.done >= p.started ? 'done' : '';
          const n = p.started > 0 ? `<span class="n">${p.done}/${p.started}</span>` : '';
          return `<li${cls ? ` class="${cls}"` : ''} title="${esc(l10nT('{0} started · {1} ended', p.started, p.done))}">${esc(p.title)}${n}</li>`;
        })
        .join('')}</ol>`
    : '';
  const agents = wf.agents.length
    ? `<details data-key="wf:${esc(wf.runId)}"${st === 'running' ? ' open' : ''}><summary>${esc(l10nT('{0} agent(s)', wf.agents.length))}</summary>` +
      `<ul class="agents">${wf.agents.map((a) => renderAgent(a, now)).join('')}</ul></details>`
    : '';
  return (
    `<section class="wf st-${st}">` +
    `<div class="head"><span class="ic" title="${esc(label)}"></span>` +
    `<span class="name"${wf.description ? ` title="${esc(wf.description)}"` : ''}>${esc(name)}</span>` +
    `<span class="meta">${meta.join(' · ')}</span></div>` +
    `<div class="bar" title="${esc(`${wf.progress.done}/${wf.progress.total}`)}"><div class="fill" style="width:${pct}%"></div></div>` +
    phases +
    agents +
    `</section>`
  );
}

function renderAgent(a: BackgroundAgent, now: number): string {
  const st = statusOf(a.status);
  const elapsed = formatDuration(elapsedMs(a, now), l10nT);
  const label = statusLabel(st, l10nT);
  const l2 = [
    a.phase ? esc(a.phase) : undefined,
    a.tokens?.total ? `<span title="${esc(tokensDetail(a.tokens, l10nT))}">${esc(formatTokens(a.tokens.total))}</span>` : undefined,
    elapsed ? esc(elapsed) : undefined,
    st !== 'running' ? `<span class="stl">${esc(label)}</span>` : undefined,
  ].filter(Boolean);
  return (
    `<li class="ag st-${st}"${a.summary ? ` title="${esc(a.summary)}"` : ''}>` +
    `<span class="ic" title="${esc(label)}"></span><div class="main">` +
    `<div class="l1"><span class="label">${esc(a.label || a.id)}</span>${a.kind ? `<span class="kind">${esc(a.kind)}</span>` : ''}</div>` +
    (l2.length ? `<div class="l2">${l2.join(' · ')}</div>` : '') +
    (a.activity ? `<div class="act">${esc(a.activity)}</div>` : '') +
    `</div></li>`
  );
}
