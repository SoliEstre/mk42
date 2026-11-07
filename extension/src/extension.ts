// Mark42 내장 확장 진입점 — 모든 창에 로드되고, mark42.role 설정으로 역할별 동작을 켜요.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { AGENT_ROLES, type AgentKind, type AgentOpenSessionParams, type DaemonNotificationMap, type HubTheme, type LinkKind } from '@mark42/protocol';
import { defaultMark42Home, defaultPipeName } from '@mark42/protocol/paths';
import { AgentController } from './agentController.ts';
import { maximizeAgentPanel, watchAgentLayout } from './agentLayout.ts';
import { createAdapters } from './agents.ts';
import { ClaudeSessionBinder } from './claudeSessions.ts';
import { DaemonClient } from './daemonClient.ts';
import { AgentUpdateButton } from './agentUpdate.ts';
import { Mk42UpdateNotifier } from './mk42Update.ts';
import { HubPanel } from './hub.ts';
import { LinkRouter, openUriLocally } from './linkRouter.ts';
import {
  agentOfRole,
  buildWindowInfo,
  daemonSpawnSpec,
  isAgentRole,
  readRoleConfigScoped,
  resolveFolderPath,
  roleLabel,
  roleOfWorkspaceFile,
  TRACKED_EXTENSION_IDS,
  trustedHomesFrom,
  type HostEnv,
  type RoleConfig,
} from './lib/role.ts';
import { isSafeSessionId } from './lib/agentUris.ts';
import { buildHubTheme, findThemeFile, resolveActiveThemeName, themeKindOf } from './lib/themeColors.ts';
import { t } from './l10n.ts';
import { createLogger, type Logger } from './log.ts';
import { defaultRunner, OsKeySender } from './sender.ts';
import { SessionsView } from './sessionsView.ts';
import { StatusBar } from './statusBar.ts';
import { TasksMonitor } from './tasksView.ts';
import { WindowTitle } from './windowTitle.ts';

function readConfig(): RoleConfig {
  const c = vscode.workspace.getConfiguration('mark42');
  const wf = vscode.workspace.workspaceFile;
  return readRoleConfigScoped(
    (k) => c.inspect(k),
    (k) => c.get(k),
    wf?.scheme === 'file' ? wf.fsPath : undefined,
  );
}

/** 신뢰하는 Mark42 home 아래 역할 워크스페이스 파일이면 그 home (제한 모드에서도 읽을 수 있는 사용자 설정 trustedHomes만 봐요) */
function roleWorkspaceHome(file: string): string | undefined {
  const c = vscode.workspace.getConfiguration('mark42');
  return roleOfWorkspaceFile(file, trustedHomesFrom((k) => c.inspect(k), defaultMark42Home()))?.home;
}

function hostEnv(context: vscode.ExtensionContext): HostEnv {
  const extensions = TRACKED_EXTENSION_IDS.flatMap((id) => {
    const ext = id === context.extension.id ? context.extension : vscode.extensions.getExtension(id);
    const v = ext?.packageJSON?.version;
    return typeof v === 'string' ? [{ id: ext!.id, version: v }] : [];
  });
  if (!extensions.some((e) => e.id === context.extension.id)) {
    const v = context.extension.packageJSON?.version;
    if (typeof v === 'string') extensions.push({ id: context.extension.id, version: v });
  }
  return {
    workspaceFile: vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : undefined,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath),
    pid: process.pid,
    appVersion: vscode.version,
    appName: vscode.env.appName,
    extensions,
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const log = createLogger(context);
  let cfg = readConfig();
  log.info(`Mark42 activate: role=${cfg.role ?? '(unmanaged)'} slot=${cfg.slotId ?? '-'} vscode=${vscode.version}`);
  const env = () => hostEnv(context);

  let controller: AgentController | undefined;
  const spawnSpec = daemonSpawnSpec(cfg, defaultPipeName());
  if (spawnSpec && 'skip' in spawnSpec) log.warn(`daemon auto-spawn disabled: ${spawnSpec.skip}`);
  const daemon = new DaemonClient({
    pipeName: cfg.pipeName ?? defaultPipeName(),
    // 파이프 주인 확인용 비밀의 위치: 신뢰한 역할 워크스페이스의 home, 아니면 기본 home
    authHome: () => cfg.home ?? defaultMark42Home(),
    windowInfo: () => buildWindowInfo(cfg, env(), controller?.sessionId),
    log,
    spawn: spawnSpec && !('skip' in spawnSpec) ? spawnSpec : undefined,
  });
  context.subscriptions.push({ dispose: () => daemon.dispose() });

  const status = new StatusBar();
  context.subscriptions.push(status);
  context.subscriptions.push(watchAgentLayout(() => isAgentRole(cfg.role)));
  const refreshStatus = () => status.update(daemon.state, cfg, daemon.state === 'disconnected' ? daemon.lastError : undefined);
  refreshStatus();

  const adapters = createAdapters(log);
  const sender = new OsKeySender(log, { isFocused: () => vscode.window.state.focused });
  const binder = new ClaudeSessionBinder(log, defaultRunner);
  context.subscriptions.push({ dispose: () => binder.dispose() });

  let sessionsView: SessionsView | undefined;
  let tasks: TasksMonitor | undefined;
  let windowTitle: WindowTitle | undefined;
  controller = new AgentController({
    context,
    log,
    adapters,
    sender,
    binder,
    daemon,
    config: () => cfg,
    hostEnv: env,
    onBound: (agent, sessionId) => {
      log.info(`window bound to ${agent} session ${sessionId}`);
      sessionsView?.refresh();
      void tasks?.reload();
      void windowTitle?.refresh();
    },
  });

  // 에이전트 창: Windows 창 제목에 이 창 세션 이름(${mark42Session}, 데몬의 window.title)
  windowTitle = new WindowTitle({
    daemon,
    log,
    agent: () => agentOfRole(cfg.role),
    folder: () => resolveFolderPath(cfg, env()),
    sessionId: () => controller?.sessionId,
  });
  context.subscriptions.push(windowTitle);

  sessionsView = new SessionsView({ daemon, log, config: () => cfg, hostEnv: env, currentSession: () => controller?.sessionId });
  context.subscriptions.push(sessionsView);

  // 에이전트 창: 이 창 세션의 백그라운드 작업(워크플로우·서브에이전트) 보기 + 상태 표시줄
  tasks = new TasksMonitor({ daemon, log, agent: () => agentOfRole(cfg.role), sessionId: () => controller?.sessionId });
  context.subscriptions.push(tasks);

  const router = new LinkRouter(log, daemon, () => cfg, env);
  context.subscriptions.push(router);

  const hub = new HubPanel(context, daemon, log);
  context.subscriptions.push(hub);

  // 에이전트 패널 제목줄의 «업데이트 확인·적용» 단추(에이전트 창만 표시)
  const agentUpdate = new AgentUpdateButton(() => (isAgentRole(cfg.role) ? cfg.role : undefined), () => daemon.api, log);
  context.subscriptions.push(agentUpdate);
  // Mk42 자체 업데이트: 받은 새 판을 설치할지 묻고(데몬이 고른 창 하나만), 준비된 동안 상태 표시줄 단추
  context.subscriptions.push(new Mk42UpdateNotifier(daemon, log));

  // 데몬 → 창 알림
  context.subscriptions.push(
    daemon.onNotification((method, params) => {
      switch (method) {
        case 'agent.openSession': {
          const p = params as AgentOpenSessionParams;
          if (!isAgentRole(cfg.role) || AGENT_ROLES[p.agent] !== cfg.role) {
            log.debug(`ignored agent.openSession for ${p.agent} in role ${cfg.role ?? '-'}`);
            return;
          }
          void controller!.handleOpenSession(p);
          return;
        }
        case 'editor.openUri': {
          if (cfg.role !== 'editor') return;
          const p = params as DaemonNotificationMap['editor.openUri'];
          void openUriLocally(p.uri, p.kind, p.selection).catch((e) => log.error(`editor.openUri failed (${p.kind})`, e));
          return;
        }
        case 'state.changed': {
          // 작업 알림({topics:['tasks']})은 작업 보기만 — 세션 목록은 다른 주제가 섞였을 때만 다시 읽어요
          const topics = (params as Partial<DaemonNotificationMap['state.changed']> | undefined)?.topics;
          const list = Array.isArray(topics) ? topics : [];
          if (list.length === 0 || list.some((t) => t !== 'tasks')) {
            sessionsView?.refresh();
            windowTitle?.schedule();
          }
          if (list.includes('tasks')) tasks?.refresh();
          return;
        }
        case 'extensions.updated':
          void agentUpdate.refresh();
          return;
        default:
          return;
      }
    }),
    daemon.onStateChange((s) => {
      refreshStatus();
      if (s === 'connected') {
        sendWindowStatus();
        void windowTitle?.refresh();
      }
    }),
  );

  const sendWindowStatus = () => {
    if (!cfg.role) return;
    const theme = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
    daemon.api?.notify('window.status', { focused: vscode.window.state.focused, ...(theme ? { theme } : {}) });
  };
  context.subscriptions.push(vscode.window.onDidChangeWindowState(() => sendWindowStatus()));

  // 별도 통합 창 테마 동기화: 이 창의 테마 색을 데몬에 알려요(붙을 때·테마를 바꿀 때·포커스를 받을 때). 데몬은 가장 최근에 포커스된
  // 창의 것을 통합 창에 줘요. 같은 테마면 다시 읽지 않아요(색 사용자 지정이 바뀌면 다시).
  let themeCache: { key: string; theme: HubTheme } | undefined;
  const sendTheme = async () => {
    if (!cfg.role || !daemon.api) return;
    const wb = vscode.workspace.getConfiguration('workbench');
    const win = vscode.workspace.getConfiguration('window');
    const kind = vscode.window.activeColorTheme.kind;
    // 지금 보이는 테마(자동 밝기·고대비 전환 포함) — workbench.colorTheme만 보면 다른 테마의 색을 보내요
    const themeName = resolveActiveThemeName(
      {
        colorTheme: wb.get<string>('colorTheme'),
        preferredDarkColorTheme: wb.get<string>('preferredDarkColorTheme'),
        preferredLightColorTheme: wb.get<string>('preferredLightColorTheme'),
        preferredHighContrastColorTheme: wb.get<string>('preferredHighContrastColorTheme'),
        preferredHighContrastLightColorTheme: wb.get<string>('preferredHighContrastLightColorTheme'),
        autoDetectColorScheme: win.get<boolean>('autoDetectColorScheme'),
        autoDetectHighContrast: win.get<boolean>('autoDetectHighContrast'),
      },
      themeKindOf(kind),
      vscode.extensions.all,
    );
    const customizations = wb.get('colorCustomizations');
    // 테마 파일 위치도 열쇠에: 테마 확장이 늦게 깔리거나 업데이트되면 다시 읽어요
    const file = themeName ? findThemeFile(vscode.extensions.all, themeName)?.path : undefined;
    const key = JSON.stringify([themeName, kind, customizations, file]);
    try {
      if (themeCache?.key !== key) {
        const theme = await buildHubTheme({
          kind,
          themeName,
          extensions: vscode.extensions.all,
          customizations,
          readFile: (p) => readFile(p, 'utf8'),
        });
        themeCache = { key, theme };
      }
      daemon.api?.notify('window.theme', themeCache.theme);
    } catch (e) {
      log.warn(`theme colors not sent: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => void sendTheme()),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) void sendTheme();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      // 테마 선택기(Ctrl+K Ctrl+T)는 미리 보기로 바꾸고 고를 때 설정만 써요(그때는 활성 테마 이벤트가 없어요)
      if (
        e.affectsConfiguration('workbench.colorCustomizations') ||
        e.affectsConfiguration('workbench.colorTheme') ||
        e.affectsConfiguration('workbench.preferredDarkColorTheme') ||
        e.affectsConfiguration('workbench.preferredLightColorTheme') ||
        e.affectsConfiguration('workbench.preferredHighContrastColorTheme') ||
        e.affectsConfiguration('workbench.preferredHighContrastLightColorTheme') ||
        e.affectsConfiguration('window.autoDetectColorScheme') ||
        e.affectsConfiguration('window.autoDetectHighContrast')
      )
        void sendTheme();
    }),
    vscode.extensions.onDidChange(() => {
      themeCache = undefined;
      void sendTheme();
    }),
    daemon.onStateChange((s) => {
      if (s === 'connected') void sendTheme();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('workbench.colorTheme')) sendWindowStatus();
      if (!e.affectsConfiguration('mark42')) return;
      const prev = cfg;
      cfg = readConfig();
      refreshStatus();
      sessionsView?.refresh();
      tasks?.refresh();
      if (prev.role !== cfg.role || prev.slotId !== cfg.slotId || prev.folderPath !== cfg.folderPath || prev.home !== cfg.home) {
        log.info(`role config changed → re-hello (role=${cfg.role ?? '-'})`);
        daemon.restart();
      }
      if (prev.pipeName !== cfg.pipeName) {
        void vscode.window.showInformationMessage(vscode.l10n.t('The daemon pipe name changed. Reload the window to apply it.'), vscode.l10n.t('Reload window')).then((a) => {
          if (a) void vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
      }
    }),
  );

  // 제한 모드(작업 영역 신뢰 안 함): Claude·Codex 확장이 꺼지고 역할 설정(mark42.role 등)도 읽히지 않아요. 역할 창이면 알리고,
  // 신뢰를 허용하면 역할을 다시 읽어 다시 접속해요 — 데몬이 들고 있던 세션 열기 요청(5분)을 그때 받아요.
  // 작업 영역 파일 위치도 신뢰돼야 해서, 창마다 새로 만드는 역할 파일은 «신뢰»를 눌러도 다음 창에서 다시 물어요 →
  // <home>\roles를 신뢰할 수 있는 폴더에 한 번 넣도록 안내해요(확장이 신뢰 목록을 바꾸는 API는 없어요).
  const roleFile = vscode.workspace.workspaceFile;
  const roleHome = !vscode.workspace.isTrusted && roleFile?.scheme === 'file' ? roleWorkspaceHome(roleFile.fsPath) : undefined;
  if (roleHome) {
    log.warn('role window opened in restricted mode: agent extensions and role settings are off until trusted');
    void vscode.window
      .showWarningMessage(
        vscode.l10n.t(
          'This Mark42 role window is in Restricted Mode. Trust it to turn on the Claude/Codex extensions and the Mark42 role. To stop being asked in every window, add {0} and your work folder to «Trusted Folders».',
          join(roleHome, 'roles'),
        ),
        vscode.l10n.t('Manage trust'),
      )
      .then((a) => {
        if (a) void vscode.commands.executeCommand('workbench.trust.manage');
      });
  }
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      const prev = cfg;
      cfg = readConfig();
      refreshStatus();
      sessionsView?.refresh();
      tasks?.refresh();
      void vscode.commands.executeCommand('setContext', 'mark42.role', cfg.role ?? '');
      if (prev.role !== cfg.role || prev.slotId !== cfg.slotId || prev.folderPath !== cfg.folderPath || prev.home !== cfg.home) {
        log.info(`workspace trusted → re-hello (role=${cfg.role ?? '-'})`);
        daemon.restart();
      }
    }),
  );

  registerCommands(context, { log, daemon, controller, router, hub, config: () => cfg, sessionsView });
  void vscode.commands.executeCommand('setContext', 'mark42.role', cfg.role ?? '');

  daemon.start();

  if (cfg.role === 'hub') {
    hub.show();
    if (!cfg.daemonPath) {
      const warnTimer = setTimeout(() => {
        if (daemon.state !== 'connected') {
          void vscode.window.showWarningMessage(
            vscode.l10n.t('Could not connect to the mk42d daemon. Set mark42.daemonPath and the hub window will start the daemon.'),
            vscode.l10n.t('Open settings'),
          ).then((a) => {
            if (a) void vscode.commands.executeCommand('workbench.action.openSettings', 'mark42.daemonPath');
          });
        }
      }, 5_000);
      context.subscriptions.push({ dispose: () => clearTimeout(warnTimer) });
    }
  }
}

export function deactivate(): void {
  // 정리는 context.subscriptions가 해요
}

interface CommandDeps {
  log: Logger;
  daemon: DaemonClient;
  controller: AgentController;
  router: LinkRouter;
  hub: HubPanel;
  config: () => RoleConfig;
  sessionsView: SessionsView;
}

async function confirmInAgentWindow(cfg: RoleConfig, question: string, action: string): Promise<boolean> {
  if (!isAgentRole(cfg.role)) return true;
  const go = await vscode.window.showWarningMessage(
    question,
    { modal: true, detail: vscode.l10n.t('If an agent is working, the turn in progress may be cut off.') },
    action,
  );
  return go === action;
}

function registerCommands(context: vscode.ExtensionContext, d: CommandDeps): void {
  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('mark42.reloadWindow', async () => {
    if (await confirmInAgentWindow(d.config(), vscode.l10n.t('Reload window?'), vscode.l10n.t('Reload window'))) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  });
  reg('mark42.restartExtensionHost', async () => {
    if (await confirmInAgentWindow(d.config(), vscode.l10n.t('Reload extensions?'), vscode.l10n.t('Reload extensions'))) {
      await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
    }
  });
  reg('mark42.maximizeAgentPanel', () => maximizeAgentPanel());
  reg('mark42.selectTheme', async () => {
    // 창별 테마(R9): 역할 워크스페이스에 값이 있으면 테마 선택이 그 워크스페이스 설정에 써져요(가정 — 실측 필요).
    const cfg = d.config();
    if (cfg.role && vscode.workspace.workspaceFile?.scheme === 'file') {
      const wb = vscode.workspace.getConfiguration('workbench');
      const insp = wb.inspect<string>('colorTheme');
      if (insp && insp.workspaceValue === undefined) {
        const current = wb.get<string>('colorTheme');
        if (current) await wb.update('colorTheme', current, vscode.ConfigurationTarget.Workspace);
      }
    }
    await vscode.commands.executeCommand('workbench.action.selectTheme');
  });
  reg('mark42.addFolder', async () => {
    const api = d.daemon.api;
    if (!api) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Not connected to the daemon, so folders cannot be registered.'));
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: true,
      openLabel: vscode.l10n.t('Register'),
      title: vscode.l10n.t('Choose folders to register with Mark42'),
    });
    if (!picked?.length) return;
    let ok = 0;
    for (const uri of picked) {
      try {
        await api.request('folders.add', { path: uri.fsPath });
        ok++;
      } catch (e) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Could not register the folder: {0} ({1})', uri.fsPath, e instanceof Error ? e.message : String(e)));
      }
    }
    if (ok) void vscode.window.showInformationMessage(vscode.l10n.t('Registered {0} folder(s).', ok));
  });
  reg('mark42.openHub', async () => {
    if (d.config().role === 'hub') {
      d.hub.show();
      return;
    }
    const api = d.daemon.api;
    if (!api) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Not connected to the daemon, so the hub window cannot be opened.'));
      return;
    }
    try {
      await api.request('window.open', { role: 'hub', folderPath: '' });
    } catch (e) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not open the hub window: {0}', e instanceof Error ? e.message : String(e)));
    }
  });
  // 내부·시험용: 이 창에서 직접 agent.openSession을 흉내 내요(데몬 보고 없음)
  reg('mark42.openAgentSession', async (args?: Partial<AgentOpenSessionParams>) => {
    const cfg = d.config();
    const role = cfg.role;
    const agent: AgentKind | undefined = args?.agent ?? (role === 'agent-claude' ? 'claude' : role === 'agent-codex' ? 'codex' : undefined);
    if (!agent || AGENT_ROLES[agent] !== role) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Only available in an agent window.'));
      return;
    }
    if (args?.sessionId !== undefined && !isSafeSessionId(args.sessionId)) {
      void vscode.window.showErrorMessage(vscode.l10n.t('The session ID format is not valid.'));
      return;
    }
    await d.controller.handleOpenSession(
      {
        requestId: `local-${Date.now()}`,
        agent,
        ...(args?.sessionId !== undefined ? { sessionId: args.sessionId } : { newSession: true }),
        ...(args?.settings ? { settings: args.settings } : {}),
        ...(args?.prompt !== undefined ? { prompt: args.prompt } : {}),
        autoSend: args?.autoSend ?? false,
      },
      false,
    );
  });
  reg('mark42.openLinkInEditor', async (uri?: string | vscode.Uri, kind?: LinkKind) => {
    if (!uri) return;
    try {
      await d.router.openLink(uri, kind);
    } catch (e) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not open the link: {0}', e instanceof Error ? e.message : String(e)));
    }
  });
  reg('mark42.smoke', () => d.controller.runSmoke());
  reg('mark42.daemonStatus', async () => {
    const cfg = d.config();
    const st = d.daemon.state;
    const role = roleLabel(cfg.role, t);
    const conn =
      st === 'connected'
        ? t('connected')
        : st === 'connecting'
          ? t('connecting')
          : d.daemon.lastError
            ? t('disconnected — {0}', d.daemon.lastError)
            : t('disconnected');
    const lines = [
      cfg.slotId ? t('Role: {0} (slot {1})', role, cfg.slotId) : t('Role: {0}', role),
      t('Connection: {0}', conn),
      t('Pipe: {0}', d.daemon.pipeName),
      d.daemon.windowId ? t('Window ID: {0}', d.daemon.windowId) : undefined,
      d.daemon.daemonVersion ? t('Daemon version: {0}', d.daemon.daemonVersion) : undefined,
      d.controller.sessionId ? t('Session: {0}', d.controller.sessionId) : undefined,
    ].filter(Boolean);
    const reconnect = t('Reconnect');
    const showLog = t('Show log');
    const a = await vscode.window.showInformationMessage(t('Mark42 daemon status'), { modal: true, detail: lines.join('\n') }, reconnect, showLog);
    if (a === reconnect) d.daemon.reconnectNow();
    else if (a === showLog) d.log.show();
  });
  reg('mark42.refreshSessions', () => d.sessionsView.refresh());
  reg('mark42.openSessionItem', async (item?: { agent: AgentKind; sessionId?: string; newSession?: boolean }) => {
    if (!item) return;
    const cfg = d.config();
    const api = d.daemon.api;
    const folderPath = resolveFolderPath(cfg, hostEnv(context));
    if (!api || !folderPath) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Not connected to the daemon or no folder is open, so the session cannot be opened.'));
      return;
    }
    // 이 창이 든 세션이면 패널만 보여 줘요
    if (item.sessionId && item.sessionId === d.controller.sessionId) {
      // claude-vscode.sidebar.open은 사용자 설정 preferredLocation을 바꿔서 쓰지 않아요
      const focus = item.agent === 'claude' ? 'claudeVSCodeSidebarSecondary.focus' : 'chatgpt.openSidebar';
      await vscode.commands.executeCommand(focus).then(undefined, () => {});
      return;
    }
    try {
      await api.request('window.open', {
        folderPath,
        role: AGENT_ROLES[item.agent],
        ...(item.sessionId ? { sessionId: item.sessionId } : { newSession: true }),
      });
    } catch (e) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not open the session window: {0}', e instanceof Error ? e.message : String(e)));
    }
  });
}
