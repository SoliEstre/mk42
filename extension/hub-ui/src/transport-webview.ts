// (A) VS Code 웹뷰 전송 — acquireVsCodeApi().postMessage 봉투(WebviewToHost/HostToWebview)로 확장 호스트가 데몬에 중계해요.
import {
  ErrorCode,
  RpcError,
  type HostToWebview,
  type ParamsOf,
  type RequestMethod,
  type ResultOf,
  type WebviewToHost,
  type WindowNotification,
  type WindowNotificationMap,
} from '@mark42/protocol';
import type { HostNotification, HostNotificationMap } from './host-messages.ts';
import { t } from './i18n.ts';
import { defaultTimers, type TimerApi } from './refresh.ts';
import { addListener, Listeners, type ConnectionStatus, type HubConnection } from './transport.ts';

export interface VsCodeApiLike {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

/** window 'message' 이벤트 구독. 해제 함수를 돌려줘요. */
export type MessageListen = (cb: (data: unknown) => void) => () => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: unknown;
  method: string;
}

export function isHostToWebview(v: unknown): v is HostToWebview {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return t === 'rpcResult' || t === 'notify' || t === 'connection';
}

export class WebviewTransport implements HubConnection {
  readonly kind = 'webview' as const;
  #api: VsCodeApiLike;
  #listen: MessageListen;
  #timers: TimerApi;
  #unlisten: (() => void) | undefined;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #status: ConnectionStatus = 'connecting';
  #ls = new Listeners();

  constructor(api: VsCodeApiLike, listen: MessageListen, timers: TimerApi = defaultTimers) {
    this.#api = api;
    this.#listen = listen;
    this.#timers = timers;
  }

  get connected(): boolean {
    return this.#status === 'connected';
  }
  get status(): ConnectionStatus {
    return this.#status;
  }
  get statusDetail(): string {
    switch (this.#status) {
      case 'connected':
        return t('conn.detail.connected');
      case 'connecting':
        return t('conn.detail.waitingHost');
      default:
        return t('conn.detail.webviewDisconnected');
    }
  }

  start(): void {
    if (this.#unlisten) return;
    this.#unlisten = this.#listen((data) => this.#onMessage(data));
    this.#post({ type: 'ready' });
  }

  request<M extends RequestMethod>(method: M, params: ParamsOf<M>, timeoutMs = 30_000): Promise<ResultOf<M>> {
    if (this.#status === 'disconnected') {
      return Promise.reject(new RpcError(ErrorCode.InternalError, 'disconnected'));
    }
    const id = this.#nextId++;
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? this.#timers.setTimeout(() => {
              this.#pending.delete(id);
              reject(new RpcError(ErrorCode.Timeout, `timeout: ${method}`));
            }, timeoutMs)
          : undefined;
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.#post({ type: 'rpc', id, method, params, ...(timeoutMs > 0 ? { timeoutMs } : {}) });
    });
  }

  notify<N extends WindowNotification>(method: N, params: WindowNotificationMap[N]): void {
    this.#post({ type: 'notify', method, params });
  }

  hostNotify<N extends HostNotification>(method: N, params: HostNotificationMap[N]): void {
    this.#post({ type: 'notify', method, params });
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
    this.#unlisten?.();
    this.#unlisten = undefined;
    this.#rejectAll('disposed');
  }

  #post(msg: WebviewToHost): void {
    this.#api.postMessage(msg);
  }

  #onMessage(data: unknown): void {
    if (!isHostToWebview(data)) return;
    switch (data.type) {
      case 'rpcResult': {
        const p = this.#pending.get(data.id);
        if (!p) return;
        this.#pending.delete(data.id);
        if (p.timer !== undefined) this.#timers.clearTimeout(p.timer);
        if (data.error) p.reject(new RpcError(data.error.code, data.error.message));
        else p.resolve(data.result);
        return;
      }
      case 'notify':
        this.#ls.emitNotification(data.method, data.params);
        return;
      case 'connection':
        this.#setStatus(data.connected ? 'connected' : 'disconnected');
        return;
    }
  }

  #setStatus(s: ConnectionStatus): void {
    if (s === this.#status) return;
    const wasConnected = this.connected;
    this.#status = s;
    if (s !== 'connected') this.#rejectAll('disconnected');
    this.#ls.emitStatus(s);
    if (wasConnected !== this.connected) this.#ls.emitConnection(this.connected);
  }

  #rejectAll(reason: string): void {
    for (const [, p] of this.#pending) {
      if (p.timer !== undefined) this.#timers.clearTimeout(p.timer);
      p.reject(new RpcError(ErrorCode.InternalError, `${reason}: ${p.method}`));
    }
    this.#pending.clear();
  }
}
