// 에이전트 창 링크 라우팅(D15·D16 PoC 근사): file: 탭이 열리면 닫고 데몬 editor.route로 그 폴더 편집기 창에 넘겨요.
// http(s): 다른 확장의 openExternal을 가로챌 안정 API가 없어요(registerExternalUriOpener는 제안 API) — 우리 UI는 mark42.openLinkInEditor를 써요.
import * as vscode from 'vscode';
import type { LinkKind, Selection } from '@mark42/protocol';
import type { DaemonClient } from './daemonClient.ts';
import { decideTabRouting, isWebUri, RecentSet, type RouteContext, type TabDescriptor } from './lib/routing.ts';
import { resolveFolderPath, type HostEnv, type RoleConfig } from './lib/role.ts';
import type { Logger } from './log.ts';

export function describeTab(tab: vscode.Tab): TabDescriptor {
  const i = tab.input;
  if (i instanceof vscode.TabInputText) return { kind: 'text', scheme: i.uri.scheme, uri: i.uri.toString() };
  if (i instanceof vscode.TabInputTextDiff) return { kind: 'diff', originalScheme: i.original.scheme, modifiedScheme: i.modified.scheme };
  if (i instanceof vscode.TabInputCustom) return { kind: 'custom', viewType: i.viewType, scheme: i.uri.scheme, uri: i.uri.toString() };
  if (i instanceof vscode.TabInputNotebook) return { kind: 'notebook', scheme: i.uri.scheme, uri: i.uri.toString() };
  if (i instanceof vscode.TabInputWebview) return { kind: 'webview', viewType: i.viewType };
  return { kind: 'other' };
}

/** 탭 입력의 URI 기준 키 (라벨은 같은 이름 파일끼리 겹쳐요) */
export function tabInputKey(tab: vscode.Tab): string | undefined {
  const i = tab.input;
  if (i instanceof vscode.TabInputText) return `text:${i.uri.toString()}`;
  if (i instanceof vscode.TabInputTextDiff) return `diff:${i.original.toString()}|${i.modified.toString()}`;
  if (i instanceof vscode.TabInputCustom) return `custom:${i.viewType}:${i.uri.toString()}`;
  if (i instanceof vscode.TabInputNotebook) return `notebook:${i.uri.toString()}`;
  return undefined;
}

/** 1부터 세는 줄·열(사람 기준). editor.openUri 받는 쪽도 같은 기준이에요. */
export function toSelection(sel: vscode.Selection): Selection {
  return {
    startLine: sel.start.line + 1,
    startColumn: sel.start.character + 1,
    endLine: sel.end.line + 1,
    endColumn: sel.end.character + 1,
  };
}

export function fromSelection(s: Selection): vscode.Range {
  const sl = Math.max(0, s.startLine - 1);
  const sc = Math.max(0, (s.startColumn ?? 1) - 1);
  const el = Math.max(0, (s.endLine ?? s.startLine) - 1);
  const ec = Math.max(0, (s.endColumn ?? s.startColumn ?? 1) - 1);
  return new vscode.Range(sl, sc, el, ec);
}

export class LinkRouter implements vscode.Disposable {
  #log: Logger;
  #daemon: DaemonClient;
  #config: () => RoleConfig;
  #hostEnv: () => HostEnv;
  #recent = new RecentSet(3_000);
  #subs: vscode.Disposable[] = [];

  constructor(log: Logger, daemon: DaemonClient, config: () => RoleConfig, hostEnv: () => HostEnv) {
    this.#log = log;
    this.#daemon = daemon;
    this.#config = config;
    this.#hostEnv = hostEnv;
    this.#subs.push(
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        for (const tab of e.opened) void this.#onTab(tab, true);
        for (const tab of e.changed) void this.#onTab(tab, false);
      }),
    );
  }

  /** 보조 창으로 옮긴 가상 문서 — 다시 옮기지 않아요(보조 창에서 열린 탭·이후 changed 이벤트) */
  #movedToAux = new Set<string>();

  #ctx(): RouteContext {
    const cfg = this.#config();
    return {
      role: cfg.role,
      connected: this.#daemon.api !== undefined,
      folderPath: resolveFolderPath(cfg, this.#hostEnv()),
      virtualDocPlacement: cfg.virtualDocPlacement,
    };
  }

  async #onTab(tab: vscode.Tab, opened: boolean): Promise<void> {
    const ctx = this.#ctx();
    const d = decideTabRouting(describeTab(tab), ctx);
    if (d.action === 'keep') return;
    if (d.action === 'aux') {
      // D15 ②(실험): 같은 확장 호스트의 보조 창으로 옮겨 수락 흐름을 지켜요. 활성 탭만 옮길 수 있어요.
      // TODO(D15 ①): 가상 문서를 그 폴더 편집기 창에 띄우는 건 패치 빌드에서(가상 문서가 창의 확장 호스트에 묶여 있어요).
      // 새로 열린 탭만 — changed(클릭·활성화)에 반응하면 보조 창 안의 탭을 또 옮겨 창이 계속 늘어요.
      if (!opened || !tab.isActive) return;
      const key = tabInputKey(tab);
      if (!key || this.#movedToAux.has(key)) return;
      this.#movedToAux.add(key);
      if (this.#movedToAux.size > 500) this.#movedToAux.delete(this.#movedToAux.values().next().value!);
      try {
        await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      } catch (e) {
        this.#log.warn(`moveEditorToNewWindow failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    if (!this.#recent.add(d.uri)) return;
    // 링크로 연 경우 선택·스크롤이 적용될 시간을 잠깐 줘요
    await new Promise((r) => setTimeout(r, 150));
    const active = vscode.window.activeTextEditor;
    const sel = active && active.document.uri.toString() === d.uri ? active.selection : undefined;
    // 빈 선택이 0:0이면 «선택 없음»으로 봐요(링크에 줄 번호가 있으면 커서가 그 줄에 있어요)
    const selection = sel && (!sel.isEmpty || sel.active.line > 0 || sel.active.character > 0) ? toSelection(sel) : undefined;
    const api = this.#daemon.api;
    if (!api || !ctx.folderPath) return;
    try {
      const r = await api.request('editor.route', { folderPath: ctx.folderPath, uri: d.uri, kind: 'file', ...(selection ? { selection } : {}) });
      this.#log.info(`routed ${d.uri} → editor window (${r.status})`);
      await vscode.window.tabGroups.close(tab, true);
      await this.#restoreAgentLayout();
    } catch (e) {
      this.#log.warn(`editor.route failed, keeping tab: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 확장이 편집기를 열면 보조 사이드바 최대화가 풀려요(보고서 6장) — 편집기가 다 닫혔으면 되돌려요 */
  async #restoreAgentLayout(): Promise<void> {
    const anyTabs = vscode.window.tabGroups.all.some((g) => g.tabs.length > 0);
    if (anyTabs) return;
    try {
      await vscode.commands.executeCommand('workbench.action.maximizeAuxiliaryBar');
    } catch {
      // 이 버전에 없는 명령
    }
  }

  /** mark42.openLinkInEditor(uri, kind?) — 우리 UI(세션 탭·hub)에서 링크를 편집기 창으로 보낼 때 */
  async openLink(target: string | vscode.Uri, kind?: LinkKind): Promise<void> {
    const uri = typeof target === 'string' ? target : target.toString();
    const k: LinkKind = kind ?? (isWebUri(uri) ? 'web' : 'file');
    const ctx = this.#ctx();
    const api = this.#daemon.api;
    if (api && ctx.folderPath) {
      try {
        await api.request('editor.route', { folderPath: ctx.folderPath, uri, kind: k });
        return;
      } catch (e) {
        this.#log.warn(`editor.route failed, opening locally: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await openUriLocally(uri, k);
  }

  dispose(): void {
    for (const s of this.#subs.splice(0)) s.dispose();
  }
}

/** editor 역할의 editor.openUri, 그리고 데몬이 없을 때의 대안 */
export async function openUriLocally(uri: string, kind: LinkKind, selection?: Selection): Promise<void> {
  if (kind === 'web') {
    if (!isWebUri(uri)) throw new Error('web link must be http(s)');
    // 1.142.0 내장 simple-browser: workbench.action.browser.open이 있으면 그쪽(통합 브라우저)으로 넘겨요
    await vscode.commands.executeCommand('simpleBrowser.show', uri);
    return;
  }
  const u = vscode.Uri.parse(uri);
  if (kind === 'preview') {
    await vscode.commands.executeCommand('markdown.showPreview', u);
    return;
  }
  const opts: vscode.TextDocumentShowOptions = { preview: false };
  if (selection) opts.selection = fromSelection(selection);
  await vscode.commands.executeCommand('vscode.open', u, opts);
}
