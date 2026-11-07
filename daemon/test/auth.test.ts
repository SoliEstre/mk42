// 데몬 파이프 서버 인증 — hello.challenge·$/auth proof, hub WS는 proof 없음, 두 번째 실행은 확인 뒤에만 부탁.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { ErrorCode, PROTOCOL_VERSION, RpcError, RpcPeer } from '@mark42/protocol';
import { computeProof, loadOrCreateAuthSecret, newChallenge, verifyProof, type WinAclOps } from '@mark42/protocol/auth';
import { socketChannel } from '@mark42/protocol/node';
import { Registry } from '../src/registry.ts';
import { askRunningDaemon, UnverifiedDaemonError, verifyRunningDaemon } from '../src/secondInstance.ts';
import { DaemonCore, PipeServer } from '../src/server.ts';
import {
  connectPipe,
  fakeLauncher,
  FakeIndexer,
  memoryChannelPair,
  sequenceIds,
  tempDir,
  uniquePipeName,
  wrapPeer,
  type SpawnCall,
} from './helpers.ts';

/** 가짜 Windows ACL 검사기: 모두 본인 전용(이 파일은 프로토콜을 봐요 — ACL 자체는 packages/protocol/test/auth.test.ts) */
const trustingAcl: WinAclOps = {
  inspect: async (paths) => ({ userSid: 'S-1-5-21-1-2-3-1001', sddl: paths.map(() => 'O:S-1-5-21-1-2-3-1001D:PAI(A;;FA;;;S-1-5-21-1-2-3-1001)') }),
  tighten: async () => {},
};

async function setup(opts: { auth?: boolean; realAcl?: boolean; onOpenHub?: () => Promise<{ url: string }>; onBootResume?: (p: { remote: boolean }) => { accepted: boolean }; onShutdown?: () => void } = {}) {
  const t = tempDir();
  const home = join(t.dir, 'home');
  const registry = await Registry.load(home);
  const calls: SpawnCall[] = [];
  const pipe = uniquePipeName();
  // realAcl: 진짜 ACL(Windows: home을 조이고 비밀을 써요) — 두 번째 실행이 <home>/auth.secret을 실제로 검사하며 읽어요
  const { secret } = await loadOrCreateAuthSecret(home, opts.realAcl ? {} : { winAcl: trustingAcl });
  const core = new DaemonCore({
    home,
    registry,
    indexers: [new FakeIndexer('claude'), new FakeIndexer('codex')],
    launcher: fakeLauncher(home, () => registry.settings, calls),
    newId: sequenceIds(),
    stateDebounceMs: 20,
    ...(opts.auth === false ? {} : { auth: { secret, pipeName: pipe } }),
    ...(opts.onOpenHub ? { onOpenHub: opts.onOpenHub } : {}),
    ...(opts.onBootResume ? { onBootResume: opts.onBootResume } : {}),
    ...(opts.onShutdown ? { onShutdown: opts.onShutdown } : {}),
  });
  await core.start();
  const server = new PipeServer();
  await server.listen(pipe);
  server.attachCore(core);
  return {
    home,
    pipe,
    secret,
    core,
    async close() {
      await server.close();
      await core.close();
      t.cleanup();
    },
  };
}

test('hello with challenge returns a proof bound to the listening pipe; without challenge no proof', async () => {
  const ctx = await setup();
  const c = await connectPipe(ctx.pipe);
  try {
    const challenge = newChallenge();
    const r = await c.request('hello', {
      protocolVersion: PROTOCOL_VERSION,
      window: { role: 'editor', pid: 1, appVersion: 'x', extensions: [] },
      challenge,
    });
    assert.ok(verifyProof(ctx.secret, ctx.pipe, challenge, r.proof));
    assert.equal(verifyProof(ctx.secret, uniquePipeName(), challenge, r.proof), false);
    const plain = await c.hello({ role: 'editor' });
    assert.equal(plain.proof, undefined);
  } finally {
    c.close();
    await ctx.close();
  }
});

test('$/auth returns a proof without registering a window; bad challenges are rejected', async () => {
  const ctx = await setup();
  const c = await connectPipe(ctx.pipe);
  try {
    const challenge = newChallenge();
    const r = await c.request('$/auth', { challenge });
    assert.ok(verifyProof(ctx.secret, ctx.pipe, challenge, r.proof));
    assert.deepEqual(ctx.core.windows(), []);
    for (const bad of ['', 'x', challenge + 'A', 42, undefined]) {
      await assert.rejects(
        c.request('$/auth', { challenge: bad as never }),
        (e: RpcError) => e.code === ErrorCode.InvalidParams,
        String(bad),
      );
    }
    await assert.rejects(
      c.request('hello', { protocolVersion: PROTOCOL_VERSION, window: { role: 'hub', pid: 1, appVersion: 'x', extensions: [] }, challenge: 'nope' }),
      (e: RpcError) => e.code === ErrorCode.InvalidParams,
    );
    assert.deepEqual(ctx.core.windows(), [], 'invalid challenge does not register the window');
  } finally {
    c.close();
    await ctx.close();
  }
});

test('daemon without an auth secret gives no proof ($/auth → NotFound)', async () => {
  const ctx = await setup({ auth: false });
  const c = await connectPipe(ctx.pipe);
  try {
    await assert.rejects(c.request('$/auth', { challenge: newChallenge() }), (e: RpcError) => e.code === ErrorCode.NotFound);
    const r = await c.request('hello', {
      protocolVersion: PROTOCOL_VERSION,
      window: { role: 'editor', pid: 1, appVersion: 'x', extensions: [] },
      challenge: newChallenge(),
    });
    assert.equal(r.proof, undefined);
  } finally {
    c.close();
    await ctx.close();
  }
});

test('hub WS clients (token auth) never get proofs — no signing oracle off the pipe', async () => {
  const ctx = await setup();
  const [a, b] = memoryChannelPair();
  ctx.core.attach(new RpcPeer(a), 'hub-ws');
  const ws = wrapPeer(new RpcPeer(b));
  try {
    await assert.rejects(ws.request('$/auth', { challenge: newChallenge() }), (e: RpcError) => e.code === ErrorCode.MethodNotFound);
    const r = await ws.request('hello', {
      protocolVersion: PROTOCOL_VERSION,
      window: { role: 'hub', pid: 1, appVersion: 'x', extensions: [] },
      challenge: newChallenge(),
    });
    assert.equal(r.proof, undefined);
  } finally {
    ws.close();
    await ctx.close();
  }
});

test('second instance: asks the verified daemon; open hub and boot resume go through', async () => {
  let opened = 0;
  const remotes: boolean[] = [];
  const ctx = await setup({
    realAcl: true,
    onOpenHub: async () => {
      opened++;
      return { url: 'http://127.0.0.1:1/' };
    },
    onBootResume: ({ remote }) => {
      remotes.push(remote);
      return { accepted: true };
    },
  });
  try {
    await verifyRunningDaemon(ctx.pipe, ctx.home);
    assert.deepEqual(await askRunningDaemon(ctx.pipe, ctx.home, '$/openHub', {}), { url: 'http://127.0.0.1:1/' });
    assert.deepEqual(await askRunningDaemon(ctx.pipe, ctx.home, '$/bootResume', { remote: true }), { accepted: true });
    assert.equal(opened, 1);
    assert.deepEqual(remotes, [true]);
  } finally {
    await ctx.close();
  }
});

test('$/shutdown: the verified pipe client (setup/updater) stops the daemon; hub WS clients cannot', async () => {
  let stops = 0;
  const ctx = await setup({ realAcl: true, onShutdown: () => void stops++ });
  const [a, b] = memoryChannelPair();
  ctx.core.attach(new RpcPeer(a), 'hub-ws');
  const ws = wrapPeer(new RpcPeer(b));
  try {
    await assert.rejects(ws.request('$/shutdown' as never, {} as never), (e: RpcError) => e.code === ErrorCode.MethodNotFound);
    assert.equal(stops, 0);
    assert.deepEqual(await askRunningDaemon(ctx.pipe, ctx.home, '$/shutdown', {}), { stopping: true });
    assert.equal(stops, 1);
  } finally {
    ws.close();
    await ctx.close();
  }
});

for (const kind of ['wrong secret', 'no $/auth'] as const) {
  test(`second instance: squatter (${kind}) is rejected before anything sensitive is sent`, async () => {
    const pipe = uniquePipeName();
    const methods: string[] = [];
    const fake = createServer((sock) => {
      new RpcPeer(socketChannel(sock), {
        onRequest: (method, params: any) => {
          methods.push(method);
          if (method === '$/auth' && kind === 'wrong secret') return { proof: computeProof(randomBytes(32), pipe, params.challenge) };
          if (method === '$/auth') throw new RpcError(ErrorCode.MethodNotFound, method);
          return { accepted: true, url: 'http://evil/' };
        },
      });
    });
    await new Promise<void>((r) => fake.listen(pipe, () => r()));
    try {
      const secret = randomBytes(32);
      await assert.rejects(askRunningDaemon(pipe, 'unused', '$/bootResume', { remote: true }, { secret }), UnverifiedDaemonError);
      await assert.rejects(askRunningDaemon(pipe, 'unused', '$/openHub', {}, { secret }), UnverifiedDaemonError);
      await assert.rejects(verifyRunningDaemon(pipe, 'unused', { secret }), UnverifiedDaemonError);
      assert.deepEqual(methods, ['$/auth', '$/auth', '$/auth'], 'only the challenge ever reached the squatter');
    } finally {
      await new Promise((r) => fake.close(() => r(undefined)));
    }
  });
}

test('second instance: missing secret file fails closed without connecting', async () => {
  const t = tempDir();
  try {
    await assert.rejects(verifyRunningDaemon(uniquePipeName(), join(t.dir, 'nohome')), /auth secret unavailable/);
  } finally {
    t.cleanup();
  }
});

if (process.platform === 'win32') {
  test('second instance (Windows): refuses a secret other users can read, before connecting', { timeout: 120_000 }, async () => {
    const t = tempDir();
    try {
      const home = join(t.dir, 'home');
      await loadOrCreateAuthSecret(home);
      // Authenticated Users 읽기를 붙여요(샌드박스 사용자가 상속받던 상황)
      execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [join(home, 'auth.secret'), '/grant', '*S-1-5-11:R'], { windowsHide: true });
      await assert.rejects(verifyRunningDaemon(uniquePipeName(), home), (e: Error & { code?: string }) => e.code === 'EACL' && /not private/.test(e.message));
    } finally {
      t.cleanup();
    }
  });
}
