import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, RpcError, type WebviewToHost } from '@mark42/protocol';
import { WebviewTransport, isHostToWebview, type VsCodeApiLike } from '../src/transport-webview.ts';
import { WsTransport, type WebSocketLike } from '../src/transport-ws.ts';
import { HUB_UI_COMMANDS, isHostNotification, isHubUiCommand } from '../src/host-messages.ts';
import { FakeTimers, flush } from './fakes.ts';
import { setLanguage } from '../src/i18n.ts';

// 한국어 화면 글을 그대로 확인해요(이 PC의 표시 언어와 무관하게).
setLanguage('ko');

// ---- 웹뷰 ----

function makeWebview() {
  const posted: WebviewToHost[] = [];
  let state: unknown;
  const api: VsCodeApiLike = {
    postMessage: (m) => void posted.push(m as WebviewToHost),
    getState: () => state,
    setState: (s) => void (state = s),
  };
  let deliver: ((d: unknown) => void) | undefined;
  let unlistened = false;
  const timers = new FakeTimers();
  const t = new WebviewTransport(
    api,
    (cb) => {
      deliver = cb;
      return () => void (unlistened = true);
    },
    timers,
  );
  return {
    t,
    posted,
    timers,
    send: (d: unknown) => deliver?.(d),
    get unlistened() {
      return unlistened;
    },
  };
}

test('webview: start는 ready를 보내고 connection 봉투로 상태가 바뀌어요', () => {
  const w = makeWebview();
  const statuses: string[] = [];
  const conns: boolean[] = [];
  w.t.onStatusChange((s) => statuses.push(s));
  w.t.onConnectionChange((c) => conns.push(c));
  assert.equal(w.t.status, 'connecting');
  w.t.start();
  w.t.start();
  assert.deepEqual(w.posted, [{ type: 'ready' }]);
  w.send({ type: 'connection', connected: true });
  assert.equal(w.t.connected, true);
  w.send({ type: 'connection', connected: true });
  w.send({ type: 'connection', connected: false });
  assert.deepEqual(statuses, ['connected', 'disconnected']);
  assert.deepEqual(conns, [true, false]);
  w.t.dispose();
  assert.ok(w.unlistened);
});

test('webview: rpc 봉투 왕복 — 결과·오류·시간 초과', async () => {
  const w = makeWebview();
  w.t.start();
  w.send({ type: 'connection', connected: true });

  const p1 = w.t.request('folders.list', {});
  const req = w.posted[1] as Extract<WebviewToHost, { type: 'rpc' }>;
  assert.equal(req.type, 'rpc');
  assert.equal(req.method, 'folders.list');
  w.send({ type: 'rpcResult', id: req.id, result: [{ id: 'f', path: 'C:\\a', label: 'a', addedAt: '' }] });
  assert.equal((await p1).length, 1);

  const p2 = w.t.request('folders.add', { path: 'x' });
  const req2 = w.posted[2] as Extract<WebviewToHost, { type: 'rpc' }>;
  w.send({ type: 'rpcResult', id: req2.id, error: { code: ErrorCode.InvalidPath, message: 'bad' } });
  await assert.rejects(p2, (e: unknown) => e instanceof RpcError && e.code === ErrorCode.InvalidPath);

  const p3 = w.t.request('windows.list', {}, 1000);
  w.timers.advance(1000);
  await assert.rejects(p3, (e: unknown) => e instanceof RpcError && e.code === ErrorCode.Timeout);

  // 모르는 id·잘못된 봉투는 무시
  w.send({ type: 'rpcResult', id: 999, result: 1 });
  w.send({ nope: true });
  w.send(null);
});

test('webview: 끊기면 대기 중인 요청을 거절하고, 끊긴 동안 요청은 바로 거절', async () => {
  const w = makeWebview();
  w.t.start();
  w.send({ type: 'connection', connected: true });
  const p = w.t.request('pinned.list', {});
  w.send({ type: 'connection', connected: false });
  await assert.rejects(p, /disconnected/);
  await assert.rejects(w.t.request('pinned.list', {}), /disconnected/);
});

test('webview: 데몬 알림은 notify 봉투로, 창·호스트 알림은 notify 봉투로 보내요', () => {
  const w = makeWebview();
  w.t.start();
  const got: [string, unknown][] = [];
  const off = w.t.onNotification((m, p) => got.push([m, p]));
  w.send({ type: 'notify', method: 'state.changed', params: { topics: ['folders'] } });
  off();
  w.send({ type: 'notify', method: 'state.changed', params: { topics: ['pinned'] } });
  assert.deepEqual(got, [['state.changed', { topics: ['folders'] }]]);

  w.t.hostNotify('ui.command', { command: 'mark42.reloadWindow' });
  w.t.hostNotify('ui.addFolder', {});
  w.t.notify('window.status', { focused: true });
  assert.deepEqual(w.posted.slice(1), [
    { type: 'notify', method: 'ui.command', params: { command: 'mark42.reloadWindow' } },
    { type: 'notify', method: 'ui.addFolder', params: {} },
    { type: 'notify', method: 'window.status', params: { focused: true } },
  ]);
});

test('isHostToWebview·host-messages 가드', () => {
  assert.ok(isHostToWebview({ type: 'connection', connected: true }));
  assert.ok(!isHostToWebview({ type: 'rpc' }));
  assert.ok(isHostNotification('ui.command'));
  assert.ok(isHostNotification('ui.addFolder'));
  assert.ok(!isHostNotification('window.status'));
  for (const c of HUB_UI_COMMANDS) assert.ok(isHubUiCommand(c));
  assert.ok(!isHubUiCommand('workbench.action.quit'));
});

// ---- WebSocket ----

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | undefined;
  #l: Record<string, ((ev: never) => void)[]> = {};
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }
  addEventListener(type: string, cb: (ev: never) => void): void {
    (this.#l[type] ??= []).push(cb);
  }
  #fire(type: string, ev?: unknown): void {
    for (const cb of this.#l[type] ?? []) (cb as (e: unknown) => void)(ev);
  }
  open(): void {
    this.readyState = 1;
    this.#fire('open');
  }
  message(data: unknown): void {
    this.#fire('message', { data });
  }
  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.#fire('close', { code, reason });
  }
  json(i: number): Record<string, unknown> {
    return JSON.parse(this.sent[i]!) as Record<string, unknown>;
  }
}

function makeWs(token: string | null = 'tok') {
  const sockets: FakeSocket[] = [];
  const timers = new FakeTimers();
  const t = new WsTransport({
    url: 'ws://127.0.0.1:1234/rpc',
    token: token ?? undefined,
    windowNumber: 3,
    timers,
    factory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  });
  return { t, sockets, timers, last: () => sockets[sockets.length - 1]! };
}

test('ws: 첫 프레임은 auth, 그 뒤 JSON-RPC 텍스트 프레임', async () => {
  const w = makeWs('secret');
  const conns: boolean[] = [];
  w.t.onConnectionChange((c) => conns.push(c));
  w.t.start();
  assert.equal(w.t.status, 'connecting');
  const s = w.last();
  assert.equal(s.url, 'ws://127.0.0.1:1234/rpc');
  s.open();
  assert.deepEqual(s.json(0), { type: 'auth', token: 'secret', w: 3 });
  assert.equal(w.t.connected, true);
  assert.deepEqual(conns, [true]);

  const p = w.t.request('folders.list', {});
  const req = s.json(1);
  assert.equal(req.jsonrpc, '2.0');
  assert.equal(req.method, 'folders.list');
  assert.ok(!s.sent[1]!.includes('\n'));
  s.message(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: [] }));
  assert.deepEqual(await p, []);

  const p2 = w.t.request('folders.remove', { folderId: 'x' });
  const req2 = s.json(2);
  s.message(JSON.stringify({ jsonrpc: '2.0', id: req2.id, error: { code: ErrorCode.NotFound, message: 'no' } }));
  await assert.rejects(p2, (e: unknown) => e instanceof RpcError && e.code === ErrorCode.NotFound);

  w.t.notify('window.status', { focused: false });
  assert.deepEqual(s.json(3), { jsonrpc: '2.0', method: 'window.status', params: { focused: false } });
});

test('ws: 알림 전달, 서버 auth 승인 프레임은 무시, 한 프레임에 여러 줄도 받아요', () => {
  const w = makeWs();
  w.t.start();
  const s = w.last();
  s.open();
  const got: string[] = [];
  w.t.onNotification((m, p) => got.push(`${m}:${JSON.stringify(p)}`));
  s.message(JSON.stringify({ type: 'auth', ok: true }));
  s.message(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'state.changed', params: { topics: ['folders'] } })}\n${JSON.stringify({
      jsonrpc: '2.0',
      method: 'state.changed',
      params: { topics: ['pinned'] },
    })}\n`,
  );
  s.message(new Uint8Array([1, 2]));
  assert.deepEqual(got, ['state.changed:{"topics":["folders"]}', 'state.changed:{"topics":["pinned"]}']);
  assert.equal(w.t.connected, true);
});

test('ws: 끊기면 대기 요청 거절 + 백오프로 다시 연결, 다시 붙으면 attempt 초기화', async () => {
  const w = makeWs();
  const statuses: string[] = [];
  w.t.onStatusChange((s) => statuses.push(s));
  w.t.start();
  w.last().open();
  const pending = w.t.request('pinned.list', {});
  w.last().serverClose(1006);
  await assert.rejects(pending, /channel closed/);
  assert.equal(w.t.status, 'disconnected');
  assert.match(w.t.statusDetail, /1초 뒤/);
  await assert.rejects(w.t.request('pinned.list', {}), /disconnected/);

  assert.equal(w.timers.nextDelay, 500);
  w.timers.advance(500);
  assert.equal(w.sockets.length, 2);
  assert.equal(w.t.status, 'connecting');
  // 연결 실패가 이어지면 지연이 두 배로
  w.last().serverClose(1006);
  assert.equal(w.timers.nextDelay, 1000);
  w.timers.advance(1000);
  w.last().serverClose(1006);
  assert.equal(w.timers.nextDelay, 2000);

  // reconnectNow는 대기 없이 바로
  w.t.reconnectNow();
  assert.equal(w.sockets.length, 4);
  assert.equal(w.timers.pending, 0);
  w.last().open();
  assert.equal(w.t.connected, true);
  w.last().serverClose(1001);
  assert.equal(w.timers.nextDelay, 500);
  assert.ok(statuses.includes('connected'));
});

test('ws: 토큰 거절(닫힘 코드 4401 또는 auth ok:false)이면 다시 연결하지 않아요', () => {
  const a = makeWs();
  a.t.start();
  a.last().open();
  a.last().serverClose(4401, 'unauthorized');
  assert.equal(a.t.status, 'authFailed');
  assert.equal(a.timers.pending, 0);
  a.t.reconnectNow();
  assert.equal(a.sockets.length, 1);

  const b = makeWs();
  b.t.start();
  b.last().open();
  b.last().message(JSON.stringify({ type: 'auth', ok: false, error: 'bad token' }));
  assert.equal(b.last().closedWith?.code, 4401);
  b.last().serverClose(1005);
  assert.equal(b.t.status, 'authFailed');
  assert.equal(b.timers.pending, 0);
});

test('ws: 새 통합 창에 밀리면(superseded 프레임 또는 4409) 다시 연결하지 않아요', () => {
  const a = makeWs();
  const statuses: string[] = [];
  a.t.onStatusChange((s) => statuses.push(s));
  a.t.start();
  a.last().open();
  a.last().message(JSON.stringify({ type: 'superseded' }));
  a.last().serverClose(4409, 'superseded');
  assert.equal(a.t.status, 'superseded');
  assert.ok(statuses.includes('superseded'));
  assert.match(a.t.statusDetail, /닫아도 돼요/);
  assert.equal(a.timers.pending, 0);
  a.t.reconnectNow();
  assert.equal(a.sockets.length, 1);

  const b = makeWs();
  b.t.start();
  b.last().open();
  b.last().serverClose(4409); // code only (frame lost)
  assert.equal(b.t.status, 'superseded');
  assert.equal(b.timers.pending, 0);
});

test('ws: 토큰이 없으면 연결하지 않고 authFailed', () => {
  const w = makeWs(null);
  w.t.start();
  assert.equal(w.sockets.length, 0);
  assert.equal(w.t.status, 'authFailed');
  assert.match(w.t.statusDetail, /토큰이 없어요/);
});

test('ws: dispose 뒤에는 재연결하지 않아요', () => {
  const w = makeWs();
  w.t.start();
  w.last().open();
  w.t.dispose();
  assert.ok(w.last().closedWith);
  w.last().serverClose(1006);
  assert.equal(w.timers.pending, 0);
  assert.equal(w.sockets.length, 1);
});

test('ws: 소켓 생성이 던지면 재시도 예약', () => {
  const timers = new FakeTimers();
  let n = 0;
  const t = new WsTransport({
    url: 'ws://x/rpc',
    token: 't',
    timers,
    factory: () => {
      n++;
      throw new Error('blocked');
    },
  });
  const origError = console.error;
  console.error = () => {};
  try {
    t.start();
    assert.equal(t.status, 'disconnected');
    timers.advance(500);
    assert.equal(n, 2);
  } finally {
    console.error = origError;
    t.dispose();
  }
});

test('flush 도우미가 동작해요', async () => {
  let done = false;
  void Promise.resolve().then(() => (done = true));
  await flush();
  assert.ok(done);
});
