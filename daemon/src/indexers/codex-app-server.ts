// codex app-server 클라이언트 (stdio, 줄 단위 JSON). Codex 프로토콜은 JSON-RPC 2.0 모양이지만 "jsonrpc" 필드를 쓰지 않아요.
// 데몬은 목록용 읽기 전용 메서드만 불러요: initialize · thread/list · thread/loaded/list.
// thread/start·thread/resume·turn/start 같은 변경 메서드는 여기서 부르지 않아요.
import { spawn, type ChildProcess } from 'node:child_process';
import { LineDecoder } from '@mark42/protocol';

export class AppServerError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'AppServerError';
    this.code = code;
  }
}

export interface AppServerOptions {
  bin: string;
  /** CODEX_HOME (없으면 상속) */
  codexHome?: string;
  log?: (m: string) => void;
  /** initialize 응답 대기 (기본 5초) */
  handshakeTimeoutMs?: number;
  clientVersion?: string;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const READ_ONLY_METHODS = new Set(['initialize', 'thread/list', 'thread/loaded/list', 'thread/read']);

/** 스크립트 경로(.js/.mjs/.ts)면 현재 node로 실행해요 — 테스트용 가짜 app-server. */
function command(bin: string): { file: string; args: string[] } {
  if (/\.(?:m?js|ts)$/i.test(bin)) return { file: process.execPath, args: [bin, 'app-server'] };
  return { file: bin, args: ['app-server'] };
}

export class AppServerClient {
  #opts: AppServerOptions;
  #child: ChildProcess | undefined;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #ready: Promise<void> | undefined;
  #dead = false;
  #exitListeners: (() => void)[] = [];

  constructor(opts: AppServerOptions) {
    this.#opts = opts;
  }

  get alive(): boolean {
    return !this.#dead && this.#child !== undefined;
  }

  onExit(cb: () => void): void {
    this.#exitListeners.push(cb);
  }

  /** 프로세스를 띄우고 initialize → initialized 핸드셰이크 */
  start(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = this.#start();
    return this.#ready;
  }

  async #start(): Promise<void> {
    const log = this.#opts.log ?? (() => {});
    const { file, args } = command(this.#opts.bin);
    const env = { ...process.env };
    if (this.#opts.codexHome) env.CODEX_HOME = this.#opts.codexHome;
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    this.#child = child;
    const decoder = new LineDecoder();
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch {
        log('codex app-server: oversized line, dropped');
        return;
      }
      for (const line of lines) this.#onLine(line);
    });
    let stderrTail = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (s: string) => {
      stderrTail = (stderrTail + s).slice(-2000);
    });
    child.stdin!.on('error', () => {});
    const exited = new Promise<never>((_, reject) => {
      const fail = (why: string) => {
        if (!this.#dead) {
          this.#dead = true;
          const err = new AppServerError(`app-server ${why}${stderrTail ? `: ${stderrTail.trim().split('\n').pop()}` : ''}`);
          for (const [, p] of this.#pending) {
            clearTimeout(p.timer);
            p.reject(err);
          }
          this.#pending.clear();
          for (const cb of this.#exitListeners.splice(0)) cb();
          reject(err);
        }
      };
      child.once('error', (e) => fail(`spawn failed (${e.message})`));
      child.once('exit', (code, signal) => fail(`exited (code=${code}, signal=${signal})`));
    });
    exited.catch(() => {});
    const init = this.#send(
      'initialize',
      {
        clientInfo: { name: 'mark42', title: 'Mark42', version: this.#opts.clientVersion ?? '0.1.0' },
        capabilities: { experimentalApi: false },
      },
      this.#opts.handshakeTimeoutMs ?? 5000,
    );
    try {
      await Promise.race([init, exited]);
    } catch (e) {
      this.kill();
      throw e;
    }
    this.#write({ method: 'initialized' });
  }

  /** 읽기 전용 메서드만 허용해요. */
  async request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (!READ_ONLY_METHODS.has(method)) throw new AppServerError(`method not allowed: ${method}`);
    await this.start();
    return this.#send(method, params, timeoutMs);
  }

  #send(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.#dead) return Promise.reject(new AppServerError('app-server not running'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AppServerError(`timeout: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  #write(msg: unknown): void {
    try {
      this.#child?.stdin?.write(JSON.stringify(msg) + '\n');
    } catch {
      // exit 이벤트에서 정리돼요.
    }
  }

  #onLine(line: string): void {
    let m: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(line);
      if (typeof v !== 'object' || v === null) return;
      m = v as Record<string, unknown>;
    } catch {
      return;
    }
    const id = m.id;
    if (typeof m.method === 'string') {
      // 서버 요청(승인 등)에는 응하지 않아요 — 이 연결은 스레드를 돌리지 않아요.
      if (typeof id === 'number' || typeof id === 'string') this.#write({ id, error: { code: -32601, message: 'not supported by mark42 indexer' } });
      return;
    }
    if (typeof id !== 'number') return;
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    const err = m.error as { code?: number; message?: string } | undefined;
    if (err) p.reject(new AppServerError(`${p.method}: ${err.message ?? 'error'}`, err.code));
    else p.resolve(m.result);
  }

  /** stdin을 닫으면 스스로 끝나요. 2초 안에 안 끝나면 강제 종료. */
  async close(): Promise<void> {
    const child = this.#child;
    if (!child || this.#dead) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.kill();
        resolve();
      }, 2000);
      t.unref?.();
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.stdin?.end();
      } catch {
        this.kill();
      }
    });
  }

  kill(): void {
    try {
      this.#child?.kill();
    } catch {
      // 이미 끝남
    }
  }
}
