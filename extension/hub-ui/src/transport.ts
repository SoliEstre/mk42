// hub UI 전송 공통부. 웹뷰(postMessage)·별도 창(WebSocket) 둘 다 HubTransport를 구현해요.
import type { DaemonNotification, DaemonNotificationMap, HubTransport } from '@mark42/protocol';
import type { HostNotification, HostNotificationMap } from './host-messages.ts';

/** `superseded` = 더 새로 연 통합 창이 데몬에 붙어서 이 창은 물러났어요(다시 붙지 않아요). */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'authFailed' | 'superseded';

export interface HubConnection extends HubTransport {
  readonly kind: 'webview' | 'ws';
  readonly status: ConnectionStatus;
  /** 사람이 읽을 연결 상태 설명(한국어) */
  readonly statusDetail: string;
  onStatusChange(cb: (status: ConnectionStatus) => void): () => void;
  /** 웹뷰 모드에서만 — 확장 호스트에 'ui.*' 알림 */
  hostNotify?<N extends HostNotification>(method: N, params: HostNotificationMap[N]): void;
  /** 대기 중인 재연결을 바로 시도 */
  reconnectNow?(): void;
  dispose(): void;
}

type AnyNotificationListener = (method: DaemonNotification, params: DaemonNotificationMap[DaemonNotification]) => void;

/** 리스너 집합 묶음 — 두 전송이 같이 써요. */
export class Listeners {
  readonly notification = new Set<AnyNotificationListener>();
  readonly connection = new Set<(connected: boolean) => void>();
  readonly status = new Set<(status: ConnectionStatus) => void>();

  emitNotification(method: string, params: unknown): void {
    for (const l of [...this.notification]) {
      try {
        l(method as DaemonNotification, params as DaemonNotificationMap[DaemonNotification]);
      } catch (e) {
        console.error('[hub-ui] notification listener failed', e);
      }
    }
  }
  emitConnection(connected: boolean): void {
    for (const l of [...this.connection]) l(connected);
  }
  emitStatus(status: ConnectionStatus): void {
    for (const l of [...this.status]) l(status);
  }
}

export function addListener<T>(set: Set<T>, cb: T): () => void {
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}
