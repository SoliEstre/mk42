import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, it } from 'node:test';
import { isPidAlive } from '../../src/indexers/claude.ts';
import { codexBinaryCandidates } from '../../src/indexers/codex-bin.ts';
import { listCodexThreadsFromSqlite, parseSource } from '../../src/indexers/codex-sqlite.ts';
import { CODEX_TUNING, createCodexIndexer, mapAppServerThread, mapThreadStatus } from '../../src/indexers/codex.ts';
import { makeCodexStateDb, makeTmp, waitFor, type FakeThreadRow } from './helpers.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-app-server.ts', import.meta.url));
const T = 1_792_000_000_000;
const TOP1 = '01a10000-0000-7000-8000-000000000001';
const TOP2 = '01a10000-0000-7000-8000-000000000002';
const TOP3 = '01a10000-0000-7000-8000-000000000003';
const SPAWN = '01a10000-0000-7000-8000-000000000004';
const GUARD = '01a10000-0000-7000-8000-000000000005';
const EMPTY = '01a10000-0000-7000-8000-000000000006';
const ARCH = '01a10000-0000-7000-8000-000000000007';
const EDGE = '01a10000-0000-7000-8000-000000000008';

const rows: FakeThreadRow[] = [
  { id: TOP1, cwd: '\\\\?\\C:\\work\\proj', name: 'Named thread', title: 'Named thread', preview: 'first msg', model: 'gpt-6-astra', reasoning_effort: 'ultra', recency_at_ms: T + 5000 },
  { id: TOP2, cwd: '\\\\?\\C:\\work\\proj', name: null, title: 'exec preview', preview: 'exec preview', source: 'exec', model: 'gpt-5.6-sol', reasoning_effort: 'xhigh', recency_at_ms: T + 1000 },
  { id: TOP3, cwd: '\\\\?\\C:\\other', name: 'Other', preview: 'o', recency_at_ms: T + 3000 },
  {
    id: SPAWN,
    cwd: '\\\\?\\C:\\work\\proj',
    name: 'Worker',
    preview: 'do x',
    source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: TOP1, depth: 1, agent_path: 'p', agent_nickname: 'n', agent_role: {} } } }),
    thread_source: 'subagent',
    recency_at_ms: T + 4000,
  },
  { id: GUARD, cwd: '\\\\?\\C:\\work\\proj', name: 'Review', preview: 'r', source: JSON.stringify({ subagent: { other: 'guardian' } }), thread_source: 'guardian_review', model: 'codex-auto-review', reasoning_effort: 'low', recency_at_ms: T + 4500 },
  { id: EMPTY, cwd: '\\\\?\\C:\\work\\proj', name: null, title: '', preview: '', source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: TOP1 } } }), recency_at_ms: T + 4600 },
  { id: ARCH, cwd: '\\\\?\\C:\\work\\proj', name: 'Archived', archived: 1, recency_at_ms: T + 9000 },
  { id: EDGE, cwd: '\\\\?\\C:\\work\\proj', name: 'Edge child', source: JSON.stringify({ subagent: 'review' }), recency_at_ms: T + 10 },
];

// app-server Thread 응답 픽스처 (실측 필드 이름)
const apiThread = (id: string, extra: Record<string, unknown>) => ({
  id,
  sessionId: id,
  preview: '',
  ephemeral: false,
  modelProvider: 'openai',
  createdAt: 1_792_000_000,
  updatedAt: 1_792_000_000,
  status: { type: 'notLoaded' },
  cwd: 'C:\\work\\proj',
  cliVersion: '0.162.0',
  source: 'vscode',
  turns: [],
  projectId: null,
  parentThreadId: null,
  name: null,
  ...extra,
});
const apiThreads = [
  apiThread(TOP1, { name: 'Named thread', model: 'gpt-6-astra', reasoningEffort: 'ultra', recencyAt: 1_792_000_005, status: { type: 'active', activeFlags: ['waitingOnApproval'] } }),
  apiThread(TOP2, { preview: 'exec preview', source: 'exec', recencyAt: 1_792_000_001, cwd: '\\\\?\\C:\\work\\proj' }),
  apiThread(TOP3, { name: 'Other', cwd: 'C:\\other', recencyAt: 1_792_000_003 }),
  apiThread(SPAWN, { name: 'Worker', source: { subAgent: { thread_spawn: { parent_thread_id: TOP1, depth: 1 } } }, recencyAt: 1_792_000_004 }),
  apiThread(GUARD, { name: 'Review', source: { subAgent: { other: 'guardian' } }, recencyAt: 1_792_000_004 }),
];

let tmp: ReturnType<typeof makeTmp>;
let home: string;
let dbPath: string;
let threadsFile: string;
const savedEnv = { ...process.env };
const savedTuning = { ...CODEX_TUNING };

before(() => {
  tmp = makeTmp('codex');
  home = join(tmp.dir, '.codex');
  mkdirSync(home);
  dbPath = join(home, 'state_5.sqlite');
  makeCodexStateDb(dbPath, rows, [{ parent: TOP2, child: EDGE }]);
  threadsFile = join(tmp.dir, 'threads.json');
  writeFileSync(threadsFile, JSON.stringify(apiThreads));
});
after(() => tmp.cleanup());
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_')) delete process.env[k];
  Object.assign(process.env, savedEnv);
  Object.assign(CODEX_TUNING, savedTuning);
});

function fakeEnv(mode: string, extra: Record<string, string> = {}): string {
  const log = join(tmp.dir, `fake-${mode}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  process.env.FAKE_MODE = mode;
  process.env.FAKE_THREADS = threadsFile;
  process.env.FAKE_LOG = log;
  Object.assign(process.env, extra);
  return log;
}
const readLog = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

describe('parseSource / mapping', () => {
  it('parses DB and app-server source shapes', () => {
    assert.deepEqual(parseSource('vscode'), { isSubagent: false });
    assert.deepEqual(parseSource('exec'), { isSubagent: false });
    assert.deepEqual(parseSource(JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'p1' } } })), { isSubagent: true, parentId: 'p1' });
    assert.deepEqual(parseSource(JSON.stringify({ subagent: { other: 'guardian' } })), { isSubagent: true });
    assert.deepEqual(parseSource({ subAgent: { thread_spawn: { parent_thread_id: 'p2' } } }), { isSubagent: true, parentId: 'p2' });
    assert.deepEqual(parseSource({ subAgent: 'review' }), { isSubagent: true });
    assert.deepEqual(parseSource({ custom: 'x' }), { isSubagent: false });
  });

  it('maps thread status', () => {
    assert.equal(mapThreadStatus({ type: 'notLoaded' }), undefined);
    assert.equal(mapThreadStatus({ type: 'idle' }), 'idle');
    assert.equal(mapThreadStatus({ type: 'active', activeFlags: [] }), 'busy');
    assert.equal(mapThreadStatus({ type: 'active', activeFlags: ['waitingOnUserInput'] }), 'waiting');
    assert.equal(mapThreadStatus({ type: 'systemError' }), undefined);
  });

  it('maps an app-server Thread', () => {
    const s = mapAppServerThread(apiThread('x', { cwd: '\\\\?\\c:\\Work\\', preview: '  hi\n there ', recencyAt: 1_792_000_000, parentThreadId: 'pp', source: { subAgent: { thread_spawn: { parent_thread_id: 'qq' } } } }))!;
    assert.equal(s.cwd, 'C:\\Work');
    assert.equal(s.title, 'hi there');
    assert.equal(s.updatedAt, new Date(1_792_000_000_000).toISOString());
    assert.equal(s.isSubagent, true);
    assert.equal(s.parentId, 'pp', 'parentThreadId wins over source');
    assert.equal(mapAppServerThread({ id: 'x' }), undefined);
  });
});

describe('codex sqlite listing', () => {
  it('lists top-level threads newest first, normalizing \\\\?\\ paths', () => {
    const list = listCodexThreadsFromSqlite(dbPath);
    assert.deepEqual(list.map((s) => s.id), [TOP1, TOP3, TOP2]);
    const t1 = list[0]!;
    assert.equal(t1.agent, 'codex');
    assert.equal(t1.cwd, 'C:\\work\\proj');
    assert.equal(t1.title, 'Named thread');
    assert.equal(t1.model, 'gpt-6-astra');
    assert.equal(t1.effort, 'ultra');
    assert.equal(t1.updatedAt, new Date(T + 5000).toISOString());
    assert.equal(t1.isSubagent, undefined);
    assert.equal(list[2]!.title, 'exec preview', 'falls back to title/preview when name is null');
  });

  it('includes subagents with parent ids (source JSON, then thread_spawn_edges); hides empty and archived', () => {
    const list = listCodexThreadsFromSqlite(dbPath, { includeSubagents: true });
    assert.deepEqual(list.map((s) => s.id), [TOP1, GUARD, SPAWN, TOP3, TOP2, EDGE]);
    const spawn = list.find((s) => s.id === SPAWN)!;
    assert.equal(spawn.isSubagent, true);
    assert.equal(spawn.parentId, TOP1);
    const guard = list.find((s) => s.id === GUARD)!;
    assert.equal(guard.isSubagent, true);
    assert.equal(guard.parentId, undefined, 'guardian rows carry no parent id');
    assert.equal(list.find((s) => s.id === EDGE)!.parentId, TOP2);
    assert.ok(!list.some((s) => s.id === EMPTY || s.id === ARCH));
  });

  it('filters by cwd with any casing/prefix and applies limit', () => {
    assert.deepEqual(listCodexThreadsFromSqlite(dbPath, { cwd: 'c:\\WORK\\proj\\' }).map((s) => s.id), [TOP1, TOP2]);
    assert.deepEqual(listCodexThreadsFromSqlite(dbPath, { cwd: 'C:\\other' }).map((s) => s.id), [TOP3]);
    assert.equal(listCodexThreadsFromSqlite(dbPath, { limit: 1 }).length, 1);
  });

  it('opens the database read-only', () => {
    const before = readFileSync(dbPath);
    listCodexThreadsFromSqlite(dbPath, { includeSubagents: true });
    assert.ok(readFileSync(dbPath).equals(before));
  });

  it('tolerates a schema without optional columns', () => {
    const p = join(tmp.dir, 'minimal.sqlite');
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT); INSERT INTO threads VALUES ('a', 'C:\\x', 'T')");
    db.close();
    assert.deepEqual(listCodexThreadsFromSqlite(p), [{ agent: 'codex', id: 'a', cwd: 'C:\\x', title: 'T', updatedAt: new Date(0).toISOString() }]);
  });
});

describe('codex indexer', () => {
  it('sqlite mode never spawns', async () => {
    const idx = createCodexIndexer({ codexHome: home, mode: 'sqlite', codexBin: join(tmp.dir, 'must-not-run.exe') });
    assert.equal((await idx.list({})).length, 3);
    assert.deepEqual(await idx.live(), []);
    await idx.stop();
  });

  it('defaults to sqlite (never spawns an app-server against the real CODEX_HOME)', async () => {
    const logs: string[] = [];
    fakeEnv('normal');
    const idx = createCodexIndexer({ codexHome: home, codexBin: FAKE, log: (m) => logs.push(m) });
    assert.equal((await idx.list({})).length, 3);
    assert.ok(!logs.some((m) => m.includes('app-server')));
    await idx.stop();
  });

  it('live() reports threads whose rollout was written recently in this boot (owned elsewhere)', async () => {
    const h = join(tmp.dir, 'codex-live');
    mkdirSync(h, { recursive: true });
    const now = Date.now();
    const boot = now - 60 * 60_000;
    const mk = (name: string, mtimeMs: number) => {
      const p = join(h, name);
      writeFileSync(p, '{}\n');
      utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
      return p;
    };
    const db = new DatabaseSync(join(h, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, rollout_path TEXT, archived INTEGER, updated_at_ms INTEGER)');
    const ins = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)');
    ins.run('active', '\\\\?\\C:\\work\\proj', mk('a.jsonl', now - 30_000), 0, now);
    ins.run('idle-long', 'C:\\work\\proj', mk('b.jsonl', now - 40 * 60_000), 0, now - 1);
    ins.run('before-boot', 'C:\\work\\proj', mk('c.jsonl', boot - 60_000), 0, now - 2);
    ins.run('archived', 'C:\\work\\proj', mk('d.jsonl', now - 1000), 1, now - 3);
    ins.run('missing-file', 'C:\\work\\proj', join(h, 'nope.jsonl'), 0, now - 4);
    db.close();
    const idx = createCodexIndexer({ codexHome: h, bootTime: () => boot, now: () => now });
    assert.deepEqual(await idx.live(), [
      { agent: 'codex', sessionId: 'active', cwd: 'C:\\work\\proj', status: 'busy', owner: 'unknown (recent rollout write)' },
    ]);
    await idx.stop();
  });

  it('auto mode falls back to sqlite when the binary is missing', async () => {
    const logs: string[] = [];
    const idx = createCodexIndexer({ codexHome: home, mode: 'auto', codexBin: join(tmp.dir, 'missing', 'codex.exe'), log: (m) => logs.push(m) });
    const list = await idx.list({ cwd: 'C:\\work\\proj' });
    assert.deepEqual(list.map((s) => s.id), [TOP1, TOP2]);
    assert.ok(logs.some((m) => m.includes('using sqlite')));
    await idx.stop();
  });

  it('auto mode falls back when the handshake times out, and the child is killed', async () => {
    CODEX_TUNING.handshakeTimeoutMs = 400;
    const log = fakeEnv('hang');
    const idx = createCodexIndexer({ codexHome: home, mode: 'auto', codexBin: FAKE });
    const list = await idx.list({});
    assert.deepEqual(list.map((s) => s.id), [TOP1, TOP3, TOP2]);
    const pid = Number(/pid (\d+)/.exec(readLog(log))?.[1]);
    await waitFor(() => !isPidAlive(pid), 5000);
    await idx.stop();
  });

  it('auto mode falls back when the app-server crashes or errors', async () => {
    fakeEnv('crash');
    const a = createCodexIndexer({ codexHome: home, mode: 'auto', codexBin: FAKE });
    assert.equal((await a.list({})).length, 3);
    await a.stop();
    fakeEnv('error');
    const b = createCodexIndexer({ codexHome: home, mode: 'auto', codexBin: FAKE });
    assert.equal((await b.list({})).length, 3);
    await b.stop();
  });

  it('appServer mode surfaces failures instead of falling back', async () => {
    fakeEnv('error');
    const idx = createCodexIndexer({ codexHome: home, codexBin: FAKE, mode: 'appServer' });
    await assert.rejects(idx.list({}), /boom/);
    await idx.stop();
  });

  it('lists via app-server: handshake, read-only params, pagination, mapping', async () => {
    CODEX_TUNING.pageSize = 2;
    const log = fakeEnv('normal', { FAKE_LOADED: `${TOP1},unknown-id` });
    const idx = createCodexIndexer({ codexHome: home, codexBin: FAKE, mode: 'appServer' });
    const top = await idx.list({});
    assert.deepEqual(top.map((s) => s.id), [TOP1, TOP3, TOP2]);
    assert.equal(top[0]!.status, 'waiting');
    assert.equal(top[0]!.effort, 'ultra');
    assert.equal(top[2]!.cwd, 'C:\\work\\proj');
    assert.equal(top[2]!.title, 'exec preview');
    const subs = await idx.list({ includeSubagents: true, cwd: 'c:/work/proj' });
    assert.deepEqual(subs.map((s) => s.id), [TOP1, SPAWN, GUARD, TOP2]);
    assert.equal(subs.find((s) => s.id === SPAWN)!.parentId, TOP1);
    assert.equal((await idx.list({ limit: 1 })).length, 1);

    const live = await idx.live();
    assert.deepEqual(live, [{ agent: 'codex', sessionId: TOP1, cwd: 'C:\\work\\proj', status: 'waiting', owner: 'mark42-app-server' }]);

    const text = readLog(log);
    const pid = Number(/pid (\d+)/.exec(text)?.[1]);
    assert.ok(text.includes(`home ${home}`), 'CODEX_HOME passed to the child');
    assert.equal(text.match(/^initialize /gm)?.length, 1, 'one process, one handshake');
    assert.ok(/^initialized /m.test(text));
    assert.ok(/^response /m.test(text), 'server requests are answered (rejected)');
    assert.ok(!text.includes('UNEXPECTED'));
    assert.ok(/thread\/list .*"cursor":"2"/.test(text), 'paginates with nextCursor');
    assert.ok(/thread\/list .*"sourceKinds":\[[^\]]*subAgent/.test(text));
    const methods = [...text.matchAll(/^([a-z][\w/]*) /gm)].map((m) => m[1]);
    for (const m of methods) assert.ok(['pid', 'initialize', 'initialized', 'thread/list', 'thread/loaded/list', 'response'].includes(m!), `unexpected method ${m}`);

    await idx.stop();
    await waitFor(() => !isPidAlive(pid), 5000);
    assert.ok(readLog(log).includes('stdin closed'), 'closed gracefully via stdin');
  });

  it('restarts the app-server lazily after it exits', async () => {
    const log = fakeEnv('normal');
    const idx = createCodexIndexer({ codexHome: home, codexBin: FAKE, mode: 'appServer' });
    await idx.list({});
    const pid1 = Number(/pid (\d+)/.exec(readLog(log))?.[1]);
    process.kill(pid1);
    await waitFor(() => !isPidAlive(pid1), 5000);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await idx.list({})).length, 3);
    const pids = [...readLog(log).matchAll(/pid (\d+)/g)].map((m) => Number(m[1]));
    assert.equal(pids.length, 2);
    await idx.stop();
  });

  it('start() polls the state db and reports changes', async () => {
    CODEX_TUNING.pollMs = 100;
    const idx = createCodexIndexer({ codexHome: home, mode: 'sqlite' });
    let calls = 0;
    await idx.start(() => calls++);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(calls, 0);
    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE threads SET name = 'Renamed' WHERE id = '" + TOP3 + "'");
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    await waitFor(() => calls > 0, 5000);
    await idx.stop();
    assert.equal((await idx.list({ cwd: 'C:\\other' }))[0]!.title, 'Renamed');
  });
});

describe('codexBinaryCandidates', () => {
  it('orders extension bundles by version, then Desktop installs', () => {
    const ext = join(tmp.dir, 'exts');
    const mk = (p: string) => {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, '');
      return p;
    };
    const newer = mk(join(ext, 'openai.chatgpt-26.1007.21434-win32-x64', 'bin', 'windows-x86_64', 'codex.exe'));
    const older = mk(join(ext, 'openai.chatgpt-26.900.1-win32-x64', 'bin', 'windows-x86_64', 'codex.exe'));
    mk(join(ext, 'openai.chatgpt-27.0.0-win32-x64', 'bin', 'linux-x86_64', 'codex'));
    mk(join(ext, 'anthropic.claude-code-2.1.301', 'bin', 'windows-x86_64', 'codex.exe'));
    const local = join(tmp.dir, 'localappdata');
    const desk = mk(join(local, 'OpenAI', 'Codex', 'bin', '9614f1d9b40d9c4f', 'codex.exe'));
    const got = codexBinaryCandidates({ env: { LOCALAPPDATA: local }, platform: 'win32', arch: 'x64', extensionsDirs: [ext] });
    assert.deepEqual(got, [newer, older, desk]);
    const override = codexBinaryCandidates({ env: { LOCALAPPDATA: local, MARK42_CODEX_BIN: desk }, platform: 'win32', arch: 'x64', extensionsDirs: [ext] });
    assert.equal(override[0], desk);
  });
});
