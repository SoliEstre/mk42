// Mk42 자체 업데이트 알림(계약 C4, 2026-11-05). 데몬(updater.ts)이 새 판 설치 파일을 받아 서명·sha256을 맞추면 `update.changed`(state ready)를
// 보내요. «지금 설치할까요?»는 창 하나만 물어요 — 데몬이 고른 창(가장 최근 포커스, 없으면 처음 붙는 창)에만 announce:true가 와요.
// 준비된 동안은 창마다 상태 표시줄에 «$(cloud-download) Mk42 <판>»(누르면 같은 질문). «설치» = update.install — 설치 엔진이 데몬을 바꿔 끼우고
// 창은 닫지 않아요(창은 새 데몬에 다시 붙어요). 명령 «Mk42 업데이트 확인»(mark42.update.check)은 지금 서버를 확인해요.
// 자동 받기가 꺼져 있으면(settings.update.autoDownload — 통합 창 ⚙) 새 판은 available로 와요: 상태 표시줄 «$(cloud) Mk42 <판>»을 누르면
// «받을까요?» → update.download. 설정은 통합 창에서만 바꿔요.
import * as vscode from 'vscode';
import type { DaemonApi, DaemonNotification, DaemonNotificationMap, Mk42UpdateChanged, Mk42UpdateStatus } from '@mark42/protocol';
import type { ConnectionState } from './daemonClient.ts';
import type { Logger } from './log.ts';

export const MK42_UPDATE_CHECK_COMMAND = 'mark42.update.check';
/** 상태 표시줄 단추(내부) — 준비된 판을 설치할지 다시 물어요 */
export const MK42_UPDATE_PROMPT_COMMAND = 'mark42.update.prompt';
const STATUS_ITEM_ID = 'mark42.mk42Update';
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

export class Mk42UpdateNotifier implements vscode.Disposable {
  #daemon: Mk42UpdateDaemon;
  #log: Logger;
  #disposables: vscode.Disposable[] = [];
  #item: vscode.StatusBarItem;
  #status: Mk42UpdateStatus | undefined;
  /** 이 창에서 이미 물은 판 */
  #announced = new Set<string>();
  #asking = false;

  constructor(daemon: Mk42UpdateDaemon, log: Logger) {
    this.#daemon = daemon;
    this.#log = log;
    this.#item = vscode.window.createStatusBarItem(STATUS_ITEM_ID, vscode.StatusBarAlignment.Right, 90);
    this.#item.command = MK42_UPDATE_PROMPT_COMMAND;
    this.#disposables.push(
      this.#item,
      vscode.commands.registerCommand(MK42_UPDATE_CHECK_COMMAND, () => this.check()),
      vscode.commands.registerCommand(MK42_UPDATE_PROMPT_COMMAND, () => this.ask()),
      daemon.onNotification((method, params) => {
        if (method !== 'update.changed') return;
        const p = params as Mk42UpdateChanged;
        if (!isMk42UpdateStatus(p)) return;
        this.#apply(p);
        if (p.announce === true) void this.#announce();
      }),
      daemon.onStateChange((s) => {
        if (s === 'connected') void this.refresh();
        else if (s === 'disconnected' && this.#status?.state !== 'ready' && this.#status?.state !== 'available') this.#item.hide();
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
  }

  dispose(): void {
    for (const d of this.#disposables.splice(0)) d.dispose();
  }
}
