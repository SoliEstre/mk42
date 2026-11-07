import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Registry } from '../src/registry.ts';
import { DaemonCore } from '../src/server.ts';
import {
  AUTH_FAILED_CLOSE_CODE,
  hubUiFiles,
  isAllowedHost,
  isAllowedOrigin,
  readHubPort,
  saveHubPort,
  startHubServer,
  SUPERSEDED_CLOSE_CODE,
} from '../src/hubServer.ts';
import { buildEdgeArgs, hubHostExe, hubHostRunning, openHubWindow } from '../src/edge.ts';
import { fakeLauncher, FakeIndexer, tempDir, type SpawnCall } from './helpers.ts';

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function openWs(url: string, opts: WebSocket.ClientOptions = {}) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))));
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

async function setup() {
  const t = tempDir();
  const ui = join(t.dir, 'ui');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(ui);
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>hub</title>');
  writeFileSync(join(ui, 'hub-ui.js'), 'console.log(1)');
  writeFileSync(join(ui, 'hub-ui.css'), 'body{}');
  const home = join(t.dir, 'home');
  const registry = await Registry.load(home);
  const calls: SpawnCall[] = [];
  const core = new DaemonCore({
    home,
    registry,
    indexers: [new FakeIndexer('claude')],
    launcher: fakeLauncher(home, () => registry.settings, calls),
    stateDebounceMs: 5,
  });
  const hub = await startHubServer({ core, uiDir: ui, token: 'secret-token', authTimeoutMs: 300 });
  return {
    hub,
    core,
    cleanup: async () => {
      await hub.close();
      await core.close();
      t.cleanup();
    },
  };
}

test('hub server: serves UI with security headers, rejects foreign Host/Origin', async () => {
  const s = await setup();
  try {
    const { port } = s.hub;
    const root = await get(port, '/');
    assert.equal(root.status, 200);
    assert.match(root.body, /<title>hub/);
    assert.match(String(root.headers['content-security-policy']), /default-src 'self'.*connect-src 'self' ws:\/\/127\.0\.0\.1:\*/);
    assert.equal(root.headers['x-content-type-options'], 'nosniff');
    assert.match(String(root.headers['content-type']), /text\/html/);
    assert.equal((await get(port, '/hub-ui.js')).status, 200);
    assert.match(String((await get(port, '/hub-ui.css')).headers['content-type']), /text\/css/);
    assert.equal((await get(port, '/../registry.json')).status, 404);
    assert.equal((await get(port, '/', { Host: `evil.example:${port}` })).status, 403);
    assert.equal((await get(port, '/', { Origin: 'http://evil.example' })).status, 403);
    assert.equal(s.hub.appUrl, `http://127.0.0.1:${port}/#token=secret-token`);
  } finally {
    await s.cleanup();
  }
});

test('hub server: wrong token → 4401; foreign origin upgrade refused; right token can call folders.list', async () => {
  const s = await setup();
  try {
    const url = `ws://127.0.0.1:${s.hub.port}/rpc`;
    const origin = `http://127.0.0.1:${s.hub.port}`;

    // a browser always sends Origin on a WebSocket: none → refused at the upgrade
    await assert.rejects(openWs(url), /403/);

    const bad = await openWs(url, { origin });
    const badClosed = closed(bad);
    const badMsg = nextMessage(bad);
    bad.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    assert.deepEqual(await badMsg, { type: 'auth', ok: false, error: 'invalid token' });
    assert.equal(await badClosed, AUTH_FAILED_CLOSE_CODE);

    const rpcFirst = await openWs(url, { origin });
    const rpcFirstClosed = closed(rpcFirst);
    rpcFirst.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'folders.list', params: {} }));
    assert.equal(await rpcFirstClosed, AUTH_FAILED_CLOSE_CODE);

    const silent = await openWs(url, { origin });
    assert.equal(await closed(silent), AUTH_FAILED_CLOSE_CODE, 'auth timeout');

    await assert.rejects(openWs(url, { origin: 'http://evil.example' }), /403/);

    const good = await openWs(url, { origin: `http://127.0.0.1:${s.hub.port}` });
    const authAck = nextMessage(good);
    // 인증과 첫 요청을 붙여 보내도 돼요 (hub-ui는 ack를 기다리지 않아요)
    good.send(JSON.stringify({ type: 'auth', token: 'secret-token' }));
    assert.deepEqual(await authAck, { type: 'auth', ok: true });
    const reply = nextMessage(good);
    good.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'folders.list', params: {} }));
    assert.deepEqual(await reply, { jsonrpc: '2.0', id: 7, result: [] });

    // hub WS 클라이언트는 hello 없이도 state.changed를 받아요
    const note = nextMessage(good);
    s.core.markChanged('pinned');
    assert.deepEqual(await note, { jsonrpc: '2.0', method: 'state.changed', params: { topics: ['pinned'] } });
    good.close();
  } finally {
    await s.cleanup();
  }
});

test('hub server: only the most recently opened hub window (highest w) stays; older ones get «superseded» and 4409', async () => {
  const s = await setup();
  try {
    const url = `ws://127.0.0.1:${s.hub.port}/rpc`;
    const origin = `http://127.0.0.1:${s.hub.port}`;
    assert.match(s.hub.nextWindowUrl(), /#token=secret-token&w=1$/);
    assert.match(s.hub.nextWindowUrl(), /&w=2$/);
    const auth = async (w?: number) => {
      const ws = await openWs(url, { origin });
      const ack = nextMessage(ws);
      ws.send(JSON.stringify({ type: 'auth', token: 'secret-token', ...(w === undefined ? {} : { w }) }));
      assert.deepEqual(await ack, { type: 'auth', ok: true });
      return ws;
    };

    const a = await auth(1);
    const aSuperseded = nextMessage(a);
    const aClosed = closed(a);
    const b = await auth(2); // opened later: a steps down
    assert.deepEqual(await aSuperseded, { type: 'superseded' });
    assert.equal(await aClosed, SUPERSEDED_CLOSE_CODE);

    // an older window reconnecting (e.g. after a daemon restart) is turned away at once; b stays
    const old = await openWs(url, { origin });
    const oldMsgs: unknown[] = [];
    old.on('message', (d) => oldMsgs.push(JSON.parse(String(d))));
    const oldClosed = closed(old);
    old.send(JSON.stringify({ type: 'auth', token: 'secret-token', w: 1 }));
    assert.equal(await oldClosed, SUPERSEDED_CLOSE_CODE);
    assert.deepEqual(oldMsgs, [{ type: 'auth', ok: true }, { type: 'superseded' }]);

    const legacy = await openWs(url, { origin }); // no w (opened by hand / older hub UI): oldest
    const legacyClosed = closed(legacy);
    legacy.send(JSON.stringify({ type: 'auth', token: 'secret-token' }));
    assert.equal(await legacyClosed, SUPERSEDED_CLOSE_CODE);

    const reply = nextMessage(b);
    b.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'folders.list', params: {} }));
    assert.deepEqual(await reply, { jsonrpc: '2.0', id: 1, result: [] });
    b.close();
  } finally {
    await s.cleanup();
  }
});

test('hub server: new token every run, preferred port reused or replaced, port remembered', async () => {
  const t = tempDir();
  try {
    assert.equal(await readHubPort(t.dir), undefined);
    await saveHubPort(t.dir, 51234, '\\\\.\\pipe\\mark42-m42d-test');
    assert.equal(await readHubPort(t.dir), 51234);
    assert.deepEqual(JSON.parse(readFileSync(join(t.dir, 'hub.json'), 'utf8')), { port: 51234, pipe: '\\\\.\\pipe\\mark42-m42d-test' }, 'the pinned hub exe finds the daemon pipe here');
    writeFileSync(join(t.dir, 'hub.json'), '{"port":80}');
    assert.equal(await readHubPort(t.dir), undefined, 'privileged / odd ports are ignored');

    const core = { attach: () => {} };
    const first = await startHubServer({ core, files: hubUiFiles() });
    const again = await startHubServer({ core, files: hubUiFiles() });
    assert.notEqual(first.token, again.token, 'random per run: an old window gets 4401 and closes itself');
    await again.close();
    const busy = first.port;
    const second = await startHubServer({ core, files: hubUiFiles(), token: 'x', preferredPort: busy });
    assert.notEqual(second.port, busy, 'taken: another port');
    await first.close();
    const third = await startHubServer({ core, files: hubUiFiles(), token: 'x', preferredPort: busy });
    assert.equal(third.port, busy, 'free again: the same address, so open hub windows reconnect');
    await second.close();
    await third.close();
  } finally {
    t.cleanup();
  }
});

test('hub host/origin helpers and default UI file layout', () => {
  assert.equal(isAllowedHost('127.0.0.1:5000', 5000), true);
  assert.equal(isAllowedHost('LOCALHOST:5000', 5000), true);
  assert.equal(isAllowedHost('127.0.0.1:5001', 5000), false);
  assert.equal(isAllowedHost(undefined, 5000), false);
  assert.equal(isAllowedOrigin(undefined, 5000), true);
  assert.equal(isAllowedOrigin('null', 5000), false);
  const files = hubUiFiles(undefined, new URL('../src/hubServer.ts', import.meta.url));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  assert.equal(files.index, join(root, 'extension', 'hub-ui', 'index.html'));
  assert.equal(files.js, join(root, 'extension', 'dist', 'hub-ui.js'));
});

test('edge: --app window args and injected spawn', async () => {
  assert.deepEqual(buildEdgeArgs('http://127.0.0.1:1/#token=t', 'C:\\H\\hub-edge'), [
    '--app=http://127.0.0.1:1/#token=t',
    '--user-data-dir=C:\\H\\hub-edge',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msImplicitSignin',
    '--disable-sync',
    '--disable-extensions',
  ]);
  const calls: SpawnCall[] = [];
  const r = await openHubWindow({
    url: 'http://127.0.0.1:9/#token=t',
    home: 'C:\\H',
    env: { 'ProgramFiles(x86)': 'C:\\PF86', VSCODE_PID: '1' },
    exists: (p) => p === 'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe',
    spawn: async (command, args, env) => {
      calls.push({ command, args });
      assert.equal(env.VSCODE_PID, undefined, 'VS Code env stripped');
      return { pid: 1 };
    },
  });
  assert.equal(r.exe, 'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(calls[0]!.args[0], '--app=http://127.0.0.1:9/#token=t');
  assert.match(calls[0]!.args[1]!, /hub-edge$/);
  await assert.rejects(openHubWindow({ url: 'x', home: 'C:\\H', env: {}, exists: () => false, spawn: async () => ({}) }), /msedge/);
  assert.equal(r.kind, 'edge');
});

test('hub window: a running Mk42 hub window is detected from <home>\\hub-host.json (pid alive)', async () => {
  const t = tempDir();
  try {
    assert.equal(await hubHostRunning(t.dir, () => true), false, 'no marker');
    writeFileSync(join(t.dir, 'hub-host.json'), JSON.stringify({ pid: 4242 }));
    assert.equal(await hubHostRunning(t.dir, (p) => p === 4242), true);
    assert.equal(await hubHostRunning(t.dir, () => false), false, 'stale marker (window crashed)');
    assert.equal(await hubHostRunning(t.dir), false, 'pid 4242 is not running here');
    writeFileSync(join(t.dir, 'hub-host.json'), JSON.stringify({ pid: process.pid }));
    assert.equal(await hubHostRunning(t.dir), true);
    writeFileSync(join(t.dir, 'hub-host.json'), '{"pid":"x"}');
    assert.equal(await hubHostRunning(t.dir, () => true), false);
  } finally {
    t.cleanup();
  }
});

test('hub window: the Mk42 hub exe in <home>\\hub when present (D46), Edge otherwise or when asked', async () => {
  const calls: SpawnCall[] = [];
  const spawn = async (command: string, args: string[], env: NodeJS.ProcessEnv) => {
    calls.push({ command, args });
    assert.equal(env.VSCODE_PID, undefined);
    return { pid: 2 };
  };
  const env = { 'ProgramFiles(x86)': 'C:\\PF86', VSCODE_PID: '1' };
  const edge = 'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(hubHostExe('C:\\H'), 'C:\\H\\hub\\mk42-hub.exe');

  const host = await openHubWindow({ url: 'http://127.0.0.1:9/#token=t&w=1', home: 'C:\\H', env, spawn, exists: () => true });
  assert.equal(host.kind, 'host');
  assert.deepEqual(calls[0], { command: 'C:\\H\\hub\\mk42-hub.exe', args: ['--url', 'http://127.0.0.1:9/#token=t&w=1', '--home', 'C:\\H'] });

  const forced = await openHubWindow({ url: 'u', home: 'C:\\H', env, spawn, exists: () => true, hubWindow: 'edge' });
  assert.equal(forced.exe, edge);

  const missing = await openHubWindow({ url: 'u', home: 'C:\\H', env, spawn, exists: (p) => p === edge });
  assert.equal(missing.kind, 'edge', 'exe not installed: Edge as before');

  const custom = await openHubWindow({ url: 'u', home: 'C:\\H', env, spawn, exists: (p) => p === 'D:\\x\\hub.exe', hubHostPath: 'D:\\x\\hub.exe' });
  assert.equal(custom.exe, 'D:\\x\\hub.exe');
});
