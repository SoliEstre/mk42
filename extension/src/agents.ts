// 에이전트 어댑터 — Claude Code / Codex 확장을 공개 명령·URI로만 조작해요.
// 명령 ID·인자 순서는 설치된 번들(Claude 2.1.301, Codex 26.1007.21434)에서 읽은 내부 계약이라 버전마다 스모크로 확인해요.
import * as vscode from 'vscode';
import type { AgentKind } from '@mark42/protocol';
import { claudeOpenUri, codexConversationEditorUri, codexThreadUri, isSafeSessionId } from './lib/agentUris.ts';
import { CLAUDE_EXTENSION_ID, CODEX_EXTENSION_ID } from './lib/role.ts';
import { normalizeViewType } from './lib/routing.ts';
import type { Logger } from './log.ts';
import type { OsKeySender, SendResult } from './sender.ts';

export interface FillResult {
  /** 입력창에 채웠는지(또는 채울 텍스트가 없었는지) */
  filled: boolean;
  detail?: string;
  /**
   * false면 채운 곳이 send()가 포커스하는 입력창이 아닐 수 있어요(편집기 탭 패널 등) — OS 키로 보내지 말아요.
   * 엉뚱한 입력창에 Enter를 치고 «보냈다»고 보고하지 않게 해요.
   */
  sendable?: boolean;
}

/** 이 창의 product-scheme URI를 «이 창으로» 돌아오게 바꿔요(windowId 쿼리). 실패하면 그대로. */
async function toThisWindow(uri: vscode.Uri): Promise<vscode.Uri> {
  try {
    return await vscode.env.asExternalUri(uri);
  } catch {
    return uri;
  }
}

/** Claude 편집기 탭 패널(claudeVSCodePanel)이 이 창에 열려 있는지 */
function claudePanelTabOpen(): boolean {
  return vscode.window.tabGroups.all.some((g) =>
    g.tabs.some((t) => t.input instanceof vscode.TabInputWebview && normalizeViewType(t.input.viewType) === 'claudeVSCodePanel'),
  );
}

export interface AgentAdapter {
  readonly agent: AgentKind;
  readonly extensionId: string;
  installed(): boolean;
  version(): string | undefined;
  /** 세션 열기 + (있으면) 프롬프트 채우기. sessionId 없으면 새 세션 */
  open(sessionId: string | undefined, fillText: string | undefined): Promise<FillResult>;
  /** 이미 열린 세션 입력창에 다시 채우기(설정 명령 → 재개 프롬프트 순서) */
  fill(sessionId: string | undefined, text: string): Promise<FillResult>;
  /** 입력창에 포커스 — OS 키 입력 직전 */
  focusInput(): Promise<void>;
  /** 채운 내용을 보내요(Enter). Codex는 채우기 공식 경로가 없어 붙여 넣기까지 여기서 해요 */
  send(sender: OsKeySender, pendingText: string | undefined): Promise<SendResult>;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function ensureActive(id: string): Promise<vscode.Extension<unknown> | undefined> {
  const ext = vscode.extensions.getExtension(id);
  if (ext && !ext.isActive) await ext.activate();
  return ext;
}

function extVersion(id: string): string | undefined {
  const v = vscode.extensions.getExtension(id)?.packageJSON?.version;
  return typeof v === 'string' ? v : undefined;
}

/** Claude: editor.open(sessionId?, prompt?, viewColumn?, groupId?, fullEditor?, {programmatic}) — 번들 2.1.301 */
export class ClaudeAdapter implements AgentAdapter {
  readonly agent = 'claude' as const;
  readonly extensionId = CLAUDE_EXTENSION_ID;
  #log: Logger;
  constructor(log: Logger) {
    this.#log = log;
  }
  installed(): boolean {
    return vscode.extensions.getExtension(this.extensionId) !== undefined;
  }
  version(): string | undefined {
    return extVersion(this.extensionId);
  }

  async open(sessionId: string | undefined, fillText: string | undefined): Promise<FillResult> {
    if (sessionId !== undefined && !isSafeSessionId(sessionId)) throw new Error(`invalid session id`);
    await ensureActive(this.extensionId);
    // 번들 2.1.301: honor-preferred-location은 그 세션이 이미 편집기 탭 패널에 있으면 패널을 써요(sidebar가 아님).
    // 탭 라벨로는 세션을 알 수 없어서, Claude 패널 탭이 하나라도 있으면 «어디에 채웠는지 모름»으로 봐요.
    const panelOpen = claudePanelTabOpen();
    try {
      // programmatic 없이 부르면 claudeCode.preferredLocation을 사용자 설정 'panel'로 덮어써요 — 꼭 넣어요
      await vscode.commands.executeCommand(
        'claude-vscode.editor.open',
        sessionId,
        fillText,
        undefined,
        undefined,
        undefined,
        { programmatic: 'honor-preferred-location' },
      );
      return panelOpen ? { filled: true, sendable: false, detail: 'claude panel tab open (target unknown)' } : { filled: true };
    } catch (e) {
      this.#log.warn(`claude-vscode.editor.open failed, falling back to URI: ${e instanceof Error ? e.message : String(e)}`);
      // 대안: URI /open → primaryEditor.open(편집기 탭, fullEditor). 사이드바가 아니라서 OS 키로 보내지 않아요.
      // asExternalUri가 windowId를 붙여서 메인 프로세스가 이 창으로 돌려보내요(URLHandlerRouter).
      const uri = await toThisWindow(vscode.Uri.parse(claudeOpenUri(vscode.env.uriScheme, sessionId, fillText)));
      const ok = await vscode.env.openExternal(uri);
      return { filled: ok, sendable: false, detail: 'uri-fallback (editor tab)' };
    }
  }

  fill(sessionId: string | undefined, text: string): Promise<FillResult> {
    // 사이드바에 이미 있는 세션이면 activateInSidebar(session, prompt)로 입력창만 다시 채워요
    return this.open(sessionId, text);
  }

  async focusInput(): Promise<void> {
    try {
      await vscode.commands.executeCommand('claudeVSCodeSidebarSecondary.focus');
    } catch {
      await vscode.commands.executeCommand('claudeVSCodeSidebar.focus');
    }
  }

  async send(sender: OsKeySender): Promise<SendResult> {
    await this.focusInput();
    await sleep(300);
    return sender.enter();
  }
}

/** Codex: URI <scheme>://openai.chatgpt/local/<threadId> → 사이드바를 그 스레드로. 새 스레드는 chatgpt.newChat */
export class CodexAdapter implements AgentAdapter {
  readonly agent = 'codex' as const;
  readonly extensionId = CODEX_EXTENSION_ID;
  #log: Logger;
  constructor(log: Logger) {
    this.#log = log;
  }
  installed(): boolean {
    return vscode.extensions.getExtension(this.extensionId) !== undefined;
  }
  version(): string | undefined {
    return extVersion(this.extensionId);
  }

  async open(threadId: string | undefined, fillText: string | undefined): Promise<FillResult> {
    await ensureActive(this.extensionId);
    if (threadId === undefined) {
      await vscode.commands.executeCommand('chatgpt.newChat');
    } else {
      // openExternal만 쓰면 메인 프로세스가 마지막 활성 창으로 보내요 — asExternalUri로 windowId를 붙여 이 창으로 돌려받아요
      const uri = await toThisWindow(vscode.Uri.parse(codexThreadUri(vscode.env.uriScheme, threadId)));
      const ok = await vscode.env.openExternal(uri);
      if (!ok) {
        this.#log.warn('codex thread URI not handled, falling back to conversation editor');
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.parse(codexConversationEditorUri(threadId)),
          'chatgpt.conversationEditor',
        );
      }
    }
    // 프롬프트를 넘기는 공식 경로가 없어요 — send()에서 붙여 넣어요
    return { filled: fillText === undefined, detail: fillText === undefined ? undefined : 'codex-no-fill-path' };
  }

  async fill(): Promise<FillResult> {
    return { filled: false, detail: 'codex-no-fill-path' };
  }

  async focusInput(): Promise<void> {
    await vscode.commands.executeCommand('chatgpt.openSidebar');
  }

  async send(sender: OsKeySender, pendingText: string | undefined): Promise<SendResult> {
    await this.focusInput();
    await sleep(300);
    if (pendingText !== undefined) {
      const prev = await vscode.env.clipboard.readText();
      await vscode.env.clipboard.writeText(pendingText);
      try {
        const r = await sender.paste(false);
        if (!r.ok) return r;
        await sleep(400);
      } finally {
        await sleep(200);
        await vscode.env.clipboard.writeText(prev);
      }
    }
    return sender.enter();
  }
}

export function createAdapters(log: Logger): Record<AgentKind, AgentAdapter> {
  return { claude: new ClaudeAdapter(log), codex: new CodexAdapter(log) };
}
