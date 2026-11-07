// 시험용 가짜 타이머·전송
import type {
  DaemonNotification,
  DaemonNotificationMap,
  ParamsOf,
  RequestMethod,
  ResultOf,
  WindowNotification,
  WindowNotificationMap,
} from '@mark42/protocol';
import type { TimerApi } from '../src/refresh.ts';
import type { ConnectionStatus, HubConnection } from '../src/transport.ts';
import type { HostNotification, HostNotificationMap } from '../src/host-messages.ts';

interface FakeTimer {
  id: number;
  at: number;
  cb: () => void;
}

export class FakeTimers implements TimerApi {
  now = 0;
  #next = 1;
  #timers: FakeTimer[] = [];

  setTimeout(cb: () => void, ms: number): unknown {
    const t = { id: this.#next++, at: this.now + ms, cb };
    this.#timers.push(t);
    return t.id;
  }
  clearTimeout(handle: unknown): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
  }
  get pending(): number {
    return this.#timers.length;
  }
  /** 다음 타이머 지연(없으면 undefined) */
  get nextDelay(): number | undefined {
    if (this.#timers.length === 0) return undefined;
    return Math.min(...this.#timers.map((t) => t.at)) - this.now;
  }
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.#timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.now = due.at;
      due.cb();
    }
    this.now = target;
  }
}

export interface RecordedRequest {
  method: string;
  params: unknown;
  timeoutMs?: number;
}

type Handler = (params: unknown) => unknown;

/** 메서드별 응답을 정해 두는 가짜 HubConnection */
export class FakeConnection implements HubConnection {
  kind: 'webview' | 'ws' = 'ws';
  status: ConnectionStatus = 'connected';
  statusDetail = '';
  readonly requests: RecordedRequest[] = [];
  readonly windowNotifies: RecordedRequest[] = [];
  readonly hostNotifies: RecordedRequest[] = [];
  readonly handlers = new Map<string, Handler>();
  #notif = new Set<(m: DaemonNotification, p: DaemonNotificationMap[DaemonNotification]) => void>();
  #conn = new Set<(c: boolean) => void>();
  #status = new Set<(s: ConnectionStatus) => void>();

  get connected(): boolean {
    return this.status === 'connected';
  }

  on(method: RequestMethod, h: Handler): this {
    this.handlers.set(method, h);
    return this;
  }

  async request<M extends RequestMethod>(method: M, params: ParamsOf<M>, timeoutMs?: number): Promise<ResultOf<M>> {
    this.requests.push({ method, params, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    const h = this.handlers.get(method);
    if (!h) throw Object.assign(new Error(`no handler: ${method}`), { code: -32601 });
    return (await h(params)) as ResultOf<M>;
  }
  notify<N extends WindowNotification>(method: N, params: WindowNotificationMap[N]): void {
    this.windowNotifies.push({ method, params });
  }
  hostNotify<N extends HostNotification>(method: N, params: HostNotificationMap[N]): void {
    this.hostNotifies.push({ method, params });
  }
  onNotification(cb: (m: DaemonNotification, p: DaemonNotificationMap[DaemonNotification]) => void): () => void {
    this.#notif.add(cb);
    return () => this.#notif.delete(cb);
  }
  onConnectionChange(cb: (c: boolean) => void): () => void {
    this.#conn.add(cb);
    return () => this.#conn.delete(cb);
  }
  onStatusChange(cb: (s: ConnectionStatus) => void): () => void {
    this.#status.add(cb);
    return () => this.#status.delete(cb);
  }
  dispose(): void {}

  emitNotification(method: string, params: unknown): void {
    for (const l of [...this.#notif]) l(method as DaemonNotification, params as never);
  }
  setStatus(s: ConnectionStatus): void {
    const was = this.connected;
    this.status = s;
    for (const l of [...this.#status]) l(s);
    if (was !== this.connected) for (const l of [...this.#conn]) l(this.connected);
  }
  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }
}

/** 마이크로태스크·짧은 프라미스 체인 비우기 */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
