// Mk42 자체 업데이트(updater.ts, 계약 C4) — 로컬 http 서버 + 시험용 Ed25519 키로 서명한 latest.json.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Mk42UpdateStatus } from '@mark42/protocol';
import { Registry } from '../src/registry.ts';
import { DaemonCore, PipeServer } from '../src/server.ts';
import {
  basicAuthHeader,
  INSTALLER_ARGS,
  Mk42Updater,
  parseLatestManifest,
  parseUpdateConfig,
  verifyManifestSignature,
  type Timers,
} from '../src/updater.ts';
import { connectPipe, fakeLauncher, FakeIndexer, sequenceIds, tempDir, uniquePipeName, type SpawnCall } from './helpers.ts';

const keys = generateKeyPairSync('ed25519');
const PUB = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519');

const CURRENT = '2026.1101.100000';
const NEXT = '2026.1105.143012';
const EXE = `Mk42-Setup-${NEXT}.exe`;
const PAYLOAD = Buffer.alloc(200_000, 7);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

interface Fixture {
  server: Server;
  base: string;
  requests: { url: string; auth?: string }[];
  /** 바꿔 끼우는 응답 */
  manifest: Record<string, unknown>;
  manifestBytes?: Buffer;
  sigKey: typeof keys.privateKey;
  badSig?: boolean;
  payload: Buffer;
  status?: number;
  close(): Promise<void>;
}

async function startServer(): Promise<Fixture> {
  const f: Fixture = {
    server: undefined as never,
    base: '',
    requests: [],
    manifest: {
      schema: 1,
      product: 'mk42',
      channel: 'internal',
      version: NEXT,
      appVersion: '1.143.1-e646868',
      publishedAt: '2026-11-05T14:30:12Z',
      file: EXE,
      size: PAYLOAD.length,
      sha256: sha(PAYLOAD),
      notes: { ko: '한국어 설명', en: 'English notes' },
    },
    sigKey: keys.privateKey,
    payload: PAYLOAD,
    close: () => new Promise((r) => f.server.close(() => r())),
  };
  f.server = createServer((req: IncomingMessage, res) => {
    f.requests.push({ url: req.url ?? '', ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    if (f.status) {
      res.writeHead(f.status).end();
      return;
    }
    const bytes = f.manifestBytes ?? Buffer.from(JSON.stringify(f.manifest));
    if (req.url === '/updates/internal/latest.json') res.end(bytes);
    else if (req.url === '/updates/internal/latest.json.sig') {
      const sig = sign(null, f.badSig ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes, f.sigKey).toString('base64');
      res.end(`${sig}\n`);
    } else if (req.url === `/updates/internal/${EXE}`) {
      res.writeHead(200, { 'content-length': String(f.payload.length) });
      res.end(f.payload);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', () => r()));
  f.base = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}/updates/`;
  return f;
}

const noTimers: Timers = { setTimeout: () => 0, clearTimeout: () => undefined };

function writeInstall(home: string, base: string, over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(home, 'install.json'),
    JSON.stringify({ schema: 1, product: 'mark42', package: { version: CURRENT }, update: { channel: 'internal', url: base, publicKey: PUB, ...over } }),
  );
}

interface Spawned {
  exe: string;
  args: string[];
  exit?: (code: number | null) => void;
}

function makeUpdater(home: string, extra: Partial<ConstructorParameters<typeof Mk42Updater>[0]> = {}) {
  const events: Mk42UpdateStatus[] = [];
  const spawned: Spawned[] = [];
  const u = new Mk42Updater({
    home,
    timers: noTimers,
    allowLoopbackHttp: true,
    sizeLimits: { min: 1, max: 10_000_000 },
    lang: () => 'ko',
    onChange: (s) => events.push(s),
    spawnInstaller: async (exe, args) => {
      const s: Spawned = { exe, args };
      spawned.push(s);
      return { onExit: (cb) => void (s.exit = cb) };
    },
    ...extra,
  });
  return { u, events, spawned };
}

async function withFixture(fn: (f: Fixture, home: string) => Promise<void>): Promise<void> {
  const f = await startServer();
  const t = tempDir('mk42-updater-');
  try {
    await fn(f, t.dir);
  } finally {
    await f.close();
    t.cleanup();
  }
}

test('updater: signed newer manifest → download with Basic auth → ready; other files in updates\\ are pruned; install spawns the silent installer', async () => {
  await withFixture(async (f, home) => {
    writeInstall(home, f.base);
    writeFileSync(join(home, 'update.secret'), 'mk42:s3cret-token\r\n');
    mkdirSync(join(home, 'updates'));
    writeFileSync(join(home, 'updates', 'Mk42-Setup-2026.1001.1.exe'), 'old');
    writeFileSync(join(home, 'updates', `${EXE}.partial`), 'half');
    const { u, events, spawned } = makeUpdater(home);
    await u.start();
    assert.equal(u.status().state, 'idle');
    assert.ok(!existsSync(join(home, 'updates', `${EXE}.partial`)), 'leftover .partial swept at start');
    const first = await u.check();
    assert.equal(first.state, 'downloading');
    await u.whenIdle();
    const s = u.status();
    assert.equal(s.state, 'ready');
    assert.equal(s.latest, NEXT);
    assert.equal(s.current, CURRENT);
    assert.equal(s.notes, '한국어 설명');
    assert.ok(events.some((e) => e.state === 'downloading'));
    assert.deepEqual(readdirSync(join(home, 'updates')), [EXE]);
    const expectAuth = `Basic ${Buffer.from('mk42:s3cret-token').toString('base64')}`;
    assert.equal(f.requests.length, 3);
    for (const r of f.requests) assert.equal(r.auth, expectAuth, r.url);

    // 다시 확인해도 다시 받지 않아요
    f.requests.length = 0;
    assert.equal((await u.check()).state, 'ready');
    assert.deepEqual(f.requests.map((r) => r.url).sort(), ['/updates/internal/latest.json', '/updates/internal/latest.json.sig']);

    const r = await u.install();
    assert.deepEqual(r, { started: true });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]!.exe, join(home, 'updates', EXE));
    for (const a of INSTALLER_ARGS) assert.ok(spawned[0]!.args.includes(a), a);
    assert.ok(spawned[0]!.args.some((a) => a.startsWith('/MK42HOME=')), 'non-default home is passed to the wizard');
    assert.equal(u.status().state, 'installing');
    assert.equal((await u.install()).started, false, 'no second installer');
    // 설치기가 데몬보다 먼저 끝나면 다시 ready
    spawned[0]!.exit!(5);
    assert.equal(u.status().state, 'ready');
    assert.match(u.status().error ?? '', /code 5/);
    u.close();
  });
});

test('updater: a restarted daemon reuses a fully downloaded installer that matches the signed sha256', async () => {
  await withFixture(async (f, home) => {
    writeInstall(home, f.base);
    mkdirSync(join(home, 'updates'));
    writeFileSync(join(home, 'updates', EXE), PAYLOAD);
    const { u } = makeUpdater(home);
    await u.start();
    assert.equal((await u.check()).state, 'ready');
    assert.ok(!f.requests.some((r) => r.url.endsWith('.exe')), 'no download');
    assert.ok(f.requests.every((r) => r.auth === undefined), 'no update.secret → no Authorization header');
  });
});

test('updater: a bad signature or a manifest signed by another key is ignored — nothing is downloaded', async () => {
  await withFixture(async (f, home) => {
    writeInstall(home, f.base);
    const { u } = makeUpdater(home);
    await u.start();
    f.badSig = true;
    let s = await u.check();
    assert.equal(s.state, 'error');
    assert.match(s.error ?? '', /signature/);
    f.badSig = false;
    f.sigKey = other.privateKey;
    s = await u.check();
    assert.equal(s.state, 'error');
    assert.ok(!f.requests.some((r) => r.url.endsWith('.exe')));
    assert.ok(!existsSync(join(home, 'updates', EXE)));
  });
});

test('updater: wrong sha256 or size → download fails, no file is kept, install refuses', async () => {
  await withFixture(async (f, home) => {
    writeInstall(home, f.base);
    const { u, spawned } = makeUpdater(home);
    await u.start();
    f.payload = Buffer.alloc(PAYLOAD.length, 9); // 같은 크기, 다른 내용
    await u.check();
    await u.whenIdle();
    assert.equal(u.status().state, 'error');
    assert.match(u.status().error ?? '', /sha256/);
    assert.deepEqual(existsSync(join(home, 'updates')) ? readdirSync(join(home, 'updates')) : [], []);
    assert.equal((await u.install()).started, false);
    assert.equal(spawned.length, 0);

    f.payload = Buffer.concat([PAYLOAD, Buffer.from('x')]);
    await u.check();
    await u.whenIdle();
    assert.equal(u.status().state, 'error');
    assert.deepEqual(readdirSync(join(home, 'updates')), []);
  });
});

test('updater: the installer is re-verified right before it is started (tampered file is removed)', async () => {
  await withFixture(async (f, home) => {
    writeInstall(home, f.base);
    const { u, spawned } = makeUpdater(home);
    await u.start();
    await u.check();
    await u.whenIdle();
    assert.equal(u.status().state, 'ready');
    writeFileSync(join(home, 'updates', EXE), Buffer.alloc(PAYLOAD.length, 1));
    const r = await u.install();
    assert.equal(r.started, false);
    assert.equal(spawned.length, 0);
    assert.equal(u.status().state, 'error');
    assert.ok(!existsSync(join(home, 'updates', EXE)));
  });
});

test('updater: same or older version → idle, old downloads are removed, nothing is fetched', async () => {
  await withFixture(async (f, home) => {
    writeInstall(home, f.base);
    mkdirSync(join(home, 'updates'));
    writeFileSync(join(home, 'updates', EXE), PAYLOAD);
    f.manifest.version = '2026.1031.235959';
    const { u } = makeUpdater(home);
    await u.start();
    const s = await u.check();
    assert.equal(s.state, 'idle');
    assert.equal(s.latest, '2026.1031.235959');
    assert.ok(s.checkedAt);
    assert.deepEqual(readdirSync(join(home, 'updates')), []);
    assert.ok(!f.requests.some((r) => r.url.endsWith('.exe')));
    f.manifest.version = CURRENT;
    assert.equal((await u.check()).state, 'idle');
  });
});

test('updater: auto install starts the installer as soon as the update is ready', async () => {
  await withFixture(async (f, home) => {
    writeInstall(home, f.base);
    const { u, spawned } = makeUpdater(home, { autoInstall: () => true });
    await u.start();
    await u.check();
    await u.whenIdle();
    assert.equal(spawned.length, 1);
    assert.equal(u.status().state, 'installing');
  });
});

test('updater: auto download off → available (nothing downloaded, older download removed); download() fetches it → ready', async () => {
  await withFixture(async (f, home) => {
    writeInstall(home, f.base);
    mkdirSync(join(home, 'updates'));
    writeFileSync(join(home, 'updates', 'Mk42-Setup-2026.1001.1.exe'), 'old');
    let autoDownload = false;
    const { u, events } = makeUpdater(home, { autoDownload: () => autoDownload });
    await u.start();
    assert.deepEqual(u.status().auto, { download: false, install: false });
    const s = await u.check();
    assert.equal(s.state, 'available');
    assert.equal(s.latest, NEXT);
    assert.equal(s.size, PAYLOAD.length);
    assert.equal(s.notes, '한국어 설명');
    assert.ok(!f.requests.some((r) => r.url.endsWith('.exe')), 'no download while auto download is off');
    assert.deepEqual(readdirSync(join(home, 'updates')), [], 'an older download is superseded');
    // 정해진 확인도 받지 않아요
    assert.equal((await u.check()).state, 'available');
    assert.ok(!f.requests.some((r) => r.url.endsWith('.exe')));

    const d = await u.download();
    assert.equal(d.state, 'downloading');
    assert.equal(d.progress?.total, PAYLOAD.length);
    await u.whenIdle();
    assert.equal(u.status().state, 'ready');
    assert.equal(u.status().size, PAYLOAD.length);
    assert.deepEqual(readdirSync(join(home, 'updates')), [EXE]);
    assert.ok(events.every((e) => e.auto?.download === false), 'every notification carries the settings');
    // 받아 둔 판은 자동 받기가 꺼져 있어도 그대로 ready
    assert.equal((await u.check()).state, 'ready');
    assert.equal((await u.download()).state, 'ready', 'download() is a no-op once ready');
  });
});

test('updater: turning auto download on while an update is available starts the download; settings changes are announced', async () => {
  await withFixture(async (f, home) => {
    writeInstall(home, f.base);
    let autoDownload = false;
    let autoInstall = false;
    const { u, events } = makeUpdater(home, { autoDownload: () => autoDownload, autoInstall: () => autoInstall });
    await u.start();
    assert.equal((await u.check()).state, 'available');
    events.length = 0;
    autoInstall = true;
    const same = await u.settingsChanged();
    assert.equal(same.state, 'available', 'auto install alone does not download');
    assert.deepEqual(events.at(-1)?.auto, { download: false, install: true });
    autoInstall = false;
    autoDownload = true;
    const s = await u.settingsChanged();
    // 받기는 시작만 하고 바로 답해요(update.setAuto가 서버를 기다리지 않게) — 진행은 알림으로
    assert.deepEqual(s.auto, { download: true, install: false });
    await u.whenIdle();
    assert.ok(events.some((e) => e.state === 'downloading'));
    assert.equal(u.status().state, 'ready');
    assert.deepEqual(u.status().auto, { download: true, install: false });
  });
});

test('updater: auto download turned on while a check is pruning an old download (state still checking) → that check downloads', async () => {
  await withFixture(async (f, home) => {
    writeInstall(home, f.base);
    mkdirSync(join(home, 'updates'));
    const old = join(home, 'updates', 'Mk42-Setup-2026.1001.1.exe');
    writeFileSync(old, 'old');
    // 정리(#prune)가 옛 파일을 지운 순간부터 켜진 것으로 — update.setAuto가 그 사이에 온 것과 같아요
    const { u } = makeUpdater(home, { autoDownload: () => !existsSync(old) });
    await u.start();
    const s = await u.check();
    assert.equal(s.state, 'downloading', 'the setting is read again after pruning');
    await u.whenIdle();
    assert.equal(u.status().state, 'ready');
  });
});

test('updater: HTTP errors are reported without credentials; 401 hints at update.secret', async () => {
  await withFixture(async (f, home) => {
    writeInstall(home, f.base);
    writeFileSync(join(home, 'update.secret'), 'mk42:do-not-leak');
    const { u } = makeUpdater(home);
    await u.start();
    f.status = 401;
    const s = await u.check();
    assert.equal(s.state, 'error');
    assert.match(s.error ?? '', /401.*update\.secret/);
    assert.ok(!JSON.stringify(s).includes('do-not-leak'));
  });
});

test('updater: disabled without an install record, a channel, an https url or an Ed25519 key', async () => {
  const t = tempDir('mk42-updater-');
  try {
    const { u } = makeUpdater(t.dir, { allowLoopbackHttp: false });
    await u.start();
    assert.equal(u.status().state, 'disabled');
    assert.equal((await u.check()).state, 'disabled');
    writeInstall(t.dir, 'http://127.0.0.1:1/updates/');
    assert.equal((await u.check()).state, 'disabled', 'plain http is refused outside tests');
    writeInstall(t.dir, 'https://mk42.estre.so/updates/', { channel: null });
    assert.equal((await u.refreshStatus()).state, 'disabled');
    u.close();
  } finally {
    t.cleanup();
  }
});

test('parseUpdateConfig: https only, no credentials/query in the url, Ed25519 key, trailing slash added', () => {
  const ok = parseUpdateConfig({ channel: 'internal', url: 'https://mk42.estre.so/updates', publicKey: PUB });
  assert.deepEqual(ok, { channel: 'internal', url: 'https://mk42.estre.so/updates/', publicKey: PUB });
  const bad: unknown[] = [
    undefined,
    { channel: null, url: null, publicKey: null },
    { channel: 'Internal', url: 'https://a/', publicKey: PUB },
    { channel: 'internal', url: 'http://mk42.estre.so/updates/', publicKey: PUB },
    { channel: 'internal', url: 'https://u:p@mk42.estre.so/updates/', publicKey: PUB },
    { channel: 'internal', url: 'https://mk42.estre.so/updates/?x=1', publicKey: PUB },
    { channel: 'internal', url: 'https://mk42.estre.so/updates/', publicKey: 'nope' },
    { channel: 'internal', url: 'https://mk42.estre.so/updates/', publicKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  ];
  for (const b of bad) assert.ok('error' in parseUpdateConfig(b), JSON.stringify(b));
  assert.ok(!('error' in parseUpdateConfig({ channel: 'internal', url: 'http://localhost:8080/u/', publicKey: PUB }, { allowLoopbackHttp: true })));
  assert.ok('error' in parseUpdateConfig({ channel: 'internal', url: 'http://example.com/u/', publicKey: PUB }, { allowLoopbackHttp: true }));
});

test('parseLatestManifest + signature: strict fields', () => {
  const good = { schema: 1, product: 'mk42', channel: 'internal', version: NEXT, file: EXE, size: 5_000_000, sha256: 'A'.repeat(64) };
  const bytes = (o: unknown) => Buffer.from(JSON.stringify(o));
  const m = parseLatestManifest(bytes(good), 'internal');
  assert.equal(m.sha256, 'a'.repeat(64));
  const bad = [
    { ...good, channel: 'stable' },
    { ...good, product: 'mark42' },
    { ...good, schema: 2 },
    { ...good, version: '1.2' },
    { ...good, file: '..\\Mk42-Setup-1.exe' },
    { ...good, file: 'Mk42-Setup-1.exe.bat' },
    { ...good, file: 'evil.exe' },
    { ...good, size: 10 },
    { ...good, size: 5e9 },
    { ...good, size: 1.5e6 + 0.5 },
    { ...good, sha256: 'g'.repeat(64) },
    { ...good, notes: { ko: 5 } },
  ];
  for (const b of bad) assert.throws(() => parseLatestManifest(bytes(b), 'internal'), /invalid latest\.json/, JSON.stringify(b));
  assert.throws(() => parseLatestManifest(Buffer.from([0xff, 0xfe, 0x00]), 'internal'));
  const b = bytes(good);
  const sig = sign(null, b, keys.privateKey).toString('base64');
  assert.equal(verifyManifestSignature(b, sig, PUB), true);
  assert.equal(verifyManifestSignature(b, `${sig.slice(0, 40)}\n${sig.slice(40)}\n`, PUB), true, 'line breaks in the base64 are fine');
  assert.equal(verifyManifestSignature(Buffer.concat([b, Buffer.from('\n')]), sig, PUB), false, 'exact bytes');
  assert.equal(verifyManifestSignature(b, sign(null, b, other.privateKey).toString('base64'), PUB), false);
  assert.equal(verifyManifestSignature(b, 'not base64!', PUB), false);
  assert.equal(verifyManifestSignature(b, Buffer.alloc(10).toString('base64'), PUB), false);
});

test('basicAuthHeader: user:password only', () => {
  assert.equal(basicAuthHeader('\uFEFFmk42:tok\n'), `Basic ${Buffer.from('mk42:tok').toString('base64')}`);
  for (const bad of ['', 'nocolon', ':pw', 'user:', 'a:b\nc:d', `u:${'x'.repeat(600)}`]) assert.equal(basicAuthHeader(bad), undefined, bad);
});

test('server: update.changed goes to every window; the ready announcement goes to one window only (most recently focused), late windows get it on hello', async () => {
  const t = tempDir();
  const registry = await Registry.load(t.dir);
  const calls: SpawnCall[] = [];
  let status: Mk42UpdateStatus = { state: 'idle', current: CURRENT, channel: 'internal' };
  const installs: number[] = [];
  const core = new DaemonCore({
    home: t.dir,
    registry,
    indexers: [new FakeIndexer('claude')],
    launcher: fakeLauncher(t.dir, () => registry.settings, calls),
    newId: sequenceIds(),
    stateDebounceMs: 10,
    mk42Update: {
      status: () => status,
      check: async () => status,
      install: async () => {
        installs.push(1);
        return { started: true };
      },
    },
  });
  await core.start();
  const server = new PipeServer();
  const pipe = uniquePipeName();
  await server.listen(pipe);
  server.attachCore(core);
  const a = await connectPipe(pipe);
  const b = await connectPipe(pipe);
  try {
    assert.deepEqual(await a.request('update.status', {}), status);
    await a.hello({ role: 'editor', folderPath: 'C:\\work\\a' });
    await b.hello({ role: 'editor', folderPath: 'C:\\work\\b' });
    // b가 나중에 붙었지만 a가 포커스를 알렸어요
    a.peer.notify('window.status', { focused: true });
    await a.request('update.status', {});
    status = { ...status, state: 'ready', latest: NEXT };
    core.notifyUpdateChanged(status);
    const na = await a.waitFor('update.changed');
    const nb = await b.waitFor('update.changed');
    assert.equal(na.announce, true);
    assert.equal(nb.announce, undefined);
    assert.equal(nb.latest, NEXT);
    // 같은 판은 다시 묻지 않아요(진행 알림 등)
    core.notifyUpdateChanged(status);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(a.notifications.filter((n) => n.method === 'update.changed' && (n.params as { announce?: boolean }).announce).length, 1);
    // 새 창이 붙어도 이미 물은 판은 다시 묻지 않아요
    const c = await connectPipe(pipe);
    await c.hello({ role: 'editor', folderPath: 'C:\\work\\c' });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!c.notifications.some((n) => n.method === 'update.changed'));
    // 새 판은 다시 물어요 — 창이 없을 때 ready가 되면 다음 hello 창이
    a.close();
    b.close();
    c.close();
    await new Promise((r) => setTimeout(r, 50));
    status = { ...status, latest: '2026.1106.1' };
    core.notifyUpdateChanged(status);
    const d = await connectPipe(pipe);
    await d.hello({ role: 'editor', folderPath: 'C:\\work\\d' });
    const nd = await d.waitFor('update.changed');
    assert.equal(nd.announce, true);
    assert.deepEqual(await d.request('update.install', {}), { started: true });
    assert.equal(installs.length, 1);
    d.close();
  } finally {
    await server.close();
    await core.close();
    t.cleanup();
  }
});

test('server: update.setAuto validates, saves settings.update in the registry and lets the updater re-announce; update.download is forwarded', async () => {
  const t = tempDir();
  const registry = await Registry.load(t.dir);
  const calls: SpawnCall[] = [];
  let changed = 0;
  let downloads = 0;
  const status = (): Mk42UpdateStatus => ({
    state: 'available',
    current: CURRENT,
    channel: 'internal',
    latest: NEXT,
    auto: { download: registry.settings.update?.autoDownload !== false, install: registry.settings.update?.autoInstall === true },
  });
  const core = new DaemonCore({
    home: t.dir,
    registry,
    indexers: [new FakeIndexer('claude')],
    launcher: fakeLauncher(t.dir, () => registry.settings, calls),
    newId: sequenceIds(),
    stateDebounceMs: 10,
    mk42Update: {
      status,
      check: async () => status(),
      install: async () => ({ started: false }),
      download: async () => {
        downloads++;
        return { ...status(), state: 'downloading' };
      },
      settingsChanged: async () => {
        changed++;
        return status();
      },
    },
  });
  await core.start();
  const server = new PipeServer();
  const pipe = uniquePipeName();
  await server.listen(pipe);
  server.attachCore(core);
  const a = await connectPipe(pipe);
  try {
    await a.hello({ role: 'hub', folderPath: 'C:\\work\\a' });
    const r = (await a.request('update.setAuto', { download: false })) as Mk42UpdateStatus;
    assert.deepEqual(r.auto, { download: false, install: false });
    assert.equal(registry.settings.update?.autoDownload, false);
    assert.equal(registry.settings.update?.autoInstall, undefined, 'only the given key is written');
    await a.request('update.setAuto', { install: true });
    assert.deepEqual(registry.settings.update, { autoDownload: false, autoInstall: true });
    assert.equal(changed, 2);
    await assert.rejects(a.request('update.setAuto', {}), /download or install/);
    await assert.rejects(a.request('update.setAuto', { download: 'yes' } as never), /boolean/);
    assert.equal(changed, 2, 'rejected requests change nothing');
    assert.equal(((await a.request('update.download', {})) as Mk42UpdateStatus).state, 'downloading');
    assert.equal(downloads, 1);
  } finally {
    a.close();
    await server.close();
    await core.close();
    t.cleanup();
  }
});
