// Mark42 세션 탭(D17) — 이 창 폴더의 세션 + 고정 상태. 에이전트 창은 그 에이전트 세션만, Codex 서브에이전트는 부모 아래 접힌 트리(D22).
import * as vscode from 'vscode';
import type { AgentKind, PinnedSession, SessionSummary, WindowRole } from '@mark42/protocol';
import { samePath } from '@mark42/protocol/paths';
import type { DaemonClient } from './daemonClient.ts';
import { agentOfRole, resolveFolderPath, type HostEnv, type RoleConfig } from './lib/role.ts';
import type { Logger } from './log.ts';

interface SessionNode {
  type: 'session';
  s: SessionSummary;
  pinned: PinnedSession | undefined;
  /** 같은 목록의 parentId → 자식들 (모든 깊이에서 같이 써요) */
  byParent: ReadonlyMap<string, SessionSummary[]>;
  /** 순환(parentId가 서로 가리키는 경우) 방지 */
  ancestors: ReadonlySet<string>;
}

type Node = { type: 'new'; agent: AgentKind } | SessionNode | { type: 'info'; label: string };

/** 서브에이전트 트리(D22) — 손자 이하도 부모 아래에 붙어요. hub-ui buildSessionTree와 같은 규칙이에요. */
export function sessionChildren(n: SessionNode): SessionNode[] {
  const kids = (n.byParent.get(n.s.id) ?? []).filter((c) => !n.ancestors.has(c.id) && c.id !== n.s.id);
  const anc = new Set(n.ancestors).add(n.s.id);
  return kids.map((c) => ({ type: 'session', s: c, pinned: undefined, byParent: n.byParent, ancestors: anc }));
}

const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' };

export class SessionsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  #daemon: DaemonClient;
  #log: Logger;
  #config: () => RoleConfig;
  #hostEnv: () => HostEnv;
  #currentSession: () => string | undefined;
  #emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#emitter.event;
  #view: vscode.TreeView<Node>;
  #subs: vscode.Disposable[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(o: {
    daemon: DaemonClient;
    log: Logger;
    config: () => RoleConfig;
    hostEnv: () => HostEnv;
    currentSession: () => string | undefined;
  }) {
    this.#daemon = o.daemon;
    this.#log = o.log;
    this.#config = o.config;
    this.#hostEnv = o.hostEnv;
    this.#currentSession = o.currentSession;
    this.#view = vscode.window.createTreeView('mark42.sessions', { treeDataProvider: this, showCollapseAll: true });
    this.#subs.push(
      this.#view,
      this.#emitter,
      o.daemon.onStateChange(() => this.refresh()),
      o.daemon.onNotification((method, params) => {
        if (method !== 'state.changed') return;
        const topics = (params as { topics?: string[] }).topics ?? [];
        if (topics.some((t) => t === 'sessions' || t === 'pinned' || t === 'windows')) this.refresh();
      }),
    );
  }

  /** state.changed가 몰려도 한 번만 다시 읽어요 */
  refresh(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#emitter.fire(undefined);
    }, 150);
  }

  #role(): WindowRole | undefined {
    return this.#config().role;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.type === 'info') {
      const it = new vscode.TreeItem(n.label);
      it.iconPath = new vscode.ThemeIcon('info');
      return it;
    }
    if (n.type === 'new') {
      const it = new vscode.TreeItem(vscode.l10n.t('New {0} session', AGENT_LABEL[n.agent]));
      it.iconPath = new vscode.ThemeIcon('add');
      it.command = { command: 'mark42.openSessionItem', title: vscode.l10n.t('New session'), arguments: [{ agent: n.agent, newSession: true }] };
      return it;
    }
    const s = n.s;
    const title = s.title?.trim() || s.lastPrompt?.trim().slice(0, 60) || s.id.slice(0, 8);
    const it = new vscode.TreeItem(
      title,
      sessionChildren(n).length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    const isCurrent = this.#currentSession() === s.id;
    const status = s.status && s.status !== 'stopped' ? statusLabel(s.status) : undefined;
    it.description = [isCurrent ? vscode.l10n.t('this window') : undefined, n.pinned ? vscode.l10n.t('pinned') : undefined, status, relTime(s.updatedAt)]
      .filter(Boolean)
      .join(' · ');
    it.iconPath = new vscode.ThemeIcon(isCurrent ? 'circle-filled' : n.pinned ? 'pinned' : s.isSubagent ? 'type-hierarchy-sub' : 'comment-discussion');
    const tip = new vscode.MarkdownString();
    tip.appendText(`${AGENT_LABEL[s.agent]} · ${s.id}\n`);
    if (s.model) tip.appendText(`${vscode.l10n.t('Model {0}', s.model)}${s.effort ? ` · effort ${s.effort}` : ''}\n`);
    tip.appendText(`${s.cwd}\n${new Date(s.updatedAt).toLocaleString()}`);
    it.tooltip = tip;
    it.contextValue = n.pinned ? 'session.pinned' : 'session';
    if (!s.isSubagent) {
      it.command = { command: 'mark42.openSessionItem', title: vscode.l10n.t('Open session'), arguments: [{ agent: s.agent, sessionId: s.id, cwd: s.cwd }] };
    }
    return it;
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (n?.type === 'session') return sessionChildren(n);
    if (n) return [];
    const cfg = this.#config();
    const folder = resolveFolderPath(cfg, this.#hostEnv());
    const agent = agentOfRole(this.#role());
    const api = this.#daemon.api;
    this.#view.message = undefined;
    const top: Node[] = [];
    if (folder && cfg.role !== 'hub') {
      for (const a of agent ? [agent] : (['claude', 'codex'] as const)) top.push({ type: 'new', agent: a });
    }
    if (!api) {
      this.#view.message = this.#daemon.state === 'connecting' ? vscode.l10n.t('Connecting to the daemon…') : vscode.l10n.t('Not connected to the daemon');
      return top;
    }
    if (!folder) {
      this.#view.message = cfg.role === 'hub' ? vscode.l10n.t('Sessions per folder are shown in the hub window') : vscode.l10n.t('No folder is open');
      return top;
    }
    try {
      const [sessions, pinned] = await Promise.all([
        api.request('sessions.list', { cwd: folder, ...(agent ? { agent } : {}), includeSubagents: true, limit: 100 }),
        api.request('pinned.list', {}),
      ]);
      const mine = pinned.filter((p) => samePath(p.folderPath, folder) && (!agent || p.agent === agent));
      const byParent = new Map<string, SessionSummary[]>();
      for (const s of sessions) {
        if (s.parentId) {
          const arr = byParent.get(s.parentId) ?? [];
          arr.push(s);
          byParent.set(s.parentId, arr);
        }
      }
      const ids = new Set(sessions.map((s) => s.id));
      const roots = sessions.filter((s) => !s.parentId || !ids.has(s.parentId));
      const pinnedOf = (s: SessionSummary) => mine.find((p) => p.agent === s.agent && p.sessionId === s.id);
      // 이 창 세션 → 고정 → 최근 순
      const current = this.#currentSession();
      roots.sort((a, b) => {
        const ra = (a.id === current ? 0 : 2) + (pinnedOf(a) ? 0 : 1);
        const rb = (b.id === current ? 0 : 2) + (pinnedOf(b) ? 0 : 1);
        return ra - rb || b.updatedAt.localeCompare(a.updatedAt);
      });
      for (const s of roots) top.push({ type: 'session', s, pinned: pinnedOf(s), byParent, ancestors: new Set() });
      if (roots.length === 0) top.push({ type: 'info', label: vscode.l10n.t('There are no sessions in this folder') });
    } catch (e) {
      this.#log.warn(`sessions view load failed: ${e instanceof Error ? e.message : String(e)}`);
      this.#view.message = vscode.l10n.t('Could not load the session list');
    }
    return top;
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    for (const s of this.#subs.splice(0)) s.dispose();
  }
}

function statusLabel(s: string): string {
  switch (s) {
    case 'busy':
      return vscode.l10n.t('working');
    case 'waiting':
      return vscode.l10n.t('waiting for input');
    case 'idle':
      return vscode.l10n.t('idle');
    default:
      return s;
  }
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return vscode.l10n.t('just now');
  if (m < 60) return vscode.l10n.t('{0} min ago', m);
  const h = Math.round(m / 60);
  if (h < 24) return vscode.l10n.t('{0} h ago', h);
  return vscode.l10n.t('{0} d ago', Math.round(h / 24));
}
