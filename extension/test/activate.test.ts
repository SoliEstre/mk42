// 확장 전체를 가짜 vscode + 가짜 데몬(named pipe)으로 활성화해 보는 통합 테스트
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { registerHooks } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { RpcPeer } from '@mark42/protocol';
import { authSecretPath, computeProof, ensurePrivateDir } from '@mark42/protocol/auth';
import { socketChannel } from '@mark42/protocol/node';

const here = dirname(fileURLToPath(import.meta.url));

// 기본 Mark42 home = 임시 폴더(MARK42_HOME) — 역할 워크스페이스 파일과 데몬 인증 비밀을 실제로 둬요
const tmpRoot = mkdtempSync(join(tmpdir(), 'm42-activate-'));
// Windows: 창은 home·auth.secret이 본인 전용(ACL)이어야 읽어요 — 데몬처럼 루트를 한 번 조이면 아래 home들이 상속받아요
await ensurePrivateDir(tmpRoot);
const HOME = join(tmpRoot, 'Mark42');
mkdirSync(HOME, { recursive: true });
process.env.MARK42_HOME = HOME;
const SECRET = randomBytes(32);
writeFileSync(authSecretPath(HOME), SECRET, { mode: 0o600 });
after(() => rmSync(tmpRoot, { recursive: true, force: true }));
const FID = '0123456789abcdef';
const stubUrl = pathToFileURL(join(here, 'helpers', 'vscode-stub.ts')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'vscode') return { url: stubUrl, shortCircuit: true, format: 'module' };
    return next(specifier, context);
  },
});

const vs = (await import(stubUrl)) as typeof import('./helpers/vscode-stub.ts');
const ext = (await import('../src/extension.ts')) as typeof import('../src/extension.ts');

interface FakeDaemon {
  server: Server;
  pipe: string;
  requests: { method: string; params: any }[];
  notes: { method: string; params: any }[];
  peers: RpcPeer[];
  notifyAll(method: string, params: unknown): void;
}

interface DaemonBehavior {
  /** 이 비밀로 proof를 만들어요(기본: 진짜 비밀). null이면 proof를 내지 않아요(옛 데몬·가짜 서버) */
  secret?: Uint8Array | null;
  /** 연결되자마자(인증 전에) 보낼 알림 */
  eager?: { method: string; params: unknown }[];
}

function startDaemon(behavior: DaemonBehavior = {}): Promise<FakeDaemon> {
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\mark42-test-${randomBytes(6).toString('hex')}` : join(here, `.m42-${randomBytes(4).toString('hex')}.sock`);
  const secret = behavior.secret === undefined ? SECRET : behavior.secret;
  const proofFor = (params: any) => (secret && typeof params?.challenge === 'string' ? { proof: computeProof(secret, pipe, params.challenge) } : {});
  const d: FakeDaemon = {
    server: undefined as never,
    pipe,
    requests: [],
    notes: [],
    peers: [],
    notifyAll(method, params) {
      for (const p of this.peers) p.notify(method, params);
    },
  };
  d.server = createServer((sock) => {
    const peer = new RpcPeer(socketChannel(sock), {
      onRequest: (method, params) => {
        d.requests.push({ method, params });
        switch (method) {
          case 'hello':
            return { protocolVersion: 1, daemonVersion: 'test', windowId: 'w1', ...proofFor(params) };
          case '$/auth':
            return proofFor(params);
          case 'folders.list':
            return [{ id: 'f1', path: 'C:\\Dev\\proj', label: 'proj', addedAt: '2026-10-17T00:00:00Z' }];
          case 'editor.route':
            return { status: 'forwarded' };
          default:
            return {};
        }
      },
      onNotification: (method, params) => d.notes.push({ method, params }),
    });
    d.peers.push(peer);
    for (const n of behavior.eager ?? []) peer.notify(n.method, n.params);
  });
  return new Promise((resolve) => d.server.listen(pipe, () => resolve(d)));
}

async function until<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

let current: { subs: { dispose(): void }[]; daemon: FakeDaemon } | undefined;

function makeContext() {
  const store = new Map<string, unknown>();
  return {
    subscriptions: [] as { dispose(): void }[],
    extension: { id: 'mark42.mark42', packageJSON: { version: '0.1.0' } },
    extensionUri: vs.Uri.file(join(here, '..')),
    globalState: { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => void store.set(k, v) },
  };
}

/** 데몬이 만드는 역할 워크스페이스 경로 모양 — 역할 키는 이 파일에서 온 값만 받아요 */
function roleWorkspace(config: Record<string, unknown>, home: string): string | undefined {
  const role = config['mark42.role'];
  if (typeof role !== 'string' || !role) return undefined;
  const slot = config['mark42.slotId'];
  const file =
    role === 'hub'
      ? join(home, 'roles', '_hub', 'hub.code-workspace')
      : join(home, 'roles', FID, `${role}${typeof slot === 'string' && slot ? `.${slot}` : ''}.code-workspace`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{}');
  return file;
}

async function activateWith(
  config: Record<string, unknown>,
  opts: {
    asFolder?: boolean;
    daemon?: DaemonBehavior;
    home?: string;
    workspaceFile?: string;
    global?: Record<string, unknown>;
    untrusted?: boolean;
  } = {},
): Promise<FakeDaemon> {
  vs.reset();
  if (opts.untrusted) vs.state.trusted = false;
  const daemon = await startDaemon(opts.daemon);
  vs.state.globalConfig = { 'mark42.pipeName': daemon.pipe, ...opts.global };
  vs.state.config = { ...config };
  const ws = opts.asFolder ? undefined : (opts.workspaceFile ?? roleWorkspace(config, opts.home ?? HOME));
  vs.state.workspaceFile = ws ? vs.Uri.file(ws) : undefined;
  vs.state.workspaceFolders = [{ uri: vs.Uri.file('C:\\Dev\\proj') }];
  vs.state.extensions.set('anthropic.claude-code', {
    id: 'anthropic.claude-code',
    packageJSON: { version: '2.1.301' },
    isActive: true,
    activate: async () => {},
  });
  const ctx = makeContext();
  ext.activate(ctx as never);
  current = { subs: ctx.subscriptions, daemon };
  return daemon;
}

afterEach(async () => {
  if (!current) return;
  for (const s of current.subs.splice(0)) s.dispose();
  ext.deactivate();
  for (const p of current.daemon.peers) p.close();
  await new Promise((r) => current!.daemon.server.close(() => r(undefined)));
  current = undefined;
});

test('agent-claude window: hello, openSession via editor.open(programmatic), report, sessionBound', async () => {
  const d = await activateWith({ 'mark42.role': 'agent-claude', 'mark42.slotId': 'slot1', 'mark42.folderPath': 'C:\\Dev\\proj' });
  const hello = await until(() => d.requests.find((r) => r.method === 'hello'));
  assert.equal(hello.params.protocolVersion, 1);
  assert.equal(hello.params.window.role, 'agent-claude');
  assert.equal(hello.params.window.slotId, 'slot1');
  assert.equal(hello.params.window.folderPath, 'C:\\Dev\\proj');
  assert.equal(hello.params.window.pid, process.pid);
  assert.deepEqual(
    hello.params.window.extensions.map((e: { id: string }) => e.id).sort(),
    ['anthropic.claude-code', 'mark42.mark42'],
  );

  d.notifyAll('agent.openSession', {
    requestId: 'r1',
    agent: 'claude',
    sessionId: '0b6c4f7e-1111-2222-3333-444455556666',
    prompt: '재개해 주세요',
    settings: { effort: 'high' },
    autoSend: false,
  });
  // 창이 막 떴을 때는 웹뷰 준비를 더 기다려요(약 6.5초)
  const report = await until(() => d.requests.find((r) => r.method === 'window.reportResult'), 20_000);
  assert.equal(report.params.requestId, 'r1');
  assert.equal(report.params.ok, true);
  assert.match(report.params.detail, /fill-only\(not-requested\)/);
  assert.match(report.params.detail, /skipped \/effort high/);
  const open = vs.state.executed.find((e) => e.id === 'claude-vscode.editor.open');
  assert.ok(open);
  assert.deepEqual(open.args, [
    '0b6c4f7e-1111-2222-3333-444455556666',
    '재개해 주세요',
    undefined,
    undefined,
    undefined,
    { programmatic: 'honor-preferred-location' },
  ]);
  const bound = await until(() => d.notes.find((n) => n.method === 'window.sessionBound'));
  assert.deepEqual(bound.params, { agent: 'claude', sessionId: '0b6c4f7e-1111-2222-3333-444455556666' });

  // 작업 보기: 든 세션의 백그라운드 작업을 읽고, state.changed {tasks}면 다시 읽어요(다른 주제는 아니에요)
  const tasksCalls = () => d.requests.filter((r) => r.method === 'tasks.list');
  const first = await until(() => tasksCalls()[0]);
  assert.deepEqual(first.params, { sessionId: '0b6c4f7e-1111-2222-3333-444455556666', agent: 'claude' });
  assert.ok(vs.state.webviewViewProviders.has('mark42.tasks.claude'));
  assert.ok(vs.state.executed.some((e) => e.id === 'setContext' && e.args[0] === 'mark42.agentKind' && e.args[1] === 'claude'));
  const before = tasksCalls().length;
  const sessionsTree = vs.state.treeViews.get('mark42.sessions')!;
  assert.ok(sessionsTree);
  await new Promise((r) => setTimeout(r, 300)); // 세션을 든 뒤의 세션 목록 새로 고침이 끝나게
  const treeBefore = sessionsTree.changes;
  d.notifyAll('state.changed', { topics: ['folders'] });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(tasksCalls().length, before, 'other topics do not refetch tasks');
  assert.ok(sessionsTree.changes > treeBefore, 'other topics refresh the sessions list');
  const treeAfterFolders = sessionsTree.changes;
  d.notifyAll('state.changed', { topics: ['tasks'] });
  await until(() => tasksCalls().length > before || undefined, 3000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sessionsTree.changes, treeAfterFolders, 'tasks-only notifications leave the sessions list alone');
});

test('role window in restricted mode: warns with a trust button, then re-hellos with its role once trusted', async () => {
  const role = { 'mark42.role': 'agent-claude', 'mark42.slotId': 'slot1', 'mark42.folderPath': 'C:\\Dev\\proj' };
  // restricted mode hides the role workspace's mark42.* values
  const d = await activateWith({}, { untrusted: true, workspaceFile: roleWorkspace(role, HOME) });
  const warn = await until(() => vs.state.messages.find((m) => m.level === 'warn' && m.text.includes('제한 모드')));
  assert.match(warn.text, /신뢰/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(d.requests.find((r) => r.method === 'hello'), undefined, 'no role yet: no hello');

  vs.state.trusted = true;
  vs.state.config = { ...role };
  vs.state.trustGranted.fire();
  const hello = await until(() => d.requests.find((r) => r.method === 'hello'));
  assert.equal(hello.params.window.role, 'agent-claude');
  assert.equal(hello.params.window.slotId, 'slot1');
});

test('openSession waits for an agent extension that shows up late (just trusted)', async () => {
  const d = await activateWith({ 'mark42.role': 'agent-claude', 'mark42.slotId': 'slot1', 'mark42.folderPath': 'C:\\Dev\\proj' });
  await until(() => d.requests.find((r) => r.method === 'hello'));
  const claude = vs.state.extensions.get('anthropic.claude-code')!;
  vs.state.extensions.delete('anthropic.claude-code'); // still being enabled after the trust grant
  d.notifyAll('agent.openSession', { requestId: 'r-late', agent: 'claude', autoSend: false });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(d.requests.find((r) => r.method === 'window.reportResult'), undefined, 'not failed as «not installed»');
  vs.state.extensions.set('anthropic.claude-code', claude);
  vs.state.extensionsChanged.fire();
  const report = await until(() => d.requests.find((r) => r.method === 'window.reportResult'), 20_000);
  assert.equal(report.params.ok, true, report.params.detail);
  assert.ok(vs.state.executed.find((e) => e.id === 'claude-vscode.editor.open'));
});

test('a trusted role window gets no restricted-mode warning', async () => {
  const d = await activateWith({ 'mark42.role': 'agent-claude', 'mark42.slotId': 'slot1', 'mark42.folderPath': 'C:\\Dev\\proj' });
  await until(() => d.requests.find((r) => r.method === 'hello'));
  assert.equal(vs.state.messages.find((m) => m.text.includes('제한 모드')), undefined);
});

test('agent window ignores openSession for the other agent', async () => {
  const d = await activateWith({ 'mark42.role': 'agent-codex', 'mark42.slotId': 's2' });
  await until(() => d.requests.find((r) => r.method === 'hello'));
  d.notifyAll('agent.openSession', { requestId: 'r2', agent: 'claude', newSession: true, autoSend: false });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(d.requests.find((r) => r.method === 'window.reportResult'), undefined);
  assert.equal(vs.state.executed.find((e) => e.id === 'claude-vscode.editor.open'), undefined);
});

test('agent window routes file tabs to the editor window and closes them', async () => {
  const d = await activateWith({ 'mark42.role': 'agent-claude', 'mark42.slotId': 's3' });
  await until(() => d.requests.find((r) => r.method === 'hello'));
  const fileTab = { input: new vs.TabInputText(vs.Uri.file('C:\\Dev\\proj\\a.ts')), isActive: true, label: 'a.ts' };
  const diffTab = { input: new vs.TabInputTextDiff(vs.Uri.file('C:\\a'), vs.Uri.parse('_claude_vscode_fs_right:/a')), isActive: false, label: 'diff' };
  vs.state.tabsChanged.fire({ opened: [fileTab, diffTab], changed: [], closed: [] });
  const route = await until(() => d.requests.find((r) => r.method === 'editor.route'));
  assert.equal(route.params.kind, 'file');
  assert.equal(route.params.folderPath, 'C:\\Dev\\proj');
  assert.equal(route.params.uri, fileTab.input.uri.toString());
  await until(() => vs.state.closedTabs.length > 0 || undefined);
  assert.deepEqual(vs.state.closedTabs, [fileTab]);
  assert.equal(d.requests.filter((r) => r.method === 'editor.route').length, 1);
});

test('editor window opens web links in the Simple Browser', async () => {
  const d = await activateWith({ 'mark42.role': 'editor' });
  await until(() => d.requests.find((r) => r.method === 'hello'));
  d.notifyAll('editor.openUri', { uri: 'https://example.com/x', kind: 'web' });
  const ex = await until(() => vs.state.executed.find((e) => e.id === 'simpleBrowser.show'));
  assert.deepEqual(ex.args, ['https://example.com/x']);
});

test('hub window opens the webview and relays rpc, notifications and ui.addFolder', async () => {
  const d = await activateWith({ 'mark42.role': 'hub' });
  await until(() => d.requests.find((r) => r.method === 'hello'));
  const panel = await until(() => vs.state.panels[0]);
  assert.equal(panel.title, '통합 창');
  assert.match(panel.html, /<body data-transport="webview">/);
  panel.receive.fire({ type: 'rpc', id: 5, method: 'folders.list', params: {} });
  const res = await until(() => panel.posted.find((m: any) => m.type === 'rpcResult' && m.id === 5) as any);
  assert.equal(res.result[0].id, 'f1');
  d.notifyAll('state.changed', { topics: ['folders'] });
  await until(() => panel.posted.find((m: any) => m.type === 'notify' && m.method === 'state.changed'));
  panel.receive.fire({ type: 'notify', method: 'ui.addFolder', params: {} });
  await until(() => vs.state.executed.find((e) => e.id === 'mark42.addFolder'));
});

test('a plain folder whose .vscode/settings.json claims mark42.role=hub stays unmanaged (no hub, no daemon spawn)', async () => {
  const d = await activateWith(
    { 'mark42.role': 'hub', 'mark42.daemonPath': 'C:\\evil\\x.js', 'mark42.nodePath': 'C:\\evil\\node.exe' },
    { asFolder: true },
  );
  await until(() => d.peers.length > 0 || undefined);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(d.requests.find((r) => r.method === 'hello'), undefined);
  assert.equal(vs.state.panels.length, 0);
});

test('codex agent window opens the thread URI routed back to this window (asExternalUri windowId)', async () => {
  const d = await activateWith({ 'mark42.role': 'agent-codex', 'mark42.slotId': 's9', 'mark42.folderPath': 'C:\\Dev\\proj' });
  vs.state.extensions.set('openai.chatgpt', { id: 'openai.chatgpt', packageJSON: { version: '26.1007.21434' }, isActive: true, activate: async () => {} });
  await until(() => d.requests.find((r) => r.method === 'hello'));
  d.notifyAll('agent.openSession', { requestId: 'rc', agent: 'codex', sessionId: '019a0000-0000-7000-8000-000000000001', autoSend: false });
  await until(() => vs.state.openedExternal[0]);
  assert.equal(vs.state.openedExternal[0], 'vscode://openai.chatgpt/local/019a0000-0000-7000-8000-000000000001?windowId=1');
});

test('unmanaged window authenticates the daemon ($/auth) without hello and never routes tabs', async () => {
  const d = await activateWith({});
  const auth = await until(() => d.requests.find((r) => r.method === '$/auth'));
  assert.match(auth.params.challenge, /^[A-Za-z0-9_-]{43}$/);
  vs.state.tabsChanged.fire({ opened: [{ input: new vs.TabInputText(vs.Uri.file('C:\\Dev\\proj\\a.ts')), isActive: true, label: 'a' }], changed: [], closed: [] });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(d.requests.find((r) => r.method === 'hello'), undefined);
  assert.equal(d.requests.find((r) => r.method === 'editor.route'), undefined);
  assert.deepEqual(vs.state.closedTabs, []);
});

test('$/auth with a fresh challenge comes before hello; notifications sent before verification are held, then handled', async () => {
  const d = await activateWith(
    { 'mark42.role': 'editor' },
    { daemon: { eager: [{ method: 'editor.openUri', params: { uri: 'https://example.com/early', kind: 'web' } }] } },
  );
  const hello = await until(() => d.requests.find((r) => r.method === 'hello'));
  const auth = d.requests.find((r) => r.method === '$/auth');
  assert.ok(auth && d.requests.indexOf(auth) < d.requests.indexOf(hello), '$/auth before hello');
  assert.match(auth.params.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(hello.params.challenge, undefined);
  const ex = await until(() => vs.state.executed.find((e) => e.id === 'simpleBrowser.show'));
  assert.deepEqual(ex.args, ['https://example.com/early']);
  await until(() => d.notes.find((n) => n.method === 'window.status'));
});

test('squatter with a wrong secret: never trusted, no notification handled, reconnects with backoff', async () => {
  const early = { requestId: 'evil', agent: 'claude', sessionId: '0b6c4f7e-1111-2222-3333-444455556666', prompt: 'rm -rf', autoSend: true };
  const d = await activateWith(
    { 'mark42.role': 'agent-claude', 'mark42.slotId': 'sq1' },
    { daemon: { secret: randomBytes(32), eager: [{ method: 'agent.openSession', params: early }, { method: 'editor.openUri', params: { uri: 'https://evil.example/', kind: 'web' } }] } },
  );
  await until(() => d.requests.find((r) => r.method === '$/auth'));
  d.notifyAll('agent.openSession', early);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(d.requests.find((r) => r.method === 'hello'), undefined, 'window info never sent to an unverified pipe');
  assert.equal(vs.state.executed.find((e) => e.id === 'claude-vscode.editor.open'), undefined);
  assert.equal(vs.state.executed.find((e) => e.id === 'simpleBrowser.show'), undefined);
  assert.equal(d.requests.find((r) => r.method === 'window.reportResult'), undefined);
  assert.equal(d.notes.find((n) => n.method === 'window.status'), undefined, 'window never considered itself connected');
  assert.ok(d.peers.length <= 2, `no tight reconnect loop (${d.peers.length} connections in 1.5s)`);
  assert.ok(d.peers.every((p) => p.closed) || d.peers.length >= 1);
});

test('daemon without proof (old or fake server): unmanaged window refuses the connection', async () => {
  const d = await activateWith({}, { daemon: { secret: null, eager: [{ method: 'state.changed', params: { topics: ['folders'] } }] } });
  await until(() => d.requests.find((r) => r.method === '$/auth'));
  await until(() => (d.peers[0]?.closed ? true : undefined));
  assert.equal(d.requests.filter((r) => r.method !== '$/auth').length, 0, 'nothing else sent to an unverified pipe');
});

test('a repository-shipped roles\\_hub\\hub.code-workspace outside the trusted home stays unmanaged', async () => {
  const repoFile = join(tmpRoot, 'repo', 'roles', '_hub', 'hub.code-workspace');
  mkdirSync(dirname(repoFile), { recursive: true });
  writeFileSync(repoFile, '{}');
  const d = await activateWith({ 'mark42.role': 'hub', 'mark42.daemonPath': 'C:\\evil\\x.js' }, { workspaceFile: repoFile });
  await until(() => d.requests.find((r) => r.method === '$/auth'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(d.requests.find((r) => r.method === 'hello'), undefined);
  assert.equal(vs.state.panels.length, 0);
});

test('a role workspace under a user-trusted custom home authenticates with that home\'s secret', async () => {
  const home2 = join(tmpRoot, 'custom-home');
  mkdirSync(home2, { recursive: true });
  const secret2 = randomBytes(32);
  writeFileSync(authSecretPath(home2), secret2, { mode: 0o600 });
  const d = await activateWith(
    { 'mark42.role': 'editor' },
    { home: home2, daemon: { secret: secret2 }, global: { 'mark42.trustedHomes': [home2] } },
  );
  await until(() => d.requests.find((r) => r.method === 'hello'));
  await until(() => d.notes.find((n) => n.method === 'window.status'));
});
