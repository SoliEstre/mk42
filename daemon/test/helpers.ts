// 테스트 공용 — 임시 홈, 가짜 인덱서, 가짜 실행기, 파이프 클라이언트.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROTOCOL_VERSION,
  RpcPeer,
  type AgentKind,
  type DaemonNotification,
  type DaemonNotificationMap,
  type HelloResult,
  type LineChannel,
  type ParamsOf,
  type RequestMethod,
  type ResultOf,
  type SessionSummary,
  type WindowInfo,
} from '@mark42/protocol';
import { socketChannel } from '@mark42/protocol/node';
import type { ListOptions, LiveSession, SessionIndexer } from '../src/indexers/types.ts';
import { AppLauncher, type DiscoveredInstall } from '../src/launcher.ts';
import type { DaemonSettings } from '../src/registry.ts';

export function tempDir(prefix = 'm42d-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function uniquePipeName(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mark42-test-${process.pid}-${randomBytes(4).toString('hex')}`
    : join(tmpdir(), `mark42-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`);
}

export class FakeIndexer implements SessionIndexer {
  readonly agent: AgentKind;
  sessions: SessionSummary[] = [];
  liveSessions: LiveSession[] = [];
  started = false;
  stopped = false;
  onChange: (() => void) | undefined;
  liveError: Error | undefined;
  constructor(agent: AgentKind) {
    this.agent = agent;
  }
  async list(_opts: ListOptions): Promise<SessionSummary[]> {
    return this.sessions.map((s) => ({ ...s }));
  }
  async live(): Promise<LiveSession[]> {
    if (this.liveError) throw this.liveError;
    return this.liveSessions.map((s) => ({ ...s }));
  }
  async start(onChange: () => void): Promise<void> {
    this.started = true;
    this.onChange = onChange;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

export interface SpawnCall {
  command: string;
  args: string[];
}

export const FAKE_INSTALL: DiscoveredInstall = { version: '1.141.1', exe: 'C:\\Fake\\Code.exe', source: 'registry', product: 'mark42' };

export function fakeLauncher(home: string, settings: () => DaemonSettings, calls: SpawnCall[]): AppLauncher {
  return new AppLauncher({
    home,
    getSettings: settings,
    discover: async () => [FAKE_INSTALL],
    spawn: async (command, args) => {
      calls.push({ command, args });
      return { pid: 4242 };
    },
    env: {},
  });
}

export function sequenceIds(): (kind: string) => string {
  const counters: Record<string, number> = {};
  return (kind) => {
    counters[kind] = (counters[kind] ?? 0) + 1;
    const n = counters[kind];
    switch (kind) {
      case 'slot':
        return `s${n}`;
      case 'pinned':
        return `p${n}`;
      case 'request':
        return `r${n}`;
      case 'window':
        return `w${n}`;
      default:
        return `c${n}`;
    }
  };
}

export interface TestClient {
  peer: RpcPeer;
  notifications: { method: string; params: unknown }[];
  request<M extends RequestMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
  hello(window: Partial<WindowInfo> & Pick<WindowInfo, 'role'>): Promise<HelloResult>;
  waitFor<N extends DaemonNotification>(
    method: N,
    pred?: (p: DaemonNotificationMap[N]) => boolean,
    timeoutMs?: number,
  ): Promise<DaemonNotificationMap[N]>;
  close(): void;
}

export function wrapPeer(peer: RpcPeer): TestClient {
  const notifications: { method: string; params: unknown }[] = [];
  const waiters: (() => void)[] = [];
  peer.setHandlers({
    onNotification: (method, params) => {
      notifications.push({ method, params });
      for (const w of waiters.splice(0)) w();
    },
  });
  const client: TestClient = {
    peer,
    notifications,
    request: (method, params) => peer.request(method, params, 5000) as Promise<never>,
    hello: (window) =>
      client.request('hello', {
        protocolVersion: PROTOCOL_VERSION,
        window: { pid: 1, appVersion: '1.141.1', extensions: [], ...window },
      }),
    waitFor: (method, pred, timeoutMs = 2000) =>
      new Promise((resolve, reject) => {
        let seen = 0;
        const check = (): boolean => {
          for (; seen < notifications.length; seen++) {
            const n = notifications[seen]!;
            if (n.method === method && (!pred || pred(n.params as never))) {
              resolve(n.params as never);
              return true;
            }
          }
          return false;
        };
        if (check()) return;
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
        const loop = () => {
          if (check()) clearTimeout(timer);
          else waiters.push(loop);
        };
        waiters.push(loop);
      }),
    close: () => peer.close(),
  };
  return client;
}

export async function connectPipe(pipe: string): Promise<TestClient> {
  const socket = connect(pipe);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return wrapPeer(new RpcPeer(socketChannel(socket)));
}

/** 메모리 안의 LineChannel 쌍 (파이프 없이 코어를 시험할 때) */
export function memoryChannelPair(): [LineChannel, LineChannel] {
  const make = () => ({ lines: [] as ((l: string) => void)[], closes: [] as (() => void)[], closed: false });
  const a = make();
  const b = make();
  const side = (self: ReturnType<typeof make>, other: ReturnType<typeof make>): LineChannel => ({
    send(line) {
      if (self.closed) throw new Error('closed');
      queueMicrotask(() => {
        for (const cb of other.lines) cb(line);
      });
    },
    onLine(cb) {
      self.lines.push(cb);
    },
    onClose(cb) {
      if (self.closed) cb();
      else self.closes.push(cb);
    },
    close() {
      for (const s of [self, other]) {
        if (s.closed) continue;
        s.closed = true;
        for (const cb of s.closes.splice(0)) cb();
      }
    },
  });
  return [side(a, b), side(b, a)];
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 조건이 참이 될 때까지 기다려요 (비동기 알림 처리 확인용). */
export async function until(cond: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await delay(5);
  }
}
