// 에이전트 창의 «업데이트 확인·적용» 단추(에이전트 패널 제목줄, 최대화 단추 옆). 이 창의 에이전트 확장(Claude Code·Codex)이 실행 중인
// 버전보다 높은 버전이 확장 폴더에 깔려 있으면 «업데이트 적용»으로 바뀌어요. 아니면 누르면 데몬에 지금 확인을 맡기고
// (extensions.checkUpdates — 갤러리 판을 데몬이 검증해서 깔아요), 새 버전이 깔리면 적용할지 물어요.
// 적용: 밖(CLI·데몬)에서 깐 새 버전은 «확장 다시 로드»(restartExtensionHost)로는 안 바뀌어요(확장 목록을 다시 읽지 않아요) — Mk42 패치의
// `mark42.extensions.restartUpdated`(VS Code «확장 다시 시작»과 같은 길)로, 그 명령이 없거나 바꿀 게 없다고 하면 창 다시 로드로.
// 검증: 데몬은 갤러리 판을 공식 판의 기준 해시와 대조해 같을 때만 깔아요. 대조하지 못한 새 버전은 단추가 «검증 안 된 새 버전»
// (`$(warning)`)으로 바뀌고, 누르면 면책 문구와 함께 위험을 감수하고 깔지 묻고, 다르면 막아요. 직접 받은 VSIX로 까는 길은 늘 열어 둬요.
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import type { AgentExtensionUpdate, DaemonApi, WindowRole } from '@mark42/protocol';
import { compareVersions, newestVersion } from './lib/extVersions.ts';
import type { Logger } from './log.ts';

export const UPDATE_READY_CONTEXT = 'mark42.agentUpdateReady';
/** 데몬이 검증하지 못한 새 버전이 사용자 확인을 기다려요 */
export const UPDATE_UNVERIFIED_CONTEXT = 'mark42.agentUpdateUnverified';
export const AGENT_WINDOW_CONTEXT = 'mark42.agentWindow';
export const AGENT_UPDATE_CHECK_COMMAND = 'mark42.agentUpdate.check';
export const AGENT_UPDATE_APPLY_COMMAND = 'mark42.agentUpdate.apply';
export const AGENT_UPDATE_UNVERIFIED_COMMAND = 'mark42.agentUpdate.unverified';
/** 업데이트와 따로 있는 «확장 다시 로드» 단추(2026-11-02 사용자 요청 — 둘을 나눠 줘) */
export const AGENT_RELOAD_COMMAND = 'mark42.agentUpdate.reload';
/** Mk42 패치(2026-11-02~): 보기 제목줄 단추 왼쪽 글자(에이전트 확장 버전) */
export const SET_TITLE_LABEL_COMMAND = 'mark42.views.setTitleLabel';
/** Mk42 패치(2026-10-30~): 밖에서 깐 새 버전으로 확장을 다시 시작해요. 다시 시작한 확장 수 */
export const RESTART_UPDATED_COMMAND = 'mark42.extensions.restartUpdated';

const AGENTS: Partial<Record<WindowRole, { id: string; name: string; views: readonly string[] }>> = {
  'agent-claude': { id: 'anthropic.claude-code', name: 'Claude Code', views: ['claudeVSCodeSidebarSecondary', 'claudeVSCodeSidebar'] },
  'agent-codex': { id: 'openai.chatgpt', name: 'Codex', views: ['chatgpt.sidebarSecondaryView', 'chatgpt.sidebarView'] },
};

function verificationLabel(v: string): string | undefined {
  switch (v) {
    case 'verified':
      return vscode.l10n.t('Verified against the official build');
    case 'unverified':
      return vscode.l10n.t('Not verified against the official build');
    case 'mismatch':
      return vscode.l10n.t('Differs from the official build — it may have been tampered with');
    case 'marketplace':
      return vscode.l10n.t('Downloaded from a trusted source');
    default:
      return undefined;
  }
}

/** Codex VSIX 받기(약 600MB)·설치까지 기다려요 */
const CHECK_TIMEOUT_MS = 20 * 60_000;
const POLL_MS = 15 * 60_000;
const FOCUS_THROTTLE_MS = 60_000;

// 단추 이름 — 언어 번들이 정해진 뒤(활성화 때) 읽도록 함수로 둬요
const APPLY = (): string => vscode.l10n.t('Apply update');
const RELOAD = (): string => vscode.l10n.t('Reload');
const INSTALL_ANYWAY = (): string => vscode.l10n.t('Install at my own risk');
const FROM_VSIX = (): string => vscode.l10n.t('Install from VSIX directly…');
const RETRY = (): string => vscode.l10n.t('Retry');
/** 검증되지 않은 확장을 깔 때 보여 주는 면책 문구 */
export function unverifiedDisclaimer(): string {
  return vscode.l10n.t(
    'This version has not been verified against the official build. Installing it runs code whose origin could not be confirmed, and any resulting problems are your responsibility. Mark42 does not vouch for the contents of this extension. You can also install a VSIX you downloaded yourself from the publisher\'s official source.',
  );
}

export class AgentUpdateButton implements vscode.Disposable {
  #role: () => WindowRole | undefined;
  #api: () => DaemonApi | undefined;
  #log: Logger;
  #disposables: vscode.Disposable[] = [];
  /** 깔려 있지만 아직 실행되지 않은 새 버전 */
  #pending: string | undefined;
  /** 데몬이 마지막으로 알려 준 이 확장의 상태(검증 대기·막힘) */
  #daemonState: AgentExtensionUpdate | undefined;
  #lastRefresh = 0;

  /** role은 읽을 때마다 — 제한 모드에서 신뢰를 받으면 역할이 늦게 정해져요 */
  constructor(role: () => WindowRole | undefined, api: () => DaemonApi | undefined, log: Logger) {
    this.#role = role;
    this.#api = api;
    this.#log = log;
    const timer = setInterval(() => void this.refresh(), POLL_MS);
    this.#disposables.push(
      vscode.commands.registerCommand(AGENT_UPDATE_CHECK_COMMAND, () => this.check()),
      vscode.commands.registerCommand(AGENT_UPDATE_APPLY_COMMAND, () => this.apply()),
      vscode.commands.registerCommand(AGENT_UPDATE_UNVERIFIED_COMMAND, () => this.check()),
      vscode.commands.registerCommand(AGENT_RELOAD_COMMAND, () => this.reload()),
      { dispose: () => clearInterval(timer) },
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && Date.now() - this.#lastRefresh > FOCUS_THROTTLE_MS) void this.refresh();
      }),
      // Mk42 자체 자동 업데이트(Claude Code)가 깔았을 때도
      vscode.extensions.onDidChange(() => void this.refresh()),
    );
    void this.refresh();
  }

  #agent(): { id: string; name: string; views: readonly string[] } | undefined {
    const role = this.#role();
    return role ? AGENTS[role] : undefined;
  }

  /** 지금 실행 중인 버전 */
  running(): string | undefined {
    const agent = this.#agent();
    const v = agent ? (vscode.extensions.getExtension(agent.id)?.packageJSON as { version?: unknown } | undefined)?.version : undefined;
    return typeof v === 'string' ? v : undefined;
  }

  /** 확장 폴더를 다시 살펴 단추를 맞춰요. 깔린 새 버전(없으면 undefined) */
  async refresh(): Promise<string | undefined> {
    this.#lastRefresh = Date.now();
    const agent = this.#agent();
    const ext = agent ? vscode.extensions.getExtension(agent.id) : undefined;
    const running = this.running();
    let pending: string | undefined;
    if (agent && ext && running && typeof ext.extensionPath === 'string') {
      const dir = dirname(ext.extensionPath);
      try {
        const names = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
        let obsolete = new Set<string>();
        try {
          obsolete = new Set(Object.keys(JSON.parse(await fsp.readFile(join(dir, '.obsolete'), 'utf8')) as object).map((k) => k.toLowerCase()));
        } catch {
          // 없으면 없음
        }
        const newest = newestVersion(names, obsolete, agent.id);
        // 반쯤 깔린 폴더(package.json 아직 없음)는 아직 아니에요
        if (newest && compareVersions(newest, running) > 0 && (await hasManifest(dir, names, agent.id, newest))) pending = newest;
      } catch (e) {
        this.#log.warn(`agent update: ${dir} not read (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    if (pending !== this.#pending) {
      this.#pending = pending;
      if (pending) this.#log.info(`agent update ready: ${agent?.id} ${running} -> ${pending}`);
    }
    if (agent) {
      await this.#readDaemonState(agent.id);
      this.#warnInstalledMismatch(agent);
      this.#promptMissing(agent);
    }
    await vscode.commands.executeCommand('setContext', AGENT_WINDOW_CONTEXT, agent !== undefined);
    await vscode.commands.executeCommand('setContext', UPDATE_READY_CONTEXT, pending !== undefined);
    await vscode.commands.executeCommand('setContext', UPDATE_UNVERIFIED_CONTEXT, pending === undefined && this.#daemonState?.status === 'pending');
    if (agent) await this.#showVersion(agent, running, pending);
    return pending;
  }

  #versionLabel: string | undefined;

  /** 패널 제목줄 단추 왼쪽에 실행 중 버전(Mk42 패치 명령이 있을 때만). 눌러도 업데이트 확인 */
  async #showVersion(agent: { name: string; views: readonly string[] }, running: string | undefined, pending: string | undefined): Promise<void> {
    if (!running) return;
    const ver = this.#daemonState?.installed === running ? this.#daemonState.installedVerification : undefined;
    const mark = ver === 'verified' || ver === 'marketplace' ? ' ✓' : ver === 'mismatch' ? ' ✖' : ver === 'unverified' ? ' ⚠' : '';
    const text = `${running}${mark}`;
    const tooltip = [
      vscode.l10n.t('{0} {1} running', agent.name, running),
      ver ? verificationLabel(ver) : undefined,
      pending ? vscode.l10n.t('{0} installed — switch with the apply update button', pending) : undefined,
    ]
      .filter(Boolean)
      .join('\n');
    const key = `${text}|${tooltip}`;
    if (key === this.#versionLabel) return;
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes(SET_TITLE_LABEL_COMMAND)) return; // 옛 빌드
    this.#versionLabel = key;
    for (const view of agent.views) await vscode.commands.executeCommand(SET_TITLE_LABEL_COMMAND, view, text, tooltip, AGENT_UPDATE_CHECK_COMMAND);
  }

  /** 데몬이 마지막으로 확인한 이 확장의 상태(네트워크 없이). 옛 데몬·연결 끊김이면 그대로 */
  async #readDaemonState(id: string): Promise<void> {
    const api = this.#api();
    if (!api) return;
    try {
      const r = await api.request('extensions.status', { ids: [id] });
      this.#daemonState = r.updates.find((u) => u.id.toLowerCase() === id.toLowerCase());
    } catch {
      // 옛 데몬(MethodNotFound) — 검증 상태 없이
    }
  }

  #warnedMismatch: string | undefined;
  #promptedMissing: string | undefined;

  /**
   * 이 창의 에이전트 확장이 아직 없을 때(첫 실행) — 그 확장의 보기·단추가 없으니 여기서 직접 물어요.
   * 검증 대기면 면책 확인, 실패면 다시 시도. 상태·버전마다 한 번만.
   */
  #promptMissing(agent: { id: string; name: string }): void {
    const u = this.#daemonState;
    if (this.running() || !u || (u.status !== 'pending' && u.status !== 'failed')) return;
    const key = `${u.status}:${u.pending ?? u.latest ?? ''}`;
    if (this.#promptedMissing === key) return;
    this.#promptedMissing = key;
    if (u.status === 'pending') {
      void this.#askUnverified(agent, u);
      return;
    }
    void vscode.window
      .showWarningMessage(vscode.l10n.t('{0} is not installed yet: {1}', agent.name, u.error ?? vscode.l10n.t('unknown error')), RETRY())
      .then((pick) => (pick === RETRY() ? this.check() : undefined));
  }

  /** 지금 깔린 판이 공식 판과 다르면(데몬이 대조) 버전마다 한 번 알려요 */
  #warnInstalledMismatch(agent: { id: string; name: string }): void {
    const u = this.#daemonState;
    if (u?.installedVerification !== 'mismatch' || !u.installed || this.#warnedMismatch === u.installed) return;
    this.#warnedMismatch = u.installed;
    void vscode.window
      .showErrorMessage(
        vscode.l10n.t(
          'The installed {0} {1} differs from the official build. It may have been tampered with — reinstall it from a VSIX downloaded from the publisher\'s official source.',
          agent.name,
          u.installed,
        ),
        FROM_VSIX(),
      )
      .then((pick) => (pick === FROM_VSIX() ? this.#installFromVsix() : undefined));
  }

  /** 검증되지 않은 새 버전: 면책 문구와 함께 위험을 감수하고 깔지, 직접 받은 VSIX로 깔지 물어요 */
  async #askUnverified(agent: { id: string; name: string }, u: AgentExtensionUpdate): Promise<void> {
    const version = u.pending ?? u.latest ?? '?';
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t('{0} {1} is a new, unverified version.', agent.name, version),
      { modal: true, detail: `${u.reason ? `${vscode.l10n.t('Reason: {0}', u.reason)}

` : ''}${unverifiedDisclaimer()}` },
      INSTALL_ANYWAY(),
      FROM_VSIX(),
    );
    if (pick === FROM_VSIX()) return this.#installFromVsix();
    if (pick !== INSTALL_ANYWAY()) return;
    const api = this.#api();
    if (!api) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Not connected to the daemon, so it could not be installed.'));
      return;
    }
    let r: AgentExtensionUpdate;
    try {
      r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Installing {0} {1}…', agent.name, version) }, () =>
        api.request('extensions.installUnverified', { id: agent.id, version }, CHECK_TIMEOUT_MS),
      );
    } catch (e) {
      // 그사이 기준이 생겨 대조했더니 달랐으면 데몬이 막고 거절해요
      await this.refresh();
      if (this.#daemonState?.status === 'blocked') return this.#explainBlocked(agent, this.#daemonState);
      void vscode.window.showWarningMessage(vscode.l10n.t('Could not install: {0}', e instanceof Error ? e.message : String(e)));
      return;
    }
    if (r.status === 'failed') {
      void vscode.window.showWarningMessage(vscode.l10n.t('Could not install: {0}', r.error ?? vscode.l10n.t('unknown error')));
      return;
    }
    const wasMissing = !this.running();
    if (await this.refresh()) await this.apply();
    else if (wasMissing) await this.#reloadForFirstInstall(agent);
  }

  /** 처음 깐 에이전트 확장은 창을 다시 불러와야 떠요 */
  async #reloadForFirstInstall(agent: { name: string }): Promise<void> {
    const go = await vscode.window.showInformationMessage(vscode.l10n.t('{0} is installed. Reload the window to start it?', agent.name), RELOAD());
    if (go === RELOAD()) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  /** 공식 판과 달라 막힌 버전 — 깔지 않았다고 알리고 직접 받은 VSIX 길만 안내해요 */
  async #explainBlocked(agent: { id: string; name: string }, u: AgentExtensionUpdate): Promise<void> {
    const pick = await vscode.window.showErrorMessage(
      vscode.l10n.t('{0} {1} on Open VSX differs from the official build, so it was not installed.', agent.name, u.latest ?? ''),
      {
        modal: true,
        detail: `${u.reason ? `${vscode.l10n.t('Difference: {0}', u.reason)}

` : ''}${vscode.l10n.t('It may be a tampered build. If needed, install a VSIX downloaded from the publisher\'s official source.')}`,
      },
      FROM_VSIX(),
    );
    if (pick === FROM_VSIX()) await this.#installFromVsix();
  }

  /** 기본 «VSIX에서 설치…» — 사용자가 직접 받은 파일로 */
  async #installFromVsix(): Promise<void> {
    await vscode.commands.executeCommand('workbench.extensions.action.installVSIX');
    if (await this.refresh()) await this.apply();
  }

  /** 깔린 새 버전으로 바꿔요(확인 창) — Mk42 패치 명령, 안 되면 창 다시 로드 */
  async apply(): Promise<void> {
    const agent = this.#agent();
    const pending = await this.refresh();
    const what = agent && pending ? `${agent.name} ${this.running() ?? '?'} → ${pending}. ` : '';
    const go = await vscode.window.showWarningMessage(
      pending ? vscode.l10n.t('Apply the update?') : vscode.l10n.t('Reload the extensions?'),
      { modal: true, detail: `${what}${vscode.l10n.t('Sessions continue, but if an agent is working, the turn in progress may be cut off.')}` },
      pending ? APPLY() : RELOAD(),
    );
    if (go !== APPLY() && go !== RELOAD()) return;
    if (!pending) {
      await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
      return;
    }
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes(RESTART_UPDATED_COMMAND)) {
      const restarted = await vscode.commands.executeCommand<number>(RESTART_UPDATED_COMMAND);
      if (typeof restarted === 'number' && restarted > 0) return; // 확장 호스트가 새 버전으로 다시 떠요(이 확장도 다시 켜져요)
      this.#log.warn('agent update: restartUpdated changed nothing, reloading the window');
    }
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  /**
   * «확장 다시 로드» 단추 — 새 버전이 깔려 있으면 그 버전으로(업데이트 적용과 같아요, 그냥 다시 시작하면 옛 버전이 다시 떠요),
   * 아니면 확인 뒤 확장 호스트를 다시 시작해요.
   */
  async reload(): Promise<void> {
    await this.apply();
  }

  /** 지금 업데이트 확인(데몬) → 새 버전이 깔리면 적용할지 물어요. 다시 로드는 따로 있는 단추로 */
  async check(): Promise<void> {
    const agent = this.#agent();
    if (!agent) return;
    if (await this.refresh()) {
      await this.apply();
      return;
    }
    const api = this.#api();
    let note = '';
    if (!api) {
      note = vscode.l10n.t('Not connected to the daemon, so new versions could not be checked.');
    } else {
      try {
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking for {0} updates…', agent.name) },
          () => api.request('extensions.checkUpdates', { ids: [agent.id] }, CHECK_TIMEOUT_MS),
        );
        const mine = r.updates.find((u) => u.id.toLowerCase() === agent.id.toLowerCase());
        this.#daemonState = mine;
        if (mine?.status === 'pending') {
          await this.refresh();
          return this.#askUnverified(agent, mine);
        }
        if (mine?.status === 'blocked') {
          await this.refresh();
          return this.#explainBlocked(agent, mine);
        }
        if (!mine) note = vscode.l10n.t('The daemon did not check this extension (Mk42 app settings not found).');
        else if (mine.status === 'failed') note = vscode.l10n.t('Could not check or install the update: {0}', mine.error ?? vscode.l10n.t('unknown error'));
        else if (mine.status === 'updated' && !(await this.refresh())) {
          note = vscode.l10n.t(
            '{0} was installed but is not visible in this window’s extensions folder — try reloading the window.',
            mine.installed ?? vscode.l10n.t('A new version'),
          );
        }
      } catch (e) {
        note = vscode.l10n.t('Could not check for updates: {0}', e instanceof Error ? e.message : String(e));
      }
    }
    if (await this.refresh()) {
      await this.apply();
      return;
    }
    const msg = note || vscode.l10n.t('{0} {1} is up to date.', agent.name, this.running() ?? '');
    if (note) void vscode.window.showWarningMessage(msg);
    else void vscode.window.showInformationMessage(msg);
  }

  dispose(): void {
    for (const d of this.#disposables.splice(0)) d.dispose();
  }
}

/** 그 버전 폴더에 package.json이 있는지(설치가 끝났는지) */
async function hasManifest(dir: string, names: readonly string[], id: string, version: string): Promise<boolean> {
  const prefix = `${id}-${version}`.toLowerCase();
  const folder = names.find((n) => {
    const l = n.toLowerCase();
    return l === prefix || l.startsWith(`${prefix}-`);
  });
  if (!folder) return false;
  try {
    await fsp.access(join(dir, folder, 'package.json'));
    return true;
  } catch {
    return false;
  }
}
