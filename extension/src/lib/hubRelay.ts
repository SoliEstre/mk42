// hub (A) 웹뷰 ↔ 데몬 중계(D20-A). 봉투는 @mark42/protocol client.ts의 WebviewToHost/HostToWebview예요.
import { ErrorCode, RpcError, type DaemonApi, type HostToWebview, type RequestMethod } from '@mark42/protocol';
import { sourceText, type Translate } from './l10n.ts';

export const HOST_METHOD_PREFIX = 'ui.';
/** 웹뷰가 넘긴 요청 한도의 상한 */
export const RELAY_MAX_TIMEOUT_MS = 15 * 60_000;
const FORWARDED_NOTIFICATIONS: ReadonlySet<string> = new Set(['window.status']);

/** 웹뷰가 이 창의 데몬 연결로 부르면 안 되는 요청 — 창 등록(hello)과 연결 인증·데몬 전용 메서드(`$/…`) */
export function isRelayableRequest(method: string): boolean {
  return method !== 'hello' && !method.startsWith('$/');
}

export interface HubRelayDeps {
  post(msg: HostToWebview): void;
  /** 연결돼 있으면 데몬 API, 아니면 undefined */
  api(): DaemonApi | undefined;
  /** 'ui.' 알림 — 확장 호스트가 직접 처리(데몬으로 보내지 않음) */
  onHostMessage(method: string, params: unknown): void;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export class HubRelay {
  #deps: HubRelayDeps;
  #disposed = false;
  constructor(deps: HubRelayDeps) {
    this.#deps = deps;
  }

  dispose(): void {
    this.#disposed = true;
  }

  #post(msg: HostToWebview): void {
    if (!this.#disposed) this.#deps.post(msg);
  }

  /** 웹뷰가 보낸 메시지 하나를 처리해요. 처리 결과(rpc)는 비동기로 돌려줘요. */
  async handle(raw: unknown): Promise<void> {
    if (!isObj(raw) || typeof raw.type !== 'string') return;
    switch (raw.type) {
      case 'ready':
        this.#post({ type: 'connection', connected: this.#deps.api() !== undefined });
        return;
      case 'notify': {
        if (typeof raw.method !== 'string') return;
        if (raw.method.startsWith(HOST_METHOD_PREFIX)) {
          this.#deps.onHostMessage(raw.method, raw.params);
          return;
        }
        // 창 → 데몬 알림 중 hub가 보내도 되는 것만(세션 묶기는 에이전트 창 몫)
        if (!FORWARDED_NOTIFICATIONS.has(raw.method)) return;
        const api = this.#deps.api();
        if (api) api.notify(raw.method as never, raw.params as never);
        return;
      }
      case 'rpc': {
        const id = raw.id;
        if (typeof id !== 'number' || typeof raw.method !== 'string') return;
        if (!isRelayableRequest(raw.method)) {
          this.#post({ type: 'rpcResult', id, error: { code: ErrorCode.MethodNotFound, message: raw.method } });
          return;
        }
        const api = this.#deps.api();
        if (!api) {
          this.#post({ type: 'rpcResult', id, error: { code: ErrorCode.InternalError, message: 'daemon disconnected' } });
          return;
        }
        // 웹뷰가 정한 한도(업데이트 확인 90초·클론 11분 등)를 데몬 요청에도 써요 — 없으면 기본(30초). 지나치게 긴 값은 15분으로
        const timeoutMs =
          typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? Math.min(raw.timeoutMs, RELAY_MAX_TIMEOUT_MS) : undefined;
        try {
          const result = await api.request(raw.method as RequestMethod, (raw.params ?? {}) as never, timeoutMs);
          this.#post({ type: 'rpcResult', id, result });
        } catch (e) {
          const code = e instanceof RpcError ? e.code : ErrorCode.InternalError;
          const message = e instanceof Error ? e.message : String(e);
          this.#post({ type: 'rpcResult', id, error: { code, message } });
        }
        return;
      }
      default:
        return;
    }
  }

  notifyFromDaemon(method: string, params: unknown): void {
    this.#post({ type: 'notify', method, params });
  }

  connectionChanged(connected: boolean): void {
    this.#post({ type: 'connection', connected });
  }
}

/** hub 웹뷰 HTML. 스크립트·스타일은 asWebviewUri로 받은 주소만 허용해요. */
export function hubHtml(o: { cspSource: string; scriptUri?: string; styleUri?: string; nonce: string; lang?: string; t?: Translate }): string {
  const t = o.t ?? sourceText;
  const csp = [
    "default-src 'none'",
    `img-src ${o.cspSource} data:`,
    `font-src ${o.cspSource}`,
    `style-src ${o.cspSource}`,
    `script-src 'nonce-${o.nonce}' ${o.cspSource}`,
  ].join('; ');
  const style = o.styleUri ? `<link rel="stylesheet" href="${escapeAttr(o.styleUri)}" />` : '';
  const body = o.scriptUri
    ? `<div id="app"></div><script nonce="${o.nonce}" src="${escapeAttr(o.scriptUri)}"></script>`
    : `<div id="app"><p>${escapeText(t('Could not find the hub window UI bundle (dist/hub-ui.js). Please rebuild the extension.'))}</p></div>`;
  return `<!doctype html>
<html lang="${escapeAttr(o.lang || 'en')}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeText(t('Hub window'))}</title>
${style}
</head>
<body data-transport="webview">
${body}
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
