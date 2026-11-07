import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { LineDecoder, RpcError, RpcPeer, type LineChannel } from '../src/rpc.ts';
import { ErrorCode } from '../src/methods.ts';

function pair(): [LineChannel, LineChannel] {
  const mk = () => ({ line: [] as ((l: string) => void)[], close: [] as (() => void)[] });
  const a = mk();
  const b = mk();
  let closed = false;
  const shut = () => {
    if (closed) return;
    closed = true;
    a.close.forEach((c) => c());
    b.close.forEach((c) => c());
  };
  const ch = (self: ReturnType<typeof mk>, other: ReturnType<typeof mk>): LineChannel => ({
    send: (l) => queueMicrotask(() => other.line.forEach((cb) => cb(l))),
    onLine: (cb) => void self.line.push(cb),
    onClose: (cb) => void self.close.push(cb),
    close: shut,
  });
  return [ch(a, b), ch(b, a)];
}

test('LineDecoder splits across chunk boundaries and drops blank lines', () => {
  const d = new LineDecoder();
  assert.deepEqual(d.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(d.push(':2}\r\n\n'), ['{"b":2}']);
});

test('request/response round trip and error mapping', async () => {
  const [c1, c2] = pair();
  const client = new RpcPeer(c1);
  new RpcPeer(c2, {
    onRequest: (method, params) => {
      if (method === 'echo') return params;
      throw new RpcError(ErrorCode.NotFound, 'nope');
    },
  });
  assert.deepEqual(await client.request('echo', { x: 1 }), { x: 1 });
  await assert.rejects(client.request('missing'), (e: unknown) => e instanceof RpcError && e.code === ErrorCode.NotFound);
});

test('notifications reach the other side', async () => {
  const [c1, c2] = pair();
  const got: unknown[] = [];
  new RpcPeer(c2, { onNotification: (m, p) => got.push([m, p]) });
  new RpcPeer(c1).notify('state.changed', { topics: ['folders'] });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(got, [['state.changed', { topics: ['folders'] }]]);
});

test('pending requests reject on close', async () => {
  const [c1, c2] = pair();
  const client = new RpcPeer(c1);
  new RpcPeer(c2, { onRequest: () => new Promise(() => {}) });
  const p = client.request('hang', {}, 0);
  client.close();
  await assert.rejects(p, /channel closed/);
});
