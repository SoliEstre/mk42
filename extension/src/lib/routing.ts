// 에이전트 창 링크 라우팅 결정(D15·D16 PoC 근사) — 탭 하나를 보고 «편집기 창으로 보낼지»를 정해요.
import type { WindowRole } from '@mark42/protocol';
import { isAgentRole, type VirtualDocPlacement } from './role.ts';

/** vscode.TabInput* 를 vscode 없이 다루려고 줄인 모양 */
export type TabDescriptor =
  | { kind: 'text'; scheme: string; uri: string }
  | { kind: 'diff'; originalScheme: string; modifiedScheme: string }
  | { kind: 'custom'; viewType: string; scheme: string; uri: string }
  | { kind: 'notebook'; scheme: string; uri: string }
  | { kind: 'webview'; viewType: string }
  | { kind: 'other' };

export type RouteDecision =
  | { action: 'route'; kind: 'file'; uri: string }
  | { action: 'aux'; reason: 'virtual' }
  | { action: 'keep'; reason: KeepReason };

export type KeepReason =
  | 'unmanaged'
  | 'not-agent-window'
  | 'virtual'
  | 'agent-surface'
  | 'webview'
  | 'offline'
  | 'no-folder'
  | 'unsupported';

/** 에이전트 확장 자신의 편집기·웹뷰 — 절대 옮기지 않아요. */
export const AGENT_VIEW_TYPES: ReadonlySet<string> = new Set([
  'claudeVSCodePanel',
  'chatgpt.conversationEditor',
]);

export interface RouteContext {
  role: WindowRole | undefined;
  connected: boolean;
  folderPath: string | undefined;
  virtualDocPlacement: VirtualDocPlacement;
}

function virtualDecision(ctx: RouteContext): RouteDecision {
  return ctx.virtualDocPlacement === 'auxWindow' ? { action: 'aux', reason: 'virtual' } : { action: 'keep', reason: 'virtual' };
}

/** webview 탭의 viewType은 `mainThreadWebview-<viewType>` 꼴로 보일 때가 있어요. */
export function normalizeViewType(viewType: string): string {
  return viewType.replace(/^mainThreadWebview-/, '');
}

export function decideTabRouting(tab: TabDescriptor, ctx: RouteContext): RouteDecision {
  if (!ctx.role) return { action: 'keep', reason: 'unmanaged' };
  if (!isAgentRole(ctx.role)) return { action: 'keep', reason: 'not-agent-window' };
  let candidate: string | undefined;
  switch (tab.kind) {
    case 'text':
      if (tab.scheme !== 'file') return virtualDecision(ctx);
      candidate = tab.uri;
      break;
    case 'notebook':
      if (tab.scheme !== 'file') return virtualDecision(ctx);
      candidate = tab.uri;
      break;
    case 'custom':
      if (AGENT_VIEW_TYPES.has(normalizeViewType(tab.viewType))) return { action: 'keep', reason: 'agent-surface' };
      if (tab.scheme !== 'file') return virtualDecision(ctx);
      candidate = tab.uri;
      break;
    case 'diff':
      // 제안 diff 등 — D15 ③(PoC): 에이전트 창에 남겨요
      return virtualDecision(ctx);
    case 'webview':
      if (AGENT_VIEW_TYPES.has(normalizeViewType(tab.viewType))) return { action: 'keep', reason: 'agent-surface' };
      // Markdown 미리보기 등은 원본 URI를 API로 알 수 없어요 — PoC는 남겨 둬요
      return { action: 'keep', reason: 'webview' };
    default:
      return { action: 'keep', reason: 'unsupported' };
  }
  if (!ctx.folderPath) return { action: 'keep', reason: 'no-folder' };
  // 데몬에 못 넘기면 닫지 않아요(탭을 잃지 않게)
  if (!ctx.connected) return { action: 'keep', reason: 'offline' };
  return { action: 'route', kind: 'file', uri: candidate };
}

/** 같은 URI를 짧은 시간에 두 번 보내지 않게 하는 기억 장치 */
export class RecentSet {
  #items = new Map<string, number>();
  readonly ttlMs: number;
  constructor(ttlMs = 3_000) {
    this.ttlMs = ttlMs;
  }
  /** 처음 보면 true(그리고 기억), ttl 안에 다시 보면 false */
  add(key: string, now = Date.now()): boolean {
    for (const [k, t] of this.#items) if (now - t > this.ttlMs) this.#items.delete(k);
    if (this.#items.has(key)) return false;
    this.#items.set(key, now);
    return true;
  }
}

export function isWebUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}
