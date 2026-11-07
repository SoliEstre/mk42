// NDJSON 프레이밍 + JSON-RPC 2.0 양방향 피어. 데몬·확장·hub UI가 같이 써요.
import { ErrorCode } from './methods.ts';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** 줄 단위 디코더. 청크 경계에서 잘린 줄은 다음 push까지 들고 있어요. */
export class LineDecoder {
  #buf = '';
  #maxLine: number;
  constructor(maxLine = 16 * 1024 * 1024) {
    this.#maxLine = maxLine;
  }
  push(chunk: string): string[] {
    this.#buf += chunk;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, nl).replace(/\r$/, '');
      this.#buf = this.#buf.slice(nl + 1);
      if (line.trim().length > 0) out.push(line);
    }
    if (this.#buf.length > this.#maxLine) {
      this.#buf = '';
      throw new RpcError(ErrorCode.InvalidRequest, 'line too long');
    }
    return out;
  }
}

/** 전송 계층 추상화: 줄 하나 = 메시지 하나 */
export interface LineChannel {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface RpcHandlers {
  onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  onNotification?: (method: string, params: unknown) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class RpcPeer {
  #channel: LineChannel;
  #handlers: RpcHandlers;
  #nextId = 1;
  #pending = new Map<number | string, Pending>();
  #closed = false;
  #closeListeners: (() => void)[] = [];

  constructor(channel: LineChannel, handlers: RpcHandlers = {}) {
    this.#channel = channel;
    this.#handlers = handlers;
    channel.onLine((line) => this.#onLine(line));
    channel.onClose(() => this.#onClose());
  }

  get closed(): boolean {
    return this.#closed;
  }

  setHandlers(handlers: RpcHandlers): void {
    this.#handlers = handlers;
  }

  onClose(cb: () => void): void {
    if (this.#closed) cb();
    else this.#closeListeners.push(cb);
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.#closed) return Promise.reject(new RpcError(ErrorCode.InternalError, 'channel closed'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new RpcError(ErrorCode.Timeout, `timeout: ${method}`));
            }, timeoutMs)
          : undefined;
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#write({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    this.#channel.close();
    this.#onClose();
  }

  #write(msg: JsonRpcMessage): void {
    try {
      this.#channel.send(JSON.stringify(msg));
    } catch {
      this.#onClose();
    }
  }

  #onLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.#write({ jsonrpc: '2.0', id: null, error: { code: ErrorCode.ParseError, message: 'parse error' } });
      return;
    }
    if (typeof msg !== 'object' || msg === null || (msg as { jsonrpc?: unknown }).jsonrpc !== '2.0') {
      this.#write({ jsonrpc: '2.0', id: null, error: { code: ErrorCode.InvalidRequest, message: 'invalid request' } });
      return;
    }
    if ('method' in msg && typeof msg.method === 'string') {
      if ('id' in msg && msg.id !== undefined && msg.id !== null) void this.#handleRequest(msg as JsonRpcRequest);
      else this.#handlers.onNotification?.(msg.method, msg.params);
      return;
    }
    const res = msg as JsonRpcResponse;
    if (res.id === null || res.id === undefined) return;
    const p = this.#pending.get(res.id);
    if (!p) return;
    this.#pending.delete(res.id);
    if (p.timer) clearTimeout(p.timer);
    if (res.error) p.reject(new RpcError(res.error.code, res.error.message, res.error.data));
    else p.resolve(res.result);
  }

  async #handleRequest(req: JsonRpcRequest): Promise<void> {
    const handler = this.#handlers.onRequest;
    if (!handler) {
      this.#write({ jsonrpc: '2.0', id: req.id, error: { code: ErrorCode.MethodNotFound, message: req.method } });
      return;
    }
    try {
      const result = await handler(req.method, req.params ?? {});
      this.#write({ jsonrpc: '2.0', id: req.id, result: result ?? {} });
    } catch (e) {
      const err =
        e instanceof RpcError
          ? { code: e.code, message: e.message, data: e.data }
          : { code: ErrorCode.InternalError, message: e instanceof Error ? e.message : String(e) };
      this.#write({ jsonrpc: '2.0', id: req.id, error: err });
    }
  }

  #onClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, p] of this.#pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError(ErrorCode.InternalError, 'channel closed'));
    }
    this.#pending.clear();
    for (const cb of this.#closeListeners.splice(0)) cb();
  }
}
