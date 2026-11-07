// tasks.list 핸들러(인자 확인·모니터 연결)와 state.changed {topics:['tasks']} 알림.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorCode, RpcError, type SessionTasks, type TasksListParams } from '@mark42/protocol';
import { Registry } from '../src/registry.ts';
import { DaemonCore, parseTasksListParams, PipeServer } from '../src/server.ts';
import { connectPipe, fakeLauncher, FakeIndexer, sequenceIds, tempDir, uniquePipeName, type SpawnCall, type TestClient } from './helpers.ts';

const SAMPLE: SessionTasks = {
  agent: 'claude',
  sessionId: 's1',
  cwd: 'C:/work/proj',
  workflows: [],
  subagents: [{ id: 'a1', label: 'Explore', status: 'running', updatedAt: '2026-10-30T00:00:00.000Z' }],
  running: 1,
  tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, total: 10 },
  updatedAt: '2026-10-30T00:00:00.000Z',
};

async function withCore(
  tasks: { list(p: TasksListParams): Promise<SessionTasks[]> } | undefined,
  fn: (core: DaemonCore, c: TestClient) => Promise<void>,
): Promise<void> {
  const t = tempDir();
  const registry = await Registry.load(t.dir);
  const calls: SpawnCall[] = [];
  const core = new DaemonCore({
    home: t.dir,
    registry,
    indexers: [new FakeIndexer('claude')],
    launcher: fakeLauncher(t.dir, () => registry.settings, calls),
    newId: sequenceIds(),
    stateDebounceMs: 10,
    ...(tasks ? { tasks } : {}),
  });
  await core.start();
  const server = new PipeServer();
  const pipe = uniquePipeName();
  await server.listen(pipe);
  server.attachCore(core);
  const c = await connectPipe(pipe);
  try {
    await fn(core, c);
  } finally {
    c.close();
    await server.close();
    await core.close();
    t.cleanup();
  }
}

test('parseTasksListParams: accepts valid params, rejects bad ones', () => {
  assert.deepEqual(parseTasksListParams(undefined), {});
  assert.deepEqual(parseTasksListParams({ agent: 'codex', sessionId: 'abc', sinceMs: 0, limit: 100, extra: 1 }), {
    agent: 'codex',
    sessionId: 'abc',
    sinceMs: 0,
    limit: 100,
  });
  const bad: unknown[] = [
    { agent: 'gpt' },
    { sessionId: '' },
    { sessionId: 'x'.repeat(129) },
    { sessionId: 5 },
    { sinceMs: -1 },
    { sinceMs: 31 * 24 * 60 * 60 * 1000 },
    { sinceMs: Number.NaN },
    { sinceMs: '1000' },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
  ];
  for (const p of bad) {
    assert.throws(
      () => parseTasksListParams(p),
      (e: unknown) => e instanceof RpcError && e.code === ErrorCode.InvalidParams,
      JSON.stringify(p),
    );
  }
});

test('tasks.list: passes validated params to the monitor; invalid params are rejected', async () => {
  const seen: TasksListParams[] = [];
  await withCore(
    {
      async list(p) {
        seen.push(p);
        return [SAMPLE];
      },
    },
    async (_core, c) => {
      await c.hello({ role: 'hub' });
      const r = await c.request('tasks.list', { agent: 'claude', limit: 5 });
      assert.deepEqual(r, [SAMPLE]);
      assert.deepEqual(seen, [{ agent: 'claude', limit: 5 }]);
      await assert.rejects(c.request('tasks.list', { limit: 1000 }), (e: RpcError) => e.code === ErrorCode.InvalidParams);
      assert.equal(seen.length, 1);
    },
  );
});

test('tasks.list without a monitor returns []; notifyTasksChanged broadcasts the tasks topic', async () => {
  await withCore(undefined, async (core, c) => {
    await c.hello({ role: 'hub' });
    assert.deepEqual(await c.request('tasks.list', {}), []);
    core.notifyTasksChanged();
    // hello가 낸 'windows'와 같은 디바운스 창에 묶일 수 있어요
    const p = await c.waitFor('state.changed', (x) => x.topics.includes('tasks'));
    assert.ok(p.topics.includes('tasks'));
  });
});
