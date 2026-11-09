// 데몬 코어 — 창 레지스트리, RequestMap 핸들러, 대기 알림, state.changed 브로드캐스트, named pipe 서버.
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, join } from 'node:path';
import {
  ErrorCode,
  PROTOCOL_VERSION,
  RpcError,
  RpcPeer,
  parseCloneUrl,
  PINNED_GROUP_MAX,
  redactCloneUrl,
  sanitizeHubTheme,
  type AgentExtensionUpdate,
  type AgentKind,
  type AgentOpenSessionParams,
  type AutostartState,
  type DaemonNotification,
  type DaemonNotificationMap,
  type EditorRouteParams,
  type EditorRouteResult,
  type Folder,
  type HelloParams,
  type HelloResult,
  type HubTheme,
  type Mk42UpdateInstallResult,
  type Mk42UpdateStatus,
  type ParamsOf,
  type PinnedSession,
  type RequestMethod,
  type ResultOf,
  type SessionsListParams,
  type SessionSummary,
  type SessionTasks,
  type StateTopic,
  type TasksListParams,
  type WindowInfo,
  type WindowOpenParams,
  type WindowOpenResult,
  type WindowRole,
} from '@mark42/protocol';
import { computeProof, isValidChallenge } from '@mark42/protocol/auth';
import { socketChannel } from '@mark42/protocol/node';
import { folderIdFor, normalizePath, pathKey, samePath } from '@mark42/protocol/paths';
import type { LiveSession, SessionIndexer } from './indexers/types.ts';
import { LaunchError, type AppLauncherLike, type LaunchOutcome } from './launcher.ts';
import { GitCloneError, removePartialClone, runGitClone, type GitCloneFn } from './gitClone.ts';
import { createMemoryLogger, errMsg, type Logger } from './log.ts';
import type { AppProduct, DaemonSettings, Registry, SlotRecord } from './registry.ts';
import { pinnedDefaults, PUBLIC_DEFAULTS, type EditionDefaults } from './edition.ts';
import { osUiLanguage, type UiLanguage } from './i18n.ts';
import { startResume, type OpenExtra, type OpenOutcome, type ResumeOutcome, type ResumeRun } from './resume.ts';
import { DAEMON_VERSION } from './version.ts';
import {
  ensureRoleWorkspace,
  isAgentRole,
  roleWorkspacePath,
  type EnsureResult,
  type RoleWorkspaceSpec,
} from './workspaces.ts';

export interface AutostartLike {
  get(): Promise<AutostartState>;
  set(enabled: boolean): Promise<AutostartState>;
}

export type IdKind = 'window' | 'slot' | 'request' | 'pinned' | 'client';
export type IdGenerator = (kind: IdKind) => string;

export function defaultIdGenerator(): IdGenerator {
  let windows = 0;
  let clients = 0;
  return (kind) => {
    switch (kind) {
      case 'slot':
        return randomBytes(4).toString('hex');
      case 'pinned':
        return `p-${randomBytes(6).toString('hex')}`;
      case 'request':
        return randomUUID();
      case 'window':
        return `w${++windows}-${randomBytes(3).toString('hex')}`;
      case 'client':
        return `c${++clients}`;
    }
  };
}

export type ClientKind = 'pipe' | 'hub-ws';

interface Client {
  id: string;
  kind: ClientKind;
  peer: RpcPeer;
  /** hello 뒤에 채워요 */
  window?: WindowInfo & { windowId: string };
  focusedAt: number;
  theme?: string;
  /** `window.theme`으로 받은 이 창의 테마 색과 받은 시각 */
  hubTheme?: HubTheme;
  hubThemeAt?: number;
  /** 창이 포커스를 받았다고 알린 마지막 시각(0 = 없음) — hello가 바꾸는 focusedAt과 달리 테마 고르기에만 */
  lastFocusedAt: number;
}

interface PendingAgent {
  params: AgentOpenSessionParams;
  expiresAt: number;
}
interface PendingEditor {
  items: DaemonNotificationMap['editor.openUri'][];
  expiresAt: number;
}

export interface ReportedResult {
  requestId: string;
  ok: boolean;
  detail?: string;
  windowId?: string;
}

export interface DaemonCoreOptions {
  home: string;
  registry: Registry;
  indexers: SessionIndexer[];
  launcher: AppLauncherLike;
  autostart?: AutostartLike;
  log?: Logger;
  newId?: IdGenerator;
  /** state.changed 디바운스. 기본 200ms */
  stateDebounceMs?: number;
  /** 창이 hello할 때까지 대기 알림을 들고 있는 시간. 기본 5분 */
  pendingTtlMs?: number;
  /** 재개 때 창 사이 간격 (settings.resumeLaunchGapMs보다 우선, 테스트용) */
  resumeGapMs?: number;
  now?: () => number;
  /** 데몬 전용 메서드 `$/openHub` (프로토콜 밖, --open-hub 두 번째 실행이 써요) */
  onOpenHub?: () => Promise<{ url: string }>;
  /** 기본 파이프가 아닐 때 역할 워크스페이스에 mark42.pipeName으로 써 넣을 이름 */
  pipeName?: string;
  /** 데몬 전용 메서드 `$/bootResume` — 다른 Windows 세션의 --boot 인스턴스가 «원격 세션이 생겼다»고 알려요 */
  onBootResume?: (p: { remote: boolean }) => Promise<{ accepted: boolean }> | { accepted: boolean };
  /**
   * 데몬 전용 메서드 `$/shutdown` — 설치기·업데이트가 데몬을 깔끔하게 끄게 해요(파이프 클라이언트만, 통합 창 WS는 안 돼요).
   * 답을 보낸 뒤에 끄도록 부르는 쪽이 미뤄요. 데몬이 꺼져도 Mk42 창은 그대로 돌고, 다시 뜬 데몬에 다시 붙어요.
   */
  onShutdown?: () => void;
  /** 재개 때 창 하나의 결과 보고를 기다리는 시간. 기본 120초 */
  resumeResultTimeoutMs?: number;
  /**
   * 파이프 서버 인증 — hello.challenge·`$/auth`에 proof로 답해요(파이프 선점 방지).
   * pipeName은 데몬이 실제로 듣는 파이프 이름이에요. 없으면 proof를 내지 않아요(창이 연결을 믿지 않아요).
   */
  auth?: { secret: Uint8Array; pipeName: string };
  /** folders.clone이 부르는 git clone (테스트용 바꿔 끼우기, 기본 {@link runGitClone}) */
  gitClone?: GitCloneFn;
  /** 판 기본값(edition.ts). 없으면 공개 기본값 */
  defaults?: EditionDefaults;
  /** 폴더별 앱 고르기(판 덧층) — settings.defaultAppProduct보다 먼저 */
  resolveAppProduct?: (folderPath: string, settings: DaemonSettings) => AppProduct | undefined;
  /** 창이 hello로 알린 앱 이름 → 앱(판 덧층). 없거나 모르면 'Mark42'만 mark42 */
  appProductOfName?: (appName: string) => AppProduct | undefined;
  /** UI 언어(새 고정 세션의 기본 재개 프롬프트). 기본 {@link osUiLanguage} */
  uiLanguage?: () => Promise<UiLanguage>;
  /** extensions.checkUpdates — 데몬이 올리는 에이전트 확장(agentUpdates.ts). 없으면 빈 결과 */
  agentUpdates?: {
    check(req: { ids?: readonly string[]; manual?: boolean }): Promise<AgentExtensionUpdate[]>;
    status(ids?: readonly string[]): AgentExtensionUpdate[];
    installUnverified(id: string, version: string): Promise<AgentExtensionUpdate>;
  };
  /** tasks.list — 백그라운드 작업(워크플로우·서브에이전트) 모니터(tasks/taskMonitor.ts). 없으면 빈 목록 */
  tasks?: { list(p: TasksListParams): Promise<SessionTasks[]> };
  /** 창이 hello했어요 — C3 준비 진행의 «창 여는 중»을 끝내요(launchProgress.ts) */
  onWindowHello?: (w: WindowInfo & { windowId: string }) => void;
  /** update.* — Mk42 자체 업데이트(updater.ts, 계약 C4). 없으면 state disabled */
  mk42Update?: {
    status(): Mk42UpdateStatus;
    /** 설치 기록을 다시 읽은 상태(네트워크 없이) — update.status */
    refreshStatus?(): Promise<Mk42UpdateStatus>;
    check(): Promise<Mk42UpdateStatus>;
    install(): Promise<Mk42UpdateInstallResult>;
    /** update.download — 자동 받기가 꺼져 기다리는 새 판을 지금 받아요 */
    download?(): Promise<Mk42UpdateStatus>;
    /** update.setAuto 뒤 — 설정을 다시 읽어 알리고(자동 받기를 켰으면 기다리던 판을 받아요) */
    settingsChanged?(): Promise<Mk42UpdateStatus>;
  };
}

const VALID_ROLES: ReadonlySet<string> = new Set<WindowRole>(['hub', 'agent-claude', 'agent-codex', 'editor']);

function agentOfRole(role: WindowRole): AgentKind | undefined {
  return role === 'agent-claude' ? 'claude' : role === 'agent-codex' ? 'codex' : undefined;
}

/** extensions.* 요청의 ids — 짧은 확장 ID 목록만 */
function extensionIds(ids: unknown): string[] | undefined {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || ids.length > 8 || !ids.every((x) => typeof x === 'string' && x.length <= 128)) {
    throw invalid('ids must be a short list of extension ids');
  }
  return ids as string[];
}

function invalid(msg: string): RpcError {
  return new RpcError(ErrorCode.InvalidParams, msg);
}

function reqString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) throw invalid(`${name} must be a non-empty string`);
  return v;
}

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const TASKS_MAX_SINCE_MS = 30 * 24 * 60 * 60 * 1000;

/** tasks.list 인자 확인 — 모르는 키는 버려요 */
export function parseTasksListParams(raw: unknown): TasksListParams {
  const p = asObject(raw);
  const out: TasksListParams = {};
  if (p.agent !== undefined) {
    if (p.agent !== 'claude' && p.agent !== 'codex') throw invalid('agent must be claude|codex');
    out.agent = p.agent;
  }
  if (p.sessionId !== undefined) {
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 || p.sessionId.length > 128) {
      throw invalid('sessionId must be a string of 1..128 chars');
    }
    out.sessionId = p.sessionId;
  }
  if (p.sinceMs !== undefined) {
    if (typeof p.sinceMs !== 'number' || !Number.isFinite(p.sinceMs) || p.sinceMs < 0 || p.sinceMs > TASKS_MAX_SINCE_MS) {
      throw invalid('sinceMs must be a number in 0..30 days');
    }
    out.sinceMs = p.sinceMs;
  }
  if (p.limit !== undefined) {
    if (typeof p.limit !== 'number' || !Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100) {
      throw invalid('limit must be an integer in 1..100');
    }
    out.limit = p.limit;
  }
  return out;
}

type Handler<M extends RequestMethod> = (params: ParamsOf<M>, client: Client) => Promise<ResultOf<M>> | ResultOf<M>;
type HandlerTable = { [M in RequestMethod]: Handler<M> };

export class DaemonCore {
  readonly home: string;
  readonly registry: Registry;
  #opts: DaemonCoreOptions;
  #log: Logger;
  #newId: IdGenerator;
  #now: () => number;
  #clients = new Map<string, Client>();
  #hubTheme: HubTheme | undefined;
  #pendingBySlot = new Map<string, PendingAgent>();
  #pendingEditor = new Map<string, PendingEditor>();
  #results = new Map<string, ReportedResult>();
  #resultListeners: ((r: ReportedResult) => void)[] = [];
  #topics = new Set<StateTopic>();
  #stateTimer: ReturnType<typeof setTimeout> | undefined;
  #handlers: HandlerTable;
  #closed = false;
  /** 재개 중인 `${agent}:${sessionId}` — 겹친 재개 실행이 같은 세션을 두 번 열지 않게 */
  #resuming = new Set<string>();
  /** Mk42 업데이트 «지금 설치할까요?»를 이미 물은 판(창 하나에만, 데몬 실행마다 판마다 한 번) */
  #announcedUpdate: string | undefined;

  constructor(opts: DaemonCoreOptions) {
    this.#opts = opts;
    this.home = opts.home;
    this.registry = opts.registry;
    this.#log = opts.log ?? createMemoryLogger();
    this.#newId = opts.newId ?? defaultIdGenerator();
    this.#now = opts.now ?? Date.now;
    this.#handlers = this.#buildHandlers();
  }

  /** 인덱서 감시 시작 */
  async start(): Promise<void> {
    for (const idx of this.#opts.indexers) {
      try {
        await idx.start(() => this.markChanged('sessions'));
      } catch (e) {
        this.#log.error(`indexer ${idx.agent} start failed: ${errMsg(e)}`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#stateTimer) clearTimeout(this.#stateTimer);
    this.#stateTimer = undefined;
    for (const c of [...this.#clients.values()]) c.peer.close();
    this.#clients.clear();
    for (const idx of this.#opts.indexers) {
      try {
        await idx.stop();
      } catch (e) {
        this.#log.warn(`indexer ${idx.agent} stop failed: ${errMsg(e)}`);
      }
    }
    await this.registry.flush();
  }

  /** 연결 하나를 붙여요(파이프 소켓 / hub WS). */
  attach(peer: RpcPeer, kind: ClientKind): void {
    if (this.#closed) {
      peer.close();
      return;
    }
    const client: Client = { id: this.#newId('client'), kind, peer, focusedAt: 0, lastFocusedAt: 0 };
    this.#clients.set(client.id, client);
    peer.setHandlers({
      onRequest: (method, params) => this.#dispatch(client, method, params),
      onNotification: (method, params) => this.#onNotification(client, method, params),
    });
    peer.onClose(() => this.#detach(client));
  }

  windows(): (WindowInfo & { windowId: string })[] {
    return [...this.#clients.values()].flatMap((c) => (c.window ? [{ ...c.window }] : []));
  }

  onReportResult(cb: (r: ReportedResult) => void): () => void {
    this.#resultListeners.push(cb);
    return () => {
      const i = this.#resultListeners.indexOf(cb);
      if (i >= 0) this.#resultListeners.splice(i, 1);
    };
  }

  /** 그 요청의 window.reportResult를 기다려요. 이미 왔으면 바로, 시간 초과면 undefined. */
  waitForResult(requestId: string, timeoutMs: number): Promise<ReportedResult | undefined> {
    const got = this.#results.get(requestId);
    if (got) return Promise.resolve(got);
    return new Promise((resolve) => {
      const off = this.onReportResult((r) => {
        if (r.requestId !== requestId) return;
        clearTimeout(t);
        off();
        resolve(r);
      });
      const t = setTimeout(() => {
        off();
        resolve(undefined);
      }, timeoutMs);
      t.unref?.();
    });
  }

  /** 연결된 Mark42 에이전트 창이 그 세션을 들고 있는지(hello·sessionBound 기준) */
  heldByWindow(agent: AgentKind, sessionId: string): boolean {
    return [...this.#clients.values()].some(
      (c) => c.window !== undefined && agentOfRole(c.window.role) === agent && c.window.sessionId === sessionId,
    );
  }

  reportedResult(requestId: string): ReportedResult | undefined {
    return this.#results.get(requestId);
  }

  markChanged(topic: StateTopic): void {
    if (this.#closed) return;
    this.#topics.add(topic);
    if (this.#stateTimer) return;
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = undefined;
      const topics = [...this.#topics];
      this.#topics.clear();
      this.#broadcastState(topics);
    }, this.#opts.stateDebounceMs ?? 200);
    this.#stateTimer.unref?.();
  }

  // ---- 공개 동작 (RPC 핸들러와 재개가 같이 써요)

  async openWindow(p: WindowOpenParams, extra?: OpenExtra): Promise<OpenOutcome> {
    const role = p.role;
    if (!VALID_ROLES.has(role)) throw invalid(`unknown role ${String(role)}`);
    if (role === 'hub') {
      const w = this.#findClients((c) => c.window?.role === 'hub')[0];
      if (w?.window) {
        void this.#focus(w);
        return { status: 'focused', windowId: w.window.windowId };
      }
      const ws = await this.#ensureWs({ role: 'hub' });
      await this.#launch(ws.file, 'hub');
      return { status: 'launched' };
    }
    const folderPath = await this.#checkDir(reqString(p.folderPath, 'folderPath'));
    if (role === 'editor') {
      const w = this.#editorWindow(folderPath);
      if (w?.window) {
        void this.#focus(w);
        return { status: 'focused', windowId: w.window.windowId };
      }
      const ws = await this.#ensureWs({ role, folderPath });
      await this.#launch(ws.file, role, undefined, false, this.#productFor(folderPath));
      return { status: 'launched' };
    }
    const agent = agentOfRole(role)!;
    if (p.sessionId !== undefined) {
      const sessionId = reqString(p.sessionId, 'sessionId');
      const openParams = (): AgentOpenSessionParams => ({
        requestId: this.#newId('request'),
        agent,
        sessionId,
        ...(extra?.settings ? { settings: extra.settings } : {}),
        ...(extra?.prompt !== undefined ? { prompt: extra.prompt } : {}),
        autoSend: extra?.autoSend ?? false,
      });
      // 1) 그 세션을 든 창이 있으면 포커스만 — 이미 그 창에서 돌고 있으니 재개 프롬프트를 다시 넣지 않아요
      const bySession = this.#findClients((c) => c.window?.role === role && c.window.sessionId === sessionId)[0];
      if (bySession?.window) {
        if (extra) this.#log.info(`session ${sessionId} already held by ${bySession.window.windowId}; focus only`);
        void this.#focus(bySession);
        return { status: 'focused', windowId: bySession.window.windowId, slotId: bySession.window.slotId };
      }
      // 2) 그 세션에 묶인 슬롯이 있으면 그 슬롯, 없으면 새 슬롯
      const slot =
        this.registry.data.slots.find((s) => s.agent === agent && s.sessionId === sessionId) ??
        (await this.#newSlot(folderPath, agent, sessionId));
      const bySlot = this.#findClients((c) => c.window?.role === role && c.window.slotId === slot.slotId)[0];
      if (bySlot?.window) {
        const op = openParams();
        bySlot.peer.notify('agent.openSession', op);
        void this.#focus(bySlot);
        return { status: 'focused', windowId: bySlot.window.windowId, slotId: slot.slotId, requestId: op.requestId };
      }
      const op = openParams();
      this.#queueAgent(slot.slotId, op);
      await this.#launchSlot(slot, role);
      return { status: 'launched', slotId: slot.slotId, requestId: op.requestId };
    }
    if (!p.newSession) {
      // 세션도 새 세션도 아니면: 그 폴더의 같은 역할 창을 포커스, 없으면 새 세션
      const w = this.#findClients(
        (c) => c.window?.role === role && !!c.window.folderPath && samePath(c.window.folderPath, folderPath),
      )[0];
      if (w?.window) {
        void this.#focus(w);
        return { status: 'focused', windowId: w.window.windowId, slotId: w.window.slotId };
      }
    }
    const slot = await this.#newSlot(folderPath, agent);
    const requestId = this.#newId('request');
    this.#queueAgent(slot.slotId, {
      requestId,
      agent,
      newSession: true,
      ...(extra?.settings ? { settings: extra.settings } : {}),
      ...(extra?.prompt !== undefined ? { prompt: extra.prompt } : {}),
      autoSend: extra?.autoSend ?? false,
    });
    await this.#launchSlot(slot, role);
    return { status: 'launched', slotId: slot.slotId, requestId };
  }

  async routeEditor(p: EditorRouteParams): Promise<EditorRouteResult> {
    const folderPath = await this.#checkDir(reqString(p.folderPath, 'folderPath'));
    const uri = reqString(p.uri, 'uri');
    const kind = p.kind === 'web' || p.kind === 'preview' ? p.kind : 'file';
    const msg: DaemonNotificationMap['editor.openUri'] = { uri, kind, ...(p.selection ? { selection: p.selection } : {}) };
    const w = this.#editorWindow(folderPath);
    if (w) {
      w.peer.notify('editor.openUri', msg);
      void this.#focus(w);
      return { status: 'forwarded' };
    }
    const key = pathKey(folderPath);
    const q = this.#pendingEditor.get(key);
    if (q && q.expiresAt > this.#now()) {
      // 이미 띄우는 중 — 큐에만 넣어요
      q.items.push(msg);
      return { status: 'launched' };
    }
    this.#pendingEditor.set(key, { items: [msg], expiresAt: this.#now() + this.#pendingTtl() });
    try {
      const ws = await this.#ensureWs({ role: 'editor', folderPath });
      await this.#launch(ws.file, 'editor', undefined, false, this.#productFor(folderPath));
    } catch (e) {
      this.#pendingEditor.delete(key);
      throw e;
    }
    return { status: 'launched' };
  }

  resumeNow(pinnedIds?: string[]): Promise<ResumeOutcome> {
    return this.startResume(pinnedIds).done;
  }

  /** 재개 시작 — planned는 사전 확인 직후, done은 창마다 보고를 기다린 뒤 */
  startResume(pinnedIds?: string[]): ResumeRun {
    const keys: string[] = [];
    const run = startResume(
      {
        pinned: () => this.registry.data.pinned,
        live: (agent) => this.#live(agent),
        held: (agent, sessionId) => this.heldByWindow(agent, sessionId) || this.#resuming.has(`${agent}:${sessionId}`),
        open: async (params, extra) => {
          const key = `${agentOfRole(params.role) ?? params.role}:${params.sessionId ?? ''}`;
          this.#resuming.add(key);
          keys.push(key);
          return this.openWindow(params, extra);
        },
        waitResult: (requestId, ms) => this.waitForResult(requestId, ms),
        resultTimeoutMs: this.#opts.resumeResultTimeoutMs ?? this.registry.settings.resumeResultTimeoutMs ?? 120_000,
        log: this.#log.child('resume'),
        gapMs: this.#opts.resumeGapMs ?? this.registry.settings.resumeLaunchGapMs ?? 1000,
      },
      pinnedIds,
    );
    const clear = () => {
      for (const k of keys) this.#resuming.delete(k);
    };
    run.done.then(clear, clear);
    return run;
  }

  // ---- 내부

  #ensureWs(spec: Omit<RoleWorkspaceSpec, 'home' | 'pipeName'>): Promise<EnsureResult> {
    return ensureRoleWorkspace({
      ...spec,
      home: this.home,
      ...(this.#opts.pipeName ? { pipeName: this.#opts.pipeName } : {}),
    });
  }

  /**
   * 창이 데몬이 만든 역할 워크스페이스(그 역할·폴더·슬롯의 정확한 자리)를 열고 있을 때만 관리 키를 다시 맞춰요. 사용자 폴더나 다른
   * 워크스페이스를 연 창은 건드리지 않아요. 내용이 같으면 쓰지 않아요(ensureRoleWorkspace).
   */
  async #refreshOwnWorkspace(w: WindowInfo): Promise<void> {
    if (!w.workspaceFile) return;
    let expected: string;
    try {
      expected = roleWorkspacePath({ home: this.home, role: w.role, folderPath: w.folderPath, slotId: w.slotId });
    } catch {
      return; // 폴더·슬롯이 맞지 않는 창
    }
    if (!samePath(expected, w.workspaceFile)) return;
    try {
      const r = await this.#ensureWs({ role: w.role, ...(w.folderPath ? { folderPath: w.folderPath } : {}), ...(w.slotId ? { slotId: w.slotId } : {}) });
      if (r.changed) this.#log.info(`role workspace refreshed for ${w.windowId}: ${expected}`);
    } catch (e) {
      this.#log.warn(`role workspace refresh failed (${expected}): ${errMsg(e)}`);
    }
  }

  #pendingTtl(): number {
    return this.#opts.pendingTtlMs ?? 5 * 60_000;
  }

  #findClients(pred: (c: Client) => boolean): Client[] {
    return [...this.#clients.values()].filter(pred).sort((a, b) => b.focusedAt - a.focusedAt);
  }

  #editorWindow(folderPath: string): Client | undefined {
    return this.#findClients(
      (c) => c.window?.role === 'editor' && !!c.window.folderPath && samePath(c.window.folderPath, folderPath),
    )[0];
  }

  /** 클론 중인 대상 폴더(pathKey) — 같은 곳에 두 번 클론하지 않게 */
  readonly #cloning = new Set<string>();

  #registerFolder(path: string, label: unknown): Promise<Folder> {
    const id = folderIdFor(path);
    return this.registry.update((d) => {
      const existing = d.folders.find((f) => f.id === id);
      if (existing) {
        if (typeof label === 'string' && label) existing.label = label;
        this.markChanged('folders');
        return { ...existing };
      }
      const folder: Folder = {
        id,
        path,
        label: typeof label === 'string' && label ? label : basename(path) || path,
        addedAt: new Date(this.#now()).toISOString(),
      };
      d.folders.push(folder);
      this.markChanged('folders');
      return { ...folder };
    });
  }

  async #checkDir(p: string): Promise<string> {
    const n = normalizePath(p);
    let ok = false;
    try {
      ok = (await fsp.stat(n)).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new RpcError(ErrorCode.InvalidPath, `not a directory: ${n}`);
    return n;
  }

  async #newSlot(folderPath: string, agent: AgentKind, sessionId?: string): Promise<SlotRecord> {
    let slotId = this.#newId('slot');
    for (let i = 0; i < 5 && this.registry.data.slots.some((s) => s.slotId === slotId); i++) slotId = this.#newId('slot');
    const rec: SlotRecord = {
      slotId,
      folderPath,
      agent,
      ...(sessionId ? { sessionId } : {}),
      createdAt: new Date(this.#now()).toISOString(),
    };
    await this.registry.update((d) => {
      d.slots.push(rec);
    });
    return rec;
  }

  #queueAgent(slotId: string, params: AgentOpenSessionParams): void {
    // 같은 슬롯에 쌓인 이전 요청은 새 요청으로 바꿔요(한 창 한 세션)
    this.#pendingBySlot.set(slotId, { params, expiresAt: this.#now() + this.#pendingTtl() });
  }

  async #launchSlot(slot: SlotRecord, role: WindowRole): Promise<void> {
    try {
      const ws = await this.#ensureWs({ role, folderPath: slot.folderPath, slotId: slot.slotId });
      await this.#launch(ws.file, role, undefined, false, this.#productFor(slot.folderPath));
    } catch (e) {
      this.#pendingBySlot.delete(slot.slotId);
      throw e;
    }
  }

  /** 그 폴더 창을 띄울 앱: 판 덧층의 폴더별 선택 → settings.defaultAppProduct → 판 기본값 */
  #productFor(folderPath: string | undefined): AppProduct {
    const s = this.registry.settings;
    const byFolder = folderPath ? this.#opts.resolveAppProduct?.(folderPath, s) : undefined;
    return byFolder ?? s.defaultAppProduct ?? this.#defaults().defaultAppProduct;
  }

  #defaults(): EditionDefaults {
    return this.#opts.defaults ?? PUBLIC_DEFAULTS;
  }

  async #lang(): Promise<UiLanguage> {
    return (this.#opts.uiLanguage ?? osUiLanguage)().catch(() => 'en' as const);
  }

  async #launch(workspaceFile: string, role: WindowRole, appVersion?: string, exact = false, appProduct?: AppProduct): Promise<LaunchOutcome> {
    try {
      return await this.#opts.launcher.launch({ workspaceFile, role, appVersion, exactVersion: exact, appProduct });
    } catch (e) {
      if (e instanceof RpcError) throw e;
      throw new RpcError(ErrorCode.LaunchFailed, e instanceof LaunchError ? e.message : `launch failed: ${errMsg(e)}`);
    }
  }

  /** 포커스 = 같은 워크스페이스를 같은 버전 Code.exe로 다시 실행(VS Code가 기존 창을 앞으로 가져와요). */
  async #focus(c: Client): Promise<void> {
    const w = c.window;
    if (!w) return;
    let target = w.workspaceFile;
    if (!target) {
      try {
        target = roleWorkspacePath({ home: this.home, role: w.role, folderPath: w.folderPath, slotId: w.slotId });
      } catch {
        target = w.folderPath;
      }
    }
    if (!target) return;
    try {
      // 그 창의 앱으로(같은 버전 번호의 다른 앱으로 띄우면 창이 하나 더 떠요). appName을 안 보내는 옛 확장이면 그 폴더의 앱
      const product: AppProduct = w.appName
        ? (this.#opts.appProductOfName?.(w.appName) ?? (w.appName === 'Mark42' ? 'mark42' : 'vscode'))
        : this.#productFor(w.folderPath);
      await this.#launch(target, w.role, w.appVersion, true, product);
    } catch (e) {
      // 같은 버전 설치본이 없으면 다른 버전으로 열면 창이 하나 더 떠요 — 포커스는 포기해요
      this.#log.warn(`focus ${w.windowId} skipped: ${errMsg(e)}`);
    }
  }

  async #live(agent?: AgentKind): Promise<LiveSession[]> {
    const out: LiveSession[] = [];
    for (const idx of this.#opts.indexers) {
      if (agent && idx.agent !== agent) continue;
      out.push(...(await idx.live()));
    }
    return out;
  }

  /** Mk42 확장 폴더에 에이전트 확장 새 버전이 깔렸다고 붙은 창에 알려요(창이 «업데이트 적용»을 보여요) */
  notifyExtensionsUpdated(ids: string[]): void {
    for (const c of this.#clients.values()) {
      if (c.window !== undefined) c.peer.notify('extensions.updated', { ids });
    }
  }

  /**
   * Mk42 자체 업데이트 상태가 바뀌었어요 — 붙은 창 모두와 통합 창에 `update.changed`. ready인 새 판은 창 하나에만 announce:true
   * (가장 최근에 포커스를 알린 창, 같으면 가장 최근에 붙은 창). 붙은 창이 없으면 다음에 hello하는 창이 받아요.
   */
  notifyUpdateChanged(status: Mk42UpdateStatus): void {
    const target = this.#updateAnnounceTarget(status);
    for (const c of this.#clients.values()) {
      if (c.kind === 'hub-ws' || c.window !== undefined) c.peer.notify('update.changed', c === target ? { ...status, announce: true } : status);
    }
  }

  #updateAnnounceTarget(status: Mk42UpdateStatus, only?: Client): Client | undefined {
    if (status.state !== 'ready' || !status.latest || status.latest === this.#announcedUpdate) return undefined;
    const candidates = only ? [only] : [...this.#clients.values()];
    let best: Client | undefined;
    for (const c of candidates) {
      if (c.kind !== 'pipe' || !c.window || c.peer.closed) continue;
      if (!best || c.lastFocusedAt > best.lastFocusedAt || (c.lastFocusedAt === best.lastFocusedAt && c.focusedAt > best.focusedAt)) best = c;
    }
    if (best) this.#announcedUpdate = status.latest;
    return best;
  }

  /** hello 뒤: 아직 아무 창도 묻지 않은 ready 판이면 이 창이 물어요 */
  #announcePendingUpdate(client: Client): void {
    const status = this.#opts.mk42Update?.status();
    if (!status || client.peer.closed) return;
    if (this.#updateAnnounceTarget(status, client) === client) client.peer.notify('update.changed', { ...status, announce: true });
  }

  /** 백그라운드 작업이 바뀌었어요 — 다른 주제처럼 묶어서 state.changed {topics:['tasks']}로 알려요 */
  notifyTasksChanged(): void {
    this.markChanged('tasks');
  }

  #broadcastState(topics: StateTopic[]): void {
    if (topics.length === 0) return;
    // hub + 세션 탭이 있는 창 — 세션 탭(mark42.sessions)은 역할 창 모두에 있어요(editor 포함)
    for (const c of this.#clients.values()) {
      if (c.kind === 'hub-ws' || c.window !== undefined) c.peer.notify('state.changed', { topics });
    }
  }

  #detach(client: Client): void {
    if (!this.#clients.delete(client.id)) return;
    if (client.window) {
      this.#log.info(`window ${client.window.windowId} (${client.window.role}) disconnected`);
      this.markChanged('windows');
    }
    // 통합 창이 따르던 창이 닫히면 남은 창 중에서 다시 골라요(남은 창이 없으면 마지막 테마 그대로)
    if (client.hubTheme) this.#pickTheme();
  }

  async #dispatch(client: Client, method: string, params: unknown): Promise<unknown> {
    if (method === '$/openHub') {
      if (!this.#opts.onOpenHub) throw new RpcError(ErrorCode.NotFound, 'hub server disabled');
      return this.#opts.onOpenHub();
    }
    if (method === '$/bootResume') {
      if (!this.#opts.onBootResume) return { accepted: false };
      return this.#opts.onBootResume({ remote: asObject(params).remote === true });
    }
    if (method === '$/shutdown') {
      if (client.kind !== 'pipe' || !this.#opts.onShutdown) throw new RpcError(ErrorCode.MethodNotFound, method);
      this.#log.info('shutdown requested over the pipe');
      this.#opts.onShutdown();
      return { stopping: true };
    }
    if (!Object.hasOwn(this.#handlers, method)) throw new RpcError(ErrorCode.MethodNotFound, method);
    const h = this.#handlers[method as RequestMethod] as Handler<RequestMethod>;
    return h(asObject(params) as never, client);
  }

  #onNotification(client: Client, method: string, raw: unknown): void {
    const params = asObject(raw);
    if (method === 'window.status') {
      if (params.focused === true) {
        client.focusedAt = this.#now();
        client.lastFocusedAt = client.focusedAt;
        if (client.hubTheme) this.#pickTheme(); // 다른 테마의 창으로 포커스가 옮겨 가면 통합 창도 따라가요
      }
      if (typeof params.theme === 'string' && params.theme !== client.theme) client.theme = params.theme;
      return;
    }
    if (method === 'window.theme') {
      const t = sanitizeHubTheme(raw);
      if (!t || !client.window) return; // 역할 창(hello를 마친 창)만
      client.hubTheme = t;
      client.hubThemeAt = this.#now();
      this.#pickTheme();
      return;
    }
    if (method === 'window.sessionBound') {
      const w = client.window;
      const sessionId = params.sessionId;
      if (!w || typeof sessionId !== 'string' || !sessionId) return;
      const agent = agentOfRole(w.role);
      if (!agent || (params.agent !== undefined && params.agent !== agent)) return;
      w.sessionId = sessionId;
      if (w.slotId) void this.#bindSlot(w.slotId, agent, w.folderPath, sessionId);
      this.markChanged('windows');
      return;
    }
    this.#log.debug(`ignored notification ${method}`);
  }

  /**
   * 통합 창(B)이 따를 테마: 테마를 알린 창 중 포커스를 받았다고 가장 최근에 알린 창의 것(같으면 — 포커스를 알린 적 없는 창끼리 —
   * 더 최근에 알린 것). hello는 순위를 바꾸지 않아요(데몬이 다시 뜰 때 마지막에 붙은 창이 이기지 않게). 바뀌면 `state.changed {theme}`.
   */
  #pickTheme(): void {
    let best: Client | undefined;
    for (const c of this.#clients.values()) {
      if (!c.hubTheme) continue;
      if (!best || c.lastFocusedAt > best.lastFocusedAt || (c.lastFocusedAt === best.lastFocusedAt && (c.hubThemeAt ?? 0) > (best.hubThemeAt ?? 0)))
        best = c;
    }
    if (!best?.hubTheme) return; // 마지막 테마는 그 창이 닫혀도 그대로 둬요
    if (JSON.stringify(best.hubTheme) === JSON.stringify(this.#hubTheme)) return;
    this.#hubTheme = best.hubTheme;
    this.markChanged('theme');
  }

  get hubTheme(): HubTheme | undefined {
    return this.#hubTheme;
  }

  async #bindSlot(slotId: string, agent: AgentKind, folderPath: string | undefined, sessionId: string): Promise<void> {
    try {
      await this.registry.update((d) => {
        // 한 세션은 한 슬롯에만 (다른 슬롯에 남은 같은 세션 매핑은 풀어요)
        for (const s of d.slots) if (s.slotId !== slotId && s.agent === agent && s.sessionId === sessionId) delete s.sessionId;
        const rec = d.slots.find((s) => s.slotId === slotId);
        if (rec) rec.sessionId = sessionId;
        else if (folderPath)
          d.slots.push({ slotId, folderPath, agent, sessionId, createdAt: new Date(this.#now()).toISOString() });
      });
    } catch (e) {
      this.#log.error(`slot bind failed: ${errMsg(e)}`);
    }
  }

  /** 파이프 연결에만 proof를 줘요(hub WS는 토큰 인증이라 proof를 낼 이유가 없어요 — 대리 서명 창구가 되지 않게). */
  #proof(client: Client, challenge: string): string | undefined {
    const auth = this.#opts.auth;
    if (!auth || client.kind !== 'pipe') return undefined;
    return computeProof(auth.secret, auth.pipeName, challenge);
  }

  #auth(p: { challenge?: unknown }, client: Client): { proof: string } {
    if (client.kind !== 'pipe') throw new RpcError(ErrorCode.MethodNotFound, '$/auth');
    if (!isValidChallenge(p.challenge)) throw invalid('challenge must be base64url of 32 bytes');
    const proof = this.#proof(client, p.challenge);
    if (proof === undefined) throw new RpcError(ErrorCode.NotFound, 'auth unavailable');
    return { proof };
  }

  #hello(p: HelloParams, client: Client): HelloResult {
    if (p.protocolVersion !== PROTOCOL_VERSION) {
      throw new RpcError(
        ErrorCode.ProtocolMismatch,
        `protocolVersion ${String(p.protocolVersion)} != ${PROTOCOL_VERSION}`,
        { protocolVersion: PROTOCOL_VERSION },
      );
    }
    const rawChallenge: unknown = p.challenge;
    if (rawChallenge !== undefined && !isValidChallenge(rawChallenge)) throw invalid('challenge must be base64url of 32 bytes');
    const challenge = rawChallenge as string | undefined;
    const win = asObject(p.window) as Partial<WindowInfo>;
    if (typeof win.role !== 'string' || !VALID_ROLES.has(win.role)) throw invalid('window.role invalid');
    const windowId = client.window?.windowId ?? this.#newId('window');
    const info: WindowInfo & { windowId: string } = {
      ...(win as WindowInfo),
      windowId,
      role: win.role,
      pid: typeof win.pid === 'number' ? win.pid : 0,
      appVersion: typeof win.appVersion === 'string' ? win.appVersion : 'unknown',
      appName: typeof win.appName === 'string' ? win.appName.slice(0, 64) : undefined,
      extensions: Array.isArray(win.extensions) ? win.extensions : [],
    };
    if (typeof win.folderPath === 'string' && win.folderPath) info.folderPath = normalizePath(win.folderPath);
    else delete info.folderPath;
    const agent = agentOfRole(info.role);
    if (agent && info.slotId) {
      const slot = this.registry.data.slots.find((s) => s.slotId === info.slotId);
      if (!info.sessionId && slot?.sessionId) info.sessionId = slot.sessionId;
      else if (info.sessionId && slot?.sessionId !== info.sessionId)
        void this.#bindSlot(info.slotId, agent, info.folderPath, info.sessionId);
    }
    client.window = info;
    client.focusedAt = this.#now();
    this.#log.info(`hello ${windowId} role=${info.role} slot=${info.slotId ?? '-'} folder=${info.folderPath ?? '-'}`);
    this.markChanged('windows');
    // 응답이 먼저 가도록 다음 틱에 대기 알림을 보내요
    setImmediate(() => {
      this.#deliverPending(client);
      this.#announcePendingUpdate(client);
    });
    // 이미 열린 창도 지금 판의 관리 설정(창 제목 틀 등)을 받게 — VS Code가 바뀐 워크스페이스 파일을 바로 다시 읽어요
    void this.#refreshOwnWorkspace(info);
    try {
      this.#opts.onWindowHello?.({ ...info });
    } catch (e) {
      this.#log.warn(`onWindowHello failed: ${errMsg(e)}`);
    }
    const result: HelloResult = { protocolVersion: PROTOCOL_VERSION, daemonVersion: DAEMON_VERSION, windowId };
    const proof = challenge === undefined ? undefined : this.#proof(client, challenge);
    if (proof !== undefined) result.proof = proof;
    return result;
  }

  #deliverPending(client: Client): void {
    const w = client.window;
    if (!w || client.peer.closed) return;
    const now = this.#now();
    if (isAgentRole(w.role) && w.slotId) {
      const p = this.#pendingBySlot.get(w.slotId);
      if (p) {
        this.#pendingBySlot.delete(w.slotId);
        if (p.expiresAt > now) this.#notify(client, 'agent.openSession', p.params);
        else this.#log.warn(`pending openSession for slot ${w.slotId} expired`);
      }
    }
    if (w.role === 'editor' && w.folderPath) {
      const key = pathKey(w.folderPath);
      const q = this.#pendingEditor.get(key);
      if (q) {
        this.#pendingEditor.delete(key);
        if (q.expiresAt > now) for (const m of q.items) this.#notify(client, 'editor.openUri', m);
      }
    }
  }

  #notify<N extends DaemonNotification>(client: Client, method: N, params: DaemonNotificationMap[N]): void {
    client.peer.notify(method, params);
  }

  async #sessionsList(p: SessionsListParams): Promise<SessionSummary[]> {
    let cwd: string | undefined;
    if (p.folderId !== undefined) {
      const f = this.registry.data.folders.find((x) => x.id === p.folderId);
      if (!f) throw new RpcError(ErrorCode.NotFound, `folder ${String(p.folderId)}`);
      cwd = f.path;
    } else if (typeof p.cwd === 'string' && p.cwd) {
      cwd = normalizePath(p.cwd);
    }
    const includeSubagents = p.includeSubagents === true;
    const limit = typeof p.limit === 'number' && p.limit > 0 ? Math.floor(p.limit) : undefined;
    const indexers = this.#opts.indexers.filter((i) => !p.agent || i.agent === p.agent);
    const lists = await Promise.all(
      indexers.map(async (idx) => {
        const [items, live] = await Promise.all([
          idx.list({ cwd, includeSubagents, limit }).catch((e) => {
            this.#log.warn(`indexer ${idx.agent} list failed: ${errMsg(e)}`);
            return [] as SessionSummary[];
          }),
          idx.live().catch((e) => {
            this.#log.warn(`indexer ${idx.agent} live failed: ${errMsg(e)}`);
            return [] as LiveSession[];
          }),
        ]);
        const liveById = new Map(live.map((l) => [`${l.agent}:${l.sessionId}`, l.status]));
        return items.map((s) => {
          const st = liveById.get(`${s.agent}:${s.id}`);
          return st ? { ...s, status: st } : s;
        });
      }),
    );
    let all = lists.flat();
    if (cwd) all = all.filter((s) => samePath(s.cwd, cwd));
    if (!includeSubagents) all = all.filter((s) => !s.isSubagent);
    all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return limit ? all.slice(0, limit) : all;
  }

  async #pinnedUpsert(raw: ParamsOf<'pinned.upsert'>): Promise<PinnedSession> {
    const p = asObject(raw);
    const defaults = this.#defaults();
    const lang = await this.#lang();
    const agent = p.agent;
    if (agent !== 'claude' && agent !== 'codex') throw invalid('agent must be claude|codex');
    const folderPath = normalizePath(reqString(p.folderPath, 'folderPath'));
    const sessionId = reqString(p.sessionId, 'sessionId');
    return this.registry.update((d) => {
      const id = typeof p.id === 'string' && p.id ? p.id : this.#newId('pinned');
      const idx = d.pinned.findIndex((x) => x.id === id);
      const prev = idx >= 0 ? d.pinned[idx] : undefined;
      const maxOrder = d.pinned.reduce((m, x) => Math.max(m, x.order), -1);
      const rec: PinnedSession = {
        ...(prev ?? {}),
        id,
        folderPath,
        agent,
        sessionId,
        settings: asObject(p.settings ?? prev?.settings ?? {}),
        resumePrompt: typeof p.resumePrompt === 'string' ? p.resumePrompt : (prev?.resumePrompt ?? defaults.resumePrompt(lang)),
        autoSend: typeof p.autoSend === 'boolean' ? p.autoSend : (prev?.autoSend ?? defaults.pinnedAutoSend),
        enabled: typeof p.enabled === 'boolean' ? p.enabled : (prev?.enabled ?? false), // 새로 고정하면 부팅 재개는 꺼짐(사용자 결정 2026-10-21)
        order: typeof p.order === 'number' && Number.isFinite(p.order) ? p.order : (prev?.order ?? maxOrder + 1),
      };
      if (typeof p.label === 'string') rec.label = p.label;
      // 그룹: 문자열이면 다듬어 넣고, 빈 문자열이면 빼요(안 보내면 그대로)
      if (typeof p.group === 'string') {
        const g = p.group.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, PINNED_GROUP_MAX);
        if (g) rec.group = g;
        else delete rec.group;
      }
      if (idx >= 0) d.pinned[idx] = rec;
      else d.pinned.push(rec);
      this.markChanged('pinned');
      return rec;
    });
  }

  #buildHandlers(): HandlerTable {
    return {
      hello: (p, c) => this.#hello(p, c),
      '$/auth': (p, c) => this.#auth(p, c),
      'folders.list': () => [...this.registry.data.folders],
      'theme.get': () => (this.#hubTheme ? { theme: this.#hubTheme } : {}),
      'extensions.checkUpdates': async (p) => ({ updates: (await this.#opts.agentUpdates?.check({ ids: extensionIds(p?.ids), manual: true })) ?? [] }),
      'extensions.status': (p) => ({ updates: this.#opts.agentUpdates?.status(extensionIds(p?.ids)) ?? [] }),
      'extensions.installUnverified': async (p) => {
        const id = reqString(p.id, 'id');
        const version = reqString(p.version, 'version');
        if (id.length > 128 || !/^\d+(?:\.\d+){1,3}$/.test(version)) throw invalid('id and version must be an extension id and a release version');
        if (!this.#opts.agentUpdates) throw new RpcError(ErrorCode.NotFound, 'no agent extension updater');
        try {
          return await this.#opts.agentUpdates.installUnverified(id, version);
        } catch (e) {
          throw new RpcError(ErrorCode.NotFound, errMsg(e));
        }
      },
      'update.status': async () => {
        const u = this.#opts.mk42Update;
        if (!u) return { state: 'disabled', current: 'unknown' };
        return u.refreshStatus ? u.refreshStatus() : u.status();
      },
      'update.check': async () => (this.#opts.mk42Update ? this.#opts.mk42Update.check() : { state: 'disabled', current: 'unknown' }),
      'update.install': async () => (this.#opts.mk42Update ? this.#opts.mk42Update.install() : { started: false, error: 'self-update is not available' }),
      'update.download': async () => {
        const u = this.#opts.mk42Update;
        if (!u) return { state: 'disabled', current: 'unknown' };
        return u.download ? u.download() : u.status();
      },
      'update.setAuto': async (p) => {
        const patch: { autoDownload?: boolean; autoInstall?: boolean } = {};
        if (p.download !== undefined) {
          if (typeof p.download !== 'boolean') throw invalid('download must be boolean');
          patch.autoDownload = p.download;
        }
        if (p.install !== undefined) {
          if (typeof p.install !== 'boolean') throw invalid('install must be boolean');
          patch.autoInstall = p.install;
        }
        if (patch.autoDownload === undefined && patch.autoInstall === undefined) throw invalid('download or install is required');
        await this.registry.update((d) => {
          d.settings.update = { ...d.settings.update, ...patch };
        });
        const u = this.#opts.mk42Update;
        if (!u) return { state: 'disabled', current: 'unknown' };
        return u.settingsChanged ? u.settingsChanged() : u.status();
      },
      'folders.add': async (p) => this.#registerFolder(await this.#checkDir(reqString(p.path, 'path')), p.label),
      'folders.clone': async (p) => {
        const parsed = parseCloneUrl(reqString(p.url, 'url'));
        if (!parsed) throw invalid('url must be a git repository address (https://, ssh://, git://, user@host:path) without a password or token');
        const parent = await this.#checkDir(reqString(p.parentDir, 'parentDir'));
        const dest = normalizePath(join(parent, parsed.name));
        const key = pathKey(dest);
        if (this.#cloning.has(key)) throw new RpcError(ErrorCode.InvalidPath, `already cloning into ${dest}`);
        // 확인과 표시 사이에 await가 없게: 같은 대상의 두 요청이 둘 다 통과하지 않아요
        this.#cloning.add(key);
        const shown = redactCloneUrl(parsed.url);
        try {
          let exists = true;
          try {
            await fsp.lstat(dest);
          } catch {
            exists = false;
          }
          if (exists) throw new RpcError(ErrorCode.InvalidPath, `already exists: ${dest}`);
          this.#log.info(`clone ${shown} -> ${dest}`);
          try {
            await (this.#opts.gitClone ?? runGitClone)(parsed.url, dest);
          } catch (e) {
            this.#log.warn(`clone ${shown} failed: ${errMsg(e)}`);
            // 클론 전에 없던 폴더라 지워도 돼요(제한 시간에 끊긴 git은 반쯤 받은 폴더를 남겨요 — 다시 시도가 «이미 있음»이 되지 않게)
            await removePartialClone(dest);
            if (e instanceof GitCloneError && e.code === 'timeout') throw new RpcError(ErrorCode.Timeout, e.message);
            throw new RpcError(ErrorCode.CloneFailed, errMsg(e));
          }
        } finally {
          this.#cloning.delete(key);
        }
        return this.#registerFolder(await this.#checkDir(dest), p.label);
      },
      'folders.remove': async (p) => {
        const folderId = reqString(p.folderId, 'folderId');
        if (!this.registry.data.folders.some((f) => f.id === folderId)) {
          throw new RpcError(ErrorCode.NotFound, `folder ${folderId}`);
        }
        await this.registry.update((d) => {
          d.folders = d.folders.filter((f) => f.id !== folderId);
        });
        this.markChanged('folders');
        return {};
      },
      'sessions.list': (p) => this.#sessionsList(p),
      'tasks.list': (p) => {
        const q = parseTasksListParams(p);
        return this.#opts.tasks ? this.#opts.tasks.list(q) : [];
      },
      'windows.list': () => this.windows(),
      'window.open': async (p) => {
        const r = await this.openWindow(p);
        const out: WindowOpenResult = { status: r.status };
        if (r.windowId !== undefined) out.windowId = r.windowId;
        if (r.slotId !== undefined) out.slotId = r.slotId;
        return out;
      },
      'editor.route': (p) => this.routeEditor(p),
      'pinned.list': () => [...this.registry.data.pinned].sort((a, b) => a.order - b.order),
      'pinned.upsert': (p) => this.#pinnedUpsert(p),
      'pinned.defaults': async () => pinnedDefaults(this.#defaults(), await this.#lang()),
      'pinned.remove': async (p) => {
        const pinnedId = reqString(p.pinnedId, 'pinnedId');
        if (!this.registry.data.pinned.some((x) => x.id === pinnedId)) {
          throw new RpcError(ErrorCode.NotFound, `pinned ${pinnedId}`);
        }
        await this.registry.update((d) => {
          d.pinned = d.pinned.filter((x) => x.id !== pinnedId);
        });
        this.markChanged('pinned');
        return {};
      },
      'autostart.get': () => {
        if (!this.#opts.autostart) throw new RpcError(ErrorCode.NotFound, 'autostart unavailable');
        return this.#opts.autostart.get();
      },
      'autostart.set': (p) => {
        if (!this.#opts.autostart) throw new RpcError(ErrorCode.NotFound, 'autostart unavailable');
        if (typeof p.enabled !== 'boolean') throw invalid('enabled must be boolean');
        return this.#opts.autostart.set(p.enabled);
      },
      'resume.runNow': async (p) => {
        const ids = Array.isArray(p.pinnedIds) ? p.pinnedIds.filter((x): x is string => typeof x === 'string') : undefined;
        // 창마다 결과 보고를 기다리면 RPC 시간 제한(30초)을 넘어요 — 사전 확인을 통과한 목록만 바로 돌려줘요
        const run = this.startResume(ids);
        run.done.then(
          (r) => this.#log.info(`resume.runNow done: started=${r.started.length} skipped=${r.skipped.length}`),
          (e) => this.#log.error(`resume.runNow failed: ${errMsg(e)}`),
        );
        return { started: await run.planned };
      },
      'window.reportResult': (p, c) => {
        const requestId = reqString(p.requestId, 'requestId');
        const r: ReportedResult = {
          requestId,
          ok: p.ok === true,
          ...(typeof p.detail === 'string' ? { detail: p.detail } : {}),
          ...(c.window ? { windowId: c.window.windowId } : {}),
        };
        this.#results.set(requestId, r);
        if (this.#results.size > 500) this.#results.delete(this.#results.keys().next().value!);
        const line = `result ${requestId} ok=${r.ok} ${r.detail ?? ''}`;
        if (r.ok) this.#log.info(line);
        else this.#log.warn(line);
        for (const cb of this.#resultListeners) cb(r);
        return {};
      },
    };
  }
}

// ---- named pipe 서버

/**
 * 파이프를 먼저 차지한 쪽이 주인(단일 인스턴스). 코어가 준비되기 전에 들어온 연결은 잠깐 들고 있다가 붙여요.
 */
export class PipeServer {
  readonly server: Server;
  #core: DaemonCore | undefined;
  #early: Socket[] = [];
  #sockets = new Set<Socket>();

  constructor() {
    this.server = createServer((socket) => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
      if (this.#core) this.#attach(socket);
      else this.#early.push(socket);
    });
  }

  /** EADDRINUSE면 그대로 reject (호출 측이 «이미 실행 중»으로 처리) */
  listen(pipeName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (e: Error) => {
        this.server.off('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(pipeName);
    });
  }

  attachCore(core: DaemonCore): void {
    this.#core = core;
    for (const s of this.#early.splice(0)) if (!s.destroyed) this.#attach(s);
  }

  #attach(socket: Socket): void {
    const peer = new RpcPeer(socketChannel(socket));
    this.#core!.attach(peer, 'pipe');
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const s of this.#sockets) s.destroy();
      this.server.close(() => resolve());
    });
  }
}
