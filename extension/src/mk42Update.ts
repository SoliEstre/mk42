// Mk42 자체 업데이트 알림(계약 C4, 2026-11-05). 데몬(updater.ts)이 새 판 설치 파일을 받아 서명·sha256을 맞추면 `update.changed`(state ready)를
// 보내요. «지금 설치할까요?»는 창 하나만 물어요 — 데몬이 고른 창(가장 최근 포커스, 없으면 처음 붙는 창)에만 announce:true가 와요.
// 준비된 동안은 창마다 상태 표시줄에 «$(cloud-download) Mk42 <판>»(누르면 같은 질문). «설치» = update.install — 설치 엔진이 데몬을 바꿔 끼우고
// 창은 닫지 않아요(창은 새 데몬에 다시 붙어요). 명령 «Mk42 업데이트 확인»(mark42.update.check)은 지금 서버를 확인해요.
// 자동 받기가 꺼져 있으면(settings.update.autoDownload — 통합 창 ⚙) 새 판은 available로 와요: 상태 표시줄 «$(cloud) Mk42 <판>»을 누르면
// «받을까요?» → update.download. 설정은 통합 창에서만 바꿔요.
// «다시 시작해서 적용»(교훈 012): 새 앱 판이 깔렸는데 열린 창이 옛 판 main에서 돌면 데몬이 상태에 appRestart를 실어요 — 상태 표시줄
// «$(sync) Mk42 <판> — 다시 시작해서 적용»을 누르면 모달로 확인한 뒤(창을 묻지 않고 닫지 않아요) app.restartToUpdate. 데몬이 옛 판 창에
// app.quitForUpdate를 보내면 이 창 판일 때 앱을 끝내요(workbench.action.quit) — 데몬이 옛 main이 끝난 뒤 같은 창을 새 판으로 다시 열어요.
// 단추는 Mk42 창(vscode.env.appName «Mark42»)에만 보여요. 옛 판 창이 모두 옛 Mark42 확장이면(appRestart.needsReload) 다시 시작하지 않고
// 그 창 하나를 다시 로드하거나 직접 닫으라고 안내해요(옛 확장은 app.quitForUpdate를 몰라요).
import * as vscode from 'vscode';
import type {
  AppQuitForUpdateParams,
  DaemonApi,
  DaemonNotification,
  DaemonNotificationMap,
  Mk42UpdateChanged,
  Mk42UpdateStatus,
} from '@mark42/protocol';
import type { ConnectionState } from './daemonClient.ts';
import type { Logger } from './log.ts';

export const MK42_UPDATE_CHECK_COMMAND = 'mark42.update.check';
/** 상태 표시줄 단추(내부) — 준비된 판을 설치할지 다시 물어요 */
export const MK42_UPDATE_PROMPT_COMMAND = 'mark42.update.prompt';
/** 상태 표시줄 단추(내부) — «다시 시작해서 적용»을 확인받고 app.restartToUpdate */
export const MK42_APP_RESTART_COMMAND = 'mark42.update.restartApp';
const STATUS_ITEM_ID = 'mark42.mk42Update';
const RESTART_ITEM_ID = 'mark42.mk42AppRestart';
/** 확인은 서명 확인까지만 기다려요(받기는 데몬이 이어서) */
const CHECK_TIMEOUT_MS = 90_000;

export interface Mk42UpdateDaemon {
  readonly api: DaemonApi | undefined;
  onNotification(cb: <N extends DaemonNotification>(method: N, params: DaemonNotificationMap[N]) => void): { dispose(): void };
  onStateChange(cb: (s: ConnectionState) => void): { dispose(): void };
}

const STATES: ReadonlySet<string> = new Set(['disabled', 'idle', 'checking', 'available', 'downloading', 'ready', 'installing', 'error']);

/** 데몬이 보낸 값이 상태 모양인지(옛 데몬은 update.*를 몰라서 오류나 빈 값을 줘요) */
export function isMk42UpdateStatus(v: unknown): v is Mk42UpdateStatus {
  const s = v as Partial<Mk42UpdateStatus> | null | undefined;
  return typeof s === 'object' && s !== null && typeof s.state === 'string' && STATES.has(s.state) && typeof s.current === 'string';
}

/** 옛 판 창이 모두 옛 Mark42 확장 — 여기서 다시 시작할 수 없어요(C11) */
function needsReloadText(versions: readonly string[]): string {
  return vscode.l10n.t(
    'Mk42 {0} windows run an older Mark42 extension that cannot restart them. Reload one of those windows (Developer: Reload Window) or close them yourself, then try again.',
    versions.join(', '),
  );
}

export class Mk42UpdateNotifier implements vscode.Disposable {
  #daemon: Mk42UpdateDaemon;
  #log: Logger;
  #disposables: vscode.Disposable[] = [];
  #item: vscode.StatusBarItem;
  /** «다시 시작해서 적용» 단추 — 업데이트 단추와 따로(받은 패키지 설치와 앱 다시 시작은 다른 일이에요) */
  #restartItem: vscode.StatusBarItem;
  #status: Mk42UpdateStatus | undefined;
  /** 이 창에서 이미 물은 판 */
  #announced = new Set<string>();
  #asking = false;
  #restartAsking = false;

  constructor(daemon: Mk42UpdateDaemon, log: Logger) {
    this.#daemon = daemon;
    this.#log = log;
    this.#restartItem = vscode.window.createStatusBarItem(RESTART_ITEM_ID, vscode.StatusBarAlignment.Right, 89);
    this.#item = vscode.window.createStatusBarItem(STATUS_ITEM_ID, vscode.StatusBarAlignment.Right, 90);
    this.#item.command = MK42_UPDATE_PROMPT_COMMAND;
    this.#disposables.push(
      this.#item,
      this.#restartItem,
      vscode.commands.registerCommand(MK42_UPDATE_CHECK_COMMAND, () => this.check()),
      vscode.commands.registerCommand(MK42_UPDATE_PROMPT_COMMAND, () => this.ask()),
      vscode.commands.registerCommand(MK42_APP_RESTART_COMMAND, () => this.restartApp()),
      daemon.onNotification((method, params) => {
        if (method === 'app.quitForUpdate') {
          void this.#quitForUpdate(params as AppQuitForUpdateParams);
          return;
        }
        if (method !== 'update.changed') return;
        const p = params as Mk42UpdateChanged;
        if (!isMk42UpdateStatus(p)) return;
        this.#apply(p);
        if (p.announce === true) void this.#announce();
      }),
      daemon.onStateChange((s) => {
        if (s === 'connected') void this.refresh();
        else if (s === 'disconnected') {
          if (this.#status?.state !== 'ready' && this.#status?.state !== 'available') this.#item.hide();
          this.#restartItem.hide(); // 다시 붙으면 새 상태로 다시 보여요
        }
      }),
    );
    void this.refresh();
  }

  get status(): Mk42UpdateStatus | undefined {
    return this.#status;
  }

  /** 마지막 상태를 다시 받아요(네트워크 없이) — 연결될 때 */
  async refresh(): Promise<void> {
    const api = this.#daemon.api;
    if (!api) return;
    try {
      const s = await api.request('update.status', {});
      if (isMk42UpdateStatus(s)) this.#apply(s);
    } catch (e) {
      // 옛 데몬은 update.*를 몰라요
      this.#log.debug(`update.status: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 명령 «Mk42 업데이트 확인» */
  async check(): Promise<void> {
    const api = this.#daemon.api;
    if (!api) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Could not check for updates: {0}', vscode.l10n.t('the Mark42 daemon is not connected')));
      return;
    }
    let s: Mk42UpdateStatus;
    try {
      const r = await api.request('update.check', {}, CHECK_TIMEOUT_MS);
      if (!isMk42UpdateStatus(r)) throw new Error(vscode.l10n.t('the Mark42 daemon does not support updates yet'));
      s = r;
    } catch (e) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Could not check for updates: {0}', e instanceof Error ? e.message : String(e)));
      return;
    }
    this.#apply(s);
    switch (s.state) {
      case 'ready':
      case 'available':
        await this.ask();
        return;
      case 'downloading':
        void vscode.window.showInformationMessage(vscode.l10n.t('Downloading Mk42 update {0}…', s.latest ?? ''));
        return;
      case 'installing':
        void vscode.window.showInformationMessage(vscode.l10n.t('Installing Mk42 update {0}…', s.latest ?? ''));
        return;
      case 'error':
        void vscode.window.showWarningMessage(vscode.l10n.t('Could not check for updates: {0}', s.error ?? '?'));
        return;
      case 'disabled':
        void vscode.window.showInformationMessage(vscode.l10n.t('This Mk42 installation has no update channel.'));
        return;
      default:
        void vscode.window.showInformationMessage(vscode.l10n.t('Mk42 is up to date ({0})', s.current));
    }
  }

  /** 준비된 판을 지금 설치할지(available이면 받을지) 물어요(상태 표시줄 단추·확인 명령·데몬이 고른 창) */
  async ask(): Promise<void> {
    const s = this.#status;
    if (s?.state === 'available') return this.#askDownload(s);
    if (!s || s.state !== 'ready' || !s.latest || this.#asking) return;
    const version = s.latest;
    this.#announced.add(version);
    this.#asking = true;
    try {
      const install = vscode.l10n.t('Install');
      const later = vscode.l10n.t('Later');
      const message = vscode.l10n.t('Mk42 update {0} has been downloaded. Install it now? (Open windows stay open.)', version);
      const pick = await vscode.window.showInformationMessage(s.notes ? `${message}\n\n${s.notes}` : message, install, later);
      if (pick !== install) return;
      await this.#install(version);
    } finally {
      this.#asking = false;
    }
  }

  /** 자동 받기가 꺼져 있어 기다리는 새 판 — 받을지 물어요 */
  async #askDownload(s: Mk42UpdateStatus): Promise<void> {
    if (!s.latest || this.#asking) return;
    const version = s.latest;
    this.#asking = true;
    try {
      const download = vscode.l10n.t('Download');
      const later = vscode.l10n.t('Later');
      const message = vscode.l10n.t('Mk42 update {0} is available. Download it now?', version);
      const pick = await vscode.window.showInformationMessage(s.notes ? `${message}\n\n${s.notes}` : message, download, later);
      if (pick !== download) return;
      const api = this.#daemon.api;
      let error: string | undefined;
      if (!api) error = vscode.l10n.t('the Mark42 daemon is not connected');
      else {
        try {
          const r = await api.request('update.download', {}, CHECK_TIMEOUT_MS);
          if (!isMk42UpdateStatus(r)) throw new Error(vscode.l10n.t('the Mark42 daemon does not support updates yet'));
          this.#apply(r);
          if (r.state === 'error') error = r.error ?? '?';
          else if (r.state === 'downloading') void vscode.window.showInformationMessage(vscode.l10n.t('Downloading Mk42 update {0}…', r.latest ?? version));
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
      if (error !== undefined) {
        this.#log.warn(`Mk42 update ${version}: download did not start (${error})`);
        void vscode.window.showErrorMessage(vscode.l10n.t('Could not download the Mk42 update: {0}', error));
      }
    } finally {
      this.#asking = false;
    }
  }

  /**
   * 상태 표시줄 «다시 시작해서 적용» — 모달로 확인받은 뒤에만 app.restartToUpdate(사용자 확인 없이 창을 닫지 않아요). Mk42가 연 창(에이전트·편집 창)은
   * 닫혔다 새 판으로 다시 열리고(통합 창은 그대로), 에이전트가 쓰고 있던 답은 끊길 수 있고, Mk42 밖에서 연 창(파일 > 폴더 열기)은 닫히기만 한다고
   * 알려요(데몬은 hello한 창만 기록해요 — 저장하지 않은 편집은 핫 종료 백업에 남아요).
   */
  async restartApp(): Promise<void> {
    const r = this.#status?.appRestart;
    if (!r || r.restarting || this.#restartAsking) return;
    if (r.needsReload?.length) {
      void vscode.window.showWarningMessage(needsReloadText(r.needsReload));
      return;
    }
    this.#restartAsking = true;
    try {
      const restart = vscode.l10n.t('Restart');
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t('Restart Mk42 to apply {0}?', r.available),
        {
          modal: true,
          detail: vscode.l10n.t(
            'Windows Mk42 opened (agent and editor windows) close and reopen on {0}; the hub window stays. Agent windows reopen their sessions without sending anything, but a reply an agent is still writing may be interrupted. Windows opened outside Mk42 (e.g. File > Open Folder) close without reopening; their unsaved edits are kept.',
            r.available,
          ),
        },
        restart,
      );
      if (pick !== restart) return;
      const api = this.#daemon.api;
      let error: string | undefined;
      if (!api) error = vscode.l10n.t('the Mark42 daemon is not connected');
      else {
        try {
          const res = await api.request('app.restartToUpdate', { available: r.available });
          if (res?.started === true) {
            this.#log.info(`Mk42 restart to ${r.available}: ${res.windows ?? '?'} window(s) will close and reopen`);
            return;
          }
          error = res?.error ?? '?';
        } catch (e) {
          // 옛 데몬은 app.restartToUpdate를 몰라요
          error = e instanceof Error ? e.message : String(e);
        }
      }
      this.#log.warn(`Mk42 restart to ${r.available} did not start (${error})`);
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not restart Mk42: {0}', error));
    } finally {
      this.#restartAsking = false;
    }
  }

  /** 데몬이 확인받은 다시 시작에서 옛 판 창에 보내요 — 이 창 판이면 앱을 끝내요(다른 판 창은 무시) */
  async #quitForUpdate(p: AppQuitForUpdateParams): Promise<void> {
    if (typeof p?.appVersion !== 'string' || p.appVersion !== vscode.version) {
      this.#log.debug(`app.quitForUpdate for ${String(p?.appVersion)} ignored (this window runs ${vscode.version})`);
      return;
    }
    this.#log.info(`Mk42 ${p.appVersion} quits to reopen on ${String(p.nextVersion)} (restart confirmed by the user)`);
    await vscode.commands.executeCommand('workbench.action.quit');
  }

  async #announce(): Promise<void> {
    const v = this.#status?.latest;
    if (!v || this.#announced.has(v)) return;
    await this.ask();
  }

  async #install(version: string): Promise<void> {
    const api = this.#daemon.api;
    let error: string | undefined;
    if (!api) error = vscode.l10n.t('the Mark42 daemon is not connected');
    else {
      try {
        const r = await api.request('update.install', {});
        if (r?.started === true) {
          this.#log.info(`Mk42 update ${version}: installer started`);
          return;
        }
        error = r?.error ?? '?';
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    this.#log.warn(`Mk42 update ${version}: install did not start (${error})`);
    void vscode.window.showErrorMessage(vscode.l10n.t('Could not start the Mk42 update: {0}', error));
  }

  #apply(s: Mk42UpdateStatus): void {
    this.#status = s;
    if (s.state === 'ready' && s.latest) {
      this.#item.text = `$(cloud-download) Mk42 ${s.latest}`;
      this.#item.tooltip = vscode.l10n.t('Mk42 update {0} is ready', s.latest);
      this.#item.name = vscode.l10n.t('Mk42 update');
      this.#item.show();
    } else if (s.state === 'available' && s.latest) {
      this.#item.text = `$(cloud) Mk42 ${s.latest}`;
      this.#item.tooltip = vscode.l10n.t('Mk42 update {0} is available', s.latest);
      this.#item.name = vscode.l10n.t('Mk42 update');
      this.#item.show();
    } else {
      this.#item.hide();
    }
    this.#applyRestart(s.appRestart);
  }

  #applyRestart(r: Mk42UpdateStatus['appRestart']): void {
    const it = this.#restartItem;
    // Mk42 창에만 — 공식 VS Code 창은 Mk42 main과 상관없어요
    if (!r || typeof r.available !== 'string' || typeof r.running !== 'string' || vscode.env.appName !== 'Mark42') {
      it.hide();
      return;
    }
    it.name = vscode.l10n.t('Mk42 restart to apply');
    if (r.restarting) {
      it.text = `$(sync~spin) ${vscode.l10n.t('Restarting Mk42 on {0}…', r.available)}`;
      it.tooltip = vscode.l10n.t('Restarting Mk42 on {0}…', r.available);
      it.command = undefined;
    } else {
      const label = vscode.l10n.t('Mk42 {0} — restart to apply', r.available);
      const reload = Array.isArray(r.needsReload) && r.needsReload.length > 0;
      it.text = `${r.failed || reload ? '$(warning)' : '$(sync)'} ${label}`;
      const lines = [vscode.l10n.t('Mk42 {0} is installed, but open windows still run {1}. Restart them to apply it.', r.available, r.running)];
      if (r.failed) lines.unshift(vscode.l10n.t('The last restart did not finish: {0}', r.error ?? r.failed));
      if (reload) lines.push(needsReloadText(r.needsReload!));
      it.tooltip = lines.join('\n\n');
      it.command = MK42_APP_RESTART_COMMAND;
    }
    it.show();
  }

  dispose(): void {
    for (const d of this.#disposables.splice(0)) d.dispose();
  }
}
