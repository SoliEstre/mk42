// (B) 별도 창 전송 — 같은 origin의 /rpc WebSocket. 첫 프레임은 {"type":"auth","token"}, 그 뒤 JSON-RPC 2.0 텍스트 프레임(프레임 하나 = 메시지 하나).
import {
  ErrorCode,
  RpcError,
  RpcPeer,
  type LineChannel,
  type ParamsOf,
  type RequestMethod,
  type ResultOf,
  type WindowNotification,
  type WindowNotificationMap,
} from '@mark42/protocol';
import { t } from './i18n.ts';
import { backoffDelay } from './model.ts';
import { defaultTimers, type TimerApi } from './refresh.ts';
import { addListener, Listeners, type ConnectionStatus, type HubConnection } from './transport.ts';

/** 브라우저 WebSocket에서 쓰는 부분만 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close', cb: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: 'error', cb: () => void): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

/** 데몬이 토큰을 거절할 때 닫는 코드. 이 코드면 재연결하지 않아요. */
export const AUTH_FAILED_CLOSE_CODES: readonly number[] = [4401, 4403, 1008];
/** 더 새로 연 통합 창이 붙어서 데몬이 이 창을 닫는 코드(+ 제어 프레임 {"type":"superseded"}). 재연결하지 않아요. */
export const SUPERSEDED_CLOSE_CODE = 4409;

export interface WsTransportOptions {
  url: string;
  token: string | undefined;
  /** 창 번호(주소의 `w`, 데몬이 연 순서) — 데몬은 가장 큰 번호의 창 하나만 남겨요. 없으면 보내지 않아요 */
  windowNumber?: number;
  factory?: WebSocketFactory;
  timers?: TimerApi;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** 서버 제어 프레임(JSON-RPC가 아님): {"type":"auth","ok":false,"error"?} */
interface ControlFrame {
  type: string;
  ok?: boolean;
  error?: string;
}
function asControlFrame(v: unknown): ControlFrame | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if ('jsonrpc' in o || typeof o.type !== 'string') return undefined;
  return o as unknown as ControlFrame;
}

export class WsTransport implements HubConnection {
  readonly kind = 'ws' as const;
  #opts: WsTransportOptions;
  #factory: WebSocketFactory;
  #timers: TimerApi;
  #ls = new Listeners();
  #ws: WebSocketLike | undefined;
  #peer: RpcPeer | undefined;
  #status: ConnectionStatus = 'connecting';
  #detail = '';
  #attempt = 0;
  #retryHandle: unknown = undefined;
  #disposed = false;

  constructor(opts: WsTransportOptions) {
    this.#opts = opts;
    this.#factory = opts.factory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.#timers = opts.timers ?? defaultTimers;
  }

  get connected(): boolean {
    return this.#status === 'connected';
  }
  get status(): ConnectionStatus {
    return this.#status;
  }
  get statusDetail(): string {
    if (this.#detail) return this.#detail;
    switch (this.#status) {
      case 'connected':
        return t('conn.detail.connected');
      case 'connecting':
        return t('conn.detail.connecting');
      case 'authFailed':
        return t('conn.detail.authFailed');
      case 'superseded':
        return t('conn.detail.superseded');
      default:
        return t('conn.detail.disconnected');
    }
  }

  start(): void {
    if (!this.#opts.token) {
      this.#setStatus('authFailed', t('conn.detail.noToken'));
      return;
    }
    this.#connect();
  }

  reconnectNow(): void {
    if (this.#disposed || this.#status === 'connected' || this.#status === 'authFailed' || this.#status === 'superseded') return;
    if (this.#retryHandle !== undefined) {
      this.#timers.clearTimeout(this.#retryHandle);
      this.#retryHandle = undefined;
    }
    if (!this.#ws) this.#connect();
  }

  request<M extends RequestMethod>(method: M, params: ParamsOf<M>, timeoutMs?: number): Promise<ResultOf<M>> {
    const peer = this.#peer;
    if (!peer || peer.closed || !this.connected) {
      return Promise.reject(new RpcError(ErrorCode.InternalError, `disconnected: ${method}`));
    }
    return peer.request(method, params, timeoutMs) as Promise<ResultOf<M>>;
  }

  notify<N extends WindowNotification>(method: N, params: WindowNotificationMap[N]): void {
    if (this.connected) this.#peer?.notify(method, params);
  }

  onNotification(cb: Parameters<HubConnection['onNotification']>[0]): () => void {
    return addListener(this.#ls.notification, cb as never);
  }
  onConnectionChange(cb: (connected: boolean) => void): () => void {
    return addListener(this.#ls.connection, cb);
  }
  onStatusChange(cb: (status: ConnectionStatus) => void): () => void {
    return addListener(this.#ls.status, cb);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#retryHandle !== undefined) this.#timers.clearTimeout(this.#retryHandle);
    this.#retryHandle = undefined;
    const ws = this.#ws;
    this.#ws = undefined;
    this.#peer?.close();
    this.#peer = undefined;
    try {
      ws?.close(1000, 'disposed');
    } catch {
      // 이미 닫힘
    }
  }

  #connect(): void {
    if (this.#disposed) return;
    this.#setStatus('connecting');
    let ws: WebSocketLike;
    try {
      ws = this.#factory(this.#opts.url);
    } catch (e) {
      console.error('[hub-ui] websocket create failed', e);
      this.#scheduleRetry();
      return;
    }
    this.#ws = ws;
    const lineCbs: ((line: string) => void)[] = [];
    const closeCbs: (() => void)[] = [];
    const channel: LineChannel = {
      send: (line) => ws.send(line),
      onLine: (cb) => void lineCbs.push(cb),
      onClose: (cb) => void closeCbs.push(cb),
      close: () => {
        try {
          ws.close(1000);
        } catch {
          // 무시
        }
      },
    };
    let authRejected = false;
    let superseded = false;

    ws.addEventListener('open', () => {
      if (this.#ws !== ws) return;
      try {
        const w = this.#opts.windowNumber;
        ws.send(JSON.stringify({ type: 'auth', token: this.#opts.token, ...(w !== undefined ? { w } : {}) }));
      } catch {
        return;
      }
      const peer = new RpcPeer(channel, {
        onNotification: (method, params) => this.#ls.emitNotification(method, params),
      });
      this.#peer = peer;
      this.#attempt = 0;
      this.#setStatus('connected');
    });

    ws.addEventListener('message', (ev) => {
      if (this.#ws !== ws || typeof ev.data !== 'string') return;
      for (const raw of ev.data.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          for (const cb of lineCbs) cb(line);
          continue;
        }
        const ctl = asControlFrame(parsed);
        if (ctl) {
          if (ctl.type === 'auth' && ctl.ok === false) {
            authRejected = true;
            this.#detail = '';
            try {
              ws.close(4401, 'auth failed');
            } catch {
              // 무시
            }
          } else if (ctl.type === 'superseded') {
            superseded = true;
          }
          continue;
        }
        for (const cb of lineCbs) cb(line);
      }
    });

    ws.addEventListener('error', () => {
      // close가 뒤따라 와요.
    });

    ws.addEventListener('close', (ev) => {
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      this.#peer = undefined;
      for (const cb of closeCbs.splice(0)) cb();
      if (this.#disposed) return;
      if (superseded || ev.code === SUPERSEDED_CLOSE_CODE) {
        this.#setStatus('superseded');
        return;
      }
      if (authRejected || AUTH_FAILED_CLOSE_CODES.includes(ev.code)) {
        this.#setStatus('authFailed');
        return;
      }
      this.#scheduleRetry();
    });
  }

  #scheduleRetry(): void {
    if (this.#disposed) return;
    const delay = backoffDelay(this.#attempt++, this.#opts.baseDelayMs, this.#opts.maxDelayMs);
    const sec = Math.max(1, Math.round(delay / 1000));
    this.#setStatus('disconnected', t('conn.detail.retryIn', sec));
    this.#retryHandle = this.#timers.setTimeout(() => {
      this.#retryHandle = undefined;
      this.#connect();
    }, delay);
  }

  #setStatus(s: ConnectionStatus, detail = ''): void {
    const changed = s !== this.#status || detail !== this.#detail;
    const wasConnected = this.connected;
    this.#status = s;
    this.#detail = detail;
    if (changed) this.#ls.emitStatus(s);
    if (wasConnected !== this.connected) this.#ls.emitConnection(this.connected);
  }
}
