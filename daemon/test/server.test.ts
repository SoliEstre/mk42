import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ErrorCode, PROTOCOL_VERSION, RpcError } from '@mark42/protocol';
import { normalizePath } from '@mark42/protocol/paths';
import { Registry } from '../src/registry.ts';
import { DaemonCore, PipeServer } from '../src/server.ts';
import { roleWorkspacePath } from '../src/workspaces.ts';
import {
  connectPipe,
  delay,
  fakeLauncher,
  FakeIndexer,
  sequenceIds,
  tempDir,
  uniquePipeName,
  until,
  type SpawnCall,
  type TestClient,
} from './helpers.ts';

interface Ctx {
  home: string;
  project: string;
  pipe: string;
  core: DaemonCore;
  server: PipeServer;
  registry: Registry;
  calls: SpawnCall[];
  claude: FakeIndexer;
  codex: FakeIndexer;
  clients: TestClient[];
  cleanup: () => void;
}

async function setup(): Promise<Ctx> {
  const t = tempDir();
  const home = join(t.dir, 'home');
  const project = join(t.dir, 'proj');
  mkdirSync(project, { recursive: true });
  const registry = await Registry.load(home);
  const calls: SpawnCall[] = [];
  const claude = new FakeIndexer('claude');
  const codex = new FakeIndexer('codex');
  const core = new DaemonCore({
    home,
    registry,
    indexers: [claude, codex],
    launcher: fakeLauncher(home, () => registry.settings, calls),
    newId: sequenceIds(),
    stateDebounceMs: 20,
    resumeGapMs: 0,
  });
  await core.start();
  const server = new PipeServer();
  const pipe = uniquePipeName();
  await server.listen(pipe);
  server.attachCore(core);
  return { home, project, pipe, core, server, registry, calls, claude, codex, clients: [], cleanup: t.cleanup };
}

async function teardown(ctx: Ctx): Promise<void> {
  for (const c of ctx.clients) c.close();
  await ctx.server.close();
  await ctx.core.close();
  ctx.cleanup();
}

async function client(ctx: Ctx): Promise<TestClient> {
  const c = await connectPipe(ctx.pipe);
  ctx.clients.push(c);
  return c;
}

let ctx: Ctx;
before(async () => {
  ctx = await setup();
});
after(async () => {
  await teardown(ctx);
});

test('hello: a window on its own role workspace gets the current managed keys (window title); other workspaces are left alone', async () => {
  const slotId = 's-title1';
  const folder = join(ctx.project, 'title-refresh');
  mkdirSync(folder, { recursive: true });
  const wsFile = roleWorkspacePath({ home: ctx.home, role: 'agent-claude', folderPath: folder, slotId });
  mkdirSync(join(wsFile, '..'), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  // 옛 판이 쓴 파일: 옛 제목 틀 + 사용자 설정
  writeFileSync(wsFile, JSON.stringify({ folders: [{ path: folder }], settings: { 'window.title': '[Mk42 Claude] old', 'editor.fontSize': 15 } }));
  const other = join(ctx.project, 'mine.code-workspace');
  writeFileSync(other, JSON.stringify({ folders: [{ path: folder }], settings: { 'window.title': 'user title' } }));

  const a = await client(ctx);
  await a.hello({ role: 'agent-claude', slotId, folderPath: folder, workspaceFile: wsFile });
  await until(() => (JSON.parse(readFileSync(wsFile, 'utf8')) as { settings: Record<string, unknown> }).settings['window.title'] !== '[Mk42 Claude] old', 2000, 'workspace refreshed');
  const s = (JSON.parse(readFileSync(wsFile, 'utf8')) as { settings: Record<string, unknown> }).settings;
  assert.match(String(s['window.title']), /\$\{mark42Session\}/);
  assert.equal(s['editor.fontSize'], 15, 'user settings kept');

  const b = await client(ctx);
  await b.hello({ role: 'agent-claude', slotId: 's-title2', folderPath: folder, workspaceFile: other });
  await delay(100);
  assert.equal((JSON.parse(readFileSync(other, 'utf8')) as { settings: Record<string, unknown> }).settings['window.title'], 'user title', 'not our role workspace');
});

test('pipe: single instance — second listen on the same pipe gets EADDRINUSE', async () => {
  const other = new PipeServer();
  await assert.rejects(other.listen(ctx.pipe), (e: NodeJS.ErrnoException) => e.code === 'EADDRINUSE');
});

test('hello: protocol mismatch is rejected, valid hello assigns windowId', async () => {
  const c = await client(ctx);
  await assert.rejects(
    c.request('hello', { protocolVersion: PROTOCOL_VERSION + 1, window: { role: 'hub', pid: 1, appVersion: 'x', extensions: [] } }),
    (e: RpcError) => e.code === ErrorCode.ProtocolMismatch,
  );
  const r = await c.hello({ role: 'hub' });
  assert.equal(r.protocolVersion, PROTOCOL_VERSION);
  assert.ok(r.windowId);
  const list = await c.request('windows.list', {});
  assert.ok(list.some((w) => w.windowId === r.windowId && w.role === 'hub'));
});

test('folders: add (validated), list, remove; state.changed reaches hub', async () => {
  const hub = await client(ctx);
  await hub.hello({ role: 'hub' });
  await assert.rejects(
    hub.request('folders.add', { path: join(ctx.project, 'missing') }),
    (e: RpcError) => e.code === ErrorCode.InvalidPath,
  );
  const f = await hub.request('folders.add', { path: ctx.project + '\\' });
  assert.equal(f.path, normalizePath(ctx.project));
  assert.equal(f.label, 'proj');
  const again = await hub.request('folders.add', { path: ctx.project.toUpperCase() });
  assert.equal(again.id, f.id, 'same folder (case-insensitive on Windows) is not duplicated');
  assert.equal((await hub.request('folders.list', {})).length, 1);
  const changed = await hub.waitFor('state.changed', (p) => p.topics.includes('folders'));
  assert.ok(changed.topics.includes('folders'));
  await assert.rejects(hub.request('folders.remove', { folderId: 'nope' }), (e: RpcError) => e.code === ErrorCode.NotFound);
  await hub.request('folders.remove', { folderId: f.id });
  assert.equal((await hub.request('folders.list', {})).length, 0);
});

test('state.changed also reaches editor windows (their 세션 tab), not un-hello’d connections', async () => {
  const editor = await client(ctx);
  await editor.hello({ role: 'editor', folderPath: join(ctx.project, 'other-editor-folder') });
  const bare = await client(ctx);
  await bare.request('windows.list', {});
  ctx.core.markChanged('pinned');
  await editor.waitFor('state.changed', (p) => p.topics.includes('pinned'));
  await delay(60);
  assert.ok(!bare.notifications.some((n) => n.method === 'state.changed'));
});

test('$/bootResume is forwarded to onBootResume (false when not wired)', async () => {
  const c = await client(ctx);
  assert.deepEqual(await c.peer.request('$/bootResume', { remote: true }), { accepted: false });
});

test('window.open: new session → slot workspace launch → pending delivered on hello → sessionBound → focus', async () => {
  const hub = await client(ctx);
  await hub.hello({ role: 'hub' });
  ctx.calls.length = 0;

  const r = await hub.request('window.open', { folderPath: ctx.project, role: 'agent-claude', newSession: true });
  assert.equal(r.status, 'launched');
  assert.ok(r.slotId);
  const slotId = r.slotId!;
  const wsFile = roleWorkspacePath({ home: ctx.home, role: 'agent-claude', folderPath: ctx.project, slotId });
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0]!.command, 'C:\\Fake\\Code.exe');
  assert.equal(ctx.calls[0]!.args.at(-1), wsFile);
  assert.deepEqual(ctx.calls[0]!.args.slice(0, 2), ['--disable-extension', 'openai.chatgpt']);
  const ws = JSON.parse(readFileSync(wsFile, 'utf8'));
  assert.equal(ws.settings['mark42.slotId'], slotId);
  assert.equal(ws.settings['mark42.role'], 'agent-claude');
  assert.ok(ctx.registry.data.slots.some((s) => s.slotId === slotId && !s.sessionId));

  // 새 창의 확장이 붙어요
  const agent = await client(ctx);
  const hello = await agent.hello({ role: 'agent-claude', slotId, folderPath: ctx.project, workspaceFile: wsFile });
  const open = await agent.waitFor('agent.openSession');
  assert.equal(open.newSession, true);
  assert.equal(open.agent, 'claude');
  assert.equal(open.sessionId, undefined);
  assert.equal(open.autoSend, false);
  assert.ok(open.requestId);

  // 세션 ID가 정해짐
  const seen = hub.notifications.length;
  agent.peer.notify('window.sessionBound', { agent: 'claude', sessionId: 'sess-1' });
  await until(() => ctx.registry.data.slots.find((s) => s.slotId === slotId)?.sessionId === 'sess-1', 2000, 'slot bound');
  await until(
    () => hub.notifications.slice(seen).some((n) => n.method === 'state.changed'),
    2000,
    'state.changed after sessionBound',
  );
  await ctx.registry.flush();
  const onDisk = JSON.parse(readFileSync(ctx.registry.file, 'utf8'));
  assert.equal(onDisk.slots.find((s: { slotId: string }) => s.slotId === slotId).sessionId, 'sess-1');

  // 같은 세션 열기 → 기존 창 포커스 (같은 워크스페이스, 같은 버전으로 다시 실행)
  ctx.calls.length = 0;
  const f = await hub.request('window.open', { folderPath: ctx.project, role: 'agent-claude', sessionId: 'sess-1' });
  assert.equal(f.status, 'focused');
  assert.equal(f.windowId, hello.windowId);
  assert.equal(f.slotId, slotId);
  await delay(20);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0]!.args.at(-1), wsFile);
  assert.equal(agent.notifications.filter((n) => n.method === 'agent.openSession').length, 1, 'plain focus sends no openSession');

  // window.reportResult
  await agent.request('window.reportResult', { requestId: open.requestId, ok: true, detail: 'filled' });
  assert.equal(ctx.core.reportedResult(open.requestId)?.ok, true);

  // 창이 닫히면 목록에서 빠져요
  agent.close();
  await until(() => !ctx.core.windows().some((w) => w.windowId === hello.windowId), 2000, 'window removed');
  const wins = await hub.request('windows.list', {});
  assert.ok(!wins.some((w) => w.windowId === hello.windowId));
});

test('window.open: existing session without window → new slot bound to session; reopen reuses the slot', async () => {
  const hub = await client(ctx);
  await hub.hello({ role: 'hub' });
  ctx.calls.length = 0;
  const r = await hub.request('window.open', { folderPath: ctx.project, role: 'agent-codex', sessionId: 'thread-7' });
  assert.equal(r.status, 'launched');
  const slotId = r.slotId!;
  assert.equal(ctx.registry.data.slots.find((s) => s.slotId === slotId)?.sessionId, 'thread-7');
  assert.deepEqual(ctx.calls[0]!.args.slice(0, 2), ['--disable-extension', 'anthropic.claude-code']);

  // 창이 뜨기 전에 다시 열어도 같은 슬롯
  const r2 = await hub.request('window.open', { folderPath: ctx.project, role: 'agent-codex', sessionId: 'thread-7' });
  assert.equal(r2.slotId, slotId);

  const agent = await client(ctx);
  const hello = await agent.hello({ role: 'agent-codex', slotId, folderPath: ctx.project });
  const open = await agent.waitFor('agent.openSession');
  assert.equal(open.sessionId, 'thread-7');
  assert.equal(open.agent, 'codex');
  await delay(30);
  assert.equal(agent.notifications.filter((n) => n.method === 'agent.openSession').length, 1, 'queued once per slot');

  const wins = await hub.request('windows.list', {});
  assert.equal(wins.find((w) => w.windowId === hello.windowId)?.sessionId, 'thread-7', 'session filled from slot');
  agent.close();
});

test('window.open: invalid role / missing folder', async () => {
  const c = await client(ctx);
  await assert.rejects(
    c.request('window.open', { folderPath: ctx.project, role: 'nope' as never }),
    (e: RpcError) => e.code === ErrorCode.InvalidParams,
  );
  await assert.rejects(
    c.request('window.open', { folderPath: join(ctx.project, 'zzz'), role: 'editor' }),
    (e: RpcError) => e.code === ErrorCode.InvalidPath,
  );
});

test('editor.route: queues until editor hello, then forwards directly', async () => {
  const c = await client(ctx);
  ctx.calls.length = 0;
  const r1 = await c.request('editor.route', { folderPath: ctx.project, uri: 'file:///a.ts', kind: 'file', selection: { startLine: 3 } });
  const r2 = await c.request('editor.route', { folderPath: ctx.project, uri: 'https://example.com', kind: 'web' });
  assert.equal(r1.status, 'launched');
  assert.equal(r2.status, 'launched');
  assert.equal(ctx.calls.length, 1, 'second route while launching does not relaunch');
  const edFile = roleWorkspacePath({ home: ctx.home, role: 'editor', folderPath: ctx.project });
  assert.equal(ctx.calls[0]!.args.at(-1), edFile);
  assert.deepEqual(ctx.calls[0]!.args.slice(0, 4), [
    '--disable-extension',
    'anthropic.claude-code',
    '--disable-extension',
    'openai.chatgpt',
  ]);

  const editor = await client(ctx);
  await editor.hello({ role: 'editor', folderPath: ctx.project.toLowerCase(), workspaceFile: edFile });
  const first = await editor.waitFor('editor.openUri');
  assert.equal(first.uri, 'file:///a.ts');
  assert.deepEqual(first.selection, { startLine: 3 });
  const second = await editor.waitFor('editor.openUri', (p) => p.kind === 'web');
  assert.equal(second.uri, 'https://example.com');

  const r3 = await c.request('editor.route', { folderPath: ctx.project, uri: 'file:///b.md', kind: 'preview' });
  assert.equal(r3.status, 'forwarded');
  const third = await editor.waitFor('editor.openUri', (p) => p.uri === 'file:///b.md');
  assert.equal(third.kind, 'preview');

  const w = await c.request('window.open', { folderPath: ctx.project, role: 'editor' });
  assert.equal(w.status, 'focused');
  editor.close();
});

test('sessions.list: aggregates indexers, filters cwd/agent/subagents, applies live status and limit', async () => {
  const other = join(ctx.project, '..', 'other');
  ctx.claude.sessions = [
    { agent: 'claude', id: 'c1', cwd: ctx.project.toUpperCase(), updatedAt: '2026-10-17T03:00:00.000Z' },
    { agent: 'claude', id: 'c2', cwd: other, updatedAt: '2026-10-17T05:00:00.000Z' },
  ];
  ctx.codex.sessions = [
    { agent: 'codex', id: 'x1', cwd: ctx.project, updatedAt: '2026-10-17T04:00:00.000Z' },
    { agent: 'codex', id: 'x2', cwd: ctx.project, updatedAt: '2026-10-17T06:00:00.000Z', isSubagent: true, parentId: 'x1' },
  ];
  ctx.claude.liveSessions = [{ agent: 'claude', sessionId: 'c1', cwd: ctx.project, status: 'busy' }];
  const c = await client(ctx);
  const all = await c.request('sessions.list', {});
  assert.deepEqual(all.map((s) => s.id), ['c2', 'x1', 'c1']);
  const mine = await c.request('sessions.list', { cwd: ctx.project, includeSubagents: true });
  assert.deepEqual(mine.map((s) => s.id), ['x2', 'x1', 'c1']);
  assert.equal(mine.find((s) => s.id === 'c1')?.status, 'busy');
  const codexOnly = await c.request('sessions.list', { agent: 'codex', cwd: ctx.project });
  assert.deepEqual(codexOnly.map((s) => s.id), ['x1']);
  const limited = await c.request('sessions.list', { limit: 1 });
  assert.deepEqual(limited.map((s) => s.id), ['c2']);
  await assert.rejects(c.request('sessions.list', { folderId: 'unknown' }), (e: RpcError) => e.code === ErrorCode.NotFound);

  // 인덱서 변경 → sessions 토픽
  const hub = await client(ctx);
  await hub.hello({ role: 'hub' });
  ctx.claude.onChange?.();
  const ch = await hub.waitFor('state.changed', (p) => p.topics.includes('sessions'));
  assert.ok(ch.topics.includes('sessions'));
  ctx.claude.sessions = [];
  ctx.codex.sessions = [];
  ctx.claude.liveSessions = [];
});

test('pinned: upsert generates id and defaults, update keeps fields, remove', async () => {
  const c = await client(ctx);
  const p = await c.request('pinned.upsert', {
    folderPath: ctx.project,
    agent: 'claude',
    sessionId: 'sess-9',
    settings: { effort: 'high' },
    resumePrompt: '이어서 해 주세요',
    autoSend: true,
    enabled: true,
    order: 5,
  });
  assert.ok(p.id);
  const q = await c.request('pinned.upsert', { ...p, label: 'main', enabled: false });
  assert.equal(q.id, p.id);
  assert.equal(q.label, 'main');
  assert.equal(q.enabled, false);
  assert.deepEqual(q.settings, { effort: 'high' });
  assert.equal((await c.request('pinned.list', {})).length, 1);
  // 내 그룹: 다듬어 넣고(제어 문자·앞뒤 공백 빼고, 60자), 안 보내면 그대로, 빈 문자열이면 빼요
  const g = await c.request('pinned.upsert', { ...q, group: `  일\u0007상 ${'x'.repeat(80)}` });
  assert.equal(g.group, `일상 ${'x'.repeat(57)}`);
  assert.equal((await c.request('pinned.upsert', { ...q, label: 'main2' })).group, g.group);
  const { group: _g, ...noGroup } = g;
  assert.equal((await c.request('pinned.upsert', { ...noGroup, group: '' })).group, undefined);
  // 빠진 값: 판 기본값(공개판 — 자동 전송 끔, 기본 재개 프롬프트), 부팅 재개(enabled)는 꺼요
  const bare = await c.request('pinned.upsert', { folderPath: ctx.project, agent: 'claude', sessionId: 'sess-10' } as never);
  assert.equal(bare.autoSend, false);
  const defaults = await c.request('pinned.defaults', {});
  assert.equal(bare.resumePrompt, defaults.resumePrompt);
  assert.ok(defaults.knownPrompts.includes(defaults.resumePrompt));
  assert.equal(bare.enabled, false);
  await c.request('pinned.remove', { pinnedId: bare.id });
  await assert.rejects(
    c.request('pinned.upsert', { ...p, agent: 'gpt' as never }),
    (e: RpcError) => e.code === ErrorCode.InvalidParams,
  );
  await c.request('pinned.remove', { pinnedId: p.id });
  assert.equal((await c.request('pinned.list', {})).length, 0);
  await assert.rejects(c.request('pinned.remove', { pinnedId: p.id }), (e: RpcError) => e.code === ErrorCode.NotFound);
});

test('unknown method → MethodNotFound; autostart without backend → NotFound', async () => {
  const c = await client(ctx);
  await assert.rejects(c.peer.request('nope.method', {}), (e: RpcError) => e.code === ErrorCode.MethodNotFound);
  await assert.rejects(c.request('autostart.get', {}), (e: RpcError) => e.code === ErrorCode.NotFound);
  await assert.rejects(c.peer.request('$/openHub', {}), (e: RpcError) => e.code === ErrorCode.NotFound);
});

test('theme: the hub follows the most recently focused window that reported its theme; bad colors are dropped', async () => {
  const hub = await client(ctx);
  await hub.hello({ role: 'hub' });
  assert.deepEqual(await hub.request('theme.get', {}), {}, 'nothing reported yet');
  const a = await client(ctx);
  await a.hello({ role: 'editor', folderPath: join(ctx.project, 'theme-a') });
  const b = await client(ctx);
  await b.hello({ role: 'editor', folderPath: join(ctx.project, 'theme-b') });

  a.peer.notify('window.theme', { kind: 'dark', name: 'A', colors: { foreground: '#AAAAAA', 'input.border': 'red' } });
  await hub.waitFor('state.changed', (p) => p.topics.includes('theme'));
  assert.deepEqual(await hub.request('theme.get', {}), { theme: { kind: 'dark', name: 'A', colors: { foreground: '#aaaaaa' } } });

  b.peer.notify('window.theme', { kind: 'light', name: 'B', colors: {} });
  await delay(30);
  assert.equal((await hub.request('theme.get', {})).theme?.name, 'B', 'neither focused yet: the newer report');

  a.peer.notify('window.status', { focused: true });
  await delay(30);
  assert.equal((await hub.request('theme.get', {})).theme?.name, 'A', 'focus moved to A: the hub follows A');

  a.peer.notify('window.theme', { kind: 'purple', colors: {} }); // unknown kind: ignored
  await delay(30);
  assert.equal((await hub.request('theme.get', {})).theme?.name, 'A');

  const bare = await client(ctx); // not hello'd: cannot set the theme
  bare.peer.notify('window.theme', { kind: 'light', name: 'X', colors: {} });
  await delay(30);
  assert.equal((await hub.request('theme.get', {})).theme?.name, 'A');

  // a window that only connects later (daemon restart, background agent window) does not take over from the focused one
  const late = await client(ctx);
  await late.hello({ role: 'editor', folderPath: join(ctx.project, 'theme-late') });
  late.peer.notify('window.status', { focused: false });
  late.peer.notify('window.theme', { kind: 'light', name: 'Late', colors: {} });
  await delay(30);
  assert.equal((await hub.request('theme.get', {})).theme?.name, 'A');

  // the followed window closes: the hub picks again among the rest
  b.peer.notify('window.status', { focused: true });
  await delay(30);
  assert.equal((await hub.request('theme.get', {})).theme?.name, 'B');
  b.close();
  await delay(60);
  assert.equal((await hub.request('theme.get', {})).theme?.name, 'A', 'B gone: back to A (focused before)');
});

test('extensions: checkUpdates without an updater is empty; an installed update is announced to attached windows', async () => {
  const w = await client(ctx);
  await w.hello({ role: 'agent-claude', folderPath: join(ctx.project, 'upd') });
  assert.deepEqual(await w.request('extensions.checkUpdates', {}), { updates: [] });
  const got = w.waitFor('extensions.updated', (p) => p.ids.includes('openai.chatgpt'));
  ctx.core.notifyExtensionsUpdated(['openai.chatgpt']);
  assert.deepEqual(await got, { ids: ['openai.chatgpt'] });
});
