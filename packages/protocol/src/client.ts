// 타입이 붙은 클라이언트 래퍼 — 확장(창)과 hub UI가 데몬을 부를 때 써요.
import type { RpcPeer } from './rpc.ts';
import type {
  DaemonNotification,
  DaemonNotificationMap,
  ParamsOf,
  RequestMethod,
  ResultOf,
  WindowNotification,
  WindowNotificationMap,
} from './methods.ts';

/** 데몬 쪽 호출 표면. 전송(named pipe / webview postMessage / WS)과 무관해요. */
export interface DaemonApi {
  request<M extends RequestMethod>(method: M, params: ParamsOf<M>, timeoutMs?: number): Promise<ResultOf<M>>;
  notify<N extends WindowNotification>(method: N, params: WindowNotificationMap[N]): void;
  onNotification(cb: <N extends DaemonNotification>(method: N, params: DaemonNotificationMap[N]) => void): () => void;
}

/** hub UI(웹뷰·별도 창)가 쓰는 전송. 연결 상태를 같이 알려요. */
export interface HubTransport extends DaemonApi {
  readonly connected: boolean;
  onConnectionChange(cb: (connected: boolean) => void): () => void;
}

/** 웹뷰 ↔ 확장 postMessage 봉투 (D20-A) */
export type WebviewToHost =
  | { type: 'rpc'; id: number; method: string; params: unknown; /** 웹뷰가 정한 요청 한도(ms) — 중계도 같은 한도로 데몬을 기다려요 */ timeoutMs?: number }
  | { type: 'notify'; method: string; params: unknown }
  | { type: 'ready' };
export type HostToWebview =
  | { type: 'rpcResult'; id: number; result?: unknown; error?: { code: number; message: string } }
  | { type: 'notify'; method: string; params: unknown }
  | { type: 'connection'; connected: boolean };

/**
 * RpcPeer 위에 타입을 입힌 DaemonApi. 피어의 알림 핸들러는 반환된 `dispatch`로 연결해요.
 *
 *   const peer = new RpcPeer(channel);
 *   const { api, dispatch } = createDaemonApi(peer);
 *   peer.setHandlers({ onNotification: dispatch, onRequest: ... });
 */
export function createDaemonApi(peer: RpcPeer): { api: DaemonApi; dispatch: (method: string, params: unknown) => void } {
  type Listener = (method: DaemonNotification, params: DaemonNotificationMap[DaemonNotification]) => void;
  const listeners = new Set<Listener>();
  const api: DaemonApi = {
    request: <M extends RequestMethod>(method: M, params: ParamsOf<M>, timeoutMs?: number) =>
      peer.request(method, params, timeoutMs) as Promise<ResultOf<M>>,
    notify: (method, params) => peer.notify(method, params),
    onNotification(cb) {
      const l = cb as Listener;
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
  const dispatch = (method: string, params: unknown): void => {
    for (const l of listeners) l(method as DaemonNotification, params as DaemonNotificationMap[DaemonNotification]);
  };
  return { api, dispatch };
}
