// folders.clone — 통합 창 «폴더 등록» 칸에 git 저장소 주소: 클론할 위치 아래에 새 폴더로 클론하고 등록
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ErrorCode, RpcError } from '@mark42/protocol';
import { normalizePath } from '@mark42/protocol/paths';
import { cloneFailureMessage, GitCloneError, runGitClone } from '../src/gitClone.ts';
import { Registry } from '../src/registry.ts';
import { DaemonCore, PipeServer } from '../src/server.ts';
import { connectPipe, fakeLauncher, FakeIndexer, sequenceIds, tempDir, uniquePipeName, type SpawnCall, type TestClient } from './helpers.ts';

const cloned: { url: string; dest: string }[] = [];
let failNext: Error | undefined;
let release: (() => void) | undefined;

let core: DaemonCore;
let server: PipeServer;
let pipe: string;
let parent: string;
let cleanup: () => void;
const clients: TestClient[] = [];

before(async () => {
  const t = tempDir();
  cleanup = t.cleanup;
  parent = join(t.dir, 'src');
  mkdirSync(parent, { recursive: true });
  const home = join(t.dir, 'home');
  const registry = await Registry.load(home);
  const calls: SpawnCall[] = [];
  core = new DaemonCore({
    home,
    registry,
    indexers: [new FakeIndexer('claude'), new FakeIndexer('codex')],
    launcher: fakeLauncher(home, () => registry.settings, calls),
    newId: sequenceIds(),
    stateDebounceMs: 20,
    gitClone: async (url, dest) => {
      if (release) await new Promise<void>((r) => (release = r));
      if (failNext) {
        const e = failNext;
        failNext = undefined;
        // like git killed at the timeout: a half-written folder stays behind
        mkdirSync(dest);
        writeFileSync(join(dest, 'partial'), 'x');
        throw e;
      }
      cloned.push({ url, dest });
      mkdirSync(dest);
    },
  });
  await core.start();
  server = new PipeServer();
  pipe = uniquePipeName();
  await server.listen(pipe);
  server.attachCore(core);
});

after(async () => {
  for (const c of clients) c.close();
  await server.close();
  await core.close();
  cleanup();
});

async function hub(): Promise<TestClient> {
  const c = await connectPipe(pipe);
  clients.push(c);
  await c.hello({ role: 'hub' });
  return c;
}

test('clone: new folder named after the repository under the chosen parent, then registered', async () => {
  const c = await hub();
  const f = await c.request('folders.clone', { url: 'https://github.com/owner/My-Repo.git', parentDir: parent });
  assert.equal(f.path, normalizePath(join(parent, 'My-Repo')));
  assert.equal(f.label, 'My-Repo');
  assert.deepEqual(cloned.at(-1), { url: 'https://github.com/owner/My-Repo.git', dest: normalizePath(join(parent, 'My-Repo')) });
  assert.ok((await c.request('folders.list', {})).some((x) => x.id === f.id));
});

test('clone: refuses a folder that already exists, odd addresses, a missing parent', async () => {
  const c = await hub();
  await assert.rejects(c.request('folders.clone', { url: 'git@github.com:owner/My-Repo.git', parentDir: parent }), (e: RpcError) => e.code === ErrorCode.InvalidPath);
  for (const url of ['C:\\Dev\\x', 'file:///C:/x', 'ext::sh -c calc', '--upload-pack=x', 'https://user:tok@github.com/o/r', 'https://tok@github.com/o/r']) {
    await assert.rejects(c.request('folders.clone', { url, parentDir: parent }), (e: RpcError) => e.code === ErrorCode.InvalidParams, url);
  }
  await assert.rejects(c.request('folders.clone', { url: 'https://github.com/o/r', parentDir: join(parent, 'nope') }), (e: RpcError) => e.code === ErrorCode.InvalidPath);
});

test('clone: a git failure is CloneFailed and registers nothing; a timeout is Timeout', async () => {
  const c = await hub();
  const before = (await c.request('folders.list', {})).length;
  failNext = new GitCloneError('git clone 실패: Repository not found.', 'failed');
  await assert.rejects(c.request('folders.clone', { url: 'https://github.com/o/missing', parentDir: parent }), (e: RpcError) => e.code === ErrorCode.CloneFailed && /Repository not found/.test(e.message));
  failNext = new GitCloneError('git clone이 제한 시간 안에 끝나지 않았어요', 'timeout');
  await assert.rejects(c.request('folders.clone', { url: 'https://github.com/o/slow', parentDir: parent }), (e: RpcError) => e.code === ErrorCode.Timeout);
  assert.equal((await c.request('folders.list', {})).length, before);
  assert.equal(existsSync(join(parent, 'missing')), false, 'the half-cloned folder is removed (it did not exist before)');
  assert.equal(existsSync(join(parent, 'slow')), false, 'a retry is not refused as «already exists»');
});

test('clone: two requests for the same target in the same tick — only one runs git', async () => {
  const c = await hub();
  const n = cloned.length;
  const results = await Promise.allSettled([
    c.request('folders.clone', { url: 'https://github.com/o/sametick', parentDir: parent }),
    c.request('folders.clone', { url: 'https://github.com/o/sametick.git', parentDir: parent }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.some((r) => r.status === 'rejected' && (r.reason as RpcError).code === ErrorCode.InvalidPath));
  assert.equal(cloned.length, n + 1);
});

test("clone failure message: the cause, not git's closing lines; hints for ssh", () => {
  const ssh = [
    "Cloning into 'r'...",
    'Host key verification failed.',
    'fatal: Could not read from remote repository.',
    '',
    'Please make sure you have the correct access rights',
    'and the repository exists.',
  ].join('\r\n');
  assert.match(cloneFailureMessage(ssh), /^git clone 실패: Host key verification failed\. — .*호스트 키/);
  assert.match(cloneFailureMessage(['git@github.com: Permission denied (publickey).', 'fatal: Could not read from remote repository.'].join('\n')), /ssh 키/);
  assert.equal(
    cloneFailureMessage(["Cloning into 'x'...", 'remote: Repository not found.', "fatal: repository 'https://github.com/o/x/' not found"].join('\n')),
    "git clone 실패: fatal: repository 'https://github.com/o/x/' not found",
  );
  assert.equal(cloneFailureMessage(''), 'git clone 실패');
});

test('clone: the same target twice at once is refused', async () => {
  const c = await hub();
  release = () => {};
  const first = c.request('folders.clone', { url: 'https://github.com/o/twice', parentDir: parent });
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(c.request('folders.clone', { url: 'https://github.com/o/twice.git', parentDir: parent }), (e: RpcError) => e.code === ErrorCode.InvalidPath && /already cloning/.test(e.message));
  const r = release;
  release = undefined;
  r();
  assert.equal((await first).label, 'twice');
});

test('runGitClone: missing git and a failing git map to their codes', async () => {
  await assert.rejects(runGitClone('https://x/y', 'C:\\nowhere\\y', { git: 'mk42-no-such-git-exe' }), (e: GitCloneError) => e.code === 'not_found');
  // node in place of git: it rejects the git arguments and exits non-zero — the last stderr line becomes the message
  await assert.rejects(runGitClone('https://x/y', 'C:\\nowhere\\y', { git: process.execPath }), (e: GitCloneError) => e.code === 'failed' && e.message.startsWith('git clone 실패'));
});
