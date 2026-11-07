// DaemonClient 서버 인증 — 진짜 비밀이면 연결, 파이프를 선점한 가짜 서버(틀린 비밀·proof 없음)면 거부하고 알림을 처리하지 않아요.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcPeer, type WindowInfo } from '@mark42/protocol';
import { authSecretPath, computeProof, ensurePrivateDir } from '@mark42/protocol/auth';
import { socketChannel } from '@mark42/protocol/node';
import { DaemonClient } from '../src/daemonClient.ts';
import type { Logger } from '../src/log.ts';

const root = mkdtempSync(join(tmpdir(), 'm42-dc-'));
after(() => rmSync(root, { recursive: true, force: true }));
// Windows: 창은 home·auth.secret이 본인 전용(ACL)이어야 읽어요 — 데몬처럼 루트를 한 번 조이면 아래 home들이 상속받아요
await ensurePrivateDir(root);

function homeWithSecret(name: string, secret: Uint8Array): string {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  writeFileSync(authSecretPath(home), secret, { mode: 0o600 });
  return home;
}

interface Fake {
  pipe: string;
  server: Server;
  peers: RpcPeer[];
  requests: { method: string; params: any }[];
  notes: { method: string; params: any }[];
  close(): Promise<void>;
}

/** proofSecret: proof를 만들 비밀(null = proof 없음). eager: 연결되자마자 보낼 알림 */
function fakeServer(proofSecret: Uint8Array | null, eager: { method: string; params: unknown }[] = []): Promise<Fake> {
  const pipe =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\mark42-dc-test-${randomBytes(6).toString('hex')}`
      : join(root, `dc-${randomBytes(4).toString('hex')}.sock`);
  const f: Fake = {
    pipe,
    server: undefined as never,
    peers: [],
    requests: [],
    notes: [],
    close: () =>
      new Promise((r) => {
        for (const p of f.peers) p.close();
        f.server.close(() => r());
      }),
  };
  const proof = (params: any) =>
    proofSecret && typeof params?.challenge === 'string' ? { proof: computeProof(proofSecret, pipe, params.challenge) } : {};
  f.server = createServer((sock) => {
    const peer = new RpcPeer(socketChannel(sock), {
      onRequest: (method, params) => {
        f.requests.push({ method, params });
        if (method === 'hello') return { protocolVersion: 1, daemonVersion: 'fake', windowId: 'w1', ...proof(params) };
        if (method === '$/auth') return proof(params);
        return {};
      },
      onNotification: (method, params) => f.notes.push({ method, params }),
    });
    f.peers.push(peer);
    for (const n of eager) peer.notify(n.method, n.params);
  });
  return new Promise((r) => f.server.listen(pipe, () => r(f)));
}

function logger(lines: string[]): Logger {
  return {
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m, e) => lines.push(`error ${m} ${e instanceof Error ? e.message : ''}`),
    debug: () => {},
    show: () => {},
  };
}

const WINDOW: WindowInfo = { role: 'editor', pid: 1, appVersion: 'test', extensions: [], folderPath: 'C:\\p' };

async function until(cond: () => boolean, ms = 4000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function client(f: Fake, home: string, windowInfo: WindowInfo | undefined, lines: string[]) {
  const notes: string[] = [];
  const c = new DaemonClient({ pipeName: f.pipe, authHome: () => home, windowInfo: () => windowInfo, log: logger(lines) });
  c.onNotification((m) => notes.push(m));
  return { c, notes };
}

test('correct secret: connected, held notifications delivered after verification', async () => {
  const secret = randomBytes(32);
  const home = homeWithSecret('ok', secret);
  const f = await fakeServer(secret, [{ method: 'state.changed', params: { topics: ['windows'] } }]);
  const lines: string[] = [];
  const { c, notes } = client(f, home, WINDOW, lines);
  try {
    c.start();
    await until(() => c.state === 'connected', 4000, 'connected');
    assert.ok(c.api);
    assert.equal(c.windowId, 'w1');
    // 순서: $/auth로 주인 확인 → 그다음에만 hello(challenge 없이)
    assert.deepEqual(f.requests.map((r) => r.method).slice(0, 2), ['$/auth', 'hello']);
    assert.equal((f.requests[1]!.params as { challenge?: string }).challenge, undefined);
    await until(() => notes.length > 0, 2000, 'held notification');
    assert.deepEqual(notes, ['state.changed']);
    f.peers[0]!.notify('editor.openUri', { uri: 'https://x', kind: 'web' });
    await until(() => notes.length === 2, 2000, 'live notification');
    assert.ok(lines.some((l) => l.includes('authenticated')));
  } finally {
    c.dispose();
    await f.close();
  }
});

test('unmanaged window uses $/auth and connects with the correct secret', async () => {
  const secret = randomBytes(32);
  const home = homeWithSecret('ok2', secret);
  const f = await fakeServer(secret);
  const { c } = client(f, home, undefined, []);
  try {
    c.start();
    await until(() => c.state === 'connected', 4000, 'connected');
    assert.deepEqual(f.requests.map((r) => r.method), ['$/auth']);
    assert.equal(c.windowId, undefined);
  } finally {
    c.dispose();
    await f.close();
  }
});

for (const [name, proofSecret] of [
  ['wrong secret', randomBytes(32)],
  ['no proof', null],
] as const) {
  for (const managed of [true, false]) {
    test(`squatter (${name}, ${managed ? 'managed' : 'unmanaged'}): rejected, no notification handled, backoff`, async () => {
      const home = homeWithSecret(`sq-${name.replace(' ', '')}-${managed}`, randomBytes(32));
      const f = await fakeServer(proofSecret, [
        { method: 'agent.openSession', params: { requestId: 'evil', agent: 'claude', prompt: 'x', autoSend: true } },
        { method: 'editor.openUri', params: { uri: 'https://evil.example/', kind: 'web' } },
      ]);
      const lines: string[] = [];
      const { c, notes } = client(f, home, managed ? WINDOW : undefined, lines);
      const states: string[] = [];
      c.onStateChange((s) => states.push(s));
      try {
        c.start();
        await until(() => f.requests.length > 0 && c.state === 'disconnected' && c.lastError !== undefined, 4000, 'rejected');
        // 알림을 더 보내도 처리하지 않아요(이미 끊었어요)
        for (const p of f.peers) p.notify('state.changed', { topics: ['folders'] });
        await new Promise((r) => setTimeout(r, 1300));
        assert.deepEqual(notes, []);
        assert.ok(!states.includes('connected'));
        assert.equal(c.api, undefined);
        assert.match(c.lastError!, /squatting|does not support daemon authentication/);
        assert.ok(lines.some((l) => l.startsWith('warn daemon authentication failed')), lines.join('\n'));
        assert.ok(f.peers.length <= 2, `reconnects back off (${f.peers.length} connections in ~1.3s)`);
        // 창 정보(hello)는 주인 확인 전에 절대 나가지 않아요 — 관리 창도 $/auth만
        assert.ok(f.requests.every((r) => r.method === '$/auth'), 'nothing but $/auth is sent to an unverified pipe');
      } finally {
        c.dispose();
        await f.close();
      }
    });
  }
}

test('missing secret file: refuses before sending anything', async () => {
  const home = join(root, 'no-secret');
  const f = await fakeServer(randomBytes(32), [{ method: 'state.changed', params: { topics: ['windows'] } }]);
  const lines: string[] = [];
  const { c, notes } = client(f, home, WINDOW, lines);
  try {
    c.start();
    await until(() => c.lastError !== undefined && c.state === 'disconnected', 4000, 'rejected');
    await new Promise((r) => setTimeout(r, 200));
    assert.match(c.lastError!, /cannot read daemon auth secret/);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(notes, []);
  } finally {
    c.dispose();
    await f.close();
  }
});

test('proof made for a different pipe name (relay from the real daemon) is rejected', async () => {
  const secret = randomBytes(32);
  const home = homeWithSecret('relay', secret);
  // 가짜 서버가 진짜 데몬(다른 파이프)에게 challenge를 넘겨 받은 proof를 그대로 돌려주는 상황
  const f = await fakeServer(null);
  f.server.removeAllListeners('connection');
  f.server.on('connection', (sock) => {
    const peer = new RpcPeer(socketChannel(sock), {
      onRequest: (method, params: any) => {
        f.requests.push({ method, params });
        return { proof: computeProof(secret, '\\\\.\\pipe\\the-real-daemon', params.challenge) };
      },
    });
    f.peers.push(peer);
  });
  const { c } = client(f, home, undefined, []);
  try {
    c.start();
    await until(() => f.requests.length > 0 && c.lastError !== undefined, 4000, 'rejected');
    assert.notEqual(c.state, 'connected');
  } finally {
    c.dispose();
    await f.close();
  }
});
