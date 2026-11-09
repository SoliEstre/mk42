// hub UI 데이터 저장소 + 동작. DOM을 모르고 HubTransport만 알아서 가짜 전송으로 시험해요.
import {
  AGENT_ROLES,
  type AgentKind,
  type AutostartState,
  ErrorCode,
  type Folder,
  type Mk42UpdateAuto,
  type Mk42UpdateStatus,
  type PinnedDefaults,
  type PinnedSession,
  type SessionSummary,
  type SessionTasks,
  type StateTopic,
  type WindowInfo,
  type WindowOpenParams,
} from '@mark42/protocol';
import {
  describeError,
  findPinned,
  makePinnedDraft,
  movePinned,
  samePathLite,
  sessionKey,
  sortPinned,
  sortSessionTasks,
} from './model.ts';
import { t } from './i18n.ts';
import { ALL_TOPICS, TopicDebouncer, type TimerApi } from './refresh.ts';
import type { HubConnection } from './transport.ts';
import { isMk42UpdateStatus, type UpdateBusy } from './update.ts';

/** folders.clone 요청 한도 — 데몬의 git clone 한도(10분)보다 조금 길게 */
export const CLONE_REQUEST_TIMEOUT_MS = 11 * 60_000;
/** update.check·update.download — 서명 확인까지 기다려요(받기는 데몬이 이어서). 창(확장)과 같은 90초 */
export const UPDATE_REQUEST_TIMEOUT_MS = 90_000;

export interface HubData {
  folders: Folder[];
  /** folderId → 그 폴더(cwd)의 세션 */
  sessions: Map<string, SessionSummary[]>;
  sessionErrors: Map<string, string>;
  windows: WindowInfo[];
  pinned: PinnedSession[];
  /** 새 고정 세션 기본값(데몬 pinned.defaults — 판마다 달라요). 못 읽었으면 undefined(«기본값으로» 단추를 숨겨요) */
  pinnedDefaults: PinnedDefaults | undefined;
  autostart: AutostartState | undefined;
  /** 최근 세션별 백그라운드 작업(실행 중인 세션 먼저) */
  tasks: SessionTasks[];
  /** 작업 목록을 못 읽은 까닭(작업 탭에 보여요 — 알림 토스트는 띄우지 않아요) */
  tasksError: string | undefined;
  /** 한 번이라도 읽은 주제 */
  loaded: Set<StateTopic | 'autostart'>;
  /** 진행 중인 주제 */
  loading: Set<StateTopic | 'autostart'>;
  /** Mk42 자체 업데이트(update.status·update.changed). 옛 데몬·못 읽음이면 undefined — 오른쪽 위를 숨겨요 */
  update: Mk42UpdateStatus | undefined;
  /** 통합 창이 보내 놓고 기다리는 업데이트 요청(그 동안 단추를 꺼요) */
  updateBusy: UpdateBusy | undefined;
}

export interface HubStoreOptions {
  debounceMs?: number;
  timers?: TimerApi;
  onError?: (message: string) => void;
  onInfo?: (message: string) => void;
}

export type ChangeKind = StateTopic | 'autostart' | 'connection' | 'update';

export class HubStore {
  readonly data: HubData = {
    folders: [],
    sessions: new Map(),
    sessionErrors: new Map(),
    windows: [],
    pinned: [],
    pinnedDefaults: undefined,
    autostart: undefined,
    tasks: [],
    tasksError: undefined,
    loaded: new Set(),
    loading: new Set(),
    update: undefined,
    updateBusy: undefined,
  };
  #conn: HubConnection;
  #opts: HubStoreOptions;
  #debouncer: TopicDebouncer;
  #gen = new Map<string, number>();
  #listeners = new Set<(kinds: Set<ChangeKind>) => void>();
  #unsubs: (() => void)[] = [];
  /** «새 판을 받았어요»를 이미 알린 판 */
  #toldReady = new Set<string>();
  /** update.changed를 받을 때마다 +1 — 요청을 보낸 뒤 알림이 왔으면 그 응답(더 옛 상태일 수 있어요)으로 덮지 않아요 */
  #updateSeq = 0;

  constructor(conn: HubConnection, opts: HubStoreOptions = {}) {
    this.#conn = conn;
    this.#opts = opts;
    this.#debouncer = new TopicDebouncer((t) => void this.refresh(t), opts.debounceMs ?? 150, opts.timers);
  }

  get connection(): HubConnection {
    return this.#conn;
  }

  onChange(cb: (kinds: Set<ChangeKind>) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  start(): void {
    this.#unsubs.push(
      this.#conn.onNotification((method, params) => {
        if (method === 'update.changed') {
          this.#updateSeq++;
          this.#applyUpdate(params, true);
          return;
        }
        if (method !== 'state.changed') return;
        const topics = (params as { topics?: unknown }).topics;
        this.#debouncer.push(Array.isArray(topics) ? (topics as StateTopic[]) : ALL_TOPICS);
      }),
      this.#conn.onConnectionChange((connected) => {
        this.#emit(['connection']);
        if (connected) void this.refreshAll();
      }),
      this.#conn.onStatusChange(() => this.#emit(['connection'])),
    );
    if (this.#conn.connected) void this.refreshAll();
  }

  dispose(): void {
    this.#debouncer.dispose();
    for (const u of this.#unsubs.splice(0)) u();
  }

  refreshAll(): Promise<void> {
    return this.refresh(new Set(ALL_TOPICS), true);
  }

  /** 주제별로 다시 읽어요. folders가 있으면 폴더를 먼저 읽고 그 폴더들의 세션을 읽어요. */
  async refresh(topics: Set<StateTopic>, includeAutostart = false): Promise<void> {
    if (!this.#conn.connected) return;
    const jobs: Promise<void>[] = [];
    const foldersJob = topics.has('folders') ? this.#loadFolders() : Promise.resolve();
    jobs.push(foldersJob);
    if (topics.has('sessions')) jobs.push(foldersJob.then(() => this.#loadSessions()));
    if (topics.has('windows')) jobs.push(this.#loadWindows());
    if (topics.has('pinned')) jobs.push(this.#loadPinned());
    if (topics.has('tasks')) jobs.push(this.#loadTasks());
    if (includeAutostart) jobs.push(this.#loadAutostart());
    if (includeAutostart) jobs.push(this.#loadUpdate());
    if (includeAutostart && !this.data.pinnedDefaults) jobs.push(this.#loadPinnedDefaults());
    await Promise.all(jobs);
  }

  /** 작업 탭을 열 때 — 알림을 놓쳤어도 지금 것으로 */
  refreshTasks(): Promise<void> {
    return this.refresh(new Set(['tasks']));
  }

  // ---- 조회 ----

  #begin(topic: string): number {
    const g = (this.#gen.get(topic) ?? 0) + 1;
    this.#gen.set(topic, g);
    this.data.loading.add(topic as StateTopic);
    return g;
  }
  #current(topic: string, g: number): boolean {
    return this.#gen.get(topic) === g;
  }
  #end(topic: StateTopic | 'autostart', g: number, ok: boolean): void {
    if (!this.#current(topic, g)) return;
    this.data.loading.delete(topic);
    if (ok) this.data.loaded.add(topic);
    this.#emit([topic]);
  }

  async #loadFolders(): Promise<void> {
    const g = this.#begin('folders');
    try {
      const folders = await this.#conn.request('folders.list', {});
      if (!this.#current('folders', g)) return;
      this.data.folders = Array.isArray(folders) ? folders : [];
      const ids = new Set(this.data.folders.map((f) => f.id));
      for (const id of [...this.data.sessions.keys()]) if (!ids.has(id)) this.data.sessions.delete(id);
      this.#end('folders', g, true);
    } catch (e) {
      this.#fail(t('action.listFolders'), e, true);
      this.#end('folders', g, false);
    }
  }

  async #loadSessions(): Promise<void> {
    const g = this.#begin('sessions');
    const folders = [...this.data.folders];
    const results = await Promise.all(
      folders.map(async (f) => {
        try {
          const list = await this.#conn.request('sessions.list', { cwd: f.path, includeSubagents: true });
          return { f, list: Array.isArray(list) ? list : [], error: undefined as string | undefined };
        } catch (e) {
          return { f, list: undefined, error: describeError(e) };
        }
      }),
    );
    if (!this.#current('sessions', g)) return;
    for (const r of results) {
      if (r.list) {
        this.data.sessions.set(r.f.id, r.list);
        this.data.sessionErrors.delete(r.f.id);
      } else if (r.error) {
        this.data.sessionErrors.set(r.f.id, r.error);
      }
    }
    this.#end('sessions', g, true);
  }

  async #loadWindows(): Promise<void> {
    const g = this.#begin('windows');
    try {
      const w = await this.#conn.request('windows.list', {});
      if (!this.#current('windows', g)) return;
      this.data.windows = Array.isArray(w) ? w : [];
      this.#end('windows', g, true);
    } catch (e) {
      this.#fail(t('action.listWindows'), e, true);
      this.#end('windows', g, false);
    }
  }

  async #loadPinned(): Promise<void> {
    const g = this.#begin('pinned');
    try {
      const p = await this.#conn.request('pinned.list', {});
      if (!this.#current('pinned', g)) return;
      this.data.pinned = sortPinned(Array.isArray(p) ? p : []);
      this.#end('pinned', g, true);
    } catch (e) {
      this.#fail(t('action.listPinned'), e, true);
      this.#end('pinned', g, false);
    }
  }

  async #loadTasks(): Promise<void> {
    const g = this.#begin('tasks');
    try {
      const list = await this.#conn.request('tasks.list', {});
      if (!this.#current('tasks', g)) return;
      this.data.tasks = sortSessionTasks(Array.isArray(list) ? list : []);
      this.data.tasksError = undefined;
      this.#end('tasks', g, true);
    } catch (e) {
      if (!this.#current('tasks', g)) return;
      // 작업은 자주 바뀌어서 실패할 때마다 토스트를 띄우지 않고 탭 안에 적어요. 옛 데몬은 tasks.list를 몰라요.
      const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
      if (code === ErrorCode.MethodNotFound) {
        this.data.tasksError = t('tasks.oldDaemon');
      } else {
        console.error('[hub-ui] tasks.list failed', e);
        this.data.tasksError = describeError(e, t('action.listTasks'));
      }
      this.#end('tasks', g, false);
    }
  }

  async #loadAutostart(): Promise<void> {
    const g = this.#begin('autostart');
    try {
      const a = await this.#conn.request('autostart.get', {});
      if (!this.#current('autostart', g)) return;
      this.data.autostart = a;
      this.#end('autostart', g, true);
    } catch (e) {
      this.#fail(t('action.autostartStatus'), e, true);
      this.#end('autostart', g, false);
    }
  }

  /** 연결될 때 — 네트워크 없이 마지막 상태. 옛 데몬(update.* 없음)이면 숨겨요. 실패는 토스트 없이(머리 줄 한구석이라) */
  async #loadUpdate(): Promise<void> {
    try {
      const s = await this.#conn.request('update.status', {});
      if (isMk42UpdateStatus(s)) this.#applyUpdate(s, false);
      else if (this.data.update) {
        this.data.update = undefined;
        this.#emit(['update']);
      }
    } catch (e) {
      const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
      if (code !== ErrorCode.MethodNotFound) console.error('[hub-ui] update.status failed', e);
      else if (this.data.update) {
        this.data.update = undefined;
        this.#emit(['update']);
      }
    }
  }

  /** 상태 반영. 알림으로 ready가 되면 한 번 알려요(데몬의 announce는 창 하나에만 가서 통합 창은 스스로) */
  #applyUpdate(v: unknown, fromNotification: boolean): void {
    if (!isMk42UpdateStatus(v)) return;
    const { announce: _announce, ...s } = v as Mk42UpdateStatus & { announce?: boolean };
    const prev = this.data.update;
    this.data.update = s;
    if (fromNotification && s.state === 'ready' && prev?.state !== 'ready') this.#tellReady(s);
    else if (s.state === 'ready' && s.latest) this.#toldReady.add(s.latest);
    this.#emit(['update']);
  }

  #tellReady(s: Mk42UpdateStatus): void {
    if (!s.latest || this.#toldReady.has(s.latest)) return;
    this.#toldReady.add(s.latest);
    this.#opts.onInfo?.(t('update.info.ready', s.latest));
  }

  /** 옛 데몬(pinned.defaults 없음)이면 조용히 넘어가요 */
  async #loadPinnedDefaults(): Promise<void> {
    try {
      this.data.pinnedDefaults = await this.#conn.request('pinned.defaults', {});
      this.#emit(['pinned']);
    } catch {
      // 기본값으로
    }
  }

  // ---- 찾기 ----

  folderForPath(p: string): Folder | undefined {
    return this.data.folders.find((f) => samePathLite(f.path, p));
  }

  /** 모든 폴더에서 세션 찾기 (고정 세션 제목 표시용) */
  findSession(agent: AgentKind, sessionId: string): SessionSummary | undefined {
    const key = sessionKey({ agent, id: sessionId });
    for (const list of this.data.sessions.values()) {
      const s = list.find((x) => sessionKey(x) === key);
      if (s) return s;
    }
    return undefined;
  }

  isPinned(s: SessionSummary): PinnedSession | undefined {
    return findPinned(this.data.pinned, s.agent, s.id);
  }

  // ---- 동작 ----

  async openWindow(params: WindowOpenParams): Promise<void> {
    // 누르자마자 알려요 — 창이 뜨기까지 몇 초 걸려서, 눌렸는지 알 수 있게(통합 창이 누른 단추 옆 말풍선으로)
    this.#opts.onInfo?.(t('info.openingWindow'));
    try {
      const r = await this.#conn.request('window.open', params, 60_000);
      this.#opts.onInfo?.(r.status === 'focused' ? t('info.focusedWindow') : t('info.launchingWindow'));
      this.#debouncer.push(['windows']);
    } catch (e) {
      this.#fail(t('action.openWindow'), e);
    }
  }

  openNewSession(folder: Folder, agent: AgentKind): Promise<void> {
    return this.openWindow({ folderPath: folder.path, role: AGENT_ROLES[agent], newSession: true });
  }

  openSession(folder: Folder, s: SessionSummary): Promise<void> {
    return this.openWindow({ folderPath: folder.path, role: AGENT_ROLES[s.agent], sessionId: s.id });
  }

  openEditor(folder: Folder): Promise<void> {
    return this.openWindow({ folderPath: folder.path, role: 'editor' });
  }

  /** 별도 창 모드의 «폴더 등록» — 절대 경로 입력. 성공하면 true */
  async addFolder(path: string): Promise<boolean> {
    const p = path.trim().replace(/^"(.*)"$/, '$1');
    if (!p) return false;
    if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p)) {
      this.#opts.onError?.(t('error.addFolderAbsolute'));
      return false;
    }
    try {
      await this.#conn.request('folders.add', { path: p });
      this.#debouncer.push(['folders']);
      return true;
    } catch (e) {
      this.#fail(t('action.addFolder'), e);
      return false;
    }
  }

  /** git 저장소를 parentDir 아래로 클론하고 등록해요(데몬 folders.clone). 등록한 폴더, 실패하면 null */
  async cloneFolder(url: string, parentDir: string): Promise<Folder | null> {
    try {
      const folder = await this.#conn.request('folders.clone', { url, parentDir }, CLONE_REQUEST_TIMEOUT_MS);
      this.#debouncer.push(['folders']);
      return folder;
    } catch (e) {
      this.#fail(t('action.clone'), e);
      return null;
    }
  }

  async removeFolder(folderId: string): Promise<void> {
    try {
      await this.#conn.request('folders.remove', { folderId });
      this.data.folders = this.data.folders.filter((f) => f.id !== folderId);
      this.data.sessions.delete(folderId);
      this.#emit(['folders']);
      this.#debouncer.push(['folders']);
    } catch (e) {
      this.#fail(t('action.removeFolder'), e);
    }
  }

  async togglePin(folder: Folder, s: SessionSummary): Promise<void> {
    const existing = this.isPinned(s);
    try {
      if (existing) {
        await this.#conn.request('pinned.remove', { pinnedId: existing.id });
        this.data.pinned = this.data.pinned.filter((p) => p.id !== existing.id);
      } else {
        const saved = await this.#conn.request('pinned.upsert', makePinnedDraft(folder.path, s, this.data.pinned));
        this.data.pinned = sortPinned([...this.data.pinned.filter((p) => p.id !== saved.id), saved]);
      }
      this.#emit(['pinned']);
      this.#debouncer.push(['pinned']);
    } catch (e) {
      this.#fail(existing ? t('action.unpin') : t('action.pin'), e);
    }
  }

  async updatePinned(pinnedId: string, patch: Partial<Omit<PinnedSession, 'id'>>): Promise<void> {
    const cur = this.data.pinned.find((p) => p.id === pinnedId);
    if (!cur) return;
    const next: PinnedSession = { ...cur, ...patch };
    this.data.pinned = sortPinned(this.data.pinned.map((p) => (p.id === pinnedId ? next : p)));
    this.#emit(['pinned']);
    try {
      const saved = await this.#conn.request('pinned.upsert', next);
      this.data.pinned = sortPinned(this.data.pinned.map((p) => (p.id === pinnedId ? saved : p)));
      this.#emit(['pinned']);
    } catch (e) {
      this.#fail(t('action.savePinned'), e);
      this.#debouncer.push(['pinned']);
    }
  }

  /** `among`: 지금 보이는 같은 묶음의 id(화면 순서) — 그 안의 이웃과 자리를 바꿔요 */
  async movePinned(pinnedId: string, delta: -1 | 1, among?: readonly string[]): Promise<void> {
    const changed = movePinned(this.data.pinned, pinnedId, delta, among);
    if (changed.length === 0) return;
    const byId = new Map(changed.map((p) => [p.id, p]));
    this.data.pinned = sortPinned(this.data.pinned.map((p) => byId.get(p.id) ?? p));
    this.#emit(['pinned']);
    try {
      for (const p of changed) await this.#conn.request('pinned.upsert', p);
    } catch (e) {
      this.#fail(t('action.reorder'), e);
    }
    this.#debouncer.push(['pinned']);
  }

  async removePinned(pinnedId: string): Promise<void> {
    try {
      await this.#conn.request('pinned.remove', { pinnedId });
      this.data.pinned = this.data.pinned.filter((p) => p.id !== pinnedId);
      this.#emit(['pinned']);
    } catch (e) {
      this.#fail(t('action.unpin'), e);
    }
  }

  async runNow(pinnedIds?: string[]): Promise<void> {
    try {
      const r = await this.#conn.request('resume.runNow', pinnedIds ? { pinnedIds } : {}, 60_000);
      const n = Array.isArray(r.started) ? r.started.length : 0;
      this.#opts.onInfo?.(n > 0 ? t('info.resumeStarted', n) : t('info.nothingToResume'));
    } catch (e) {
      this.#fail(t('action.resumeNow'), e);
    }
  }

  async setAutostart(enabled: boolean): Promise<void> {
    try {
      const r = await this.#conn.request('autostart.set', { enabled });
      this.data.autostart = { ...(this.data.autostart ?? { method: 'taskScheduler', taskName: '' }), ...r };
      this.#emit(['autostart']);
    } catch (e) {
      this.#fail(t('action.setAutostart'), e);
      void this.#loadAutostart();
    }
  }

  // ---- Mk42 자체 업데이트(통합 창 오른쪽 위) ----

  async #updateAction(busy: UpdateBusy, action: string, run: () => Promise<void>): Promise<void> {
    if (this.data.updateBusy) return;
    this.data.updateBusy = busy;
    this.#emit(['update']);
    try {
      await run();
    } catch (e) {
      this.#fail(action, e);
    } finally {
      this.data.updateBusy = undefined;
      this.#emit(['update']);
    }
  }

  /**
   * 응답 상태를 반영해요 — 단, 요청을 보낸(seq) 뒤 update.changed가 왔으면 그게 더 새것이라 덮지 않아요
   * (웹뷰 중계는 응답을 한 차례 늦게 넘겨서, 바로 뒤의 알림이 먼저 도착할 수 있어요).
   */
  #expectStatus(v: unknown, seq: number): Mk42UpdateStatus {
    if (!isMk42UpdateStatus(v)) throw new Error(t('update.info.oldDaemon'));
    if (seq === this.#updateSeq) this.#applyUpdate(v, false);
    return v;
  }

  /** «확인» — 지금 서버를 확인해요(새 판이면 자동 받기에 따라 downloading 또는 available) */
  checkUpdate(): Promise<void> {
    const action = t('action.updateCheck');
    return this.#updateAction('check', action, async () => {
      const seq = this.#updateSeq;
      const s = this.#expectStatus(await this.#conn.request('update.check', {}, UPDATE_REQUEST_TIMEOUT_MS), seq);
      switch (s.state) {
        case 'idle':
          this.#opts.onInfo?.(t('update.info.upToDate', s.current));
          return;
        case 'available':
          this.#opts.onInfo?.(t('update.info.available', s.latest ?? '?'));
          return;
        case 'downloading':
          this.#opts.onInfo?.(t('update.info.downloading', s.latest ?? '?'));
          return;
        case 'ready':
          if (s.latest) this.#toldReady.add(s.latest);
          this.#opts.onInfo?.(t('update.info.ready', s.latest ?? '?'));
          return;
        case 'installing':
          this.#opts.onInfo?.(t('update.info.installing'));
          return;
        case 'disabled':
          this.#opts.onInfo?.(t('update.info.noChannel'));
          return;
        case 'error':
          this.#opts.onError?.(`${action}: ${s.error ?? '?'}`);
          return;
        default:
          return;
      }
    });
  }

  /** «받기» — 자동 받기가 꺼져 기다리는 새 판(또는 받기에 실패한 판)을 지금 받아요 */
  downloadUpdate(): Promise<void> {
    const action = t('action.updateDownload');
    return this.#updateAction('download', action, async () => {
      const seq = this.#updateSeq;
      const s = this.#expectStatus(await this.#conn.request('update.download', {}, UPDATE_REQUEST_TIMEOUT_MS), seq);
      if (s.state === 'error') this.#opts.onError?.(`${action}: ${s.error ?? '?'}`);
      else if (s.state === 'downloading') this.#opts.onInfo?.(t('update.info.downloading', s.latest ?? '?'));
    });
  }

  /** «설치» — 받아 둔 판을 조용히 설치해요. 설치 엔진이 데몬을 바꿔 끼우고 창은 그대로(통합 창은 다시 붙어요) */
  installUpdate(): Promise<void> {
    const action = t('action.updateInstall');
    return this.#updateAction('install', action, async () => {
      const r = await this.#conn.request('update.install', {});
      if (r?.started === true) this.#opts.onInfo?.(t('update.info.installing'));
      else this.#opts.onError?.(`${action}: ${r?.error ?? '?'}`);
    });
  }

  /** ⚙ 메뉴 — 자동 받기·자동 설치(registry.json settings.update). 누른 값을 먼저 보이고(응답까지 체크가 되돌아가 보이지 않게), 실패하면 데몬 값으로 */
  setUpdateAuto(patch: Partial<Mk42UpdateAuto>): Promise<void> {
    const action = t('action.updateSettings');
    const cur = this.data.update;
    if (cur?.auto && !this.data.updateBusy) this.data.update = { ...cur, auto: { ...cur.auto, ...patch } };
    return this.#updateAction('auto', action, async () => {
      try {
        const seq = this.#updateSeq;
        this.#expectStatus(await this.#conn.request('update.setAuto', patch, UPDATE_REQUEST_TIMEOUT_MS), seq);
      } catch (e) {
        void this.#loadUpdate();
        throw e;
      }
    });
  }

  #fail(action: string, e: unknown, quietWhenDisconnected = false): void {
    console.error(`[hub-ui] ${action} failed`, e);
    // 조회가 연결 끊김으로 실패한 건 헤더 상태로 이미 보여서 따로 알리지 않아요.
    if (quietWhenDisconnected && !this.#conn.connected) return;
    this.#opts.onError?.(describeError(e, action));
  }

  #emit(kinds: ChangeKind[]): void {
    const set = new Set(kinds);
    for (const l of [...this.#listeners]) l(set);
  }
}
