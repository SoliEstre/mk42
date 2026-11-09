// hub UI 화면. 상태는 HubStore가 들고, 여기서는 그리기와 입력 연결만 해요.
import type {
  AgentKind,
  BackgroundAgent,
  BackgroundWorkflow,
  ClaudeSettings,
  CodexSettings,
  Folder,
  PinnedSession,
  SessionSummary,
  SessionTasks,
  TokenUsage,
} from '@mark42/protocol';
import { AGENT_ROLES, parseCloneUrl, PINNED_GROUP_MAX } from '@mark42/protocol';
import { ANCHOR_TTL_MS, anchorElement, Bubble, type Anchor } from './bubble.ts';
import { clear, confirmButton, el } from './dom.ts';
import { canPickFolder, isAbsoluteWinPath, looksLikeRepoAddress, pickFolder, pushRecentFolder } from './host-bridge.ts';
import type { HubUiCommand } from './host-messages.ts';
import { t, t as tr } from './i18n.ts';
import {
  AGENT_LABEL,
  AGENT_ORDER,
  CLAUDE_EFFORTS,
  HUB_TABS,
  adjacentTab,
  buildSessionTree,
  chipsFor,
  currentPhaseIndex,
  cwdBasename,
  filterTree,
  folderForCwd,
  folderLabel,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatTokens,
  groupByAgent,
  groupPinned,
  type HubTab,
  isClaudeEffort,
  isOpen,
  isPinnedGroupBy,
  liveStartMs,
  type OpenState,
  parseHubTab,
  parseOpenState,
  type Progress,
  runningTotal,
  sessionProgress,
  sortByActivity,
  sortWorkflowAgents,
  taskElapsedMs,
  taskSessionKey,
  taskSessionTitle,
  taskStatusView,
  type TimedTask,
  toggleOpen,
  tokenTooltip,
  workflowKey,
  workflowName,
  PINNED_GROUP_BY,
  pinnedGroupByLabel,
  pinnedGroupNames,
  pinnedMatches,
  type PinnedGroupBy,
  type PinnedView,
  sessionKey,
  sessionTitle,
  statusView,
  windowCountTooltip,
  windowsByFolder,
  type SessionNode,
  type WindowCount,
} from './model.ts';
import type { ChangeKind, HubStore } from './store.ts';
import { formatBytes, updateView } from './update.ts';

export interface UiPrefs {
  query: string;
  expanded: string[];
  collapsedFolders: string[];
  showAll: string[];
  /** «폴더 등록» 칸 드롭다운: 최근 등록한 폴더·클론 위치(최근 것부터) */
  recentFolders?: string[];
  /** 보고 있던 탭 */
  tab?: HubTab;
  /** 고정 세션 검색·묶어 보기·접은 묶음 */
  pinnedQuery?: string;
  pinnedGroupBy?: PinnedGroupBy;
  collapsedPinnedGroups?: string[];
  /** 작업 탭에서 직접 펼친·접은 세션·워크플로우(고른 적 없으면 실행 중일 때 펼쳐요) */
  openTasks?: string[];
  closedTasks?: string[];
}

export type { HubTab };
export interface PrefsStore {
  load(): Partial<UiPrefs> | undefined;
  save(p: UiPrefs): void;
}

const ROOT_LIMIT = 10;

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export class HubApp {
  #root: HTMLElement;
  #store: HubStore;
  #prefs: PrefsStore;
  #query = '';
  #expanded = new Set<string>();
  #collapsedFolders = new Set<string>();
  #showAll = new Set<string>();
  #recentFolders: string[] = [];
  #tab: HubTab = 'pinned';
  #pinnedQuery = '';
  #pinnedGroupBy: PinnedGroupBy = 'none';
  #collapsedPinnedGroups = new Set<string>();
  #taskOpen: OpenState = { open: new Set(), closed: new Set() };
  /** 펼쳐 둔 결과 요약(agent id) — 다시 그려도 열린 채로. 저장하지는 않아요 */
  #openSummaries = new Set<string>();

  #tabButtons = new Map<HubTab, HTMLButtonElement>();
  #tabPanels = new Map<HubTab, HTMLElement>();
  #folderTabCount!: HTMLElement;
  #tasksTabCount!: HTMLElement;
  #tasksList!: HTMLElement;
  #pinnedFilter!: HTMLInputElement;
  #pinnedFilterCount!: HTMLElement;
  #pinnedGroupNames!: HTMLDataListElement;
  #connEl!: HTMLElement;
  #connText!: HTMLElement;
  #connDetail!: HTMLElement;
  #reconnectBtn!: HTMLButtonElement;
  #toastEl!: HTMLElement;
  #searchInput!: HTMLInputElement;
  #searchCount!: HTMLElement;
  #pinnedList!: HTMLElement;
  #pinnedCount!: HTMLElement;
  #autostartInput!: HTMLInputElement;
  #autostartLabel!: HTMLElement;
  /** 머리 줄 오른쪽 «Mk42 업데이트»(update.ts) */
  #updateEl!: HTMLElement;
  #updatePill!: HTMLElement;
  #updateText!: HTMLElement;
  #updateProgress!: HTMLProgressElement;
  #updateCheckBtn!: HTMLButtonElement;
  #updateDownloadBtn!: HTMLButtonElement;
  #updateInstallBtn!: HTMLButtonElement;
  #updateMenu!: HTMLDetailsElement;
  #updateAutoDownload!: HTMLInputElement;
  #updateAutoInstall!: HTMLInputElement;
  #folderList!: HTMLElement;
  #pinnedDirty = false;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** 방금 사용자가 누른 곳 — 그 뒤 온 메시지(창 열기 결과 등)를 그 옆 말풍선으로 */
  #anchor: Anchor | undefined;
  #bubble = new Bubble();
  /**
   * 마우스(포인터)를 누르고 있는 동안은 목록을 다시 그리지 않아요 — 입력칸 A에서 B를 누르면 A의 변경 저장이 그 순간 목록을 다시 그려
   * 막 누른 B가 새 요소로 바뀌고 초점이 풀렸어요(2026-11-02). 손을 떼면(초점이 B로 옮겨진 뒤) 미룬 것을 그려요.
   */
  #pointerHeldAt = 0;
  #heldRenders = new Set<'pinned' | 'folders' | 'tasks'>();
  #clock: ReturnType<typeof setInterval> | undefined;
  /** 작업 탭이 보이고 실행 중인 작업이 있을 때만 도는 1초 시계(걸린 시간만 고쳐 써요) */
  #taskClock: ReturnType<typeof setInterval> | undefined;

  constructor(root: HTMLElement, store: HubStore, prefs: PrefsStore) {
    this.#root = root;
    this.#store = store;
    this.#prefs = prefs;
    const p = prefs.load() ?? {};
    this.#query = typeof p.query === 'string' ? p.query : '';
    this.#expanded = new Set(strArr(p.expanded));
    this.#collapsedFolders = new Set(strArr(p.collapsedFolders));
    this.#showAll = new Set(strArr(p.showAll));
    this.#recentFolders = strArr(p.recentFolders).slice(0, 10);
    this.#tab = parseHubTab(p.tab);
    this.#pinnedQuery = typeof p.pinnedQuery === 'string' ? p.pinnedQuery : '';
    this.#pinnedGroupBy = isPinnedGroupBy(p.pinnedGroupBy) ? p.pinnedGroupBy : 'none';
    this.#collapsedPinnedGroups = new Set(strArr(p.collapsedPinnedGroups));
    this.#taskOpen = parseOpenState(p.openTasks, p.closedTasks);
  }

  get #webview(): boolean {
    return this.#store.connection.kind === 'webview';
  }

  mount(): void {
    clear(this.#root);
    this.#root.append(this.#buildShell(), this.#bubble.element);
    this.#watchPointer();
    this.#store.onChange((kinds) => this.#onChange(kinds));
    this.#renderConnection();
    this.#renderAutostart();
    this.#renderUpdate();
    this.#renderPinned();
    this.#renderFolders();
    this.#renderTasks();
    // 상대 시간 갱신(업데이트의 «마지막 확인»도)
    this.#clock = setInterval(() => {
      this.#renderFolders();
      this.#renderUpdate();
    }, 60_000);
  }

  dispose(): void {
    if (this.#clock) clearInterval(this.#clock);
    if (this.#taskClock) clearInterval(this.#taskClock);
    this.#taskClock = undefined;
  }

  toast(message: string, kind: 'error' | 'info' = 'info'): void {
    // 방금 누른 단추가 있으면 그 옆 말풍선으로(스크롤해도 따라가요), 아니면 위쪽 알림(화면에 고정)
    const a = this.#anchor;
    if (a && Date.now() - a.at <= ANCHOR_TTL_MS) {
      this.#toastEl.hidden = true;
      this.#bubble.show(a, message, kind);
      return;
    }
    if (this.#toastTimer) clearTimeout(this.#toastTimer);
    this.#toastEl.textContent = message;
    this.#toastEl.dataset.kind = kind;
    this.#toastEl.hidden = false;
    this.#toastTimer = setTimeout(() => {
      this.#toastEl.hidden = true;
    }, kind === 'error' ? 8000 : 3500);
  }

  /** 누른 곳 기록 + 누르고 있는 동안 다시 그리기 미루기 */
  #watchPointer(): void {
    document.addEventListener(
      'pointerdown',
      (e) => {
        const target = anchorElement(e.target);
        // 단추·링크를 누를 때만 말풍선 자리로 — 입력칸·빈 곳을 누른 뒤 온 다른 메시지는 위쪽 알림으로
        if (target) {
          const r = target.getBoundingClientRect();
          this.#anchor = {
            el: target,
            key: target.dataset.focusKey,
            rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
            x: e.clientX,
            y: e.clientY,
            at: Date.now(),
          };
        }
        this.#pointerHeldAt = Date.now();
      },
      true,
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const target = anchorElement(e.target);
        if (!target) return;
        const r = target.getBoundingClientRect();
        this.#anchor = {
          el: target,
          key: target.dataset.focusKey,
          rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
          x: (r.left + r.right) / 2,
          y: r.top,
          at: Date.now(),
        };
      },
      true,
    );
    const release = () => {
      if (!this.#pointerHeldAt) return;
      this.#pointerHeldAt = 0;
      // 초점이 새 입력칸으로 옮겨진 뒤에 그려요
      this.#scheduleFlush();
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('blur', release);
  }

  /** 누르고 있는 중이면 미뤄 두고 true(창 밖에서 떼어 pointerup을 못 받는 경우를 생각해 1.5초 넘게 누르고 있으면 그냥 그려요) */
  #holdRender(region: 'pinned' | 'folders' | 'tasks'): boolean {
    if (!this.#pointerHeldAt || Date.now() - this.#pointerHeldAt > 1500) return false;
    this.#heldRenders.add(region);
    return true;
  }

  #flushHeldRenders(): void {
    // 아직 누르고 있으면 손을 뗄 때 다시
    if (this.#pointerHeldAt && Date.now() - this.#pointerHeldAt <= 1500) return;
    const regions = [...this.#heldRenders];
    this.#heldRenders.clear();
    for (const r of regions) {
      if (r === 'pinned') this.#renderPinned();
      else if (r === 'folders') this.#renderFolders();
      else this.#renderTasks();
    }
  }

  #savePrefs(): void {
    try {
      this.#prefs.save({
        query: this.#query,
        expanded: [...this.#expanded],
        collapsedFolders: [...this.#collapsedFolders],
        showAll: [...this.#showAll],
        recentFolders: this.#recentFolders,
        tab: this.#tab,
        pinnedQuery: this.#pinnedQuery,
        pinnedGroupBy: this.#pinnedGroupBy,
        collapsedPinnedGroups: [...this.#collapsedPinnedGroups],
        openTasks: [...this.#taskOpen.open],
        closedTasks: [...this.#taskOpen.closed],
      });
    } catch {
      // 저장 못 해도 화면은 그대로
    }
  }

  #onChange(kinds: Set<ChangeKind>): void {
    if (kinds.has('update') || kinds.has('connection')) this.#renderUpdate();
    if (kinds.has('connection')) {
      this.#renderConnection();
      // 아직 못 읽은 목록의 안내 문구가 연결 상태를 따라가요.
      if (!this.#store.data.loaded.has('pinned')) this.#renderPinned();
      if (!this.#store.data.loaded.has('folders')) this.#renderFolders();
      if (!this.#store.data.loaded.has('tasks')) this.#renderTasks();
    }
    if (kinds.has('autostart')) this.#renderAutostart();
    // 데이터가 바뀌어 다시 그리는 건 다음 차례에 — 입력칸의 변경 저장(change)은 초점이 옮겨 가는 도중에 와서, 바로 그리면 옮겨 갈
    // 입력칸(클릭·Tab·터치)이 새 요소로 바뀌어 초점이 풀려요(2026-11-02). 다음 차례면 초점이 이미 내려앉아 있어 그 칸을 지켜요.
    if (kinds.has('pinned') || kinds.has('sessions') || kinds.has('folders')) this.#heldRenders.add('pinned');
    if (kinds.has('folders') || kinds.has('sessions') || kinds.has('windows') || kinds.has('pinned')) this.#heldRenders.add('folders');
    // 폴더 이름이 작업 세션 머리에 쓰여서 folders도 봐요.
    if (kinds.has('tasks') || kinds.has('folders')) this.#heldRenders.add('tasks');
    this.#scheduleFlush();
  }

  #flushQueued = false;

  #scheduleFlush(): void {
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    setTimeout(() => {
      this.#flushQueued = false;
      this.#flushHeldRenders();
    }, 0);
  }

  // ---- 골격 ----

  #buildShell(): HTMLElement {
    const conn = this.#store.connection;
    this.#connText = el('span', { cls: 'conn-text' });
    this.#connDetail = el('span', { cls: 'conn-detail muted small' });
    this.#reconnectBtn = el('button', {
      cls: 'btn small',
      attrs: { type: 'button', hidden: true },
      text: t('conn.reconnectNow'),
      on: { click: () => conn.reconnectNow?.() },
    });
    this.#connEl = el('div', { cls: 'conn', attrs: { role: 'status' } }, el('span', { cls: 'dot' }), this.#connText);

    const toolbar = this.#webview
      ? el(
          'div',
          { cls: 'toolbar' },
          this.#cmdButton(t('toolbar.reloadWindow'), 'mark42.reloadWindow'),
          this.#cmdButton(t('toolbar.restartExtensionHost'), 'mark42.restartExtensionHost'),
          this.#cmdButton(t('toolbar.theme'), 'mark42.selectTheme'),
        )
      : null;

    this.#toastEl = el('div', { cls: 'toast', attrs: { role: 'alert', hidden: true } });

    this.#searchInput = el('input', {
      cls: 'search',
      attrs: {
        type: 'search',
        placeholder: t('folders.searchPlaceholder'),
        'aria-label': t('folders.searchLabel'),
        value: this.#query,
      },
      on: {
        input: () => {
          this.#query = this.#searchInput.value;
          this.#savePrefs();
          this.#renderFolders();
        },
        keydown: (ev) => {
          if (ev.key === 'Escape' && this.#searchInput.value) {
            this.#searchInput.value = '';
            this.#query = '';
            this.#savePrefs();
            this.#renderFolders();
          }
        },
      },
    });
    this.#searchCount = el('span', { cls: 'search-count muted' });

    this.#autostartInput = el('input', {
      attrs: { type: 'checkbox', disabled: true },
      on: { change: () => void this.#store.setAutostart(this.#autostartInput.checked) },
    });
    this.#autostartLabel = el('span', { text: t('pinned.autostart') });
    this.#pinnedCount = el('span', { cls: 'count muted' });
    this.#pinnedList = el('ol', {
      cls: 'pinned-list',
      on: {
        focusout: (ev) => {
          // 편집이 끝나면(포커스가 목록 밖으로 나가면) 미뤄 둔 다시 그리기를 해요.
          const next = ev.relatedTarget;
          if (next instanceof Node && this.#pinnedList.contains(next)) return;
          setTimeout(() => {
            if (this.#pinnedDirty && !this.#pinnedList.contains(document.activeElement)) this.#renderPinned();
          }, 0);
        },
      },
    });

    this.#folderList = el('div', { cls: 'folder-list' });

    // 고정 세션 탭의 검색·묶어 보기
    this.#pinnedFilter = el('input', {
      cls: 'search',
      attrs: {
        type: 'search',
        placeholder: t('pinned.searchPlaceholder'),
        'aria-label': t('pinned.searchLabel'),
        value: this.#pinnedQuery,
      },
      on: {
        input: () => {
          this.#pinnedQuery = this.#pinnedFilter.value;
          this.#savePrefs();
          this.#renderPinned();
        },
        keydown: (ev) => {
          if (ev.key === 'Escape' && this.#pinnedFilter.value) {
            this.#pinnedFilter.value = '';
            this.#pinnedQuery = '';
            this.#savePrefs();
            this.#renderPinned();
          }
        },
      },
    });
    this.#pinnedFilterCount = el('span', { cls: 'search-count muted' });
    const groupBy = el(
      'select',
      {
        attrs: { 'aria-label': t('pinned.groupBy'), title: t('pinned.groupBy'), value: this.#pinnedGroupBy },
        on: {
          change: () => {
            if (isPinnedGroupBy(groupBy.value)) this.#pinnedGroupBy = groupBy.value;
            this.#savePrefs();
            this.#renderPinned();
          },
        },
      },
      ...PINNED_GROUP_BY.map((g) => el('option', { attrs: { value: g }, text: pinnedGroupByLabel(g) })),
    );
    this.#pinnedGroupNames = el('datalist', { attrs: { id: 'm42-pinned-groups' } });
    this.#folderTabCount = el('span', { cls: 'count muted' });

    const pinnedPanel = el(
      'section',
      { cls: 'section pinned-section', attrs: { role: 'tabpanel', id: 'tab-pinned', 'aria-labelledby': 'tabbtn-pinned' } },
      el(
        'div',
        { cls: 'section-head' },
        el('div', { cls: 'searchbar inline' }, this.#pinnedFilter, this.#pinnedFilterCount),
        el('label', { cls: 'check' }, `${t('pinned.groupBy')} `, groupBy),
        el('label', { cls: 'check' }, this.#autostartInput, this.#autostartLabel),
        el('button', {
          cls: 'btn',
          attrs: { type: 'button', title: t('pinned.resumeAllTitle') },
          text: t('pinned.resumeAll'),
          on: { click: () => void this.#store.runNow() },
        }),
      ),
      this.#pinnedGroupNames,
      this.#pinnedList,
    );
    const foldersPanel = el(
      'section',
      { cls: 'section folders-section', attrs: { role: 'tabpanel', id: 'tab-folders', 'aria-labelledby': 'tabbtn-folders' } },
      el('div', { cls: 'searchbar' }, this.#searchInput, this.#searchCount),
      el('div', { cls: 'section-head' }, this.#buildAddFolder()),
      this.#folderList,
    );
    this.#tasksTabCount = el('span', { cls: 'count tab-running' });
    this.#tasksList = el('div', { cls: 'task-list' });
    // 결과 요약을 펼친 채로 두려고 기억해요(toggle은 거품이 안 일어서 capture로 받아요).
    this.#tasksList.addEventListener(
      'toggle',
      (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLDetailsElement) || !t.dataset.summaryKey) return;
        if (t.open) this.#openSummaries.add(t.dataset.summaryKey);
        else this.#openSummaries.delete(t.dataset.summaryKey);
      },
      true,
    );
    const tasksPanel = el(
      'section',
      { cls: 'section tasks-section', attrs: { role: 'tabpanel', id: 'tab-tasks', 'aria-labelledby': 'tabbtn-tasks' } },
      el(
        'div',
        { cls: 'section-head' },
        el('span', { cls: 'muted small tasks-hint', text: t('tasks.hint') }),
        el('button', {
          cls: 'btn small',
          attrs: { type: 'button', title: t('tasks.refreshTitle') },
          text: t('tasks.refresh'),
          on: { click: () => void this.#store.refreshTasks() },
        }),
      ),
      this.#tasksList,
    );
    this.#tabPanels.set('pinned', pinnedPanel);
    this.#tabPanels.set('folders', foldersPanel);
    this.#tabPanels.set('tasks', tasksPanel);
    const tabButton = (tab: HubTab, label: string, count: HTMLElement) => {
      const b = el(
        'button',
        {
          cls: 'tab',
          attrs: { type: 'button', role: 'tab', id: `tabbtn-${tab}`, 'aria-controls': `tab-${tab}` },
          on: { click: () => this.#selectTab(tab) },
        },
        label,
        ' ',
        count,
      );
      this.#tabButtons.set(tab, b);
      return b;
    };
    const tabbar = el(
      'div',
      {
        cls: 'tabbar',
        attrs: { role: 'tablist', 'aria-label': t('tabs.label') },
        on: {
          keydown: (ev) => {
            const next =
              ev.key === 'ArrowRight'
                ? adjacentTab(this.#tab, 1)
                : ev.key === 'ArrowLeft'
                  ? adjacentTab(this.#tab, -1)
                  : ev.key === 'Home'
                    ? HUB_TABS[0]
                    : ev.key === 'End'
                      ? HUB_TABS[HUB_TABS.length - 1]
                      : undefined;
            if (!next) return;
            ev.preventDefault();
            this.#selectTab(next);
            this.#tabButtons.get(this.#tab)?.focus();
          },
        },
      },
      tabButton('pinned', t('tabs.pinned'), this.#pinnedCount),
      tabButton('folders', t('tabs.folders'), this.#folderTabCount),
      tabButton('tasks', t('tabs.tasks'), this.#tasksTabCount),
    );
    this.#applyTab();

    return el(
      'div',
      { cls: 'hub' },
      el(
        'header',
        { cls: 'topbar' },
        el('div', { cls: 'brand' }, el('strong', { text: 'Mk42' }), el('span', { cls: 'muted', text: t('app.brandSub') })),
        el('div', { cls: 'conn-wrap' }, this.#connEl, this.#connDetail, this.#reconnectBtn),
        this.#buildUpdate(),
        toolbar,
      ),
      this.#toastEl,
      tabbar,
      pinnedPanel,
      foldersPanel,
      tasksPanel,
    );
  }

  /** 머리 줄 오른쪽: 판·상태(진행 막대), [확인]·[받기]·[설치(두 번 눌러 확정)], ⚙ 자동 받기·자동 설치 */
  #buildUpdate(): HTMLElement {
    const store = this.#store;
    this.#updateText = el('span', { cls: 'update-text' });
    this.#updateProgress = el('progress', { cls: 'update-progress', attrs: { max: 1, value: 0, hidden: true } });
    this.#updatePill = el(
      'span',
      { cls: 'update-pill', attrs: { role: 'status', 'aria-live': 'polite' } },
      el('span', { cls: 'dot' }),
      this.#updateText,
      this.#updateProgress,
    );
    this.#updateCheckBtn = el('button', {
      cls: 'btn small',
      attrs: { type: 'button', title: t('update.btn.checkTitle') },
      text: t('update.btn.check'),
      on: { click: () => void store.checkUpdate() },
    });
    this.#updateDownloadBtn = el('button', {
      cls: 'btn small primary',
      attrs: { type: 'button', hidden: true },
      text: t('update.btn.download'),
      on: { click: () => void store.downloadUpdate() },
    });
    this.#updateInstallBtn = confirmButton(t('update.btn.install'), t('update.btn.installConfirm'), () => void store.installUpdate(), 'small primary');
    this.#updateInstallBtn.hidden = true;
    this.#updateAutoDownload = el('input', {
      attrs: { type: 'checkbox' },
      on: { change: () => void store.setUpdateAuto({ download: this.#updateAutoDownload.checked }) },
    });
    this.#updateAutoInstall = el('input', {
      attrs: { type: 'checkbox' },
      on: { change: () => void store.setUpdateAuto({ install: this.#updateAutoInstall.checked }) },
    });
    const summary = el('summary', {
      cls: 'btn small icon',
      attrs: { title: t('update.menu.label'), 'aria-label': t('update.menu.label') },
      text: '⚙',
    });
    this.#updateMenu = el(
      'details',
      { cls: 'update-menu' },
      summary,
      el(
        'div',
        { cls: 'update-menu-panel', attrs: { role: 'group', 'aria-label': t('update.menu.label') } },
        el('label', { cls: 'check' }, this.#updateAutoDownload, el('span', { text: t('update.menu.autoDownload') })),
        el('label', { cls: 'check' }, this.#updateAutoInstall, el('span', { text: t('update.menu.autoInstall') })),
        el('p', { cls: 'muted small', text: t('update.menu.hint') }),
      ),
    );
    // 메뉴 바깥을 누르거나 Esc면 닫아요
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (this.#updateMenu.open && e.target instanceof Node && !this.#updateMenu.contains(e.target)) this.#updateMenu.open = false;
      },
      true,
    );
    this.#updateMenu.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.#updateMenu.open) return;
      this.#updateMenu.open = false;
      summary.focus();
    });
    this.#updateEl = el(
      'div',
      { cls: 'update', attrs: { hidden: true } },
      this.#updatePill,
      this.#updateCheckBtn,
      this.#updateDownloadBtn,
      this.#updateInstallBtn,
      this.#updateMenu,
    );
    return this.#updateEl;
  }

  #renderUpdate(): void {
    const s = this.#store.data.update;
    // 옛 데몬(update.* 없음)·아직 못 읽음이면 숨겨요
    this.#updateEl.hidden = !s;
    if (!s) return;
    const connected = this.#store.connection.connected;
    const v = updateView(s, this.#store.data.updateBusy);
    // 보일지는 기다리는 요청과 상관없이(누르는 동안 단추가 사라지지 않게), 켤지는 기다리는 요청·연결까지
    const shown = updateView(s);
    this.#updateEl.dataset.tone = v.tone;
    this.#updateText.textContent = v.label;
    this.#updatePill.title = v.title;
    this.#updateProgress.hidden = v.progress === undefined;
    if (v.progress !== undefined) this.#updateProgress.value = v.progress;
    this.#updateCheckBtn.hidden = s.state === 'disabled';
    this.#updateCheckBtn.disabled = !connected || !v.canCheck;
    this.#updateDownloadBtn.hidden = !shown.canDownload;
    this.#updateDownloadBtn.disabled = !connected || !v.canDownload;
    this.#updateDownloadBtn.title = t('update.btn.downloadTitle', s.latest ?? '?', formatBytes(s.size) || '?');
    this.#updateInstallBtn.hidden = !shown.canInstall;
    this.#updateInstallBtn.disabled = !connected || !v.canInstall;
    this.#updateInstallBtn.title = t('update.btn.installTitle', s.latest ?? '?');
    this.#updateMenu.hidden = !v.auto;
    if (!v.auto) this.#updateMenu.open = false;
    const menuOff = !connected || this.#store.data.updateBusy !== undefined;
    this.#updateAutoDownload.checked = v.auto?.download ?? true;
    this.#updateAutoInstall.checked = v.auto?.install ?? false;
    this.#updateAutoDownload.disabled = menuOff;
    this.#updateAutoInstall.disabled = menuOff;
  }

  #selectTab(tab: HubTab): void {
    if (this.#tab === tab) return;
    this.#tab = tab;
    this.#savePrefs();
    this.#applyTab();
    // 작업 탭을 열면 알림을 놓쳤어도 지금 것으로 다시 읽어요.
    if (tab === 'tasks') void this.#store.refreshTasks();
    this.#syncTaskClock();
  }

  #applyTab(): void {
    for (const [tab, b] of this.#tabButtons) {
      const on = tab === this.#tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('active', on);
    }
    for (const [tab, panel] of this.#tabPanels) panel.hidden = tab !== this.#tab;
  }

  #cmdButton(label: string, command: HubUiCommand): HTMLButtonElement {
    return el('button', {
      cls: 'btn',
      attrs: { type: 'button' },
      text: label,
      on: { click: () => this.#store.connection.hostNotify?.('ui.command', { command }) },
    });
  }

  #buildAddFolder(): HTMLElement {
    const conn = this.#store.connection;
    if (this.#webview) {
      return el('button', {
        cls: 'btn primary',
        attrs: { type: 'button' },
        text: t('folders.add'),
        on: { click: () => conn.hostNotify?.('ui.addFolder', {}) },
      });
    }
    // 별도 창: 경로(최근 폴더 드롭다운) 또는 git 저장소 주소 → 등록 / 클론 후 등록. 폴더 선택은 Mk42 통합 창 exe 안에서만.
    const recent = el('datalist', { attrs: { id: 'm42-recent-folders' } });
    const fillRecent = () => {
      clear(recent);
      for (const r of this.#recentFolders) recent.append(el('option', { attrs: { value: r } }));
    };
    fillRecent();
    const input = el('input', {
      cls: 'path-input',
      attrs: {
        type: 'text',
        list: 'm42-recent-folders',
        placeholder: t('folders.pathPlaceholder'),
        'aria-label': t('folders.pathLabel'),
        spellcheck: 'false',
        autocomplete: 'off',
      },
    });
    const picker = canPickFolder();
    const buttons: HTMLButtonElement[] = [];
    let busy = false;
    const setBusy = (b: boolean) => {
      busy = b;
      input.disabled = b;
      for (const x of buttons) x.disabled = b;
    };
    const remember = (path: string) => {
      this.#recentFolders = pushRecentFolder(this.#recentFolders, path);
      fillRecent();
      this.#savePrefs();
    };
    const register = async (path: string) => {
      if (await this.#store.addFolder(path)) {
        remember(path.trim().replace(/^"(.*)"$/, '$1'));
        input.value = '';
      }
    };
    // git 주소: 클론할 위치(그 아래에 저장소 이름 폴더가 생겨요)를 골라 클론하고 등록
    const clone = async (url: string, name: string) => {
      if (!picker) {
        this.toast(t('clone.needPicker'), 'error');
        return;
      }
      const parent = await pickFolder({ title: t('clone.pickTitle', name), initial: this.#recentFolders[0] });
      if (!parent) return;
      setBusy(true);
      this.toast(t('clone.cloning', name));
      try {
        const folder = await this.#store.cloneFolder(url, parent);
        if (folder) {
          remember(parent);
          input.value = '';
          this.toast(t('clone.done', folder.path));
        }
      } finally {
        setBusy(false);
      }
    };
    // 칸의 글이 저장소 주소면 클론(true), 주소처럼 생겼지만 못 쓰면 알리고 멈춤(true), 아니면 false — 두 단추가 같은 판단을 써요
    const handledAsRepo = (text: string): boolean => {
      const git = parseCloneUrl(text);
      if (git) {
        void clone(git.url, git.name);
        return true;
      }
      if (looksLikeRepoAddress(text)) {
        this.toast(t('clone.badUrl'), 'error');
        return true;
      }
      return false;
    };
    const submit = async () => {
      if (busy || handledAsRepo(input.value)) return;
      return register(input.value);
    };
    const addBtn = el('button', { cls: 'btn primary', attrs: { type: 'submit' }, text: t('folders.add') });
    buttons.push(addBtn);
    const pickBtn = picker
      ? el('button', {
          cls: 'btn',
          attrs: { type: 'button', title: t('folders.pickTitle') },
          text: t('folders.pick'),
          on: {
            click: () => {
              if (busy || handledAsRepo(input.value)) return;
              const typed = input.value.trim().replace(/^"(.*)"$/, '$1');
              void pickFolder({ title: t('folders.pickDialogTitle'), initial: isAbsoluteWinPath(typed) ? typed : this.#recentFolders[0] }).then(
                async (path) => {
                  if (!path) return;
                  setBusy(true);
                  try {
                    await register(path);
                  } finally {
                    setBusy(false);
                  }
                },
              );
            },
          },
        })
      : null;
    if (pickBtn) buttons.push(pickBtn);
    return el(
      'form',
      {
        cls: 'add-folder',
        on: {
          submit: (ev) => {
            ev.preventDefault();
            void submit();
          },
        },
      },
      input,
      recent,
      addBtn,
      pickBtn,
    );
  }

  // ---- 연결 ----

  #renderConnection(): void {
    const conn = this.#store.connection;
    this.#connEl.dataset.status = conn.status;
    const short =
      conn.status === 'connected'
        ? t('conn.connected')
        : conn.status === 'connecting'
          ? t('conn.connecting')
          : conn.status === 'authFailed'
            ? t('conn.authFailed')
            : conn.status === 'superseded'
              ? t('conn.superseded')
              : t('conn.disconnected');
    this.#connText.textContent = short;
    this.#connDetail.textContent = conn.status === 'connected' ? '' : conn.statusDetail;
    this.#connEl.title = conn.statusDetail;
    this.#reconnectBtn.hidden = !(conn.reconnectNow && conn.status === 'disconnected');
    this.#root.classList.toggle('offline', !conn.connected);
  }

  #loadingText(): string {
    return this.#store.connection.connected ? t('loading.connected') : t('loading.waiting');
  }

  #renderAutostart(): void {
    const a = this.#store.data.autostart;
    this.#autostartInput.disabled = !a;
    this.#autostartInput.checked = !!a?.enabled;
    this.#autostartLabel.title = a?.taskName ? t('pinned.autostartTask', a.taskName) : '';
  }

  // ---- 고정 세션 ----

  #renderPinned(): void {
    if (this.#holdRender('pinned')) return;
    const active = document.activeElement;
    // 글을 고치는 중(입력칸·여러 줄·고르기)일 때만 미뤄요 — 단추(접기·↑↓)는 다시 그린 뒤 같은 단추로 초점을 돌려줘요
    if (active instanceof HTMLElement && this.#pinnedList.contains(active) && active.matches('input, textarea, select')) {
      this.#pinnedDirty = true;
      return;
    }
    const focusKey = active instanceof HTMLElement && this.#pinnedList.contains(active) ? active.dataset.focusKey : undefined;
    this.#pinnedDirty = false;
    this.#renderPinnedNow();
    if (focusKey) {
      for (const b of this.#pinnedList.querySelectorAll<HTMLElement>('[data-focus-key]')) {
        if (b.dataset.focusKey === focusKey) {
          b.focus();
          break;
        }
      }
    }
  }

  #renderPinnedNow(): void {
    const list = this.#store.data.pinned;
    this.#pinnedCount.textContent = list.length ? String(list.length) : '';
    clear(this.#pinnedList);
    if (list.length === 0) {
      this.#pinnedFilterCount.textContent = '';
      const loaded = this.#store.data.loaded.has('pinned');
      this.#pinnedList.append(
        el('li', {
          cls: 'empty muted',
          text: loaded ? t('pinned.empty') : this.#loadingText(),
        }),
      );
      return;
    }
    // 내 그룹 이름 추천(그룹 칸)
    clear(this.#pinnedGroupNames);
    for (const g of pinnedGroupNames(list)) this.#pinnedGroupNames.append(el('option', { attrs: { value: g } }));

    const views: PinnedView[] = list.map((p) => {
      const s = this.#store.findSession(p.agent, p.sessionId);
      const folder = this.#store.folderForPath(p.folderPath);
      return { pinned: p, title: s ? sessionTitle(s) : p.label?.trim() || p.sessionId, folderName: folder ? folderLabel(folder) : p.folderPath };
    });
    const query = this.#pinnedQuery.trim();
    const shown = views.filter((v) => pinnedMatches(v, query));
    this.#pinnedFilterCount.textContent = query ? `${shown.length} / ${views.length}` : '';
    if (shown.length === 0) {
      this.#pinnedList.append(el('li', { cls: 'empty muted', text: t('pinned.noMatch') }));
      return;
    }
    const groups = groupPinned(shown, this.#pinnedGroupBy);
    if (this.#pinnedGroupBy === 'none') {
      const among = shown.map((v) => v.pinned.id);
      shown.forEach((v, i) => this.#pinnedList.append(this.#pinnedRow(v, i, among)));
      return;
    }
    for (const g of groups) {
      const among = g.items.map((v) => v.pinned.id);
      const collapsed = this.#collapsedPinnedGroups.has(g.key) && !query; // 찾는 중에는 펼쳐요
      const inner = el('ol', { cls: 'pinned-list nested' });
      if (!collapsed) g.items.forEach((v, i) => inner.append(this.#pinnedRow(v, i, among)));
      const head = el(
        'div',
        { cls: 'pinned-group-head' },
        el(
          'button',
          {
            cls: 'link group-toggle',
            // 찾는 중에는 모두 펼쳐 보여서 접기를 막아요(눌러도 안 보이는데 저장된 접힘만 뒤집히지 않게)
            attrs: {
              type: 'button',
              'aria-expanded': String(!collapsed),
              disabled: !!query,
              title: query ? t('pinned.searchExpanded') : undefined,
              'data-focus-key': `group:${g.key}`,
            },
            on: {
              click: () => {
                if (query) return;
                if (this.#collapsedPinnedGroups.has(g.key)) this.#collapsedPinnedGroups.delete(g.key);
                else this.#collapsedPinnedGroups.add(g.key);
                this.#savePrefs();
                this.#renderPinned();
              },
            },
          },
          collapsed ? '▸ ' : '▾ ',
          el('strong', { text: g.label }),
          el('span', { cls: 'count muted', text: ` ${g.items.length}` }),
        ),
        // 폴더별로 묶어 볼 때: 그 폴더의 편집기 창(2026-11-02 사용자 요청)
        this.#pinnedGroupBy === 'folder' && g.items[0]
          ? el('button', {
              cls: 'btn small',
              attrs: { type: 'button', title: t('pinned.openEditorTitle', g.items[0].pinned.folderPath), 'data-focus-key': `editor:${g.key}` },
              text: t('pinned.openEditor'),
              on: { click: () => void this.#store.openWindow({ folderPath: g.items[0]!.pinned.folderPath, role: 'editor' }) },
            })
          : null,
        el('button', {
          cls: 'btn small',
          attrs: { type: 'button', title: t('pinned.resumeGroupTitle'), 'data-focus-key': `resume:${g.key}` },
          text: t('pinned.resumeGroup'),
          on: { click: () => void this.#store.runNow(among) },
        }),
      );
      this.#pinnedList.append(el('li', { cls: 'pinned-group' }, head, collapsed ? null : inner));
    }
  }

  #pinnedRow(v: PinnedView, index: number, among: readonly string[]): HTMLElement {
    const p = v.pinned;
    const total = among.length;
    const store = this.#store;
    const s = store.findSession(p.agent, p.sessionId);
    const title = v.title;
    const update = (patch: Partial<Omit<PinnedSession, 'id'>>) => void store.updatePinned(p.id, patch);

    const head = el(
      'div',
      { cls: 'pinned-head' },
      el('span', { cls: ['agent-chip', p.agent], text: AGENT_LABEL[p.agent] }),
      el(
        'button',
        {
          cls: 'link pinned-title',
          attrs: { type: 'button', title: t('pinned.openWindowTitle', p.sessionId) },
          on: {
            click: () =>
              void store.openWindow({ folderPath: p.folderPath, role: AGENT_ROLES[p.agent], sessionId: p.sessionId }),
          },
        },
        title,
      ),
      this.#pinnedGroupBy === 'folder' ? null : el('span', { cls: 'muted folder-ref', attrs: { title: p.folderPath }, text: v.folderName }),
      p.group && this.#pinnedGroupBy !== 'group' ? el('span', { cls: 'chip', attrs: { title: t('pinned.myGroup') }, text: p.group }) : null,
      s ? this.#statusBadge(s) : null,
      el(
        'span',
        { cls: 'row-actions' },
        el('button', {
          cls: 'btn icon',
          attrs: { type: 'button', title: t('pinned.up'), 'aria-label': t('pinned.up'), disabled: index === 0, 'data-focus-key': `up:${p.id}` },
          text: '↑',
          on: { click: () => void store.movePinned(p.id, -1, among) },
        }),
        el('button', {
          cls: 'btn icon',
          attrs: { type: 'button', title: t('pinned.down'), 'aria-label': t('pinned.down'), disabled: index === total - 1, 'data-focus-key': `down:${p.id}` },
          text: '↓',
          on: { click: () => void store.movePinned(p.id, 1, among) },
        }),
        el('button', {
          cls: 'btn',
          attrs: { type: 'button' },
          text: t('pinned.resumeNow'),
          on: { click: () => void store.runNow([p.id]) },
        }),
        confirmButton(t('pinned.unpin'), t('pinned.unpinConfirm'), () => void store.removePinned(p.id), 'danger'),
      ),
    );

    const enabled = el('input', {
      attrs: { type: 'checkbox', checked: p.enabled },
      on: { change: () => update({ enabled: enabled.checked }) },
    });
    const autoSend = el('input', {
      attrs: { type: 'checkbox', checked: p.autoSend },
      on: { change: () => update({ autoSend: autoSend.checked }) },
    });
    const groupInput = el('input', {
      cls: 'group-input',
      attrs: { type: 'text', list: 'm42-pinned-groups', maxlength: PINNED_GROUP_MAX, placeholder: t('pinned.groupNone'), 'aria-label': t('pinned.myGroup'), value: p.group ?? '' },
      on: { change: () => update({ group: groupInput.value.trim() }) },
    });

    const opts = el(
      'div',
      { cls: 'pinned-opts' },
      el('label', { cls: 'check', attrs: { title: t('pinned.bootResumeTitle') } }, enabled, t('pinned.bootResume')),
      el('label', { cls: 'check', attrs: { title: t('pinned.autoSendTitle') } }, autoSend, t('pinned.autoSend')),
      ...(p.agent === 'claude' ? this.#claudeSettings(p, update) : this.#codexSettings(p, update)),
      el('label', { cls: 'check', attrs: { title: t('pinned.groupFieldTitle') } }, `${t('pinned.groupField')} `, groupInput),
    );

    // 데몬이 기본값을 알려 줬을 때만 «기본값으로»를 보여요(옛 데몬이면 무엇이 기본인지 몰라요)
    const defaults = this.#store.data.pinnedDefaults;
    const prompt = el('textarea', {
      cls: 'prompt',
      attrs: { rows: 2, 'aria-label': t('pinned.resumePrompt'), value: p.resumePrompt },
      on: {
        change: () => update({ resumePrompt: prompt.value }),
      },
    });
    const promptRow = el(
      'div',
      { cls: 'prompt-row' },
      el('label', { cls: 'field-label', text: t('pinned.resumePrompt') }),
      prompt,
      defaults && !defaults.knownPrompts.includes(p.resumePrompt)
        ? el('button', {
            cls: 'btn small',
            attrs: { type: 'button' },
            text: t('pinned.resetPrompt'),
            on: { click: () => update({ resumePrompt: defaults.resumePrompt }) },
          })
        : null,
    );

    return el('li', { cls: ['pinned', !p.enabled && 'disabled'] }, head, opts, promptRow);
  }

  #claudeSettings(p: PinnedSession, update: (patch: Partial<Omit<PinnedSession, 'id'>>) => void): HTMLElement[] {
    const st = p.settings as ClaudeSettings;
    const effort = el(
      'select',
      {
        attrs: { 'aria-label': 'effort', value: st.effort ?? '' },
        on: {
          change: () => {
            const v = effort.value;
            const next: ClaudeSettings = { ...st };
            if (isClaudeEffort(v)) next.effort = v;
            else delete next.effort;
            update({ settings: next });
          },
        },
      },
      el('option', { attrs: { value: '' }, text: t('settings.unchanged') }),
      CLAUDE_EFFORTS.map((e) => el('option', { attrs: { value: e }, text: e })),
    );
    const ultra = el('input', {
      attrs: { type: 'checkbox', checked: !!st.ultracode },
      on: { change: () => update({ settings: { ...st, ultracode: ultra.checked } }) },
    });
    return [
      el('label', { cls: 'field' }, el('span', { cls: 'field-label', text: 'effort' }), effort),
      el('label', { cls: 'check' }, ultra, 'ultracode'),
      st.model ? el('span', { cls: 'chip', attrs: { title: t('settings.modelRestored') }, text: st.model }) : null,
    ].filter((x): x is HTMLElement => x !== null);
  }

  #codexSettings(p: PinnedSession, update: (patch: Partial<Omit<PinnedSession, 'id'>>) => void): HTMLElement[] {
    const st = p.settings as CodexSettings;
    const textField = (label: string, key: 'model' | 'reasoningEffort', placeholder: string) => {
      const input = el('input', {
        cls: 'text-small',
        attrs: { type: 'text', value: st[key] ?? '', placeholder, spellcheck: 'false', 'aria-label': label },
        on: {
          change: () => {
            const v = input.value.trim();
            const next: CodexSettings = { ...st };
            if (v) next[key] = v;
            else delete next[key];
            update({ settings: next });
          },
        },
      });
      return el('label', { cls: 'field' }, el('span', { cls: 'field-label', text: label }), input);
    };
    return [textField(t('settings.model'), 'model', t('settings.unchanged')), textField(t('settings.reasoningEffort'), 'reasoningEffort', t('settings.unchanged'))];
  }

  // ---- 폴더·세션 ----

  #renderFolders(): void {
    if (this.#holdRender('folders')) return;
    const store = this.#store;
    const { folders } = store.data;
    const query = this.#query.trim();
    const counts = windowsByFolder(store.data.windows, folders);
    this.#folderTabCount.textContent = folders.length ? String(folders.length) : '';
    clear(this.#folderList);

    if (folders.length === 0) {
      const loaded = store.data.loaded.has('folders');
      this.#folderList.append(
        el('p', {
          cls: 'empty muted',
          text: loaded ? t('folders.empty') : this.#loadingText(),
        }),
      );
      this.#searchCount.textContent = '';
      return;
    }

    let totalMatches = 0;
    let shownFolders = 0;
    for (const f of folders) {
      const sessions = store.data.sessions.get(f.id) ?? [];
      const grouped = groupByAgent(sessions);
      const trees = AGENT_ORDER.map((agent) => {
        const ft = filterTree(buildSessionTree(grouped[agent]), query);
        return { agent, ...ft };
      });
      const matches = trees.reduce((a, t) => a + t.matchCount, 0);
      totalMatches += matches;
      if (query && matches === 0) continue;
      shownFolders++;
      this.#folderList.append(this.#folderSection(f, trees, counts.get(f.id)));
    }

    if (query) {
      this.#searchCount.textContent = t('folders.matches', totalMatches);
      if (shownFolders === 0) this.#folderList.append(el('p', { cls: 'empty muted', text: t('folders.noResults') }));
    } else {
      this.#searchCount.textContent = '';
    }
  }

  #folderSection(
    f: Folder,
    trees: { agent: AgentKind; nodes: SessionNode[]; forceExpanded: Set<string>; matchCount: number }[],
    count: WindowCount | undefined,
  ): HTMLElement {
    const store = this.#store;
    const searching = !!this.#query.trim();
    const collapsed = !searching && this.#collapsedFolders.has(f.id);
    const err = store.data.sessionErrors.get(f.id);

    const toggle = el('button', {
      cls: 'twisty',
      attrs: { type: 'button', 'aria-expanded': String(!collapsed), 'aria-label': collapsed ? t('common.expand') : t('common.collapse') },
      text: collapsed ? '▸' : '▾',
      on: {
        click: () => {
          if (this.#collapsedFolders.has(f.id)) this.#collapsedFolders.delete(f.id);
          else this.#collapsedFolders.add(f.id);
          this.#savePrefs();
          this.#renderFolders();
        },
      },
    });

    const total = count?.total ?? 0;
    const head = el(
      'div',
      { cls: 'folder-head' },
      toggle,
      el(
        'div',
        { cls: 'folder-name' },
        el('span', { cls: 'label', text: folderLabel(f) }),
        el('span', { cls: 'path muted', attrs: { title: f.path }, text: f.path }),
      ),
      count && total > 0
        ? el('span', {
            cls: 'badge windows',
            attrs: { title: windowCountTooltip(count) },
            text: t('folders.windowsBadge', total),
          })
        : null,
      el(
        'div',
        { cls: 'row-actions' },
        el('button', {
          cls: 'btn new-session claude',
          attrs: { type: 'button', title: t('folders.newClaude') },
          text: 'Claude',
          on: { click: () => void store.openNewSession(f, 'claude') },
        }),
        el('button', {
          cls: 'btn new-session codex',
          attrs: { type: 'button', title: t('folders.newCodex') },
          text: 'Codex',
          on: { click: () => void store.openNewSession(f, 'codex') },
        }),
        el('button', {
          cls: 'btn',
          attrs: { type: 'button', title: t('folders.editorTitle') },
          text: t('folders.editor'),
          on: { click: () => void store.openEditor(f) },
        }),
        confirmButton(t('folders.remove'), t('folders.removeConfirm'), () => void store.removeFolder(f.id), 'danger subtle'),
      ),
    );

    const body = el('div', { cls: 'folder-body', attrs: { hidden: collapsed } });
    if (err) body.append(el('p', { cls: 'error-line', text: t('folders.sessionListError', err) }));
    const loadedSessions = store.data.sessions.has(f.id);
    for (const t of trees) {
      if (searching && t.matchCount === 0) continue;
      body.append(this.#agentGroup(f, t, loadedSessions));
    }
    return el('section', { cls: ['folder', collapsed && 'collapsed'], attrs: { 'data-folder-id': f.id } }, head, body);
  }

  #agentGroup(
    f: Folder,
    t: { agent: AgentKind; nodes: SessionNode[]; forceExpanded: Set<string> },
    loaded: boolean,
  ): HTMLElement {
    const searching = !!this.#query.trim();
    const showKey = `${f.id}:${t.agent}`;
    const showAll = searching || this.#showAll.has(showKey);
    const roots = showAll ? t.nodes : t.nodes.slice(0, ROOT_LIMIT);
    const list = el('ul', { cls: 'session-tree', attrs: { role: 'tree', 'aria-label': tr('sessions.treeLabel', AGENT_LABEL[t.agent]) } });
    for (const n of roots) list.append(this.#sessionItem(f, n, t.forceExpanded, 0));

    const group = el(
      'div',
      { cls: ['agent-group', t.agent] },
      el(
        'div',
        { cls: 'agent-head' },
        el('span', { cls: ['agent-chip', t.agent], text: AGENT_LABEL[t.agent] }),
        el('span', { cls: 'muted count', text: t.nodes.length ? `${t.nodes.length}` : '' }),
      ),
    );
    if (t.nodes.length === 0) {
      group.append(el('p', { cls: 'empty muted small', text: loaded ? tr('sessions.none') : this.#loadingText() }));
      return group;
    }
    group.append(list);
    if (!searching && t.nodes.length > ROOT_LIMIT) {
      group.append(
        el('button', {
          cls: 'link more',
          attrs: { type: 'button' },
          text: showAll ? tr('common.collapse') : tr('sessions.showMore', t.nodes.length - ROOT_LIMIT),
          on: {
            click: () => {
              if (this.#showAll.has(showKey)) this.#showAll.delete(showKey);
              else this.#showAll.add(showKey);
              this.#savePrefs();
              this.#renderFolders();
            },
          },
        }),
      );
    }
    return group;
  }

  #statusBadge(s: SessionSummary): HTMLElement | null {
    const sv = statusView(s.status);
    return sv ? el('span', { cls: ['badge', 'status', sv.cls], text: sv.label }) : null;
  }

  #sessionItem(f: Folder, n: SessionNode, forceExpanded: Set<string>, depth: number): HTMLElement {
    const store = this.#store;
    const s = n.session;
    const key = sessionKey(s);
    const hasKids = n.children.length > 0;
    const expanded = hasKids && (forceExpanded.has(key) || this.#expanded.has(key));
    const pinned = store.isPinned(s);
    const rel = formatRelativeTime(s.updatedAt);

    const twisty = hasKids
      ? el(
          'button',
          {
            cls: 'twisty',
            attrs: {
              type: 'button',
              'aria-expanded': String(expanded),
              title: t('sessions.subagentCount', n.descendantCount),
            },
            on: {
              click: () => {
                if (this.#expanded.has(key)) this.#expanded.delete(key);
                else this.#expanded.add(key);
                this.#savePrefs();
                this.#renderFolders();
              },
            },
          },
          expanded ? '▾' : '▸',
          el('span', { cls: 'kid-count', text: String(n.descendantCount) }),
        )
      : el('span', { cls: 'twisty-spacer' });

    const main = el(
      'button',
      {
        cls: 'session-open',
        attrs: { type: 'button', title: `${s.id}${s.lastPrompt ? `\n${s.lastPrompt}` : ''}` },
        on: { click: () => void store.openSession(f, s) },
      },
      el('span', { cls: 'title', text: sessionTitle(s) }),
      el(
        'span',
        { cls: 'meta' },
        s.isSubagent ? el('span', { cls: 'chip sub', text: t('sessions.subagent') }) : null,
        chipsFor(s).map((c) => el('span', { cls: 'chip', text: c })),
        rel ? el('time', { cls: 'muted', attrs: { datetime: s.updatedAt, title: s.updatedAt }, text: rel }) : null,
      ),
    );

    const pin = el('button', {
      cls: ['pin', pinned && 'on'],
      attrs: {
        type: 'button',
        'aria-pressed': String(!!pinned),
        title: pinned ? t('pinned.unpin') : t('sessions.pinTitle'),
        'aria-label': pinned ? t('pinned.unpin') : t('sessions.pin'),
      },
      text: pinned ? '★' : '☆',
      on: { click: () => void store.togglePin(f, s) },
    });

    const item = el(
      'li',
      {
        cls: ['session', s.isSubagent && 'subagent', depth > 0 && 'child'],
        attrs: { role: 'treeitem', 'aria-expanded': hasKids ? String(expanded) : null, 'data-status': s.status ?? null },
      },
      el('div', { cls: 'session-row' }, twisty, main, this.#statusBadge(s), pin),
    );
    if (expanded) {
      const kids = el('ul', { cls: 'session-tree children', attrs: { role: 'group' } });
      for (const c of n.children) kids.append(this.#sessionItem(f, c, forceExpanded, depth + 1));
      item.append(kids);
    }
    return item;
  }

  // ---- 작업(백그라운드 워크플로우·서브에이전트) ----

  #renderTasks(): void {
    if (this.#holdRender('tasks')) return;
    const { tasks, tasksError } = this.#store.data;
    const running = runningTotal(tasks);
    this.#tasksTabCount.textContent = running ? `⟳ ${running}` : '';
    this.#tasksTabCount.title = running ? t('tasks.runningCount', running) : '';
    this.#tasksTabCount.classList.toggle('on', running > 0);

    // 머리 단추에 있던 초점을 다시 그린 뒤 같은 단추로 돌려줘요.
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && this.#tasksList.contains(active) ? active.dataset.focusKey : undefined;
    clear(this.#tasksList);
    if (tasksError) this.#tasksList.append(el('p', { cls: 'error-line', text: tasksError }));
    if (tasks.length === 0) {
      if (!tasksError) {
        const loaded = this.#store.data.loaded.has('tasks');
        this.#tasksList.append(
          el('p', {
            cls: 'empty muted',
            text: loaded ? t('tasks.empty') : this.#loadingText(),
          }),
        );
      }
    } else {
      for (const st of tasks) this.#tasksList.append(this.#taskSession(st));
    }
    if (focusKey) {
      for (const b of this.#tasksList.querySelectorAll<HTMLElement>('[data-focus-key]')) {
        if (b.dataset.focusKey === focusKey) {
          b.focus();
          break;
        }
      }
    }
    this.#syncTaskClock();
  }

  /** 작업 탭이 보이고 실행 중인 것이 있을 때만 1초마다 걸린 시간을 고쳐 써요(다시 읽지 않아요). */
  #syncTaskClock(): void {
    const want = this.#tab === 'tasks' && runningTotal(this.#store.data.tasks) > 0;
    if (want && !this.#taskClock) this.#taskClock = setInterval(() => this.#tickTasks(), 1000);
    else if (!want && this.#taskClock) {
      clearInterval(this.#taskClock);
      this.#taskClock = undefined;
    }
  }

  #tickTasks(): void {
    const now = Date.now();
    for (const e of this.#tasksList.querySelectorAll<HTMLElement>('[data-live-start]')) {
      const start = Number(e.dataset.liveStart);
      if (Number.isFinite(start)) e.textContent = formatDuration(Math.max(0, now - start));
    }
  }

  #toggleTask(key: string, defaultOpen: boolean): void {
    toggleOpen(this.#taskOpen, key, defaultOpen);
    this.#savePrefs();
    this.#renderTasks();
  }

  #tokens(t: TokenUsage | undefined): HTMLElement | null {
    const text = formatTokens(t?.total);
    if (!t || !text || t.total <= 0) return null;
    return el('span', { cls: 'task-tokens muted', attrs: { title: tokenTooltip(t) }, text: tr('tasks.tokens', text) });
  }

  #elapsed(t: TimedTask): HTMLElement | null {
    const ms = taskElapsedMs(t);
    if (ms === undefined) return null;
    const live = liveStartMs(t);
    return el('span', {
      cls: 'task-elapsed muted',
      attrs: { title: live !== undefined ? tr('tasks.sinceStart') : tr('tasks.elapsed'), 'data-live-start': live },
      text: formatDuration(ms),
    });
  }

  #progress(p: Progress, label: string): HTMLElement {
    const pct = formatPercent(p);
    return el(
      'span',
      { cls: 'task-progress', attrs: { title: `${label}: ${p.done} / ${p.total}${pct ? ` (${pct})` : ''}` } },
      el('progress', { attrs: { max: Math.max(1, p.total), value: Math.min(p.done, Math.max(1, p.total)), 'aria-label': label } }),
      el('span', { cls: 'muted small', text: `${p.done}/${p.total}` }),
    );
  }

  #statusIcon(status: BackgroundAgent['status']): HTMLElement {
    const sv = taskStatusView(status);
    return el('span', { cls: ['task-status', sv.cls], attrs: { title: sv.label, role: 'img', 'aria-label': sv.label }, text: sv.icon });
  }

  #taskSession(st: SessionTasks): HTMLElement {
    const key = taskSessionKey(st);
    const defaultOpen = st.running > 0;
    const open = isOpen(this.#taskOpen, key, defaultOpen);
    // 세션 cwd가 등록 폴더의 하위 폴더여도 그 등록 폴더 이름으로 보여요
    const folder = folderForCwd(this.#store.data.folders, st.cwd);
    const title = taskSessionTitle(st);
    const bodyId = `task-${key.replace(/[^\w-]/g, '_')}`;

    const head = el(
      'button',
      {
        cls: 'task-head task-session-head',
        attrs: {
          type: 'button',
          'aria-expanded': String(open),
          'aria-controls': bodyId,
          title: `${st.cwd}\n${st.sessionId}`,
          'data-focus-key': key,
        },
        on: { click: () => this.#toggleTask(key, defaultOpen) },
      },
      el('span', { cls: 'task-twisty', attrs: { 'aria-hidden': 'true' }, text: open ? '▾' : '▸' }),
      el('span', { cls: 'task-folder', text: folder ? folderLabel(folder) : cwdBasename(st.cwd) }),
      el('span', { cls: ['agent-chip', st.agent], text: AGENT_LABEL[st.agent] }),
      title ? el('span', { cls: 'task-session-title', text: title }) : el('span', { cls: 'task-session-title' }),
      st.running > 0 ? el('span', { cls: 'badge task-running', text: t('tasks.running', st.running) }) : null,
      this.#tokens(st.tokens),
      this.#progress(sessionProgress(st), t('tasks.overallProgress')),
    );

    const body = el('div', { cls: 'task-session-body', attrs: { id: bodyId, hidden: !open } });
    if (open) {
      const workflows = sortByActivity(st.workflows, (w) => w.runId);
      const subagents = sortByActivity(st.subagents, (a) => a.id);
      for (const w of workflows) body.append(this.#taskWorkflow(w));
      if (subagents.length) {
        body.append(
          el(
            'div',
            { cls: 'task-group' },
            el('div', { cls: 'task-group-label muted small', text: t('tasks.subagents', subagents.length) }),
            el('ul', { cls: 'task-agents' }, subagents.map((a) => this.#agentRow(a, true))),
          ),
        );
      }
      if (!workflows.length && !subagents.length) body.append(el('p', { cls: 'empty muted small', text: t('tasks.none') }));
    }
    return el('section', { cls: ['task-session', !open && 'collapsed', st.running > 0 && 'running'] }, head, body);
  }

  #taskWorkflow(w: BackgroundWorkflow): HTMLElement {
    const key = workflowKey(w);
    const defaultOpen = w.status === 'running';
    const open = isOpen(this.#taskOpen, key, defaultOpen);
    const cur = currentPhaseIndex(w.phases, w.status);
    const bodyId = `task-${key.replace(/[^\w-]/g, '_')}`;
    const name = workflowName(w);

    const head = el(
      'button',
      {
        cls: 'task-head task-workflow-head',
        attrs: {
          type: 'button',
          'aria-expanded': String(open),
          'aria-controls': bodyId,
          title: w.description?.trim() ? `${name}\n${w.description.trim()}` : `${name} (${w.runId})`,
          'data-focus-key': key,
        },
        on: { click: () => this.#toggleTask(key, defaultOpen) },
      },
      el('span', { cls: 'task-twisty', attrs: { 'aria-hidden': 'true' }, text: open ? '▾' : '▸' }),
      this.#statusIcon(w.status),
      el('span', { cls: 'chip', text: t('tasks.workflow') }),
      el('span', { cls: 'task-workflow-name', text: name }),
      this.#progress(w.progress, t('tasks.workflowProgress')),
      this.#tokens(w.tokens),
      this.#elapsed(w),
    );

    const phases = w.phases.length
      ? el(
          'ol',
          { cls: 'task-phases', attrs: { 'aria-label': t('tasks.phases') } },
          w.phases.map((p, i) =>
            el(
              'li',
              {
                cls: [
                  'chip',
                  'task-phase',
                  i === cur && 'current',
                  i !== cur && p.started > 0 && p.done >= p.started && 'done',
                  p.started === 0 && 'pending',
                ],
                attrs: { title: t('tasks.phaseTitle', p.title, p.started, p.done), 'aria-current': i === cur ? 'step' : null },
              },
              p.title,
              p.started > 0 ? el('span', { cls: 'task-phase-count', text: ` ${p.done}/${p.started}` }) : null,
            ),
          ),
        )
      : null;

    const body = el('div', { cls: 'task-workflow-body', attrs: { id: bodyId, hidden: !open } });
    if (open) {
      const agents = sortWorkflowAgents(w.agents, w.phases);
      if (agents.length) body.append(el('ul', { cls: 'task-agents' }, agents.map((a) => this.#agentRow(a, w.phases.length > 0))));
      else body.append(el('p', { cls: 'empty muted small', text: t('tasks.noAgents') }));
    }
    return el('div', { cls: ['task-workflow', !open && 'collapsed'], attrs: { 'data-status': w.status } }, head, phases, body);
  }

  #agentRow(a: BackgroundAgent, showPhase: boolean): HTMLElement {
    const line = el(
      'div',
      { cls: 'task-agent-line' },
      this.#statusIcon(a.status),
      el('span', { cls: 'task-agent-label', attrs: { title: `${a.label}\n${a.id}` }, text: a.label || a.id }),
      showPhase && a.phase ? el('span', { cls: 'chip', attrs: { title: t('tasks.phase') }, text: a.phase }) : null,
      a.kind ? el('span', { cls: 'chip sub', attrs: { title: t('tasks.kind') }, text: a.kind }) : null,
      el('span', { cls: 'task-agent-meta' }, this.#tokens(a.tokens), this.#elapsed(a)),
    );
    const activity = a.activity?.trim()
      ? el('div', { cls: 'task-activity muted small', attrs: { title: a.activity }, text: a.activity.trim() })
      : null;
    let summary: HTMLElement | null = null;
    const text = a.summary?.trim();
    if (text) {
      summary = el(
        'details',
        { cls: 'task-summary', attrs: { 'data-summary-key': a.id, open: this.#openSummaries.has(a.id) } },
        el('summary', { cls: 'muted small', attrs: { title: text }, text: t('tasks.summary') }),
        el('p', { cls: 'small', text }),
      );
    }
    return el('li', { cls: 'task-agent', attrs: { 'data-status': a.status } }, line, activity, summary);
  }
}
