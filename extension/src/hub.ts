// hub (A): VS Code hub 창의 «통합 창» 웹뷰 패널 + postMessage ↔ 데몬 중계(D20-A)
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { isHubUiCommand } from '../hub-ui/src/host-messages.ts';
import type { DaemonClient } from './daemonClient.ts';
import { t } from './l10n.ts';
import { HubRelay, hubHtml } from './lib/hubRelay.ts';
import type { Logger } from './log.ts';

export class HubPanel implements vscode.Disposable {
  #context: vscode.ExtensionContext;
  #daemon: DaemonClient;
  #log: Logger;
  #panel: vscode.WebviewPanel | undefined;
  #relay: HubRelay | undefined;
  #subs: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext, daemon: DaemonClient, log: Logger) {
    this.#context = context;
    this.#daemon = daemon;
    this.#log = log;
    this.#subs.push(
      daemon.onNotification((method, params) => this.#relay?.notifyFromDaemon(method, params)),
      daemon.onStateChange((s) => {
        if (s !== 'connecting') this.#relay?.connectionChanged(s === 'connected');
      }),
    );
  }

  show(): void {
    if (this.#panel) {
      this.#panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const dist = vscode.Uri.joinPath(this.#context.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel('mark42.hub', vscode.l10n.t('Hub window'), vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    panel.iconPath = new vscode.ThemeIcon('layers');
    const webview = panel.webview;
    const scriptFile = vscode.Uri.joinPath(dist, 'hub-ui.js');
    const styleFile = vscode.Uri.joinPath(dist, 'hub-ui.css');
    const html = hubHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString('base64url'),
      lang: vscode.env.language,
      t,
      ...(existsSync(scriptFile.fsPath) ? { scriptUri: webview.asWebviewUri(scriptFile).toString() } : {}),
      ...(existsSync(styleFile.fsPath) ? { styleUri: webview.asWebviewUri(styleFile).toString() } : {}),
    });
    const relay = new HubRelay({
      post: (msg) => void webview.postMessage(msg),
      api: () => this.#daemon.api,
      onHostMessage: (method, params) => void this.#onHostMessage(method, params),
    });
    this.#panel = panel;
    this.#relay = relay;
    const sub = webview.onDidReceiveMessage((m) => void relay.handle(m));
    panel.onDidDispose(() => {
      sub.dispose();
      relay.dispose();
      if (this.#panel === panel) {
        this.#panel = undefined;
        this.#relay = undefined;
      }
    });
    webview.html = html;
  }

  async #onHostMessage(method: string, params: unknown): Promise<void> {
    try {
      if (method === 'ui.addFolder') {
        await vscode.commands.executeCommand('mark42.addFolder');
        return;
      }
      if (method === 'ui.command') {
        const command = typeof params === 'object' && params !== null ? (params as { command?: unknown }).command : undefined;
        // hub UI가 부를 수 있는 명령은 툴바 3종뿐(계약: hub-ui/src/host-messages.ts)
        if (isHubUiCommand(command)) await vscode.commands.executeCommand(command);
        return;
      }
      this.#log.debug(`ignored hub host message ${method}`);
    } catch (e) {
      this.#log.error(`hub host message ${method} failed`, e);
    }
  }

  dispose(): void {
    this.#panel?.dispose();
    for (const s of this.#subs.splice(0)) s.dispose();
  }
}
