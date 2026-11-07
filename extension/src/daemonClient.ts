// mk42d 데몬 클라이언트 — named pipe + NDJSON JSON-RPC, 재연결 1→2→4→…30초(계약 mk42d-ipc §2).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import {
  createDaemonApi,
  ErrorCode,
  PROTOCOL_VERSION,
  RpcError,
  RpcPeer,
  type DaemonApi,
  type DaemonNotification,
  type DaemonNotificationMap,
  type HelloResult,
  type WindowInfo,
} from '@mark42/protocol';
import { authSecretPath, newChallenge, readAuthSecret, verifyProof } from '@mark42/protocol/auth';
import { socketChannel } from '@mark42/protocol/node';
import { Backoff } from './lib/backoff.ts';
import { preferRenamedDaemonEntry } from './lib/role.ts';
import type { Logger } from './log.ts';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/** 인증 전에 온 알림을 들고 있는 최대 개수(넘치면 버려요) */
const MAX_HELD_NOTIFICATIONS = 256;

/** 파이프 주인이 데몬 비밀을 증명하지 못했어요(파이프 선점 의심) */
export class DaemonAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonAuthError';
  }
}

export interface DaemonClientOptions {
  pipeName: string;
  /**
   * 이 창을 맡은 Mark42 home — 그 home의 auth.secret으로 파이프 주인을 확인해요
   * (신뢰한 역할 워크스페이스의 home, 아니면 기본 home). 연결마다 다시 불러요.
   */
  authHome: () => string;
  /** undefined = 관리하지 않는 창: 서버 인증($/auth)만 하고 hello로 창 등록은 하지 않아요 */
  windowInfo: () => WindowInfo | undefined;
  log: Logger;
  /** 데몬이 없을 때 한 번 띄워 볼지(hub 창만) */
  spawn?: { nodePath: string; entry: string } | undefined;
}

type NotificationListener = <N extends DaemonNotification>(method: N, params: DaemonNotificationMap[N]) => void;

export class DaemonClient {
  #opts: DaemonClientOptions;
  #backoff = new Backoff();
  #state: ConnectionState = 'disconnected';
  #api: DaemonApi | undefined;
  #peer: RpcPeer | undefined;
  #socket: Socket | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;
  #spawned = false;
  #hello: HelloResult | undefined;
  #lastError: string | undefined;
  #stateListeners = new Set<(s: ConnectionState) => void>();
  #notifListeners = new Set<NotificationListener>();

  constructor(opts: DaemonClientOptions) {
    this.#opts = opts;
  }

  get state(): ConnectionState {
    return this.#state;
  }
  /** 연결돼 있을 때만 */
  get api(): DaemonApi | undefined {
    return this.#state === 'connected' ? this.#api : undefined;
  }
  get windowId(): string | undefined {
    return this.#hello?.windowId;
  }
  get daemonVersion(): string | undefined {
    return this.#hello?.daemonVersion;
  }
  get lastError(): string | undefined {
    return this.#lastError;
  }
  get pipeName(): string {
    return this.#opts.pipeName;
  }

  onStateChange(cb: (s: ConnectionState) => void): { dispose(): void } {
    this.#stateListeners.add(cb);
    return { dispose: () => this.#stateListeners.delete(cb) };
  }
  onNotification(cb: NotificationListener): { dispose(): void } {
    this.#notifListeners.add(cb);
    return { dispose: () => this.#notifListeners.delete(cb) };
  }

  start(): void {
    if (this.#disposed || this.#state !== 'disconnected' || this.#timer) return;
    this.#connect();
  }

  /** 기다리지 않고 바로 다시 연결해요(명령·설정 변경 때). */
  reconnectNow(): void {
    if (this.#disposed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#backoff.reset();
    if (this.#state === 'disconnected') this.#connect();
  }

  /** 창 정보가 바뀌면(역할 설정 변경) 다시 hello 하려고 연결을 끊고 다시 붙어요. */
  restart(): void {
    this.#teardown();
    this.reconnectNow();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#teardown();
    this.#stateListeners.clear();
    this.#notifListeners.clear();
  }

  #setState(s: ConnectionState): void {
    if (this.#state === s) return;
    this.#state = s;
    for (const cb of [...this.#stateListeners]) {
      try {
        cb(s);
      } catch (e) {
        this.#opts.log.error('state listener failed', e);
      }
    }
  }

  #teardown(): void {
    const peer = this.#peer;
    this.#peer = undefined;
    this.#api = undefined;
    this.#hello = undefined;
    if (peer && !peer.closed) peer.close();
    this.#socket?.destroy();
    this.#socket = undefined;
    if (!this.#disposed) this.#setState('disconnected');
  }

  #schedule(): void {
    if (this.#disposed || this.#timer) return;
    const delay = this.#backoff.next();
    this.#opts.log.debug(`daemon reconnect in ${delay}ms`);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#connect();
    }, delay);
  }

  #connect(): void {
    if (this.#disposed) return;
    this.#setState('connecting');
    const socket = connect(this.#opts.pipeName);
    this.#socket = socket;
    let opened = false;
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (opened) return;
      this.#lastError = err.code ?? err.message;
      this.#opts.log.debug(`daemon connect failed: ${this.#lastError}`);
      socket.destroy();
      if (this.#socket === socket) this.#socket = undefined;
      this.#setState('disconnected');
      if ((err.code === 'ENOENT' || err.code === 'ECONNREFUSED') && this.#maybeSpawn()) {
        // 데몬이 파이프를 열 시간을 줘요
        this.#backoff.reset();
      }
      this.#schedule();
    });
    socket.once('connect', () => {
      opened = true;
      void this.#onOpen(socket);
    });
  }

  /**
   * 연결을 믿기 전에 파이프 주인을 확인해요: 새 challenge를 보내고(hello.challenge, 관리하지 않는 창은 `$/auth`)
   * 이 창 home의 auth.secret으로 proof를 검증해요. 그 전에 온 알림은 들고만 있다가 검증되면 넘기고, 실패하면 버려요.
   * 실패하면 경고를 남기고 끊은 뒤 백오프로 다시 시도해요(바로 다시 붙지 않아요).
   */
  async #onOpen(socket: Socket): Promise<void> {
    const peer = new RpcPeer(socketChannel(socket));
    const { api, dispatch } = createDaemonApi(peer);
    let verified = false;
    let held: [string, unknown][] | undefined = [];
    let dropped = 0;
    peer.setHandlers({
      onNotification: (method, params) => {
        if (verified) {
          dispatch(method, params);
        } else if (held && held.length < MAX_HELD_NOTIFICATIONS) {
          held.push([method, params]);
        } else {
          dropped++;
        }
      },
      onRequest: (method) => {
        throw new RpcError(ErrorCode.MethodNotFound, method);
      },
    });
    api.onNotification((method, params) => {
      for (const cb of [...this.#notifListeners]) {
        try {
          cb(method, params);
        } catch (e) {
          this.#opts.log.error(`notification handler failed (${method})`, e);
        }
      }
    });
    // api는 검증 뒤에만 내보내요(#api·state 'connected')
    this.#peer = peer;
    peer.onClose(() => {
      if (this.#peer !== peer) return;
      this.#opts.log.info('daemon connection closed');
      this.#teardown();
      this.#schedule();
    });
    const pipe = this.#opts.pipeName;
    try {
      const home = this.#opts.authHome();
      let secret: Uint8Array;
      try {
        secret = await readAuthSecret(home);
      } catch (e) {
        throw new DaemonAuthError(
          `cannot read daemon auth secret ${authSecretPath(home)} (${e instanceof Error ? e.message : String(e)}) — not trusting ${pipe}`,
        );
      }
      if (this.#peer !== peer) return;
      // 창 정보(pid·폴더·워크스페이스 파일·확장 버전)는 주인 확인 뒤에만 보내요 — 먼저 $/auth만 해요.
      const challenge = newChallenge();
      let proof: unknown;
      try {
        proof = (await api.request('$/auth', { challenge }, 10_000))?.proof;
      } catch (e) {
        if (e instanceof RpcError && e.code === ErrorCode.ProtocolMismatch) throw e;
        // 인증을 모르는 상대(옛 데몬·가짜 서버)는 $/auth를 모르거나 이상하게 답해요
        if (e instanceof RpcError && (e.code === ErrorCode.MethodNotFound || e.code === ErrorCode.NotFound)) {
          throw new DaemonAuthError(`process on ${pipe} does not support daemon authentication (${e.message})`);
        }
        throw e;
      }
      if (!verifyProof(secret, pipe, challenge, proof)) {
        throw new DaemonAuthError(
          `process on ${pipe} did not prove knowledge of ${authSecretPath(home)} — the pipe may be held by another process (squatting); refusing the connection`,
        );
      }
      if (this.#peer !== peer) return;
      // 주인이 확인된 같은 연결에서만 창을 등록해요. 그동안 온 알림은 계속 들고 있다가 hello 뒤에 넘겨요.
      const info = this.#opts.windowInfo();
      const hello: HelloResult | undefined = info
        ? await api.request('hello', { protocolVersion: PROTOCOL_VERSION, window: info }, 10_000)
        : undefined;
      if (this.#peer !== peer) return;
      if (hello && hello.protocolVersion !== PROTOCOL_VERSION) {
        throw new RpcError(ErrorCode.ProtocolMismatch, `protocol ${hello.protocolVersion} != ${PROTOCOL_VERSION}`);
      }
      verified = true;
      this.#hello = hello;
      this.#api = api;
      if (hello) this.#opts.log.info(`daemon hello ok (authenticated): window ${hello.windowId}, daemon ${hello.daemonVersion}`);
      else this.#opts.log.info('daemon connected (authenticated, unmanaged window, no hello)');
      this.#lastError = undefined;
      this.#backoff.reset();
      this.#setState('connected');
      const queued = held ?? [];
      held = undefined;
      if (dropped > 0) this.#opts.log.warn(`dropped ${dropped} daemon notifications received before authentication`);
      for (const [m, p] of queued) {
        if (this.#peer !== peer) break;
        dispatch(m, p);
      }
    } catch (e) {
      const n = held?.length ?? 0;
      held = undefined;
      this.#lastError = e instanceof Error ? e.message : String(e);
      if (e instanceof DaemonAuthError) {
        this.#opts.log.warn(`daemon authentication failed: ${this.#lastError}${n + dropped > 0 ? ` (discarded ${n + dropped} notifications)` : ''}`);
      } else {
        this.#opts.log.error('daemon hello failed', e);
      }
      if (this.#peer === peer) {
        this.#teardown();
        this.#schedule();
      }
    }
  }

  /** hub 창 + daemonPath가 있을 때만, 활성화마다 한 번 띄워요. 경로를 추측하지 않아요. */
  #maybeSpawn(): boolean {
    const sp = this.#opts.spawn;
    if (!sp || this.#spawned) return false;
    this.#spawned = true;
    const entry = preferRenamedDaemonEntry(sp.entry, existsSync);
    if (entry !== sp.entry) this.#opts.log.info(`daemonPath points to the old m42d bundle; using ${entry}`);
    if (!existsSync(entry)) {
      this.#opts.log.warn(`daemonPath not found: ${entry}`);
      return false;
    }
    try {
      const child = spawn(sp.nodePath, [entry], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
      child.on('error', (e) => this.#opts.log.error('daemon spawn failed', e));
      child.unref();
      this.#opts.log.info(`spawned daemon: ${sp.nodePath} ${entry} (pid ${child.pid ?? '?'})`);
      return true;
    } catch (e) {
      this.#opts.log.error('daemon spawn failed', e);
      return false;
    }
  }
}
