import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CLAUDE_TUNING, createClaudeIndexer, encodeClaudeProjectDir, summarizeRecords } from '../../src/indexers/claude.ts';
import { deadPid, jsonl, makeTmp, waitFor } from './helpers.ts';

const CWD_A = 'C:\\work\\proj-a';
const CWD_B = 'C:\\work\\Proj B';
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const ID4 = '44444444-4444-4444-8444-444444444444';
const pad = (n: number) => 'x'.repeat(n);

const base = (cwd: string, sessionId: string) => ({ cwd, sessionId, entrypoint: 'claude-vscode', userType: 'external', version: '2.1.301', isSidechain: false });
const user = (cwd: string, id: string, text: string) => ({ ...base(cwd, id), type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: '2026-10-17T00:00:00Z' });
const toolResult = (cwd: string, id: string) => ({ ...base(cwd, id), type: 'user', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] } });
const assistant = (cwd: string, id: string, model: string, effort?: string, requestedModel?: string) => ({
  ...base(cwd, id),
  type: 'assistant',
  message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] },
  ...(effort ? { effort } : {}),
  ...(requestedModel ? { requestedModel } : {}),
});

let tmp: ReturnType<typeof makeTmp>;
let claudeDir: string;
let dirA: string;
let dirB: string;
let dead: number;

before(async () => {
  tmp = makeTmp('claude');
  claudeDir = join(tmp.dir, '.claude');
  dirA = join(claudeDir, 'projects', encodeClaudeProjectDir(CWD_A));
  dirB = join(claudeDir, 'projects', encodeClaudeProjectDir(CWD_B));
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });

  // ID1: 작은 세션, 소문자 드라이브 cwd, 메타 레코드 다 있음
  writeFileSync(
    join(dirA, `${ID1}.jsonl`),
    jsonl([
      { type: 'queue-operation', operation: 'enqueue', sessionId: ID1, timestamp: 't' },
      user('c:\\work\\proj-a', ID1, 'first prompt'),
      assistant('c:\\work\\proj-a', ID1, 'claude-opus-5-5', 'xhigh', 'claude-opus-5-5[1m]'),
      { type: 'ai-title', sessionId: ID1, aiTitle: 'AI title' },
      { type: 'custom-title', sessionId: ID1, customTitle: 'My title' },
      { type: 'ai-title', sessionId: ID1, aiTitle: 'Later AI title' },
      { type: 'last-prompt', sessionId: ID1, lastPrompt: 'p'.repeat(300), leafUuid: 'u' },
      { type: 'cost-state', sessionId: ID1 },
    ]),
  );
  // 서브에이전트 파일은 목록에 안 나와요
  mkdirSync(join(dirA, ID1, 'subagents'), { recursive: true });
  writeFileSync(join(dirA, ID1, 'subagents', 'agent-abc.jsonl'), jsonl([user(CWD_A, 'agent-abc', 'sub')]));

  // ID2: 1MB 넘는 큰 세션 — cwd는 64KB 뒤에, 가운데 제목은 안 읽혀야 하고, 마지막 assistant 뒤에 큰 레코드
  const big: unknown[] = [{ type: 'queue-operation', operation: 'enqueue', sessionId: ID2 }, { type: 'file-history-snapshot', snapshot: { p: pad(100 * 1024) } }];
  big.push(user(CWD_A, ID2, 'big first'));
  big.push(assistant(CWD_A, ID2, 'claude-opus-5', 'low'));
  for (let i = 0; i < 400; i++) big.push({ type: 'attachment', ...base(CWD_A, ID2), attachment: { p: pad(2000) } });
  big.push({ type: 'custom-title', sessionId: ID2, customTitle: 'MIDDLE ONLY' });
  for (let i = 0; i < 400; i++) big.push({ type: 'attachment', ...base(CWD_A, ID2), attachment: { p: pad(2000) } });
  big.push(user(CWD_A, ID2, 'the real last prompt'));
  big.push(assistant(CWD_A, ID2, 'claude-opus-5-5', 'high'));
  big.push(toolResult(CWD_A, ID2));
  for (let i = 0; i < 40; i++) big.push({ type: 'api-request-blob', sessionId: ID2, message: { p: pad(2000) } });
  big.push({ type: 'ai-title', sessionId: ID2, aiTitle: 'Tail title' });
  writeFileSync(join(dirA, `${ID2}.jsonl`), jsonl(big));

  // ID3: 다른 폴더(공백 포함)
  writeFileSync(join(dirB, `${ID3}.jsonl`), jsonl([user(CWD_B, ID3, 'b prompt'), assistant(CWD_B, ID3, 'claude-fable-5')]));

  // ID4: 인코딩 규칙과 다른 폴더 이름 — cwd 필드로 찾아야 해요
  const odd = join(claudeDir, 'projects', 'unexpected-dir-name');
  mkdirSync(odd);
  writeFileSync(join(odd, `${ID4}.jsonl`), jsonl([user('C:\\elsewhere', ID4, 'odd')]));
  // cwd가 없는 파일은 건너뛰어요
  writeFileSync(join(odd, '55555555-5555-4555-8555-555555555555.jsonl'), jsonl([{ type: 'queue-operation', sessionId: 'x' }]));

  const now = Date.now() / 1000;
  utimesSync(join(dirA, `${ID1}.jsonl`), now - 300, now - 300);
  utimesSync(join(dirA, `${ID2}.jsonl`), now - 100, now - 100);
  utimesSync(join(dirB, `${ID3}.jsonl`), now - 200, now - 200);
  utimesSync(join(odd, `${ID4}.jsonl`), now - 400, now - 400);

  // 실행 중 세션: 이 프로세스(살아 있음) + 죽은 pid + 읽으면 안 되는 .key
  dead = await deadPid();
  const sdir = join(claudeDir, 'sessions');
  writeFileSync(join(sdir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: ID2, cwd: 'c:\\work\\proj-a', status: 'busy', kind: 'interactive', entrypoint: 'claude-vscode', name: 'n', version: '2.1.301' }));
  writeFileSync(join(sdir, `${dead}.json`), JSON.stringify({ pid: dead, sessionId: ID3, cwd: CWD_B, status: 'idle' }));
  writeFileSync(join(sdir, `${process.pid}.deadbeefcafe.key`), JSON.stringify({ pid: process.pid, sessionId: 'KEY-LEAK', cwd: CWD_A, status: 'busy' }));
  writeFileSync(join(sdir, 'garbage.json'), '{');
});

after(() => tmp.cleanup());

describe('encodeClaudeProjectDir', () => {
  it('replaces every non-alphanumeric character with "-"', () => {
    assert.equal(encodeClaudeProjectDir('C:\\Dev\\work area\\Mark42'), 'C--Dev-work-area-Mark42');
    assert.equal(encodeClaudeProjectDir('C:\\Dev\\a\\.agent\\x_y'), 'C--Dev-a--agent-x-y');
  });
});

describe('summarizeRecords', () => {
  it('prefers custom-title over ai-title and falls back to the last human prompt', () => {
    const s = summarizeRecords([user('C:\\a', 'i', 'hello   world'), toolResult('C:\\a', 'i'), { type: 'ai-title', aiTitle: 'A' }]);
    assert.equal(s.title, 'A');
    assert.equal(s.lastPrompt, 'hello world');
    assert.equal(s.cwd, 'C:\\a');
  });
  it('ignores <synthetic> models and command wrappers', () => {
    const s = summarizeRecords([
      assistant('C:\\a', 'i', 'claude-opus-5-5'),
      assistant('C:\\a', 'i', '<synthetic>'),
      { ...user('C:\\a', 'i', 'x'), message: { role: 'user', content: '<command-name>/effort</command-name>' } },
    ]);
    assert.equal(s.model, 'claude-opus-5-5');
    assert.equal(s.lastPrompt, undefined);
  });
});

describe('claude indexer', () => {
  it('lists sessions newest first with metadata and live status', async () => {
    const idx = createClaudeIndexer({ claudeDir });
    const all = await idx.list({});
    assert.deepEqual(all.map((s) => s.id), [ID2, ID3, ID1, ID4]);
    const s1 = all.find((s) => s.id === ID1)!;
    assert.equal(s1.agent, 'claude');
    assert.equal(s1.cwd, 'C:\\work\\proj-a');
    assert.equal(s1.title, 'My title');
    assert.equal(s1.lastPrompt, 'p'.repeat(200));
    assert.equal(s1.model, 'claude-opus-5-5[1m]');
    assert.equal(s1.effort, 'xhigh');
    assert.equal(s1.status, undefined);
    assert.ok(!Number.isNaN(Date.parse(s1.updatedAt)));
    const s3 = all.find((s) => s.id === ID3)!;
    assert.equal(s3.status, undefined, 'dead pid → not live');
  });

  it('reads big files by head/tail only', async () => {
    const idx = createClaudeIndexer({ claudeDir });
    const s2 = (await idx.list({ cwd: CWD_A })).find((s) => s.id === ID2)!;
    assert.equal(s2.cwd, CWD_A, 'cwd found beyond the first 64KB');
    assert.equal(s2.title, 'Tail title', 'middle-only custom-title is never read');
    assert.equal(s2.lastPrompt, 'the real last prompt');
    assert.equal(s2.model, 'claude-opus-5-5', 'tail widened past large trailing records');
    assert.equal(s2.effort, 'high');
    assert.equal(s2.status, 'busy');
  });

  it('filters by cwd (case-insensitive) and limit', async () => {
    const idx = createClaudeIndexer({ claudeDir });
    assert.deepEqual((await idx.list({ cwd: 'c:\\WORK\\proj-a\\' })).map((s) => s.id), [ID2, ID1]);
    assert.deepEqual((await idx.list({ cwd: CWD_B })).map((s) => s.id), [ID3]);
    assert.deepEqual((await idx.list({ cwd: 'C:\\elsewhere' })).map((s) => s.id), [ID4], 'found via cwd field when dir name does not match');
    assert.equal((await idx.list({ limit: 2 })).length, 2);
    assert.deepEqual(await idx.list({ cwd: 'C:\\nowhere' }), []);
  });

  it('live() returns only alive pids and never reads .key files', async () => {
    const idx = createClaudeIndexer({ claudeDir });
    const live = await idx.live();
    assert.deepEqual(live, [{ agent: 'claude', sessionId: ID2, cwd: CWD_A, status: 'busy', pid: process.pid }]);
    assert.ok(!live.some((l) => l.sessionId === 'KEY-LEAK'));
  });

  it('live() ignores session files left over from before this boot (pid reuse after a crash or reboot)', async () => {
    const dir = join(tmp.dir, 'stale-claude');
    const sdir = join(dir, 'sessions');
    mkdirSync(sdir, { recursive: true });
    const boot = Date.now() - 60 * 60_000; // 1시간 전에 부팅
    const fresh = { pid: 101, sessionId: 'fresh', cwd: CWD_A, status: 'idle', startedAt: Date.now() - 1000 };
    const oldFile = { pid: 102, sessionId: 'old-file', cwd: CWD_A, status: 'idle', startedAt: boot - 10 * 60_000 };
    const oldStart = { pid: 103, sessionId: 'old-start', cwd: CWD_A, status: 'busy', startedAt: boot - 10 * 60_000 };
    for (const r of [fresh, oldFile, oldStart]) writeFileSync(join(sdir, `${r.pid}.json`), JSON.stringify(r));
    const before = (boot - 30 * 60_000) / 1000;
    utimesSync(join(sdir, '102.json'), before, before);
    const idx = createClaudeIndexer({ claudeDir: dir, bootTime: () => boot, pidAlive: () => true });
    const live = await idx.live();
    assert.deepEqual(live.map((l) => l.sessionId), ['fresh']);
  });

  it('re-reads a file when it changes (cache keyed by mtime+size)', async () => {
    const idx = createClaudeIndexer({ claudeDir });
    assert.equal((await idx.list({ cwd: CWD_B }))[0]!.title, undefined);
    appendFileSync(join(dirB, `${ID3}.jsonl`), jsonl([{ type: 'custom-title', sessionId: ID3, customTitle: 'Renamed' }]));
    assert.equal((await idx.list({ cwd: CWD_B }))[0]!.title, 'Renamed');
  });

  it('start() reports changes (watch + polling) and stop() ends it', async () => {
    const saved = { ...CLAUDE_TUNING };
    CLAUDE_TUNING.pollMs = 100;
    CLAUDE_TUNING.debounceMs = 50;
    const idx = createClaudeIndexer({ claudeDir });
    let calls = 0;
    try {
      await idx.start(() => calls++);
      await new Promise((r) => setTimeout(r, 250));
      const before = calls;
      writeFileSync(join(dirB, '66666666-6666-4666-8666-666666666666.jsonl'), jsonl([user(CWD_B, '6', 'new')]));
      await waitFor(() => calls > before, 5000);
      // 세션 파일 삭제(pid 종료 흉내)도 감지
      const n = calls;
      writeFileSync(join(claudeDir, 'sessions', `${dead}.json`), JSON.stringify({ pid: dead, sessionId: ID3, cwd: CWD_B, status: 'busy' }));
      await waitFor(() => calls > n, 5000);
    } finally {
      await idx.stop();
      Object.assign(CLAUDE_TUNING, saved);
    }
    const n = calls;
    writeFileSync(join(dirB, '77777777-7777-4777-8777-777777777777.jsonl'), jsonl([user(CWD_B, '7', 'after stop')]));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls, n, 'no callbacks after stop');
  });

  it('handles a missing claude dir', async () => {
    const idx = createClaudeIndexer({ claudeDir: join(tmp.dir, 'nope') });
    assert.deepEqual(await idx.list({}), []);
    assert.deepEqual(await idx.live(), []);
    await idx.start(() => {});
    await idx.stop();
  });
});
