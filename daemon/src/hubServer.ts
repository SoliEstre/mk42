// hub (B) 루프백 서버 (WBS 2.9B, D20-B) — 127.0.0.1 임의 포트 HTTP + /rpc WebSocket(실행마다 새 토큰).
// 첫 프레임 {"type":"auth","token"} 이 맞아야 JSON-RPC 2.0 텍스트 프레임을 받아요(틀리면 4401로 닫음).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { RpcPeer, type LineChannel } from '@mark42/protocol';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { atomicWriteFile } from './fsutil.ts';
import { createMemoryLogger, errMsg, type Logger } from './log.ts';

export const AUTH_FAILED_CLOSE_CODE = 4401;
const MAX_FRAME = 16 * 1024 * 1024;

export interface HubUiFiles {
  index: string;
  js: string;
  css: string;
}

/**
 * 기본 위치: repo 레이아웃 기준(daemon/src·daemon/dist 둘 다 repo 루트에서 두 단계 아래).
 * index.html은 extension/hub-ui/, 번들은 extension/dist/. settings.hubUiDir가 있으면 세 파일 모두 그 폴더에서.
 */
export function hubUiFiles(uiDir?: string, base: string | URL = import.meta.url): HubUiFiles {
  if (uiDir) return { index: join(uiDir, 'index.html'), js: join(uiDir, 'hub-ui.js'), css: join(uiDir, 'hub-ui.css') };
  const root = fileURLToPath(new URL('../../', base));
  return {
    index: join(root, 'extension', 'hub-ui', 'index.html'),
    js: join(root, 'extension', 'dist', 'hub-ui.js'),
    css: join(root, 'extension', 'dist', 'hub-ui.css'),
  };
}

export const HUB_CSP =
  "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': HUB_CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export interface HubAttachTarget {
  attach(peer: RpcPeer, kind: 'hub-ws'): void;
}

export interface HubServerOptions {
  core: HubAttachTarget;
  /** 직접 지정한 UI 파일 (테스트), 없으면 hubUiFiles(uiDir) */
  files?: HubUiFiles;
  uiDir?: string;
  /** 정확히 이 포트(없으면 preferredPort, 그것도 없으면 아무 포트) */
  port?: number;
  /**
   * 먼저 이 포트를 써 보고, 쓰는 중이면 아무 포트. 토큰은 실행마다 새로라(고정 토큰은 그 사이 포트를 잡은 프로그램에 넘어갈 수 있어요)
   * 이전 실행의 통합 창은 같은 주소로 다시 붙으려다 토큰 거절(4401)을 받고 스스로 닫혀요 — «연결 끊김» 창이 남지 않게.
   */
  preferredPort?: number;
  token?: string;
  log?: Logger;
  authTimeoutMs?: number;
}

/** 더 새로 연 통합 창이 붙어서 이전 창을 닫을 때의 코드(제어 프레임 {"type":"superseded"}를 먼저 보내요) */
export const SUPERSEDED_CLOSE_CODE = 4409;

/**
 * `<home>\hub.json` = `{port, pipe}` — 지난번 통합 창 포트(다음 시작 때 먼저 써 봐요)와 데몬 파이프 이름(작업 표시줄에 고정한
 * Mk42 통합 창 exe가 인자 없이 뜨면 이 파이프로 `$/openHub`를 부탁해요 — hub-host `HubLauncher`)
 */
export function hubStateFile(home: string): string {
  return join(home, 'hub.json');
}

export async function readHubPort(home: string): Promise<number | undefined> {
  try {
    const v = (JSON.parse(await fsp.readFile(hubStateFile(home), 'utf8')) as { port?: unknown }).port;
    return typeof v === 'number' && Number.isInteger(v) && v > 1024 && v < 65536 ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function saveHubPort(home: string, port: number, pipe?: string): Promise<void> {
  await atomicWriteFile(hubStateFile(home), JSON.stringify({ port, pipe }) + '\n');
}

export interface HubServer {
  readonly port: number;
  readonly token: string;
  /** 통합 창 주소 (토큰은 hash — 서버로 보내지지 않아요). 창을 새로 열 때는 nextWindowUrl() */
  readonly appUrl: string;
  /** 통합 창을 새로 열 때 쓰는 주소 — 창 번호 `w`가 하나씩 커져요. 데몬은 가장 큰 번호의 창 하나만 남겨요 */
  nextWindowUrl(): string;
  close(): Promise<void>;
}

function tokenEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Host·Origin이 루프백 주소(그 포트)인지 — DNS rebinding·다른 사이트의 WS 연결 차단 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true; // 브라우저가 아닌 클라이언트 (토큰은 여전히 필요)
  const o = origin.toLowerCase();
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

function wsChannel(ws: WebSocket): { channel: LineChannel; deliver: (text: string) => void } {
  const lineCbs: ((line: string) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  let closed = false;
  ws.on('close', () => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs.splice(0)) cb();
  });
  return {
    deliver(text) {
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line) for (const cb of lineCbs) cb(line);
      }
    },
    channel: {
      send(line) {
        if (closed) throw new Error('closed');
        ws.send(line);
      },
      onLine(cb) {
        lineCbs.push(cb);
      },
      onClose(cb) {
        if (closed) cb();
        else closeCbs.push(cb);
      },
      close() {
        try {
          ws.close(1000);
        } catch {
          // 무시
        }
      },
    },
  };
}

function rawToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

export async function startHubServer(opts: HubServerOptions): Promise<HubServer> {
  const log = opts.log ?? createMemoryLogger();
  const token = opts.token ?? randomBytes(24).toString('base64url');
  const files = opts.files ?? hubUiFiles(opts.uiDir);
  const authTimeoutMs = opts.authTimeoutMs ?? 5000;
  let port = 0;

  const routes: Record<string, { file: string; type: string }> = {
    '/': { file: files.index, type: 'text/html; charset=utf-8' },
    '/index.html': { file: files.index, type: 'text/html; charset=utf-8' },
    '/hub-ui.js': { file: files.js, type: 'text/javascript; charset=utf-8' },
    '/hub-ui.css': { file: files.css, type: 'text/css; charset=utf-8' },
  };

  const send = (res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  };

  const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
    if (!isAllowedHost(req.headers.host, port) || !isAllowedOrigin(req.headers.origin, port)) {
      send(res, 403, 'forbidden');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'method not allowed');
      return;
    }
    const path = (req.url ?? '/').split('?')[0]!.split('#')[0]!;
    const route = routes[path];
    if (!route) {
      send(res, 404, 'not found');
      return;
    }
    try {
      send(res, 200, await fsp.readFile(route.file), route.type);
    } catch (e) {
      log.warn(`hub ui file missing: ${route.file} (${errMsg(e)})`);
      send(res, 404, 'hub UI not built');
    }
  };

  const server = createServer((req, res) => {
    onRequest(req, res).catch((e) => {
      log.error(`hub request failed: ${errMsg(e)}`);
      if (!res.headersSent) send(res, 500, 'error');
      else res.destroy();
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

  const reject = (socket: Duplex, status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/rpc') return reject(socket, '404 Not Found');
    // 브라우저는 WebSocket에 늘 Origin을 붙여요 — 없으면(브라우저가 아닌 프로그램) 받지 않아요
    if (!isAllowedHost(req.headers.host, port) || !req.headers.origin || !isAllowedOrigin(req.headers.origin, port)) {
      log.warn(`hub ws rejected: host=${req.headers.host ?? '-'} origin=${req.headers.origin ?? '-'}`);
      return reject(socket, '403 Forbidden');
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  // 통합 창은 하나만: 인증된 창마다 창 번호(w — 데몬이 연 순서, 주소에 붙여 줌)를 기억했다가, 가장 큰 번호 말고는 물러나게 해요.
  // 다시 불러온 창은 같은 주소라 번호가 그대로예요. 번호 없이 연 창(손으로 연 주소)은 가장 오래된 것으로 봐요.
  const hubs = new Map<WebSocket, number>();
  const supersede = (ws: WebSocket) => {
    hubs.delete(ws);
    try {
      ws.send(JSON.stringify({ type: 'superseded' }));
    } catch {
      // 무시
    }
    ws.close(SUPERSEDED_CLOSE_CODE, 'superseded');
  };
  let windowSeq = 0;
  const keepNewest = (ws: WebSocket, w: number) => {
    hubs.set(ws, w);
    let newest: WebSocket | undefined;
    let newestAt = -Infinity;
    for (const [w, at] of hubs) {
      if (at > newestAt || (at === newestAt && w === ws)) {
        newest = w;
        newestAt = at;
      }
    }
    for (const w of [...hubs.keys()]) if (w !== newest) supersede(w);
  };

  const onConnection = (ws: WebSocket) => {
    let authed = false;
    ws.on('close', () => hubs.delete(ws));
    const { channel, deliver } = wsChannel(ws);
    const timer = setTimeout(() => {
      if (!authed) ws.close(AUTH_FAILED_CLOSE_CODE, 'auth timeout');
    }, authTimeoutMs);
    timer.unref();
    ws.on('close', () => clearTimeout(timer));
    ws.on('error', (e) => log.warn(`hub ws error: ${errMsg(e)}`));
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, 'text frames only');
        return;
      }
      const text = rawToText(data);
      if (authed) {
        deliver(text);
        return;
      }
      // 첫 프레임 = 인증. 같은 프레임에 줄바꿈으로 뒤따른 메시지가 있으면 이어서 처리해요.
      const nl = text.indexOf('\n');
      const first = nl >= 0 ? text.slice(0, nl) : text;
      const rest = nl >= 0 ? text.slice(nl + 1) : '';
      let msg: { type?: unknown; token?: unknown; w?: unknown } | undefined;
      try {
        msg = JSON.parse(first) as { type?: unknown; token?: unknown; w?: unknown };
      } catch {
        msg = undefined;
      }
      if (!msg || msg.type !== 'auth' || typeof msg.token !== 'string' || !tokenEquals(msg.token, token)) {
        log.warn('hub ws auth failed');
        try {
          ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'invalid token' }));
        } catch {
          // 무시
        }
        ws.close(AUTH_FAILED_CLOSE_CODE, 'auth failed');
        return;
      }
      authed = true;
      clearTimeout(timer);
      ws.send(JSON.stringify({ type: 'auth', ok: true }));
      const w = typeof msg.w === 'number' && Number.isInteger(msg.w) && msg.w > 0 ? msg.w : 0;
      keepNewest(ws, w);
      if (!hubs.has(ws)) {
        log.info('hub window superseded by a newer one (on connect)');
        return;
      }
      opts.core.attach(new RpcPeer(channel), 'hub-ws');
      if (rest.trim()) deliver(rest);
    });
  };

  const listen = (p: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  if (opts.port !== undefined) await listen(opts.port);
  else if (opts.preferredPort) {
    try {
      await listen(opts.preferredPort);
    } catch (e) {
      log.info(`hub port ${opts.preferredPort} not available (${errMsg(e)}); using another`);
      await listen(0);
    }
  } else await listen(0);
  port = (server.address() as AddressInfo).port;
  log.info(`hub server listening on 127.0.0.1:${port}`);

  return {
    port,
    token,
    appUrl: `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`,
    nextWindowUrl: () => `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}&w=${++windowSeq}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
