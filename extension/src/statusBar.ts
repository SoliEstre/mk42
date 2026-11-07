// 상태 표시줄: 데몬 연결 상태 + 툴바 3종(창 다시 로드·확장 다시 로드·테마) — 역할과 무관하게 항상 보여요(R9·R11).
// 에이전트 창에는 «에이전트 패널 크게» 단추가 하나 더 있어요.
import * as vscode from 'vscode';
import type { ConnectionState } from './daemonClient.ts';
import { t } from './l10n.ts';
import { isAgentRole, roleLabel, type RoleConfig } from './lib/role.ts';

export class StatusBar implements vscode.Disposable {
  #conn: vscode.StatusBarItem;
  #items: vscode.StatusBarItem[] = [];
  /** 에이전트 창에서만: 에이전트 패널 다시 크게(agentLayout.ts) */
  #panel: vscode.StatusBarItem;

  constructor() {
    this.#conn = vscode.window.createStatusBarItem('mark42.connection', vscode.StatusBarAlignment.Left, 100);
    this.#conn.name = vscode.l10n.t('Mark42 daemon connection');
    this.#conn.command = 'mark42.daemonStatus';
    this.#conn.show();
    const tools: [string, string, string][] = [
      ['mark42.reloadWindow', '$(refresh)', vscode.l10n.t('Reload window')],
      ['mark42.restartExtensionHost', '$(debug-restart)', vscode.l10n.t('Reload extensions')],
      ['mark42.selectTheme', '$(symbol-color)', vscode.l10n.t('Quick theme switch')],
    ];
    let prio = 99;
    for (const [command, text, tooltip] of tools) {
      const it = vscode.window.createStatusBarItem(`${command}.status`, vscode.StatusBarAlignment.Left, prio--);
      it.name = `Mark42 ${tooltip}`;
      it.text = text;
      it.tooltip = tooltip;
      it.command = command;
      it.show();
      this.#items.push(it);
    }
    this.#panel = vscode.window.createStatusBarItem('mark42.maximizeAgentPanel.status', vscode.StatusBarAlignment.Left, prio--);
    this.#panel.name = vscode.l10n.t('Mark42 maximize agent panel');
    this.#panel.text = '$(screen-full)';
    this.#panel.tooltip = vscode.l10n.t('Maximize agent panel (hide the editor area)');
    this.#panel.command = 'mark42.maximizeAgentPanel';
  }

  update(state: ConnectionState, cfg: RoleConfig, detail?: string): void {
    const icon = state === 'connected' ? '$(layers)' : state === 'connecting' ? '$(sync~spin)' : '$(debug-disconnect)';
    this.#conn.text = `${icon} Mark42`;
    const stateText =
      state === 'connected'
        ? vscode.l10n.t('Connected to the daemon')
        : state === 'connecting'
          ? vscode.l10n.t('Connecting to the daemon')
          : vscode.l10n.t('Not connected to the daemon');
    this.#conn.tooltip = `${roleLabel(cfg.role, t)} — ${stateText}${detail ? ` (${detail})` : ''}`;
    this.#conn.backgroundColor = state === 'disconnected' && cfg.role ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    if (isAgentRole(cfg.role)) this.#panel.show();
    else this.#panel.hide();
  }

  dispose(): void {
    this.#panel.dispose();
    this.#conn.dispose();
    for (const it of this.#items) it.dispose();
  }
}
