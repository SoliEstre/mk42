// 에이전트 창의 Windows 창 제목(작업 표시줄·Alt+Tab)에 이 창 세션 이름을 넣어요.
// 데몬이 역할 워크스페이스에 쓰는 window.title(daemon/src/workspaces.ts roleWindowTitle)의 ${mark42Session}을 채워요:
// VS Code 기본 명령 registerWindowTitleVariable로 변수를 컨텍스트 키에 묶고, setContext로 값을 넣어요(앱 패치 없이).
// 세션은 이 창에 묶인 것(Mark42가 열어 준 세션 — window.sessionBound)이에요. 창을 다시 불러 확장이 잊었으면 데몬의 창 목록에서 찾아요.
import * as vscode from 'vscode';
import type { AgentKind, SessionSummary } from '@mark42/protocol';
import type { DaemonClient } from './daemonClient.ts';
import type { Logger } from './log.ts';

export const TITLE_VARIABLE = 'mark42Session';
export const TITLE_CONTEXT_KEY = 'mark42.sessionTitle';
const MAX_LABEL = 60;

/** 창 제목에 넣을 세션 이름: 제목, 없으면 마지막 질문의 첫 줄. 한 줄로 펴고 60자에서 줄여요 */
export function sessionTitleLabel(s: Pick<SessionSummary, 'title' | 'lastPrompt'> | undefined): string {
  const raw = s?.title?.trim() || s?.lastPrompt?.trim() || '';
  const first = raw.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const flat = first.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > MAX_LABEL ? `${chars.slice(0, MAX_LABEL - 1).join('')}…` : flat;
}

/** 창 제목 변수 값: 대괄호 안 역할 이름 뒤에 붙어요 — «[Mk42 Claude: 이름]», 없으면 빈 값(예전 제목 그대로) */
export function titleValue(label: string): string {
  return label ? `: ${label}` : '';
}

export interface WindowTitleOptions {
  daemon: Pick<DaemonClient, 'api' | 'windowId'>;
  log: Logger;
  agent: () => AgentKind | undefined;
  folder: () => string | undefined;
  sessionId: () => string | undefined;
}

export class WindowTitle implements vscode.Disposable {
  readonly #o: WindowTitleOptions;
  #registered = false;
  #label: string | undefined;
  #labelFor: string | undefined;
  #seq = 0;

  constructor(o: WindowTitleOptions) {
    this.#o = o;
  }

  #timer: ReturnType<typeof setTimeout> | undefined;

  /** 세션 목록 알림은 답하는 동안 자주 와요 — 잠깐 모아서 한 번만 */
  schedule(delayMs = 500): void {
    if (!this.#o.agent() || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.refresh();
    }, delayMs);
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** 지금 값(시험용) */
  get label(): string | undefined {
    return this.#label;
  }

  /** 세션이 묶였을 때·세션 목록이 바뀌었을 때·데몬에 다시 붙었을 때 불러요. 실패해도 창에는 영향 없어요(제목만 그대로). */
  async refresh(): Promise<void> {
    const agent = this.#o.agent();
    if (!agent) return;
    const seq = ++this.#seq;
    try {
      if (!this.#registered) {
        await vscode.commands.executeCommand('registerWindowTitleVariable', TITLE_VARIABLE, TITLE_CONTEXT_KEY);
        this.#registered = true;
      }
      const api = this.#o.daemon.api;
      if (!api) return; // 끊긴 동안은 마지막 이름을 그대로
      let id = this.#o.sessionId();
      if (!id) {
        const windowId = this.#o.daemon.windowId;
        const windows = windowId ? await api.request('windows.list', {}) : [];
        id = windows.find((w) => w.windowId === windowId)?.sessionId;
      }
      let label = '';
      if (id) {
        const folder = this.#o.folder();
        const list = await api.request('sessions.list', { ...(folder ? { cwd: folder } : {}), agent, includeSubagents: false, limit: 200 });
        const s = list.find((x) => x.id === id);
        // 목록에서 못 찾으면(오래된 세션이 한도 밖 등) 같은 세션의 이름은 그대로 둬요
        label = s ? sessionTitleLabel(s) : this.#labelFor === id ? (this.#label ?? '') : '';
      }
      if (seq !== this.#seq) return; // 더 새 refresh가 있어요
      this.#labelFor = id;
      if (label === this.#label) return;
      this.#label = label;
      // 창 제목 틀은 «[Mk42 Claude${mark42Session}] …» — 이름이 있을 때만 «: 이름»
      await vscode.commands.executeCommand('setContext', TITLE_CONTEXT_KEY, titleValue(label));
    } catch (e) {
      this.#o.log.debug(`window title: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
